#!/usr/bin/env bash
# Linux startup wrapper for the installed Forge Agent.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mode=recover
case "${1:-}" in
  --check) mode=check; shift ;;
  --restart) mode=restart; shift ;;
  --help)
    cat <<'HELP'
Usage: ./smart-start.sh [--check | --restart] [Forge Agent arguments...]

No arguments: recover suspended Forge Agent sessions, then start interactive mode.
--check:       inspect the session without stopping processes or launching anything.
--restart:     also stop an active Forge Agent using this browser session.

Other arguments are passed to Forge Agent unchanged.
Set FORGE_AGENT_BIN to select an installed forge-agent executable.
HELP
    exit 0 ;;
esac

agent_bin="${FORGE_AGENT_BIN:-$(command -v forge-agent || true)}"
if [[ -z "$agent_bin" || ! -x "$agent_bin" ]]; then
  echo 'Forge Agent is not on PATH. Activate your Node environment or set FORGE_AGENT_BIN.' >&2
  exit 1
fi
node "$script_dir/scripts/smart-start.js" "$mode" "$agent_bin"
[[ "$mode" == check ]] && exit 0
if [[ $# -eq 0 ]]; then set -- --interactive; fi
exec "$agent_bin" "$@"
