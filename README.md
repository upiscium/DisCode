# DisCode

`DisCode` is a small control plane that exposes OpenCode sessions through Discord threads without treating the terminal UI as an API. Existing compatibility identifiers remain stable: the executable is `opencode-discord-bridge`, configuration uses the `OCB_`/`OPENCODE_` environment names, and the NixOS/systemd service and module remain `opencode-discord-bridge`.

OpenCode servers are the source of truth. Local or remote OpenCode servers keep their own sessions authoritative, optional `opencode attach` clients provide TUI views, and this bridge is another API client through `@opencode-ai/sdk`.

## Behavior

- `/oc start directory:<absolute-path> [host:<configured-id>] [model:<provider/model>] [agent:<name>] [title]` creates an OpenCode session and a Discord thread.
  - Omitting `host` uses the configured default host.
  - `host` accepts only stable IDs from the operator-configured host registry; Discord cannot supply an arbitrary URL.
  - `model` and `agent` are optional autocomplete values derived from the selected host and canonical allowed directory. They are revalidated against the current OpenCode catalog when the command executes.
- `/oc model model:<provider/model>` changes the bound thread's model preference for subsequent Discord-origin prompts.
- `/oc agent agent:<name>` changes the bound thread's agent preference for subsequent Discord-origin prompts.
- Plain text posted by an authorized user in a bound thread is sent with `session.promptAsync()` to that binding's host. If an explicit model or agent preference exists, the Bridge revalidates it against the current selected-host catalog immediately before every prompt; stale selections fail closed rather than silently falling back to OpenCode defaults.
- `question.asked` events are posted as **Ask** messages. The next authorized thread message answers the pending question through the same host's OpenCode question API.
- `permission.updated` events are posted as Discord buttons.
  - `Allow once`
  - `Reject`
  - `Allow always` only when explicitly enabled by configuration.
- `session.idle` publishes the latest completed assistant **Result** to the correct host/thread binding.
- `/oc status` reports Host ID, session state, directory, latest actual model/agent from OpenCode message history, the configured Discord prompt preferences, and a credential-free attach command for the bound host.
- `/oc abort` asks the bound host's OpenCode server to abort the current turn.
- `/oc close` deletes the bound OpenCode session, removes the binding, and archives the Discord thread.
- `/oc unbind` removes only the Discord binding and leaves the OpenCode session alive.
- `/oc health` probes every configured host in parallel and reports aggregate plus per-host HTTP/SSE readiness. Host IDs are shown; URLs and credentials are not.
- Persisted JSON bindings include `hostId` plus optional model/agent prompt preferences, allowing the bridge to reconnect each Discord thread to the correct OpenCode host and preserve Discord selection preferences after restart. Legacy state-v1 bindings without `hostId` or selection fields remain backward compatible.

The persisted binding metadata is limited to routing and presentation identifiers: `threadId`, `parentChannelId`, `hostId`, `sessionId`, canonical `directory`, fallback/title text, `createdBy`, `createdAt`, optional model preference (`providerID`/`modelID`), optional agent preference, `lastPublishedAssistantMessageId`, `headerMessageId`, `todoMessageId`, and `subagentPanelMessageId`. The latter message IDs are pointers only; they do not persist panel contents. OpenCode Questions and Permissions, TODO item text/status, SubAgent metadata or tool activity, prompts/answers/attachments, catalog payloads, and Discord/OpenCode credentials are explicitly not persisted.

The managed session header deliberately separates `Latest actual model / agent` from `Discord model / agent preference`. Actual values come only from OpenCode message history. Preferences are Bridge-side instructions for the next Discord-origin prompt. Before any user message has established actual context, the header shows `(not observed yet)`; when no Discord preference is configured it shows `(OpenCode default)`.

For a multi-question Ask, reply with one line per question; for a multi-select question, separate selections with commas. A **Reject Ask** button is also provided. Pending Ask and permission requests are reconciled per host when the bridge restarts. OpenCode remains the source of truth: the Bridge re-queries each bound directory and re-surfaces only requests that are still pending for the exact host/session/directory binding.

