# ADR 0002: Normalize OpenCode permission protocol drift at the gateway

Status: Accepted

## Context

The bridge pins `@opencode-ai/sdk` 1.18.20, whose generated root event type uses `permission.updated` and the legacy session-scoped permission reply endpoint. Current OpenCode servers emit `permission.asked` with a different request shape and expose `POST /permission/:requestID/reply` with `{ "reply": ... }`.

Session, question, and event-stream interoperability can therefore succeed while a tool permission silently blocks the turn if the bridge only understands the pinned SDK's legacy permission event.

## Decision

Keep the pinned SDK for the stable session/event client surface, but normalize current permission events inside `OpenCodeGateway` before they reach `Bridge`:

- `permission.asked` -> the legacy bridge-internal `permission.updated` shape;
- current `permission.replied` -> the legacy bridge-internal replied shape.

When replying, try the current `/permission/:requestID/reply` API first and fall back to the pinned SDK's legacy session-scoped endpoint only when the current route returns 404.

## Consequences

- Bridge permission UI remains independent of OpenCode protocol-version details.
- Current and 1.18.20-era servers can both be supported without weakening permission policy.
- A future SDK upgrade can remove this compatibility shim after explicit E2E verification.
- Pending permission reconciliation after a bridge restart remains a separate hardening task; this change fixes live permission delivery and reply compatibility.
