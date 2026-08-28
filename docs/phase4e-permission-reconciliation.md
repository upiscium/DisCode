# Phase 4E — Pending permission reconciliation

OpenCode remains the source of truth for pending permission requests. The Bridge does not persist permission requests in its state file.

At startup, after the per-host global SSE consumers are started, the Bridge derives each configured host's unique bound directories from persisted bindings and requests the pending permission list from that OpenCode server. A request is surfaced to Discord only when the queried host, request session ID, and queried directory all match one persisted binding.

Live SSE publication and startup reconciliation share one race-safe publication tracker keyed by `(host_id, permission_id)`. A permission is reserved before the Discord send crosses an await boundary. Successful publication remains reserved until OpenCode reports the permission replied; failed Discord publication rolls the reservation back so a later attempt can retry.

Permission buttons are also checked against the current OpenCode pending-permission list immediately before replying. A request resolved by another OpenCode client is therefore treated as stale rather than replayed from Discord.

Reconciliation failures are isolated per host/directory. Structured warning `opencode.permission_reconcile_failed` includes only `host_id`; directory paths, raw permission payloads, tool metadata, and credentials are not logging context.

The existing permission-policy boundary is unchanged: `Allow always` remains unavailable unless the operator explicitly enables it.
