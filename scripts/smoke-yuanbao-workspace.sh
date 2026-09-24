#!/usr/bin/env bash
set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd -- "${script_dir}/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo 'Error: Node.js is required but was not found on PATH.' >&2
  exit 127
fi

cd -- "${project_root}"
exec node scripts/acp-live-check.mjs --model=yuanbao --workspace-contract