Assistant streaming is optional and disabled by default. When `DISCORD_STREAM_ASSISTANT_TEXT=true`, each host has an isolated streaming publisher. Assistant text is buffered and coalesced to a conservative update cadence before a single Discord preview message is edited. Reasoning and successful raw tool output are not streamed. `session.idle` still re-fetches the canonical assistant result and converges the preview to the final `✅ Result`.

Tool-call summaries are also isolated per host so identical OpenCode session IDs on different hosts cannot cross-deliver preview or tool activity state.

Discord attachments can be sent to an idle bound session as OpenCode FileParts. PNG, JPEG, WebP, GIF, PDF, and bounded UTF-8 text-like files are supported. The bridge accepts at most four attachments per message, 10 MiB per attachment, and 20 MiB total. Attachment bytes are fetched only from Discord attachment CDN URLs, validated in memory, converted to data URLs, and never written to the host filesystem. Archives, executables, unsupported binary files, redirects, and invalid media signatures are rejected. A pending Ask remains text-only. Explicit model/agent preferences are applied to attachment prompts through the same execution-time revalidation path used for text prompts.

### Existing-session discovery and binding

- `/oc sessions directory:<absolute-path> [host:<configured-id>]` authorizes the directory on the selected host and then freshly lists current eligible OpenCode root sessions in that exact scope. The list is informational; it does not create a binding. It shows bounded title, session ID, status, update time, and bound/unbound state without exposing the canonical directory.
- `/oc bind directory:<absolute-path> session:<autocomplete> [host:<configured-id>]` authorizes the requested directory, reads that exact session from the selected host, and creates a new Discord thread for it. It does not create, fork, or copy the OpenCode session and cannot accept an arbitrary host URL. The autocomplete value is a selector only and is never execution authority.
- Bind eligibility is deliberately narrow: the session must be on the selected host, have the authorized canonical directory, be a root session (no parent), and be unarchived. A session already bound on that same host cannot be bound again. Host and session identity are treated as a pair, so equal IDs on different hosts are isolated.
- Binding performs a fresh pre-bind read after directory authorization and a second fresh read after Discord thread creation, before claiming the persisted binding. Observational title/model/agent changes are accepted, but deletion, movement, reparenting, archiving, host/directory/ID mismatch, an existing binding, or any failed validation aborts the bind. The post-bind initialization refreshes the managed header, TODO and SubAgent panels, actual history, and pending requests from current OpenCode APIs.
- Existing actual model/agent values are observed from current OpenCode history; they are not inferred as Bridge preferences. A newly bound existing session starts with Discord model/agent preference set to `(OpenCode default)`.
- If a pre-commit bind step fails, DisCode removes the new Discord thread and any uncommitted binding claim. Rollback never deletes the pre-existing OpenCode session. If rollback persistence itself fails, the claimed binding is retained rather than risking deletion of an existing session; the failure is reported through bounded logs.
- `/oc unbind` detaches only the Discord thread and leaves the OpenCode session alive, allowing it to be discovered and safely bound again later. `/oc close` explicitly deletes the bound OpenCode session through that host's API, removes the binding, and archives the Discord thread. Neither operation silently substitutes for the other.

`/oc unbind` does not query or depend on current OpenCode execution status. It may detach a binding while the session is busy, retrying, waiting on a Question or Permission, or temporarily unreachable. It does not abort the session, answer or reject a request, or delete the OpenCode session. Old Question and Permission controls become stale and non-authoritative after unbind; a later bind reconstructs current pending requests from OpenCode APIs in the new thread. `/oc close` remains the destructive lifecycle operation and retains its current lifecycle safety checks.

```text
existing OpenCode session
  -> /oc bind
  -> new Discord thread
  -> managed header
  -> current parent-session TODO panel
  -> read-only SubAgent panel
  -> current pending Ask/Permission recovery

/oc unbind
  -> remove Discord binding only
  -> old pending-request controls become stale
  -> OpenCode session remains discoverable for a later bind

/oc close
  -> delete the bound OpenCode session
  -> remove binding
  -> archive the Discord thread
```

