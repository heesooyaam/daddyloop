#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' 2>/dev/null; then
  python3 scripts/install-node.py
  export PATH="$PWD/.tools/node/bin:$PATH"
fi
npm ci
npm run build
printf '\nReady. Run ./scripts/reviewctl.mjs serve --demo\n'
