# Architecture

## Responsibility split

### OpenCode Servers

Each configured OpenCode server is the authoritative owner of its sessions, model/tool execution, session state, messages, questions, and permission requests. The bridge must not reimplement these semantics or migrate a session between hosts implicitly.

### tmux

Process and interactive-terminal persistence only. A local helper can keep `opencode serve` alive and may host `opencode attach` windows for SSH operators. tmux is not used as a transport protocol, and Discord does not remotely control tmux on other hosts.

### OpenCodeDiscordBridge

A narrow adapter between Discord and configured OpenCode hosts:

- authenticates/authorizes Discord operators;
- resolves a stable operator-configured host ID;
- maps a Discord thread to `(hostId, OpenCode session)`;
- validates repository directory scope against that host's allowed roots;
- forwards thread text and attachments as OpenCode prompts;
- projects OpenCode questions, permissions, results, errors, tool summaries, and optional streaming into Discord;
- aggregates per-host HTTP/SSE readiness for operator diagnostics;
- persists only the mapping required to reconnect after restart.

### OpenCode policy/configuration

Remains the execution-policy authority on every host. A Discord authorization grants the human access to the bridge, not blanket authority to bypass OpenCode tool policies.

## Host registry

`OPENCODE_HOSTS_JSON` defines trusted host identities. Discord sees only the host ID, never a free-form URL or credential.

Each runtime host owns:

- one authenticated OpenCode gateway;
- one global SSE consumer/readiness monitor;
- one isolated assistant-stream publisher;
- one isolated tool-summary publisher;
- one directory authorizer built from that host's allowed roots.

The legacy single-host environment is projected as a registry containing host ID `default`.

## Primary flow

```text
/oc start directory:<absolute> [host:<configured-id>]
  -> validate Discord user/guild
  -> resolve configured host (default if omitted)
  -> ask selected OpenCode host for canonical /path
  -> verify remote directory is accessible through OpenCode file API
  -> verify canonical directory within selected host allowed roots
  -> selected host: OpenCode session.create
  -> Discord thread.create
  -> persist thread/host/session binding

Discord thread message
  -> validate author
  -> find binding
  -> resolve binding.hostId
  -> reject overlapping turn while that session is busy/retrying
  -> selected host: OpenCode session.promptAsync

Per-host OpenCode global SSE
  -> identify event source host
  -> question.asked     -> matching host/session binding -> Discord Ask
  -> permission.updated -> matching host/session/directory binding -> race-safe Discord buttons
  -> session.idle       -> matching host/session binding -> canonical Result
  -> session.error      -> matching host/session binding -> Discord error

/oc health
  -> snapshot every configured host and its current SSE freshness
  -> authenticated /global/health probe for every host in parallel
  -> isolate each probe failure as that host's degraded HTTP state
  -> render per-host ready/degraded plus aggregate Bridge readiness
```

All session lookup used for event delivery is keyed by `(hostId, sessionId)`. Identical session IDs on two independent OpenCode hosts are therefore not interchangeable.

A host is health-ready only when its HTTP probe reports healthy and its per-host global SSE monitor is connected. The aggregate Bridge health is `ready` only when every configured host is ready; otherwise it is `degraded`. Diagnostic output identifies hosts by stable ID and does not expose host URLs, usernames, or credentials.

## Remote directory validation

The Bridge must not use its own filesystem to validate a path that belongs to another host.

For every configured host, allowed-root authorization uses that OpenCode server itself as the canonicalization source:

1. `GET /path?directory=<requested>` returns the host-side canonical `directory`.
2. Existing paths are resolved by OpenCode through its filesystem realpath logic, so symlink targets are reflected in the canonical path.
3. The Bridge requires both requested and canonical paths to be absolute.
4. `GET /file?directory=<canonical>&path=.` confirms that the canonical directory exists and is accessible through OpenCode.
5. The canonical directory is compared only against the selected host's configured allowed roots.

A path outside those roots, a symlink escape, an inaccessible path, or an invalid OpenCode response fails closed before session creation.

## Failure semantics

Creating a session is a two-system operation. If Discord thread creation or binding persistence fails after the OpenCode session was created, the bridge attempts compensation by deleting the new thread and the session on the same selected host.

For normal operation, the state file is updated atomically by writing a temporary file and renaming it into place.

An OpenCode event-stream disconnect is isolated to that host. Each gateway reconnects with bounded exponential backoff. Result publication is idempotent at the bridge level using `lastPublishedAssistantMessageId` in persisted state.

