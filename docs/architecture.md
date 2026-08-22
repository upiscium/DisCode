# Architecture

## Responsibility split

### OpenCode Server

Authoritative owner of OpenCode sessions, model/tool execution, session state, messages, and permission requests. The bridge must not reimplement these semantics.

### tmux

Process and interactive-terminal persistence only. It keeps `opencode serve` alive and may host `opencode attach` windows for SSH operators. It is not used as a transport protocol.

### OpenCodeDiscordBridge

A narrow adapter between Discord and OpenCode:

- authenticates/authorizes Discord operators;
- maps a Discord thread to an OpenCode session;
- validates repository directory scope;
- forwards thread text as OpenCode prompts;
- projects OpenCode permissions/results/errors into Discord;
- persists only the mapping required to reconnect after restart.

### OpenCode policy/configuration

Remains the execution-policy authority. A Discord authorization grants the human access to the bridge, not blanket authority to bypass OpenCode tool policies.

## Primary flow

```text
/oc start
  -> validate Discord user/guild
  -> realpath(directory)
  -> verify directory within OPENCODE_ALLOWED_ROOTS
  -> OpenCode session.create
  -> Discord thread.create
  -> persist thread/session binding

Discord thread message
  -> validate author
  -> find binding
  -> reject attachments in MVP
  -> reject overlapping turn while session is busy/retrying
  -> OpenCode session.promptAsync

OpenCode global SSE
  -> question.asked    -> Discord Ask -> next authorized thread message -> question.reply
  -> permission.updated -> Discord permission buttons
  -> session.idle       -> read latest assistant message -> Result
  -> session.error      -> Discord error
```

## Failure semantics

Creating a session is a two-system operation. If Discord thread creation or binding persistence fails after the OpenCode session was created, the bridge attempts compensation by deleting the new thread and OpenCode session.

For normal operation, the state file is updated atomically by writing a temporary file and renaming it into place.

An OpenCode event-stream disconnect is recoverable. The gateway reconnects with bounded exponential backoff. Result publication is idempotent at the bridge level using `lastPublishedAssistantMessageId` in persisted state.

Permission messages are de-duplicated in memory by permission ID while the process is alive. OpenCode remains the source of truth for whether a permission is still pending.

Pending question requests are queried from OpenCode during bridge startup so an Ask that survived a bridge restart can be surfaced again.

## Threat model assumptions

- The bridge and OpenCode server run on the same trusted host for the MVP.
- OpenCode binds to loopback.
- Discord is an untrusted transport surface; user IDs, guild ID, and directory roots are explicit allowlists.
- A compromised Discord account in `DISCORD_ALLOWED_USER_IDS` can issue prompts and approve one-shot permissions exposed by OpenCode. Therefore the Discord account and bot token are security-critical credentials.
- `Allow always` is disabled unless the operator explicitly opts in.
- The bridge does not copy arbitrary tool output or environment variables into permission messages.

## Persistence model

`STATE_FILE` is JSON with mode `0600` and schema version 1:

```json
{
  "version": 1,
  "bindings": {
    "discord-thread-id": {
      "threadId": "discord-thread-id",
      "parentChannelId": "discord-channel-id",
      "sessionId": "ses_...",
      "directory": "/real/repository/path",
      "title": "Terreate",
      "createdBy": "discord-user-id",
      "createdAt": "2026-08-22T00:00:00.000Z",
      "lastPublishedAssistantMessageId": "msg_..."
    }
  }
}
```

No token or password belongs in this file.
