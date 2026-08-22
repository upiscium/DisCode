# ADR 0007: Preserve short tool activity across assistant step transitions

Status: Accepted

## Context

Tool activity is coalesced to a conservative Discord update cadence. OpenCode may finish a tool call and advance to a new assistant message before the one-second summary timer fires. This is common for short failures and other fast tool calls.

The original tool-summary publisher cancelled the pending timer and immediately replaced the per-session assistant-message buffer when a new `message.updated` event arrived. If the previous assistant message had never been flushed to Discord, its tool activity was discarded.

The live Phase 2 E2E exposed this with a short failed `read` call: later `bash` and `webfetch` activity appeared correctly, but the earlier failed `read` was absent from `Tool activity`.

## Decision

When an assistant-message transition is observed for a bound session:

1. cancel and drain any in-flight summary edit for the previous assistant message;
2. explicitly flush the previous assistant message's current redacted tool summary;
3. only then discard its in-memory message identity/buffer and start tracking the new assistant message.

The explicit flush uses the same redacted projection as normal cadence updates. Raw input/output/error/title/metadata remain outside the tool-activity model.

## Consequences

- fast completed or failed tools are not lost merely because OpenCode advances to another assistant message before the cadence timer;
- the one-second coalescing policy remains unchanged during normal execution;
- a step transition may force an immediate final summary update for the preceding assistant message;
- redaction and authority boundaries are unchanged.
