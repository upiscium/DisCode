set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
    @just --list

install:
    npm install

check:
    npm run check

build:
    npm run build

run:
    npm run start

tmux-start:
    ./scripts/start-opencode-tmux.sh