`/oc sessions` and bind autocomplete use current host APIs. Session listings are always freshly discovered; the short-lived bind autocomplete cache is memory-only, scoped by exact host and canonical directory, and is discarded on restart. It is never persisted or treated as authority. Before committing a bind, DisCode rechecks the current session and uniqueness under a host/session lock.

### Read-only managed views

- `/oc todo` and the managed TODO panel show the current bound parent-session TODO state fetched from OpenCode. They do not provide a Discord-side TODO mutation API.
- `/oc subagents` lists the bound root's reachable child sessions, and `/oc subagent child:<autocomplete>` shows bounded read-only detail for one authorized child. The child selector is autocomplete-backed and exact host, directory, and root-session checks are repeated before display. These commands do not prompt, mutate, close, or rebind child sessions.
- Managed header, TODO, SubAgent, result, and redacted tool-activity messages are projections of OpenCode state. Panel message IDs may be persisted as routing metadata; Question, Permission, TODO, SubAgent, tool, prompt, attachment, and credential content is not persisted. Tool views are bounded and never include raw tool input, output, or payloads.

## Security boundary

Discord is not a remote shell in this design.

1. The bridge only accepts commands from `DISCORD_ALLOWED_USER_IDS` in one configured guild.
2. Discord can select only a stable host ID from `OPENCODE_HOSTS_JSON`; it cannot provide an arbitrary host URL, hostname, username, or password.
3. `/oc start` accepts only canonical directories contained by the selected host's configured allowed roots. For remote hosts, the bridge asks that OpenCode server for its canonical `/path` result and verifies directory accessibility through the OpenCode file API before creating a session. Symlink-resolved paths outside the allowlist are rejected.
4. Discord text becomes an OpenCode prompt. The bridge does not expose an endpoint that executes arbitrary shell commands directly.
5. OpenCode remains responsible for tool and shell permissions. Permission requests are surfaced to Discord, but the policy decision still flows through the selected OpenCode host's permission API.
6. A local OpenCode server should stay on `127.0.0.1`. Remote OpenCode hosts should be reachable only over a deliberately secured network/transport and should still use server authentication.
7. State contains only thread/session/host metadata plus non-secret model/agent prompt preferences. Discord and OpenCode credentials are never persisted in the state file.
8. Host-registry passwords are referenced with `passwordEnv`; password values are not embedded in `OPENCODE_HOSTS_JSON` or exposed through registry serialization.
9. A configured secret-file path is operator-controlled configuration. Discord cannot select or change it.
10. Structured logs use stable identifiers rather than message payloads. Prompt text, Ask answers, tool output, attachment content, directory paths, and Discord user/guild IDs are not part of the normal log context, while credential-like fields and known secret values are redacted.
11. Pending Questions and permissions are never reconstructed from Discord history or persisted as Bridge authority. Startup/bind reconciliation and permission-button handling consult current APIs on the selected OpenCode host, and stale/resolved requests are rejected instead of replayed.
12. Metrics are disabled by default and use a stricter low-cardinality policy than logs: session/thread IDs, paths, user/guild IDs, message content, URLs, usernames, and credentials are not metric labels or payload.
13. Discord cannot provide provider endpoints, provider configuration, or provider credentials. Model/agent autocomplete is populated only from the selected host's current OpenCode catalog after directory authorization, and every explicit selection is revalidated against that same host and canonical directory at command execution and again immediately before prompt execution. A stale explicit selection never falls back silently to another model or agent.

`DISCORD_ALLOW_PERMISSION_ALWAYS` defaults to `false` because a persistent approval has a materially larger blast radius than a one-turn approval.

### Phase 7 security invariants

Phase 7 security work is an invariant set, not a claim that Phase 7 is complete. Any future existing-session or managed-panel change must preserve all of the following:

