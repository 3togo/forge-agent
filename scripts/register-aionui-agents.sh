#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORGE_AGENT="$SCRIPT_DIR/../forge-agent-acp"
NODE_BIN="$(command -v node || true)"
SQLITE3_BIN="$(command -v sqlite3 || true)"

MODE="acp"
MODELS=""
API_KEYS=""
RESTART=false
STOP_ONLY=false

usage() {
  cat <<EOF
Usage: $0 [options]

Register Forge agents (DeepSeek, Doubao, Gemini) in AionUi.

Options:
  --api              Register as API providers instead of ACP agents (requires API keys)
  --models LIST      Comma-separated list of models (default: deepseek,doubao,gemini)
  --api-key MODEL=KEY  API key for a model (e.g., --api-key deepseek=sk-xxx)
  --restart          Restart AionUi after registration
  --stop-only        Only stop AionUi, don't register (for manual DB operations)
  -h, --help         Show this help

Examples:
  $0                           # Register all models as ACP agents
  $0 --models deepseek         # Register only DeepSeek
  $0 --api --api-key deepseek=sk-xxx --api-key doubao=sk-yyy
  $0 --restart                 # Register and restart AionUi
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) MODE="api"; shift ;;
    --models) MODELS="$2"; shift 2 ;;
    --api-key)
      API_KEYS="$API_KEYS $2"
      shift 2
      ;;
    --restart) RESTART=true; shift ;;
    --stop-only) STOP_ONLY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [[ -z "$NODE_BIN" ]]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

if [[ -z "$SQLITE3_BIN" ]]; then
  echo "Error: sqlite3 not found in PATH" >&2
  exit 1
fi

DB_PATH="$HOME/.config/AionUi/aionui/aionui-backend.db"
if [[ ! -f "$DB_PATH" ]]; then
  echo "Error: AionUi database not found at $DB_PATH" >&2
  echo "Install AionUi first: https://www.aionui.com/" >&2
  exit 1
fi

is_aionui_running() {
  ps -u "$(id -u)" -o comm= 2>/dev/null | grep -qi '^aionui'
}

stop_aionui() {
  if is_aionui_running; then
    echo "Stopping AionUi..."
    pkill -f 'AionUi' 2>/dev/null || true
    sleep 2
    if is_aionui_running; then
      pkill -9 -f 'AionUi' 2>/dev/null || true
      sleep 1
    fi
    echo "AionUi stopped."
  else
    echo "AionUi is not running."
  fi
}

start_aionui() {
  if command -v AionUi &>/dev/null; then
    echo "Starting AionUi..."
    nohup AionUi &>/dev/null &
    disown
    echo "AionUi started."
  else
    echo "Warning: AionUi command not found. Please start it manually." >&2
  fi
}

if [[ "$STOP_ONLY" == "true" ]]; then
  stop_aionui
  exit 0
fi

if is_aionui_running; then
  echo "Warning: AionUi is running. Stopping it to avoid database conflicts..."
  stop_aionui
fi

echo "Registering Forge agents in AionUi (mode: $MODE)..."

if [[ "$MODE" == "acp" ]]; then
  ARGS="--register"
  if [[ -n "$MODELS" ]]; then
    ARGS="$ARGS --models=$MODELS"
  fi
  "$FORGE_AGENT" $ARGS
else
  ARGS="--register --api"
  if [[ -n "$MODELS" ]]; then
    ARGS="$ARGS --models=$MODELS"
  fi
  for kv in $API_KEYS; do
    ARGS="$ARGS --api-key=$kv"
  done
  "$FORGE_AGENT" $ARGS
fi

echo ""
echo "Registration complete."

if [[ "$RESTART" == "true" ]]; then
  start_aionui
else
  echo "Restart AionUi to see the new agents in Settings → Agent Management."
fi
