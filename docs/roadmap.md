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

Introduce a host registry instead of making Discord directly address arbitrary URLs. Each configured host should have a stable name, local credentials, allowed roots, and health state.

Do not expose an arbitrary host/URL parameter to Discord commands.

## Phase 4 — Durable service operation

- systemd/NixOS service for the bridge itself;
- secret injection through credentials rather than `.env` where appropriate;
- structured logging and metrics;
- state migration strategy or SQLite if concurrency/lifecycle complexity justifies it;
- reconnection reconciliation for pending permissions.

## Separate infrastructure work

`upiscium/Templates` currently has no TypeScript adapter. Do not block this bridge on that gap. After the MVP proves useful, add a reusable TypeScript/Node Agent Core adapter to Templates and adopt it here in a dedicated change.
