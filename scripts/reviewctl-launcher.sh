#!/usr/bin/env bash
set -euo pipefail
reviewloop_launcher="${BASH_SOURCE[0]}"
while [[ -L "$reviewloop_launcher" ]]; do
  reviewloop_parent="$(cd -P -- "$(dirname -- "$reviewloop_launcher")" && pwd)"
  reviewloop_launcher="$(readlink -- "$reviewloop_launcher")"
  [[ "$reviewloop_launcher" = /* ]] || reviewloop_launcher="$reviewloop_parent/$reviewloop_launcher"
done
reviewloop_root="$(cd -P -- "$(dirname -- "$reviewloop_launcher")/.." && pwd)"
export PATH="$reviewloop_root/node/bin:$reviewloop_root/tools/bin:$reviewloop_root/tools/node_modules/.bin:$PATH"
exec "$reviewloop_root/node/bin/node" "$reviewloop_root/app/dist/server/cli.js" "$@"
