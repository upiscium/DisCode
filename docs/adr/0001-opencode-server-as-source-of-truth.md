# ADR 0001: Treat OpenCode Server as the source of truth

Status: Accepted

## Context

The bridge must let an operator work on the same OpenCode session both through Discord and through an SSH/tmux TUI. A naive implementation can drive the TUI with `tmux send-keys` and scrape terminal output, but that couples correctness to terminal state, ANSI rendering, dialogs, key bindings, and timing.

OpenCode already exposes the session, message, event, abort, and permission operations needed by the bridge through its server and TypeScript SDK.

## Decision

Run `opencode serve` as the authoritative process. Connect both `opencode attach` and `OpenCodeDiscordBridge` as clients of that server.

Use tmux only for server/TUI process persistence. Never use terminal scraping or synthetic keystrokes as the bridge protocol.

## Consequences

Positive:

- Discord and TUI observe the same session.
- Permission semantics stay owned by OpenCode.
- Restart/reconnect can be expressed in terms of stable session IDs.
- Terminal rendering changes do not break the bridge.
- Multi-session and later multi-host support have a clean extension point.

Negative:

- The bridge depends on OpenCode's server/SDK API compatibility.
- SDK updates require an explicit compatibility check.
- The bridge needs its own Discord/session mapping persistence.

## Rejected alternative

`tmux capture-pane` + `tmux send-keys` was rejected because terminal UI is presentation state, not a stable machine interface.
