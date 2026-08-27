# OpenCodeDiscordBridge

`OpenCodeDiscordBridge` is a small control plane that exposes OpenCode sessions through Discord threads without treating the terminal UI as an API.

OpenCode servers are the source of truth. Local or remote OpenCode servers keep their own sessions authoritative, optional `opencode attach` clients provide TUI views, and this bridge is another API client through `@opencode-ai/sdk`.

## Behavior

- `/oc start directory:<absolute-path> [host:<configured-id>] [title]` creates an OpenCode session and a Discord thread.
  - Omitting `host` uses the configured default host.
  - `host` accepts only stable IDs from the operator-configured host registry; Discord cannot supply an arbitrary URL.
- Plain text posted by an authorized user in a bound thread is sent with `session.promptAsync()` to that binding's host.
- `question.asked` events are posted as **Ask** messages. The next authorized thread message answers the pending question through the same host's OpenCode question API.
- `permission.updated` events are posted as Discord buttons.
  - `Allow once`
  - `Reject`
  - `Allow always` only when explicitly enabled by configuration.
- `session.idle` publishes the latest completed assistant **Result** to the correct host/thread binding.
- `/oc status` reports Host ID, session state, directory, and a credential-free attach command for the bound host.
- `/oc abort` asks the bound host's OpenCode server to abort the current turn.
- `/oc close` deletes the bound OpenCode session, removes the binding, and archives the Discord thread.
- `/oc unbind` removes only the Discord binding and leaves the OpenCode session alive.
- `/oc health` probes every configured host in parallel and reports aggregate plus per-host HTTP/SSE readiness. Host IDs are shown; URLs and credentials are not.
- Persisted JSON bindings include `hostId`, allowing the bridge to reconnect each Discord thread to the correct OpenCode host after restart. Legacy state-v1 bindings without `hostId` migrate to the configured default host.

For a multi-question Ask, reply with one line per question; for a multi-select question, separate selections with commas. A **Reject Ask** button is also provided. Pending Ask requests are reconciled per host when the bridge restarts.

Assistant streaming is optional and disabled by default. When `DISCORD_STREAM_ASSISTANT_TEXT=true`, each host has an isolated streaming publisher. Assistant text is buffered and coalesced to a conservative update cadence before a single Discord preview message is edited. Reasoning and successful raw tool output are not streamed. `session.idle` still re-fetches the canonical assistant result and converges the preview to the final `✅ Result`.

Tool-call summaries are also isolated per host so identical OpenCode session IDs on different hosts cannot cross-deliver preview or tool activity state.

Discord attachments can be sent to an idle bound session as OpenCode FileParts. PNG, JPEG, WebP, GIF, PDF, and bounded UTF-8 text-like files are supported. The bridge accepts at most four attachments per message, 10 MiB per attachment, and 20 MiB total. Attachment bytes are fetched only from Discord attachment CDN URLs, validated in memory, converted to data URLs, and never written to the host filesystem. Archives, executables, unsupported binary files, redirects, and invalid media signatures are rejected. A pending Ask remains text-only.

## Security boundary

Discord is not a remote shell in this design.

1. The bridge only accepts commands from `DISCORD_ALLOWED_USER_IDS` in one configured guild.
2. Discord can select only a stable host ID from `OPENCODE_HOSTS_JSON`; it cannot provide an arbitrary host URL, hostname, username, or password.
3. `/oc start` accepts only canonical directories contained by the selected host's configured allowed roots. For remote hosts, the bridge asks that OpenCode server for its canonical `/path` result and verifies directory accessibility through the OpenCode file API before creating a session. Symlink-resolved paths outside the allowlist are rejected.
4. Discord text becomes an OpenCode prompt. The bridge does not expose an endpoint that executes arbitrary shell commands directly.
5. OpenCode remains responsible for tool and shell permissions. Permission requests are surfaced to Discord, but the policy decision still flows through the selected OpenCode host's permission API.
6. A local OpenCode server should stay on `127.0.0.1`. Remote OpenCode hosts should be reachable only over a deliberately secured network/transport and should still use server authentication.
7. State contains only thread/session/host metadata. Discord and OpenCode credentials are never persisted in the state file.
8. Host-registry passwords are referenced with `passwordEnv`; password values are not embedded in `OPENCODE_HOSTS_JSON` or exposed through registry serialization.
9. A configured secret-file path is operator-controlled configuration. Discord cannot select or change it.

