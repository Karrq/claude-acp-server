#!/bin/zsh
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/path/to/claude-acp-server}"

cd "$REPO_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-4319}"
export FACADE_API_KEY="${FACADE_API_KEY:-replace-me}"
export ACP_BACKEND_COMMAND="${ACP_BACKEND_COMMAND:-/opt/homebrew/bin/npx}"
export ACP_BACKEND_ARGS="${ACP_BACKEND_ARGS:--y @agentclientprotocol/claude-agent-acp}"

exec /opt/homebrew/bin/node dist/index.js