Health probing is also isolated per host. `/oc health` probes all configured hosts concurrently; an unreachable or invalid host becomes a degraded entry without suppressing healthy results from other hosts.

Pending question state is keyed by `(hostId, sessionId)`. Permission publication state is keyed by `(hostId, permission ID)` and reserves an entry before Discord send, so startup reconciliation and live SSE cannot publish the same request concurrently. A failed Discord send rolls that reservation back. OpenCode remains the source of truth for whether either request is still pending.

Pending question and permission requests are queried per host during Bridge startup after the per-host SSE consumers start. Permission reconciliation derives only bound directories from persisted state, calls the selected host's authenticated `GET /permission?directory=...`, and surfaces a request only when host ID, session ID, and directory all match one persisted binding. Permission requests themselves are not persisted.

Before a Discord permission button sends a reply, the Bridge queries the selected OpenCode host again and confirms the same request is still pending. A request resolved by another OpenCode client is therefore rejected as stale rather than replayed. Reconciliation failures are isolated and logged as `opencode.permission_reconcile_failed` with bounded `host_id` context only.

If persisted state references a host ID that no longer exists in the registry, startup fails rather than silently rerouting that binding to another server.

## Service/runtime lifecycle

The flake package contains only the Bridge runtime and its Node dependencies. It does not bundle, launch, or supervise OpenCode servers; each configured server remains an independent authority and lifecycle domain.

The NixOS module gives systemd ownership of Bridge process lifecycle:

- the unit waits for `network-online.target` before startup;
- abnormal Bridge exits are restarted with `Restart=on-failure`;
- stop/restart sends `SIGTERM`, which enters the Bridge's existing shutdown path;
- `StateDirectory` provides a persistent writable `/var/lib/<name>` location and the module supplies `STATE_FILE` from that location;
- a Bridge restart therefore preserves bindings without coupling OpenCode session lifetime to the Bridge process;
- stopping the Bridge does not stop, abort, migrate, or delete OpenCode server sessions.

Runtime non-secret configuration can still be supplied through `Environment=` or a systemd `EnvironmentFile`. Secrets remain an application-level dotenv file selected with `OCB_SECRETS_FILE`. The NixOS module can supply that contract either directly with legacy `secretsFile` or through systemd `LoadCredential=` with `secretsCredentialFile`. The Bridge parser itself is unchanged: it expands `~`/`~/...` when a normal path is supplied and loads the selected file before repository-local `.env`.

Configuration precedence is intentionally fixed as:

```text
process/systemd environment
  > OCB_SECRETS_FILE
  > repository .env
```

In legacy `secretsFile` mode the NixOS module places only the selected path in the service environment; Nix never reads or serializes the file content, Nix-store-backed paths are rejected, and the service user must be able to read the source directly.

In `secretsCredentialFile` mode the source must be an absolute non-store path. systemd loads it as credential `ocb-secrets.env` and exposes the private runtime copy under `%d/ocb-secrets.env`; the module sets `OCB_SECRETS_FILE` to that credential-directory path. The source may therefore remain unreadable by the Bridge service user outside systemd's credential handoff. `secretsFile` and `secretsCredentialFile` are mutually exclusive so there is exactly one file authority. Missing or unreadable credential sources prevent the unit from starting, while malformed credential content still fails in the unchanged Bridge parser without exposing secret values.

## Structured logging / observability boundary

Runtime logging is emitted through one logger contract rather than direct `console.*` calls. Every record has a stable machine-readable `event` plus timestamp, level, and human-readable message. JSON mode emits exactly one JSON object per line so journald/collector tooling can parse it without reconstructing multiline output.

Typical JSON record:

```json
{
  "timestamp": "2026-08-27T12:34:56.789Z",
  "level": "info",
  "event": "session.created",
  "message": "OpenCode session created",
  "host_id": "host-1",
  "session_id": "ses_...",
  "thread_id": "1234567890"
}
```

The stable context policy intentionally favors identifiers over payloads. `host_id`, OpenCode `session_id`, Discord `thread_id`, coarse interaction kind, OpenCode event type, retry timing, normalized `error_type`, and scalar `error_code` may be logged when useful. Arbitrary `Error.message` and stack traces are not emitted. Directory paths, Discord user/guild IDs, prompt/message text, Ask answers, attachment content, raw tool output, raw config objects, and raw Error objects are not part of the normal logging contract.