`DISCORD_ALLOW_PERMISSION_ALWAYS` defaults to `false` because a persistent approval has a materially larger blast radius than a one-turn approval.

## Host layout

```text
                         +--> OpenCode host: local
Discord thread A --+     |      session A
                   |     |
                   +--> OpenCodeDiscordBridge
                   |     |
Discord thread B --+     +--> OpenCode host: lab
                                session B

Each configured host:
  - has its own authenticated OpenCode gateway
  - has its own global SSE consumer/readiness monitor
  - has isolated assistant-stream/tool-summary state
  - applies its own allowed-root policy

Optional TUI clients attach directly to the same OpenCode session on the
appropriate host. The Bridge never uses tmux send-keys or terminal scraping.
```

## Requirements

- Node.js 22+
- OpenCode on each configured target host (the bridge SDK is pinned to 1.18.20 with compatibility handling for newer server APIs used by the project)
- tmux only where the provided local helper scripts are used
- A dedicated Discord bot application
- Discord bot scopes/permissions needed to use the configured text channel, create public threads, send messages, add reactions, and use application commands
- The Discord **Message Content Intent** enabled, because ordinary thread messages are used as prompts
- Network reachability from the Bridge process to every configured OpenCode host

A Nix development shell is included:

```bash
nix develop
```

The Bridge runtime is also exposed as a reproducible flake package:

```bash
nix build
./result/bin/opencode-discord-bridge
```

OpenCode itself is intentionally not pinned or bundled by the Bridge package; each host's existing OpenCode installation/configuration remains authoritative.

## Bootstrap

### 1. Create the Discord application

Create a dedicated bot application in the Discord Developer Portal. Enable **Message Content Intent** and install the bot into the target guild with application commands plus the channel/thread permissions described above.

Copy `.env.example` to `.env` for ordinary configuration. Secrets may stay in `.env` for backward compatibility, but a separate `OCB_SECRETS_FILE` is preferred for service operation. Keep both `.env` and the secret file out of git.

### 2. Configure the OpenCode boundary

The legacy single-host form remains supported and is the fallback when `OPENCODE_HOSTS_JSON` is unset:

```dotenv
OPENCODE_ALLOWED_ROOTS=/home/upiscium/Documents/Programs
OPENCODE_BASE_URL=http://127.0.0.1:4096
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=<long-random-password>
DISCORD_STREAM_ASSISTANT_TEXT=false
```

With legacy configuration, the runtime host ID is `default`, preserving the previous single-host behavior.

For multi-host operation, configure a registry. The registry contains no password values: each host uses `passwordEnv` to reference a separate environment variable.

```dotenv
OPENCODE_HOST_LOCAL_PASSWORD=<local-password>
OPENCODE_HOST_LAB_PASSWORD=<lab-password>
OPENCODE_HOSTS_JSON={"defaultHost":"local","hosts":[{"id":"local","baseUrl":"http://127.0.0.1:4096","username":"opencode","passwordEnv":"OPENCODE_HOST_LOCAL_PASSWORD","allowedRoots":["/home/upiscium/Documents/Programs"]},{"id":"lab","baseUrl":"http://10.0.0.20:4096","username":"opencode","passwordEnv":"OPENCODE_HOST_LAB_PASSWORD","allowedRoots":["/srv/projects"]}]}
```

Host IDs are lowercase stable tokens. Duplicate IDs, unknown default hosts, non-HTTP(S) URLs, URL userinfo, empty root lists, missing password environment variables, and unknown JSON fields are rejected at startup.

Every configured host receives an independent gateway and SSE consumer. A persisted binding referencing a host that is no longer configured causes startup to fail rather than silently rerouting the session.

`/oc health` performs authenticated `/global/health` probes for all configured hosts concurrently and combines them with each host's SSE freshness. The bridge is reported `ready` only when every host is HTTP-healthy and SSE-connected; otherwise the aggregate is `degraded` while healthy hosts remain visible individually.

Set `DISCORD_STREAM_ASSISTANT_TEXT=true` only when buffered progress previews are desired. The default `false` keeps final-only behavior.

### Secret file

Set `OCB_SECRETS_FILE` in the real process/systemd environment to load a separate dotenv-style secret file. It may live at any normal filesystem path, including a path under the runtime user's home:

```bash
export OCB_SECRETS_FILE=~/secrets/ocb_secrets.env
```

Example `~/secrets/ocb_secrets.env`:

