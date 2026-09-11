#!/usr/bin/env bash
set -euo pipefail
daddyloop_launcher="${BASH_SOURCE[0]}"
while [[ -L "$daddyloop_launcher" ]]; do
  daddyloop_parent="$(cd -P -- "$(dirname -- "$daddyloop_launcher")" && pwd)"
  daddyloop_launcher="$(readlink -- "$daddyloop_launcher")"
  [[ "$daddyloop_launcher" = /* ]] || daddyloop_launcher="$daddyloop_parent/$daddyloop_launcher"
done
daddyloop_root="$(cd -P -- "$(dirname -- "$daddyloop_launcher")/.." && pwd)"
export PATH="$daddyloop_root/node/bin:$daddyloop_root/tools/bin:$daddyloop_root/tools/node_modules/.bin:$PATH"
exec "$daddyloop_root/node/bin/node" "$daddyloop_root/app/dist/server/cli.js" "$@"
