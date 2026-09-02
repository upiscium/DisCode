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

Status: **Complete (2026-08-28)**

- Phase 4A / Issue #34: **Complete** — reproducible Nix package plus NixOS/systemd service lifecycle, persistent state, restart/stop smoke validation.
- Phase 4B / Issue #36: **Complete** — optional dotenv-style secret file from an operator-selected path such as `~/secrets/ocb_secrets.env`, with runtime precedence `process environment > secret file > repository .env` and real-environment fail-closed/leakage validation.
- Phase 4C / Issue #38: **Complete** — structured JSON logging foundation with stable event names, host/session/thread context, log-level filtering, explicit privacy/redaction boundaries, and Adam real-environment smoke validation.
- Phase 4D / Issue #40: **Complete** — opt-in low-cardinality Prometheus/OpenMetrics scrape endpoint with loopback-only default exposure, host health/readiness gauges, persisted binding gauges, bounded lifecycle counters, and explicit metrics cardinality/privacy boundaries.
- Phase 4E / Issue #42: **Complete (2026-08-28)** — OpenCode-source-of-truth pending permission recovery after Bridge restart, with exact host/session/directory isolation, race-safe SSE/reconcile publication, stale-button rejection, bounded failure logging, and Adam/Eve real-environment validation.
- Phase 4F / Issue #45: **Complete (2026-08-28)** — optional systemd `LoadCredential=` secret delivery preserving the application-level `OCB_SECRETS_FILE` contract, with service-user source isolation, credential-copy use, missing-source fail-closed behavior, legacy `secretsFile` compatibility, and Adam real-environment validation.

Phase 4D does not deploy Prometheus, Grafana, alerting, OpenTelemetry collectors, or firewall rules. Those remain deployment/infrastructure concerns outside the Bridge application.

## Phase 5 — Runtime selection UX

Status: **Complete (2026-08-28)**

- Phase 5A / Issue #48: **Complete (2026-08-28)** — host/directory-scoped OpenCode model and agent autocomplete, optional `/oc start` selection, bound-thread `/oc model` and `/oc agent` preferences, execution-time catalog revalidation, stale-selection fail-closed behavior, restart-persistent binding preferences, text/attachment propagation, and explicit separation of OpenCode-history actual values from Bridge-side Discord preferences in the managed header and `/oc status`.
- OpenCode remains the selection/execution authority: Discord never supplies provider URLs, provider configuration, or credentials, and an explicit stale selection never silently falls back to another model or agent.
- Adam/Eve real-environment acceptance covered deploy/health, host-scoped autocomplete, explicit model execution, bound-thread model/agent changes, restart recovery, stale persisted-selection rejection, host failure isolation, and Discord/journal/metrics leakage checks.

Model variants / reasoning-effort selection remain a possible Phase 5B only if there is a demonstrated operator need; they are not part of Phase 5A.

## Phase 6 — Session introspection

Status: **Complete (2026-08-31)**

### Phase 6A / Issue #52 — Parent-session TODO introspection

- OpenCode TODO API responses and `todo.updated` events remain the source of truth.
- `/oc todo` refreshes a managed one-message TODO panel for the exact bound parent session.
- Startup, reconnect, and event reconciliation preserve exact host/session/directory isolation.
- TODO content is never persisted; state stores only the managed Discord message ID.
- Discord unknown-message error `10008` is recovered by recreating the managed panel, while lifecycle serialization prevents panel publication from racing close/unbind.

### Phase 6B / Issue #53 — Read-only SubAgent introspection

- `/oc subagents` lists descendants and `/oc subagent child:<autocomplete>` selects bounded read-only detail.
- Descendant authority is rooted at the exact bound parent session and canonical host/directory; child sessions never receive direct Discord bindings.
- Child transcript, tool activity, and TODO state are bounded projections, with a managed SubAgent panel reconciled on startup, reconnect, and relevant events.
- A reachable session missing from the OpenCode status map is treated as `idle`.
- Child transcript/tool payloads are not persisted or logged, and canonical Session/Parent identifiers retain their exact punctuation in Discord.
- Nested depth greater than one was **N/A** in real-environment smoke under the tested OpenCode configuration because the default `subagent_depth`/task permission prevented child delegation. Recursive graph authority remains covered by automated tests; this was not a DisCode failure.

## Phase 7 — Session discovery and reattachment

### Phase 7A / Issue #56 — Existing root-session discovery and bind

Status: **Complete (2026-09-02)**

- `/oc sessions` performs fresh discovery for the exact configured host and canonical allowed directory; `/oc bind` creates a new Discord thread for an existing eligible root session.
- Authority is `configured host -> canonical allowed directory -> current OpenCode root session -> fresh execution-time validation -> Discord thread -> post-I/O OpenCode validation -> guarded unique binding claim`.
- Archived sessions are excluded, and child/SubAgent sessions remain read-only descendants that cannot be bound directly.
- One `(hostId, sessionId)` cannot fan out to multiple Discord threads; identical session IDs on different configured hosts remain isolated.
- Autocomplete is UX only. Its short-lived cache is bounded and memory-only, `/oc sessions` never uses it, and bind execution always performs fresh exact-session reads before and after thread creation.
- The guarded StateStore claim and independent bind/lifecycle serializers prevent concurrent duplicate binding and serialize bind initialization with close/unbind.
- Failed bind compensation removes only newly created Discord/state artifacts and never deletes the pre-existing OpenCode session.
- Existing actual model/agent values are observed from OpenCode history; no Bridge prompt preference is inferred, so initial Discord preferences remain OpenCode default.
- Managed header, TODO, and SubAgent state are reconstructed after claim. Current pending Ask/Permission state is then recovered from exact OpenCode APIs, with live-SSE/reconciliation publication deduplication.
- `/oc unbind` leaves the OpenCode session alive and clears transient publication coordination so a later discovery and rebind can safely surface still-pending requests.

#### Real-environment acceptance

Adam/Eve smoke verified fresh `/oc sessions` discovery; exact canonical Session ID rendering; existing root-session `/oc bind` without new OpenCode session creation; managed header, TODO, and SubAgent reconstruction; bound-state transition and duplicate-bind rejection; `unbind -> rediscover -> rebind`; restart persistence without old-thread managed-panel resurrection; same-directory host isolation; pending Ask and Permission recovery after unbind/rebind; old-thread Ask controls becoming non-authoritative; Ask response from the newly bound thread; and pure `/oc unbind` while OpenCode was active or pending.

The initial real-environment smoke exposed a lifecycle defect: `/oc unbind` shared `/oc close`'s busy/pending lifecycle gate, preventing reattachment testing while an OpenCode request remained pending. The final policy separates the operations:

- `/oc unbind` is a Discord-owned binding detach only, independent of OpenCode busy, retry, Question, Permission, or unreachable state.
- `/oc close` is destructive OpenCode session deletion and retains execution/pending lifecycle blockers.

## Future considerations

The current atomic JSON state store remains the supported persistence model. A schema migration framework or SQLite should be introduced only if observed concurrency, lifecycle, query, or migration complexity makes the additional storage layer materially useful; it is not unfinished Phase 7 work.

OpenCode-specific operational limitations are tracked separately as upstream dependencies rather than extending Bridge implementation phases indefinitely. In particular, `/oc abort` hard-kill behavior and long-running `opencode serve` degradation remain tracked in Issues #5 and #44.

## Separate infrastructure work

`upiscium/Templates` currently has no TypeScript adapter. Do not block this bridge on that gap. After the MVP proves useful, add a reusable TypeScript/Node Agent Core adapter to Templates and adopt it here in a dedicated change.