```dotenv
DISCORD_TOKEN=<discord-bot-token>
OPENCODE_HOST_LOCAL_PASSWORD=<local-password>
OPENCODE_HOST_LAB_PASSWORD=<lab-password>
```

Legacy single-host operation can place `OPENCODE_SERVER_PASSWORD` there instead. `~/...` is expanded against the user running the Bridge; absolute paths such as `/run/secrets/opencode-discord-bridge.env` and relative paths are also supported. The selected file must be readable by that runtime user.

Startup precedence is fixed as:

```text
process/systemd environment
  > OCB_SECRETS_FILE
  > repository-local .env
```

A configured secret file that is missing, unreadable, or malformed makes startup fail closed. Error messages contain the file path/line where useful, but not the secret values.

### 3. Start a local OpenCode server with the helper (optional)

For the Bridge machine's local OpenCode server:

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

The helper manages only the local OpenCode server. The Discord bridge does not remotely start, stop, or control tmux sessions on configured remote hosts.

### 4. Install and start the bridge

Dependencies are locked in `package-lock.json`, so use the reproducible install path:

```bash
npm ci
npm run check
npm run build
npm start
```

`src/index.ts` loads the optional `OCB_SECRETS_FILE` first and then repository-local `.env`. Existing process environment values retain highest precedence.

### 5. Create Discord/OpenCode sessions

Use the default host:

```text
/oc start directory:/home/upiscium/Documents/Programs/Terreate title:Terreate
```

Or explicitly select a configured host:

```text
/oc start directory:/srv/projects/Terreate host:lab title:Terreate-lab
```

The bot creates a thread bound to `(hostId, sessionId)`. From then on, prompts, attachments, Ask/permission replies, lifecycle commands, Results, and managed-header updates are routed only to that host.

## NixOS service operation

The flake exports `nixosModules.default` and `nixosModules.opencode-discord-bridge`. A deployment flake can import the module and run the Bridge as a durable systemd service. For example, to keep secrets in `~/secrets/ocb_secrets.env` owned by an existing user:

```nix
{
  inputs.opencode-discord-bridge.url = "github:upiscium/OpencodeDiscordBridge";

  outputs = { nixpkgs, opencode-discord-bridge, ... }: {
    nixosConfigurations.bridge-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        opencode-discord-bridge.nixosModules.default
        {
          services.opencode-discord-bridge = {
            enable = true;
            user = "upiscium";
            group = "users";
            createUser = false;
            secretsFile = "~/secrets/ocb_secrets.env";
            environmentFile = "/run/opencode-discord-bridge.env";
            stateDirectory = "opencode-discord-bridge";
          };
        }
      ];
    };
  };
}
```

`secretsFile` is only a path string. Nix never reads the selected file and the module rejects paths that already point into the Nix store. `~/...` is expanded at runtime using the configured service user's home; with the default dedicated system user, use a path readable by that user (typically an absolute path). The service user must have filesystem permission to read the file.

`environmentFile` and `environment` remain available for non-secret or legacy configuration. `STATE_FILE` is controlled by the module and placed under `/var/lib/<stateDirectory>/<stateFile>`. The module rejects store-backed `environmentFile` paths as well.

By default the module creates an `opencode-discord-bridge` system user/group, starts after `network-online.target`, uses systemd `StateDirectory` for persistent writable state, restarts on abnormal exit, and stops the process with `SIGTERM`. Restarting or stopping this service does not start, stop, migrate, or delete any OpenCode server/session.

A future systemd `LoadCredential=` layer may copy/isolate the selected secret source further; the application-level variable contract does not depend on a specific secret backend.

## Opening the same session in TUI

`/oc status` shows the bound Host ID and a credential-free `opencode attach` command using that host's configured base URL, session ID, and directory. Authentication is still supplied by the operator environment; credentials are never printed into Discord.

For the local helper-managed host, you can also use:

```bash
./scripts/open-tui-window.sh \
  /home/upiscium/Documents/Programs/Terreate \
  ses_xxxxxxxxx

tmux -L opencode-bridge attach -t opencode
```

This opens the same OpenCode session Discord is controlling, not a second session.

## Development gates

```bash
npm run lint
npm run typecheck
npm test
npm run check
nix build
nix flake check
```

CI uses `npm ci` and the committed lockfile before running the Node quality gate, and separately builds/checks the Nix package and module.

See `docs/architecture.md`, `docs/adr/0001-opencode-server-as-source-of-truth.md`, and `docs/roadmap.md` for the design boundary and next stages.
