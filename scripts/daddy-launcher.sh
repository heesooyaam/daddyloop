#!/usr/bin/env bash
set -euo pipefail
daddyloop_launcher="${BASH_SOURCE[0]}"
while [[ -L "$daddyloop_launcher" ]]; do
  daddyloop_parent="$(cd -P -- "$(dirname -- "$daddyloop_launcher")" && pwd)"
  daddyloop_launcher="$(readlink -- "$daddyloop_launcher")"
  [[ "$daddyloop_launcher" = /* ]] || daddyloop_launcher="$daddyloop_parent/$daddyloop_launcher"
done
daddyloop_root="$(cd -P -- "$(dirname -- "$daddyloop_launcher")/.." && pwd)"
for daddyloop_module_bin in "$daddyloop_root"/modules/*/bin; do
  [[ ! -d "$daddyloop_module_bin" ]] || PATH="$daddyloop_module_bin:$PATH"
done
export PATH="$daddyloop_root/node/bin:$PATH"
exec "$daddyloop_root/node/bin/node" "$daddyloop_root/app/dist/server/cli.js" "$@"
