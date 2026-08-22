# ADR 0005: Buffer assistant text before Discord streaming

Status: Accepted

## Context

Phase 1 intentionally published assistant output only when OpenCode emitted `session.idle`. This made the final-result path simple and restart-safe, but long turns gave Discord users no textual progress until completion.

OpenCode 1.18.20 and current OpenCode use the same legacy event contract for streaming message parts:

- `message.updated` identifies the message and its role;
- `message.part.updated` identifies the part type and carries the current part snapshot;
- `message.part.delta` carries `{ sessionID, messageID, partID, field, delta }`;
- text and reasoning deltas both use `field: "text"`.

A text part is created with an empty `message.part.updated`, receives many `message.part.delta` events, and receives a completed `message.part.updated` snapshot at text end. Applying each delta directly to Discord would create excessive edit traffic and couple OpenCode event throughput to Discord API latency.

## Decision

Buffered streaming is optional and disabled by default through `DISCORD_STREAM_ASSISTANT_TEXT=false`.

When enabled:

1. Only messages previously observed as `role: "assistant"` are eligible.
2. Only parts previously observed as `type: "text"` are eligible. Unknown parts and reasoning parts fail closed and are never streamed.
3. Text deltas and completed text snapshots update an in-memory per-session buffer.
4. Discord updates are coalesced to a conservative one-second cadence. Per-event Discord API calls are forbidden.
5. A turn uses at most one streaming preview message. Long previews are bounded and retain the newest text.
6. On `session.idle`, if a preview exists, the publisher re-fetches the canonical latest assistant result, edits the preview into the first `✅ Result` chunk, publishes any remaining chunks, and updates the existing `lastPublishedAssistantMessageId` dedupe state before yielding the idle event to the normal Bridge consumer.
7. If no preview exists—for example a short turn or a Bridge restart during a turn—the streaming publisher does not intercept finalization. The existing Phase 1 `session.idle` result path remains authoritative.
8. Discord preview failures are isolated from the OpenCode event stream. The original event is always yielded to the Bridge.

The streaming layer is inserted as a thin `OpenCodeGateway.events()` subclass so the Phase 1 Bridge implementation and its permission/question/session authority boundaries remain unchanged.

## Restart semantics

Streaming buffers and preview identities are deliberately non-durable. After a Bridge restart, unknown deltas are ignored until the required assistant-message and text-part observations are seen again. Regardless of preview recovery, `session.idle` still converges through the canonical latest assistant result.

## Consequences

- Discord gains useful progress without token-by-token edit pressure.
- Reasoning and raw successful tool output are not newly exposed.
- Final output remains based on the OpenCode message store rather than the accumulated preview buffer.
- A transient Discord preview/edit failure can leave a partial preview visible, but it cannot prevent the canonical final-result path from running.
- The implementation depends on the legacy `message.part.delta` event shape shared by OpenCode 1.18.20 and current OpenCode; compatibility tests and E2E validation must be rerun when that contract changes.
