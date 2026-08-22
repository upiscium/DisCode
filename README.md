# OpenCodeDiscordBridge

`OpenCodeDiscordBridge` is a small control plane that exposes an OpenCode session through a Discord thread without treating the terminal UI as an API.

The OpenCode server is the source of truth. A local tmux session keeps `opencode serve` alive, an optional `opencode attach` window gives an SSH/TUI view, and this bridge is another client of the same OpenCode server through `@opencode-ai/sdk`.

## MVP behavior

- `/oc start directory:<absolute-path> [title]` creates an OpenCode session and a Discord thread.
- Plain text posted by an authorized user in that thread is sent with `session.promptAsync()`.
- `question.asked` events are posted as **Ask** messages. The next authorized thread message answers the pending question through OpenCode's question API.
- `permission.updated` events are posted as Discord buttons.
  - `Allow once`
  - `Reject`
  - `Allow always` only when explicitly enabled by configuration.
- `session.idle` publishes the latest completed assistant **Result** to the thread.
- `/oc status` reports the bound OpenCode session state.
- `/oc abort` asks OpenCode to abort the current turn.
- A persisted JSON binding lets the bridge reconnect a Discord thread to an existing OpenCode session after restart.

For a multi-question Ask, reply with one line per question; for a multi-select question, separate selections with commas. A **Reject Ask** button is also provided. Pending Ask requests are reconciled from OpenCode when the bridge restarts.

The MVP deliberately does **not** stream every token to Discord. Publishing only at `session.idle` avoids rate-limit pressure, duplicate edits, and partial-result recovery complexity. Streaming can be added later without changing the control-plane boundary.

## Security boundary

Discord is not a remote shell in this design.

1. The bridge only accepts commands from `DISCORD_ALLOWED_USER_IDS` in one configured guild.
2. `/oc start` accepts only real directories contained by `OPENCODE_ALLOWED_ROOTS`. Paths are resolved with `realpath`, so a symlink cannot escape the allowlist.
3. Discord text becomes an OpenCode prompt. The bridge does not expose an endpoint that executes arbitrary shell commands directly.
4. OpenCode remains responsible for tool and shell permissions. Permission requests are surfaced to Discord, but the policy decision still flows through OpenCode's permission API.
5. The OpenCode server should stay on `127.0.0.1` and use `OPENCODE_SERVER_PASSWORD` even on a single-purpose host.
6. State contains only thread/session metadata. Discord and OpenCode credentials are never persisted in the state file.

`DISCORD_ALLOW_PERMISSION_ALWAYS` defaults to `false` because a persistent approval has a materially larger blast radius than a one-turn approval.

## Host layout

```text
Discord thread
      |
      v
OpenCodeDiscordBridge
      |
      | @opencode-ai/sdk / SSE
      v
127.0.0.1:4096
OpenCode Server
      |
      +---- OpenCode session A <---- Discord thread A
      |             ^
      |             |
      |       optional TUI
      |
      +---- OpenCode session B <---- Discord thread B
                    ^
                    |
              optional TUI

Dedicated tmux server (-L opencode-bridge)
  session: opencode
    window: server -> opencode serve
    window: repo-A -> opencode attach ... --session ses_...
```

The TUI and Discord bridge are peer clients. No ANSI parsing and no `tmux send-keys` are required.

## Requirements

- Node.js 22+
- OpenCode on the target host (the MVP is implemented against the 1.18.20 server/SDK API surface)
- tmux on the target host
- A dedicated Discord bot application
- Discord bot scopes/permissions needed to use the configured text channel, create public threads, send messages, add reactions, and use application commands
- The Discord **Message Content Intent** enabled, because ordinary thread messages are used as prompts

A Nix development shell is included:

```bash
nix develop
```

OpenCode itself is intentionally not pinned in `flake.nix`; the host's existing OpenCode installation/configuration is reused.

## Bootstrap

### 1. Create the Discord application

Create a dedicated bot application in the Discord Developer Portal. Enable **Message Content Intent** and install the bot into the target guild with application commands plus the channel/thread permissions described above.

Copy `.env.example` to `.env` and fill the Discord IDs/token. Keep `.env` out of git.

### 2. Configure the OpenCode boundary

At minimum:

```dotenv
OPENCODE_ALLOWED_ROOTS=/home/upiscium/Documents/Programs
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<long-random-password>
```

The same `OPENCODE_SERVER_PASSWORD` environment variable should be present when the tmux server and bridge are launched.

### 3. Start OpenCode in the dedicated tmux server

```bash
set -a
source .env
set +a
./scripts/start-opencode-tmux.sh
```

The helper uses a separate tmux socket/server by default:

```bash
tmux -L opencode-bridge attach -t opencode
```

This avoids accidentally depending on the environment of an unrelated, already-running tmux server.

### 4. Install and start the bridge

Dependencies are locked in `package-lock.json`, so use the reproducible install path:

```bash
npm ci
npm run check
npm run build
npm start
```

`src/index.ts` automatically loads `.env` when present.

### 5. Create a Discord/OpenCode session

From the configured guild:

```text
/oc start directory:/home/upiscium/Documents/Programs/Terreate title:Terreate
```

The bot creates a thread. From then on, normal text in that thread is sent to that OpenCode session.

## Opening the same session in tmux/TUI

The bot posts the OpenCode session ID in the new thread. On the host:

```bash
./scripts/open-tui-window.sh \
  /home/upiscium/Documents/Programs/Terreate \
  ses_xxxxxxxxx

tmux -L opencode-bridge attach -t opencode
```

This is the same OpenCode session Discord is controlling, not a second session.

## Development gates

```bash
npm run lint
npm run typecheck
npm test
npm run check
```

CI uses `npm ci` and the committed lockfile before running the same `npm run check` quality gate.

See `docs/architecture.md`, `docs/adr/0001-opencode-server-as-source-of-truth.md`, and `docs/roadmap.md` for the design boundary and next stages.