1. Discord authorization remains limited to `DISCORD_ALLOWED_USER_IDS` in the configured guild; Discord receives configured host IDs, never arbitrary endpoints or credentials.
2. Discord cannot enumerate an arbitrary global session catalog: every discovery request is scoped by one configured host plus an authorized canonical directory.
3. Every requested directory is canonicalized by the selected OpenCode host (realpath semantics) and checked against that host's `OPENCODE_ALLOWED_ROOTS` before discovery, autocomplete, bind, or selection. Only the exact authorized root/project scope is used.
4. Session IDs returned by autocomplete are selectors, not authority. Existing-session discovery and binding accept root, unarchived sessions only; child/SubAgent sessions remain read-only descendants.
5. A binding is unique for `(hostId, sessionId)` and its Discord thread; equal session IDs across configured hosts never cross routes or state.
6. `/oc bind` validates fresh OpenCode state before thread creation and again afterward, claims state atomically, and compensates only newly created Discord/state artifacts. Rollback must never delete the pre-existing OpenCode session.
7. OpenCode remains authoritative for session state, actual model/agent usage, Questions, Permissions, TODOs, SubAgents, tools, and execution policy. DisCode projections and preferences cannot become alternate authority.
8. Pending Question and Permission recovery queries the selected host's current APIs after startup or bind, matches exact host/session/directory identity, and rejects stale or already-resolved requests. Discord history is never recovery authority.
9. Managed TODO and SubAgent surfaces are read-only, child inspection is constrained to the bound root, and tool activity is bounded and redacted. Existing-session transcript/message content and raw tool input/output are not copied into Bridge state.
10. Persistent permission approval (`always`) remains opt-in. Credentials, raw Question/Permission/TODO/SubAgent/tool content, prompt or attachment content, and raw provider/catalog data remain non-persisted and absent from normal logs/metrics.
11. Discovery and autocomplete caches are memory-only, bounded, exact-scope data and are never restored as authority after restart. Fresh API validation is required before any binding or execution decision.

## Host layout

```text
                         +--> OpenCode host: local
Discord thread A --+     |      session A
                   |     |
                    +--> DisCode
                   |     |
Discord thread B --+     +--> OpenCode host: lab
                                session B

Each configured host:
  - has its own authenticated OpenCode gateway
  - has its own global SSE consumer/readiness monitor
  - has isolated assistant-stream/tool-summary state
  - applies its own allowed-root policy
  - supplies its own model/agent catalog for Discord selection

Optional TUI clients attach directly to the same OpenCode session on the
appropriate host. The Bridge never uses tmux send-keys or terminal scraping.
```

## Requirements

- Node.js 22+
- OpenCode on each configured target host (the bridge SDK is pinned to 1.18.20 with compatibility handling for newer server APIs used by the project)
- tmux only where the provided local helper scripts are used
- A dedicated Discord bot application
- Discord bot scopes/permissions needed to use the configured text channel, create public threads, send messages, add reactions, and use application commands
- The Discord **Message Content Intent** enabled, because ordinary thread messages are used as prompts
- Network reachability from the Bridge process to every configured OpenCode host

A Nix development shell is included:

```bash
nix develop
```

The Bridge runtime is also exposed as a reproducible flake package:

```bash
nix build
./result/bin/opencode-discord-bridge
```

OpenCode itself is intentionally not pinned or bundled by the Bridge package; each host's existing OpenCode installation/configuration remains authoritative.

## Bootstrap

### 1. Create the Discord application

Create a dedicated bot application in the Discord Developer Portal. Enable **Message Content Intent** and install the bot into the target guild with application commands plus the channel/thread permissions described above.

Copy `.env.example` to `.env` for ordinary configuration. Secrets may stay in `.env` for backward compatibility, but a separate `OCB_SECRETS_FILE` is preferred for service operation. Keep both `.env` and the secret file out of git.

### 2. Configure the OpenCode boundary

The legacy single-host form remains supported and is the fallback when `OPENCODE_HOSTS_JSON` is unset:

```dotenv
OPENCODE_ALLOWED_ROOTS=/home/upiscium/Documents/Programs
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<long-random-password>
DISCORD_STREAM_ASSISTANT_TEXT=false
```

With legacy configuration, the runtime host ID is `default`, preserving the previous single-host behavior.

For multi-host operation, configure a registry. The registry contains no password values: each host uses `passwordEnv` to reference a separate environment variable.

