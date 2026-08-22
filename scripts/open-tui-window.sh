#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <directory> <session-id> [window-name]" >&2
  exit 64
fi

socket="${OPENCODE_TMUX_SOCKET:-opencode-bridge}"
tmux_session="${OPENCODE_TMUX_SESSION:-opencode}"
base_url="${OPENCODE_BASE_URL:-http://127.0.0.1:4096}"
directory="$(realpath "$1")"
opencode_session="$2"
window_name="${3:-$(basename "$directory")}"
window_name="${window_name//:/-}"

command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 127; }
command -v opencode >/dev/null || { echo "opencode is required" >&2; exit 127; }
tmux -L "$socket" has-session -t "$tmux_session" 2>/dev/null || {
  echo "tmux session '$tmux_session' does not exist; run scripts/start-opencode-tmux.sh first" >&2
  exit 1
}

# OpenCode attach reads OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME
# from the inherited environment when explicit CLI flags are omitted. Keep
# credentials out of argv and the tmux window command history.
attach_args=(opencode attach "$base_url" --session "$opencode_session" --dir "$directory")
printf -v attach_command '%q ' "${attach_args[@]}"
tmux -L "$socket" new-window -d -t "$tmux_session" -n "$window_name" "exec $attach_command"

echo "TUI window opened."
echo "Attach: tmux -L $socket attach -t $tmux_session"
