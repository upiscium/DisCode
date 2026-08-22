# ADR 0004: Define operator health and readiness

Status: Accepted

## Context

The bridge needs an operator-facing diagnostic that distinguishes a reachable OpenCode HTTP API from a bridge that can actually receive OpenCode events. Treating `/global/health` alone as readiness would report healthy while the global SSE path is stale or disconnected.

OpenCode 1.18.20 and current OpenCode emit `server.connected` immediately on the global SSE stream and a `server.heartbeat` every 10 seconds.

## Decision

`/oc health` reports two independent signals:

- OpenCode HTTP health from authenticated `GET /global/health`;
- global SSE freshness observed by the bridge event consumer.

The bridge is `ready` only when OpenCode HTTP reports `healthy: true` and at least one global SSE event has been observed within the last 25 seconds. Otherwise it reports `degraded`.

The command is available to authorized users anywhere in the configured guild; it does not require a thread/session binding.

HTTP/auth/network failures are returned as diagnostic states instead of escaping as generic Discord interaction errors. Credentials, Authorization headers, and server passwords are never included in the rendered diagnostic.

## Consequences

- HTTP availability and event-delivery readiness are visible separately.
- A dead SSE connection becomes degraded after the heartbeat freshness window rather than at the exact socket-disconnect instant.
- The 25-second threshold tolerates normal heartbeat scheduling jitter while detecting loss after roughly two missed 10-second heartbeats.
- This is operator readiness, not a security or isolation guarantee.
