# ADR 0006: Treat Discord tool activity as a redacted projection

Status: Accepted

## Context

OpenCode tool parts expose operationally useful progress state, but they also carry fields that can contain sensitive data:

- `state.input` can contain shell commands, search queries, prompts, file contents, credentials, or arbitrary plugin data;
- `state.output` is arbitrary tool output;
- `state.metadata`, `state.title`, and `state.error` are tool-defined or provider-derived data and cannot be assumed safe for Discord;
- unknown/custom tools have no stable schema that the bridge can safely interpret.

A heuristic "mask known secret patterns" approach is insufficient because it assumes the bridge can enumerate every sensitive representation.

## Decision

Tool activity is optional and disabled by default through `DISCORD_SHOW_TOOL_SUMMARIES=false`.

When enabled, the bridge builds a new redacted activity model from each assistant tool part instead of buffering or rendering the raw part.

The retained model contains only:

- tool name;
- lifecycle status (`pending`, `running`, `completed`, `error`);
- start/end timestamps used for duration;
- an optional annotation produced by an explicit whitelist.

The bridge never copies raw output, metadata, title, or error text into the activity buffer.

Raw input is default-deny. Only these initial annotations are permitted:

1. File-oriented built-in tools with an explicitly known path field (`read`, `edit`, `write`, `grep`, `glob`). A path lexically inside the bound repository directory is rendered repository-relative. A path outside that directory is rendered only as `[external path]`.
2. `webfetch.url`. The bridge parses the URL and removes username, password, query parameters, and fragment before rendering protocol + host + pathname.

All other input fields and unknown/custom tool inputs are omitted completely. In particular, the initial policy does not render bash commands, search queries, grep/glob patterns, task/subagent prompts, or arbitrary plugin inputs.

## Delivery

One bounded `🔧 Tool activity` Discord message is maintained per assistant message. Tool updates are coalesced on a conservative one-second cadence rather than mapped one-to-one to Discord API calls.

The summary shows only the most recent bounded set of calls and reports how many earlier calls were omitted. `session.idle` drains any in-flight update and flushes the latest status before the in-memory state is discarded.

Tool activity state is deliberately non-durable. It is observational UX, not source-of-truth session state.

## Failure and authority boundary

Tool summary delivery is implemented as an OpenCode event observer. Observer failures are isolated before the original event reaches the existing Bridge consumer, so permission, question, session, and final-result processing continue.

The feature does not grant Discord new execution authority and does not change OpenCode permission policy.

## Consequences

- Tool progress becomes visible without exposing successful tool output or arbitrary inputs.
- The whitelist is intentionally conservative; useful new annotations require an explicit reviewed schema addition.
- Repository path classification is lexical display redaction, not a filesystem authorization decision. Actual path authorization remains OpenCode/bridge policy responsibility.
- Custom tools remain visible by name/status/duration only until a safe annotation contract is explicitly added.