```dotenv
OPENCODE_HOST_LOCAL_PASSWORD=<local-password>
OPENCODE_HOST_LAB_PASSWORD=<lab-password>
OPENCODE_HOSTS_JSON={"defaultHost":"local","hosts":[{"id":"local","baseUrl":"http://127.0.0.1:4096","username":"opencode","passwordEnv":"OPENCODE_HOST_LOCAL_PASSWORD","allowedRoots":["/home/upiscium/Documents/Programs"]},{"id":"lab","baseUrl":"http://10.0.0.20:4096","username":"opencode","passwordEnv":"OPENCODE_HOST_LAB_PASSWORD","allowedRoots":["/srv/projects"]}]}
```

Host IDs are lowercase stable tokens. Duplicate IDs, unknown default hosts, non-HTTP(S) URLs, URL userinfo, empty root lists, missing password environment variables, and unknown JSON fields are rejected at startup.

Every configured host receives an independent gateway and SSE consumer. A persisted binding referencing a host that is no longer configured causes startup to fail rather than silently rerouting the session.

`/oc health` performs authenticated `/global/health` probes for all configured hosts concurrently and combines them with each host's SSE freshness. The bridge is reported `ready` only when every host is HTTP-healthy and SSE-connected; otherwise the aggregate is `degraded` while healthy hosts remain visible individually.

Set `DISCORD_STREAM_ASSISTANT_TEXT=true` only when buffered progress previews are desired. The default `false` keeps final-only behavior.

### Secret file

Set `OCB_SECRETS_FILE` in the real process/systemd environment to load a separate dotenv-style secret file. It may live at any normal filesystem path, including a path under the runtime user's home:

```bash
export OCB_SECRETS_FILE=~/secrets/ocb_secrets.env
```

Example `~/secrets/ocb_secrets.env`:

```dotenv
DISCORD_TOKEN=<discord-bot-token>
OPENCODE_HOST_LOCAL_PASSWORD=<local-password>
OPENCODE_HOST_LAB_PASSWORD=<lab-password>
```

Legacy single-host operation can place `OPENCODE_SERVER_PASSWORD` there instead. `~/...` is expanded against the user running the Bridge; absolute paths such as `/run/secrets/opencode-discord-bridge.env` and relative paths are also supported. The selected file must be readable by that runtime user.

Startup precedence is fixed as:

```text
process/systemd environment
  > OCB_SECRETS_FILE
  > repository-local .env
```

A configured secret file that is missing, unreadable, or malformed makes startup fail closed. Error messages contain the file path/line where useful, but not the secret values.

### Logging

Runtime logging supports two formats and four severity thresholds:

```dotenv
OCB_LOG_LEVEL=info
OCB_LOG_FORMAT=pretty
```

`OCB_LOG_LEVEL` accepts `debug`, `info`, `warn`, or `error`. `OCB_LOG_FORMAT` accepts `json` or `pretty`. Manual execution defaults to `info/pretty`; the NixOS module defaults to `info/json` for journald-friendly service operation. Invalid values fail closed during configuration loading.

JSON mode emits exactly one record per line. Example:

```json
{"timestamp":"2026-08-27T12:34:56.789Z","level":"info","event":"session.created","message":"OpenCode session created","host_id":"host-1","session_id":"ses_...","thread_id":"1234567890"}
```

Stable lifecycle/failure event names include `bridge.starting`, `bridge.started`, `bridge.stopping`, `bridge.stopped`, `discord.connected`, `discord.interaction_failed`, `discord.message_failed`, `opencode.consumer_failed`, `opencode.observer_failed`, `opencode.stream_disconnected`, `opencode.health_degraded`, `session.created`, `session.closed`, `session.unbound`, and `session.rollback_failed`.

Log context is intentionally narrow. Host/session/thread IDs and coarse event/failure metadata are allowed; prompt/message text, Ask answers, raw tool output, attachment content, directory paths, Discord user/guild IDs, raw config objects, and raw Error stacks are not part of the normal logging contract. Credential-like fields are forcibly redacted, and the resolved Discord/OpenCode secrets are also used as value sentinels so accidental string inclusion is replaced with `[REDACTED]`.

When systemd is using JSON mode, individual events can be filtered from the raw message stream, for example:

