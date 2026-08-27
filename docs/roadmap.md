# Roadmap

## Phase 0 — Bootstrap (this repository state)

- TypeScript/Node 22 project
- Discord guild command registration
- Discord operator allowlist
- realpath-based repository root policy
- thread <-> session state store
- OpenCode SDK gateway
- tmux server/TUI helpers
- basic CI and tests

## Phase 1 — MVP validation

- Run against one real target host and one test Discord guild.
- Validate `/oc start`, normal thread prompt, Ask/reply/reject, idle Result, permission once/reject, `/oc status`, and `/oc abort` end-to-end.
- Commit the generated `package-lock.json` and switch CI from `npm install` to `npm ci`.
- Verify behavior across bridge restart while an OpenCode session remains alive.
- Add an explicit health/readiness command for operator diagnostics.

## Phase 2 — Operator UX

Status: **Complete (2026-08-22)**

- Optional buffered streaming/edit of assistant text with a conservative Discord update cadence.
- Tool-call summaries with redaction rules.
- Attachments and OpenCode file-part support.
- Session close/archive/unbind lifecycle.
- TUI attach command generation in `/oc status`.
- Thread topic/header refresh with model/agent/branch information.

## Phase 3 — Multi-host

Status: **Complete (2026-08-27, including real-environment health E2E)**

- Stable operator-configured host registry with per-host credentials and allowed roots.
- Host-aware Discord bindings keyed by `(hostId, sessionId)`.
- Per-host OpenCode gateways, SSE consumers, streaming state, and tool-summary state.
- Remote host path canonicalization and allowed-root enforcement through the selected OpenCode server.
- `/oc start host:<configured-id>` routing without arbitrary Discord-provided URLs.
- Host-aware Ask, permission, Result, status, abort, close, unbind, and managed-header routing.
- `/oc health` aggregate HTTP/SSE readiness across every configured host.
- Multi-host real-environment E2E validation for routing, permission, Ask, status, lifecycle isolation, and health fail/recovery.

Discord never accepts an arbitrary OpenCode URL, hostname, username, or credential.

## Phase 4 — Durable service operation

Status: **In progress (2026-08-27)**

- Phase 4A / Issue #34: **Complete** — reproducible Nix package plus NixOS/systemd service lifecycle, persistent state, restart/stop smoke validation.
- Phase 4B / Issue #36: **In progress** — optional dotenv-style secret file from an operator-selected path such as `~/secrets/ocb_secrets.env`, with runtime precedence `process environment > secret file > repository .env`.
- Optional systemd `LoadCredential=` copy/isolation can be added later without changing the application secret-variable contract.
- Structured logging and metrics.
- State migration strategy or SQLite if concurrency/lifecycle complexity justifies it.
- Reconnection reconciliation for pending permissions.

## Separate infrastructure work

`upiscium/Templates` currently has no TypeScript adapter. Do not block this bridge on that gap. After the MVP proves useful, add a reusable TypeScript/Node Agent Core adapter to Templates and adopt it here in a dedicated change.
