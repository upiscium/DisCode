#!/usr/bin/env bash
set -euo pipefail

socket="${OPENCODE_TMUX_SOCKET:-opencode-bridge}"
session="${OPENCODE_TMUX_SESSION:-opencode}"
hostname="${OPENCODE_TMUX_HOSTNAME:-127.0.0.1}"
port="${OPENCODE_TMUX_PORT:-4096}"

command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 127; }
command -v opencode >/dev/null || { echo "opencode is required" >&2; exit 127; }

if tmux -L "$socket" has-session -t "$session" 2>/dev/null; then
  echo "tmux session already exists: tmux -L $socket attach -t $session"
  exit 0
fi

printf -v server_command 'exec opencode serve --hostname %q --port %q' "$hostname" "$port"
tmux -L "$socket" new-session -d -s "$session" -n server "$server_command"

echo "OpenCode server started in dedicated tmux server."
echo "Attach: tmux -L $socket attach -t $session"
echo "URL:    http://$hostname:$port"
