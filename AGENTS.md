# Agent instructions

## Scope

This repository implements a narrow Discord <-> OpenCode control bridge. OpenCode Server is the source of truth. tmux is process/TUI persistence only.

## Non-negotiable boundaries

- Do not introduce `tmux send-keys`, terminal scraping, or ANSI parsing as an application protocol.
- Do not add a Discord endpoint that executes arbitrary shell commands directly.
- Do not bypass OpenCode permission handling.
- Do not weaken `DISCORD_ALLOWED_USER_IDS`, guild restriction, or `OPENCODE_ALLOWED_ROOTS` without an explicit security rationale and review.
- Resolve requested directories through `realpath` before allowlist comparison; lexical prefix checks alone are insufficient.
- Do not persist Discord/OpenCode credentials in bridge state or logs.
- Persistent permission approval (`always`) must remain opt-in.

## Development workflow

Prefer small, contract-driven changes. For each behavior change, identify the authority boundary, failure modes, and an automated test before implementation when practical.

Required quality gate before a PR is considered ready:

```bash
npm run check
```

The gate covers Biome, TypeScript strict type checking, and Vitest.

## Compatibility

The repository pins `@opencode-ai/sdk`. When updating it, inspect OpenCode event names, permission response types, session prompt/abort/messages APIs, and global SSE shape before changing the pin.

## Repository hygiene

- Keep generated/runtime state out of git.
- `.worktrees/` is ignored and is the preferred local worktree container.
- Do not commit `.env` or tokens.
- Once `package-lock.json` exists, preserve it and use `npm ci` in CI.