```bash
journalctl -u opencode-discord-bridge -o cat \
  | jq 'select(.event == "session.created")'
```

### Metrics

The Prometheus/OpenMetrics scrape endpoint is explicitly opt-in and disabled by default:

```dotenv
OCB_METRICS_ENABLED=false
OCB_METRICS_HOST=127.0.0.1
OCB_METRICS_PORT=9464
```

When enabled, the Bridge exposes only `GET /metrics`. The default listener is loopback-only. If an enabled listener cannot bind, startup fails closed before Discord login. Shutdown closes the listener. The application does not provide metrics auth/TLS and the NixOS module does not open firewall ports; exposing a non-loopback address is an explicit deployment decision that must be protected externally.

A local scrape can be inspected with:

```bash
curl --fail --silent http://127.0.0.1:9464/metrics
```

The initial metric family uses the `opencode_discord_bridge_` prefix and includes:

```text
opencode_discord_bridge_info{version="..."} 1
opencode_discord_bridge_ready 0|1
opencode_discord_bridge_opencode_host_http_healthy{host_id="..."} 0|1
opencode_discord_bridge_opencode_host_sse_connected{host_id="..."} 0|1
opencode_discord_bridge_bound_sessions{host_id="..."} N
opencode_discord_bridge_session_operations_total{host_id="...",operation="created|closed|unbound"} N
opencode_discord_bridge_health_probe_duration_seconds{host_id="..."} histogram
opencode_discord_bridge_metrics_scrapes_total{result="success|error"} N
```

`ready` uses exactly the same semantics as `/oc health`: every configured host must be HTTP healthy and SSE connected. Each scrape performs the authenticated host health probes in parallel. Metrics scrapes suppress repeated `opencode.health_degraded` warning emission so normal Prometheus polling does not amplify logs.

Metrics cardinality is intentionally stricter than structured logging. Only configured stable `host_id` values and fixed `operation`/`result` enums are labels. Session IDs, thread IDs, directory paths, Discord user/guild IDs, prompt/Ask/tool/output content, URLs, usernames, credentials, and arbitrary errors are not exported. `bound_sessions` is calculated from persisted StateStore contents at scrape time; lifecycle operation counters are process-lifetime counters and may reset after restart.

### 3. Start a local OpenCode server with the helper (optional)

For the Bridge machine's local OpenCode server:

```bash
set -a
source .env
set +a
./scripts/start-opencode-tmux.sh
```

The helper uses a separate tmux socket/server by default:

```bash
tmux -L opencode-bridge attach -t opencode
```

The helper manages only the local OpenCode server. The Discord bridge does not remotely start, stop, or control tmux sessions on configured remote hosts.

### 4. Install and start the bridge

Dependencies are locked in `package-lock.json`, so use the reproducible install path:

```bash
npm ci
npm run check
npm run build
npm start
```

`src/index.ts` loads the optional `OCB_SECRETS_FILE` first and then repository-local `.env`. Existing process environment values retain highest precedence.

### 5. Create Discord/OpenCode sessions

Use the default host and OpenCode defaults:

```text
/oc start directory:/home/upiscium/Documents/Programs/Terreate title:Terreate
```

Or explicitly select a configured host plus a model/agent offered by autocomplete:

```text
/oc start directory:/srv/projects/Terreate host:lab model:openrouter/anthropic/claude-sonnet-4.6 agent:build title:Terreate-lab
```

The model value is canonical `providerID/modelID`; only the first `/` separates provider ID from model ID, so model IDs may themselves contain `/`. Autocomplete is advisory rather than authority: the selected model/agent is revalidated against the current selected-host catalog when `/oc start` executes.

After a thread is bound, change preferences with:

```text
/oc model model:openrouter/openai/gpt-5.6
/oc agent agent:review
```

These commands do not mutate an already-running OpenCode turn. They persist the next-Discord-prompt preference and refresh the managed header. Each subsequent Discord-origin prompt revalidates the stored preference immediately before it is sent. If the selected model/agent has disappeared from the host catalog, the prompt is rejected instead of falling back silently.

