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
  -> permission.updated -> matching host/session binding -> Discord buttons
  -> session.idle       -> matching host/session binding -> canonical Result
  -> session.error      -> matching host/session binding -> Discord error
```

All session lookup used for event delivery is keyed by `(hostId, sessionId)`. Identical session IDs on two independent OpenCode hosts are therefore not interchangeable.

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

Permission messages are de-duplicated in memory by `(hostId, permission ID)`. Pending question state is keyed by `(hostId, sessionId)`. OpenCode remains the source of truth for whether either request is still pending.

Pending question requests are queried per host during bridge startup so an Ask that survived a bridge restart can be surfaced again.

If persisted state references a host ID that no longer exists in the registry, startup fails rather than silently rerouting that binding to another server.

## Threat model assumptions

- The Bridge process and configured host registry are trusted operator infrastructure.
- Discord is an untrusted transport surface; user IDs, guild ID, stable host IDs, and per-host directory roots are explicit allowlists.
- Remote OpenCode servers are reachable only over a deliberately secured network/transport appropriate to the deployment. Host credentials remain required.
- A compromised Discord account in `DISCORD_ALLOWED_USER_IDS` can issue prompts and approve one-shot permissions exposed by OpenCode for any host ID made available by the operator. Therefore the Discord account, bot token, and host registry are security-critical.
- `Allow always` is disabled unless the operator explicitly opts in.
- The bridge does not copy arbitrary tool output or environment variables into permission messages or host metadata.
- The bridge does not accept arbitrary OpenCode URLs from Discord and does not execute shell/tmux/PID-control operations itself.

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