Fields whose names indicate token/password/authorization/secret/credential data are always redacted. Directory/user/guild and content-like fields are forcibly omitted even if a caller supplies them. In addition, the production logger receives the resolved Discord token, OpenCode host passwords, and derived Basic-auth credential encodings as known secret sentinels and removes those values if they become embedded in logger-authored messages or allowed scalar context. This is defense in depth; callers must still avoid sending sensitive payloads to the logger at all.

`OCB_LOG_LEVEL` controls `debug|info|warn|error`. `OCB_LOG_FORMAT` controls `json|pretty`. Manual execution defaults to `info/pretty`; the NixOS service defaults to `info/json` for journald ingestion.

## Prometheus metrics boundary

Metrics are a stricter observability surface than structured logs because every label value contributes to time-series cardinality. The metrics endpoint is therefore disabled by default. When enabled it binds to `127.0.0.1:9464` unless the operator explicitly chooses another address or port. The Bridge does not add metrics auth/TLS and the NixOS module does not open firewall ports automatically.

The initial metrics contract uses the `opencode_discord_bridge_` prefix and exposes only low-cardinality application state:

- static Bridge build/version information;
- aggregate readiness using the same HTTP-healthy plus SSE-connected semantics as `/oc health`;
- per-configured-host HTTP health and SSE connectivity;
- current persisted Discord/OpenCode binding count by host;
- process-lifetime create/close/unbind operation counters;
- per-host health-probe latency histogram;
- bounded scrape success/error counters.

Metrics labels may contain only operator-configured stable `host_id` values and fixed enumerations such as lifecycle `operation` or scrape `result`. OpenCode `session_id`, Discord `thread_id`, directory paths, Discord user/guild IDs, prompt/Ask/tool/output content, URLs, usernames, credentials, and arbitrary error strings are forbidden as metric labels or metric payload.

Each `/metrics` scrape performs the same authenticated OpenCode `/global/health` probes used by `/oc health`, in parallel, and combines those results with the same per-host SSE freshness snapshot. The health-probe primitive is side-effect configurable: Discord `/oc health` preserves `opencode.health_degraded` warning emission, while Prometheus scrapes suppress repeated degraded warnings so scrape cadence does not amplify logs.

`bound_sessions` is derived from current `StateStore` contents at scrape time rather than a process-local increment/decrement counter. It therefore reflects persisted bindings again after a Bridge restart. Lifecycle operation counters are intentionally process-lifetime counters and may reset on restart.

Metrics collection does not alter OpenCode session/execution/permission state, does not expose Node process/GC default metrics, and does not deploy Prometheus, Grafana, alert rules, OpenTelemetry collectors, or other monitoring infrastructure.

## Threat model assumptions

- The Bridge process and configured host registry are trusted operator infrastructure.
- Discord is an untrusted transport surface; user IDs, guild ID, stable host IDs, and per-host directory roots are explicit allowlists.
- Remote OpenCode servers are reachable only over a deliberately secured network/transport appropriate to the deployment. Host credentials remain required.
- A compromised Discord account in `DISCORD_ALLOWED_USER_IDS` can issue prompts and approve one-shot permissions exposed by OpenCode for any host ID made available by the operator. Therefore the Discord account, bot token, host registry, and selected secret-file path are security-critical.
- `Allow always` is disabled unless the operator explicitly opts in.
- The bridge does not copy arbitrary tool output or environment variables into permission messages or host metadata.
- The bridge does not accept arbitrary OpenCode URLs or secret-file paths from Discord and does not execute shell/tmux/PID-control operations itself.
- A metrics listener configured on a non-loopback address is an explicit operator exposure decision and must be protected by deployment-level network controls as appropriate.

## Persistence model

`STATE_FILE` is JSON with mode `0600` and schema version 1:

```json
{
  "version": 1,
  "bindings": {
    "discord-thread-id": {
      "threadId": "discord-thread-id",
      "parentChannelId": "discord-channel-id",
      "hostId": "lab",
      "sessionId": "ses_...",
      "directory": "/srv/projects/Terreate",
      "title": "Terreate",
      "createdBy": "discord-user-id",
      "createdAt": "2026-08-23T00:00:00.000Z",
      "lastPublishedAssistantMessageId": "msg_...",
      "headerMessageId": "discord-message-id"
    }
  }
}
```

Legacy schema-v1 bindings without `hostId` are migrated to the configured default host when the state file is loaded, then written back in host-aware form. The schema version remains 1 because this is an additive migration.

No token or password belongs in this file.