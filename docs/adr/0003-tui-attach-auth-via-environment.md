# ADR 0003: Pass OpenCode attach credentials via environment

Status: Accepted

## Context

`scripts/open-tui-window.sh` previously expanded `OPENCODE_SERVER_PASSWORD` into `opencode attach --password ...`. That places the secret in the process argument vector and in the tmux window command string, where it can be observed through process inspection or tmux metadata/history.

OpenCode 1.18.20 and current OpenCode both support omitting `--password` and `--username`; `attach` then resolves Basic Auth from `OPENCODE_SERVER_PASSWORD` and `OPENCODE_SERVER_USERNAME` in the inherited environment.

## Decision

The helper must never place OpenCode credentials in attach CLI arguments. It launches `opencode attach` with only the URL, session ID, and directory, and relies on the environment already inherited by the dedicated tmux server/window.

## Consequences

- OpenCode credentials are not exposed through the attach process argv or tmux window command.
- The caller must continue to start the dedicated tmux server from an environment containing the same `OPENCODE_SERVER_*` variables as the bridge.
- The default username remains `opencode` through OpenCode's own environment fallback.
