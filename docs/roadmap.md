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

Status: **In progress (2026-08-28)**

- Phase 4A / Issue #34: **Complete** — reproducible Nix package plus NixOS/systemd service lifecycle, persistent state, restart/stop smoke validation.
- Phase 4B / Issue #36: **Complete** — optional dotenv-style secret file from an operator-selected path such as `~/secrets/ocb_secrets.env`, with runtime precedence `process environment > secret file > repository .env` and real-environment fail-closed/leakage validation.
- Phase 4C / Issue #38: **Complete** — structured JSON logging foundation with stable event names, host/session/thread context, log-level filtering, explicit privacy/redaction boundaries, and Adam real-environment smoke validation.
- Phase 4D / Issue #40: **Complete** — opt-in low-cardinality Prometheus/OpenMetrics scrape endpoint with loopback-only default exposure, host health/readiness gauges, persisted binding gauges, bounded lifecycle counters, and explicit metrics cardinality/privacy boundaries.
- Phase 4E / Issue #42: **Complete (2026-08-28)** — OpenCode-source-of-truth pending permission recovery after Bridge restart, with exact host/session/directory isolation, race-safe SSE/reconcile publication, stale-button rejection, bounded failure logging, and Adam/Eve real-environment validation.
- Phase 4F / Issue #45: **Complete (2026-08-28)** — optional systemd `LoadCredential=` secret delivery preserving the application-level `OCB_SECRETS_FILE` contract, with service-user source isolation, credential-copy use, missing-source fail-closed behavior, legacy `secretsFile` compatibility, and Adam real-environment validation.
- State migration strategy or SQLite if concurrency/lifecycle complexity justifies it.

Phase 4D does not deploy Prometheus, Grafana, alerting, OpenTelemetry collectors, or firewall rules. Those remain deployment/infrastructure concerns outside the Bridge application.

## Separate infrastructure work

`upiscium/Templates` currently has no TypeScript adapter. Do not block this bridge on that gap. After the MVP proves useful, add a reusable TypeScript/Node Agent Core adapter to Templates and adopt it here in a dedicated change.