The bot creates a thread bound to `(hostId, sessionId)`. From then on, prompts, attachments, Ask/permission replies, lifecycle commands, Results, selection preferences, and managed-header updates are routed only to that host.

## NixOS service operation

The flake exports `nixosModules.default` and `nixosModules.opencode-discord-bridge`. A deployment flake can import the module and run the Bridge as a durable systemd service. For example, to let systemd copy a root/operator-owned dotenv secret into the service credential directory while explicitly enabling loopback metrics:

```nix
{
  inputs.opencode-discord-bridge.url = "github:upiscium/OpencodeDiscordBridge";

  outputs = { nixpkgs, opencode-discord-bridge, ... }: {
    nixosConfigurations.bridge-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        opencode-discord-bridge.nixosModules.default
        {
          services.opencode-discord-bridge = {
            enable = true;
            user = "upiscium";
            group = "users";
            createUser = false;
            secretsCredentialFile = "/run/secrets/opencode-discord-bridge.env";
            environmentFile = "/run/opencode-discord-bridge.env";
            logLevel = "info";
            logFormat = "json";
            metrics = {
              enable = true;
              address = "127.0.0.1";
              port = 9464;
            };
            stateDirectory = "opencode-discord-bridge";
          };
        }
      ];
    };
  };
}
```

`secretsCredentialFile` is an absolute source path used only by systemd `LoadCredential=`. Nix never reads the source content and rejects sources already inside the Nix store. systemd exposes the runtime copy as `ocb-secrets.env` inside its private credential directory, while the module sets `OCB_SECRETS_FILE=%d/ocb-secrets.env`. The Bridge therefore keeps the same application-level secret-file contract without requiring the service user to have direct read permission on the source file.

Legacy `secretsFile` remains supported and backward compatible. It passes the selected path directly as `OCB_SECRETS_FILE`, so that file must remain readable by the configured service user; `~/...` is expanded by the Bridge at runtime. `secretsFile` and `secretsCredentialFile` are mutually exclusive and conflicting configuration fails during Nix evaluation.

`environmentFile` and `environment` remain available for non-secret or legacy configuration. `STATE_FILE` is controlled by the module and placed under `/var/lib/<stateDirectory>/<stateFile>`. The module rejects store-backed `environmentFile`, `secretsFile`, and `secretsCredentialFile` paths. The credential source path is visible in systemd unit metadata, so operators should not encode secret values into filenames.

The NixOS module defaults to `logLevel = "info"`, `logFormat = "json"`, and `metrics.enable = false`. If metrics are enabled, their defaults remain `address = "127.0.0.1"` and `port = 9464`; the module does not add the port to `networking.firewall.allowedTCPPorts`.

By default the module creates an `opencode-discord-bridge` system user/group, starts after `network-online.target`, uses systemd `StateDirectory` for persistent writable state, restarts on abnormal exit, and stops the process with `SIGTERM`. Restarting or stopping this service does not start, stop, migrate, or delete any OpenCode server/session. `LoadCredential=` is optional deployment hardening; agenix or sops-nix may provide the source path without becoming Bridge dependencies.

## Opening the same session in TUI

`/oc status` shows the bound Host ID, latest actual model/agent observed in OpenCode message history, the Discord prompt preferences, and a credential-free `opencode attach` command using that host's configured base URL, session ID, and directory. Authentication is still supplied by the operator environment; credentials are never printed into Discord.

For the local helper-managed host, you can also use:

```bash
./scripts/open-tui-window.sh \
  /home/upiscium/Documents/Programs/Terreate \
  ses_xxxxxxxxx

tmux -L opencode-bridge attach -t opencode
```

This opens the same OpenCode session Discord is controlling, not a second session. A model/agent change made by another OpenCode client is therefore visible as actual history without rewriting the Bridge's separate Discord preference.

## Development gates

```bash
npm run lint
npm run typecheck
npm test
npm run check
nix build
nix flake check
```

CI uses `npm ci` and the committed lockfile before running the Node quality gate, and separately builds/checks the Nix package and module.

See `docs/architecture.md`, `docs/adr/0001-opencode-server-as-source-of-truth.md`, and `docs/roadmap.md` for the design boundary and next stages.
