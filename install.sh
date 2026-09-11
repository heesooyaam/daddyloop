#!/usr/bin/env bash
set -euo pipefail
umask 077
daddyloop_version="0.13.1"
daddyloop_prefix="${DADDYLOOP_INSTALL_DIR:-$HOME/.local/share/daddyloop}"
daddyloop_bin_dir="${DADDYLOOP_BIN_DIR:-$HOME/.local/bin}"
daddyloop_base="${DADDYLOOP_DOWNLOAD_BASE:-https://github.com/heesooyaam/daddyloop/releases/download/v$daddyloop_version}"
daddyloop_config="${DADDYLOOP_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/daddyloop/config.json}"
daddyloop_setup=true
daddyloop_yes=false
daddyloop_modules=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-setup) daddyloop_setup=false; daddyloop_yes=true; shift ;;
    --yes) daddyloop_yes=true; shift ;;
    --modules) [[ $# -gt 1 ]] || { printf 'Missing module list\n' >&2; exit 1; }; daddyloop_modules="$2"; shift 2 ;;
    --modules=*) daddyloop_modules="${1#*=}"; shift ;;
    --help) printf 'Install daddyloop.\nOptions: --yes, --no-setup, --modules codex,claude,github,gitlab,arcadia\nWithout --yes, choose modules with arrows and Space.\n'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" = Linux ]] || { printf 'The managed release requires Linux; use the website from other devices.\n' >&2; exit 1; }
case "$(uname -m)" in x86_64) daddyloop_arch=x64 ;; aarch64|arm64) daddyloop_arch=arm64 ;; *) printf 'Unsupported architecture\n' >&2; exit 1 ;; esac
command -v curl >/dev/null
command -v tar >/dev/null
daddyloop_system_packages() {
  command -v apt-get >/dev/null || { printf 'Install these system packages and rerun: %s\n' "$*" >&2; exit 1; }
  if [[ "$EUID" = 0 ]]; then
    apt-get update
    apt-get install -y --no-install-recommends "$@"
  elif command -v sudo >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends "$@"
  else printf 'Install these system packages and rerun: %s\n' "$*" >&2; exit 1; fi
}
if ! command -v git >/dev/null; then daddyloop_system_packages git ca-certificates; fi
mkdir -p "$daddyloop_prefix/releases" "$daddyloop_bin_dir"
daddyloop_lock="$daddyloop_prefix/.install-lock"
mkdir "$daddyloop_lock" 2>/dev/null || { printf 'An installation lock exists: %s\n' "$daddyloop_lock" >&2; exit 1; }
daddyloop_tmp=""
trap '[[ -z "$daddyloop_tmp" ]] || rm -rf -- "$daddyloop_tmp"; rmdir -- "$daddyloop_lock"' EXIT
daddyloop_tmp="$(mktemp -d "$daddyloop_prefix/releases/.install-XXXXXXXX")"
# Each component must have a valid checksum and a single, traversal-free archive root.
daddyloop_extract() {
  local asset="$1" archive_root="$2" destination="$3" checksum actual expected entry
  mkdir -p "$destination"
  curl -fL --retry 3 --connect-timeout 20 "$daddyloop_base/$asset" -o "$daddyloop_tmp/$asset"
  curl -fL --retry 3 --connect-timeout 20 "$daddyloop_base/$asset.sha256" -o "$daddyloop_tmp/$asset.sha256"
  expected="$(awk '{print $1; exit}' "$daddyloop_tmp/$asset.sha256")"
  actual="$(sha256sum "$daddyloop_tmp/$asset")"; actual="${actual%% *}"
  [[ "$expected" =~ ^[a-f0-9]{64}$ && "$expected" = "$actual" ]] || { printf 'Release checksum mismatch; installation stopped.\n' >&2; exit 1; }
  tar -tzf "$daddyloop_tmp/$asset" > "$daddyloop_tmp/entries"
  while IFS= read -r entry; do
    [[ "$entry" = "$archive_root" || "$entry" = "$archive_root/"* ]] || { printf 'Invalid archive root\n' >&2; exit 1; }
    case "/$entry/" in *'/../'*) printf 'Invalid archive path\n' >&2; exit 1 ;; esac
  done < "$daddyloop_tmp/entries"
  tar -xzf "$daddyloop_tmp/$asset" -C "$destination"
  printf '%s  %s\n' "$actual" "$asset" >> "$daddyloop_tmp/components"
}
daddyloop_extract "daddyloop-linux-$daddyloop_arch.tar.gz" daddyloop "$daddyloop_tmp/core"
daddyloop_payload="$daddyloop_tmp/core/daddyloop"
daddyloop_node="$daddyloop_payload/node/bin/node"
[[ "$(DADDYLOOP_CONFIG="$daddyloop_tmp/blank.json" "$daddyloop_payload/bin/daddy" --version)" = "$daddyloop_version" ]] || { printf 'Release version mismatch\n' >&2; exit 1; }
daddyloop_choices=(modules select --file "$daddyloop_tmp/selection.json")
if [[ -n "$daddyloop_modules" ]]; then daddyloop_choices+=(--modules "$daddyloop_modules")
elif $daddyloop_setup && [[ -f "$daddyloop_config" ]]; then daddyloop_choices+=(--from-config "$daddyloop_config"); fi
if $daddyloop_yes || [[ ! -r /dev/tty ]]; then
  DADDYLOOP_CONFIG="$daddyloop_tmp/blank.json" "$daddyloop_payload/bin/daddy" "${daddyloop_choices[@]}" --yes
else
  DADDYLOOP_CONFIG="$daddyloop_tmp/blank.json" "$daddyloop_payload/bin/daddy" "${daddyloop_choices[@]}" < /dev/tty
fi
"$daddyloop_node" -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1])); const m=JSON.parse(fs.readFileSync(process.argv[2])).modules; for(const id of [...s.modules].sort()) { const d=m.find(x=>x.id===id); if(!d)process.exit(1); console.log(id+"\t"+(d.artifact||"-")+"\t"+(d.command||"-")); }' "$daddyloop_tmp/selection.json" "$daddyloop_payload/release.json" > "$daddyloop_tmp/modules"
mkdir -p "$daddyloop_payload/modules"
while IFS=$'\t' read -r daddyloop_id daddyloop_artifact daddyloop_command; do
  [[ "$daddyloop_id" =~ ^[a-z][a-z0-9-]*$ ]] || exit 1
  [[ "$daddyloop_artifact" != '-' ]] || continue
  [[ "$daddyloop_artifact" =~ ^[a-z][a-z0-9-]*$ ]] || exit 1
  daddyloop_extract "daddyloop-$daddyloop_artifact-linux-$daddyloop_arch.tar.gz" daddyloop-module "$daddyloop_tmp/module-$daddyloop_id"
  daddyloop_addon="$daddyloop_tmp/module-$daddyloop_id/daddyloop-module"
  "$daddyloop_node" -e 'const m=require(process.argv[1]); if(m.id!==process.argv[2]||m.version!==process.argv[3]||m.arch!==process.argv[4]||m.platform!=="linux")process.exit(1)' "$daddyloop_addon/module.json" "$daddyloop_id" "$daddyloop_version" "$daddyloop_arch"
  [[ "$daddyloop_command" =~ ^[a-z][a-z0-9-]*$ ]] || exit 1
  PATH="$daddyloop_payload/node/bin:$PATH" "$daddyloop_node" -e 'const fs=require("fs"),path=require("path"),cp=require("child_process"); const m=require(path.join(process.argv[1],"module.json")); const result=cp.execFileSync(path.join(process.argv[1],"bin",process.argv[2]),["--version"],{encoding:"utf8",timeout:15000}); if(result.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0]!==m.cliVersion)process.exit(1)' "$daddyloop_addon" "$daddyloop_command"
  mv -- "$daddyloop_addon" "$daddyloop_payload/modules/$daddyloop_id"
done < "$daddyloop_tmp/modules"
cp -- "$daddyloop_tmp/selection.json" "$daddyloop_payload/installed-modules.json"
if [[ -d "$daddyloop_payload/modules/claude" ]]; then
  if ! command -v bwrap >/dev/null || ! command -v socat >/dev/null; then
    daddyloop_system_packages bubblewrap socat
  fi
fi
cat "$daddyloop_tmp/selection.json" >> "$daddyloop_tmp/components"
daddyloop_signature="$(sha256sum "$daddyloop_tmp/components")"; daddyloop_signature="${daddyloop_signature%% *}"
daddyloop_destination="$daddyloop_prefix/releases/$daddyloop_version-${daddyloop_signature:0:12}"
# Different module selections are immutable variants, so they never overwrite one another.
if [[ -e "$daddyloop_destination" ]]; then
  [[ -f "$daddyloop_destination/.archive-sha256" && "$(cat "$daddyloop_destination/.archive-sha256")" = "$daddyloop_signature" ]] || { printf 'Existing version differs and was preserved.\n' >&2; exit 1; }
else
  printf '%s\n' "$daddyloop_signature" > "$daddyloop_payload/.archive-sha256"
  mv -- "$daddyloop_payload" "$daddyloop_destination"
fi
if [[ -e "$daddyloop_bin_dir/daddy" || -L "$daddyloop_bin_dir/daddy" ]]; then
  [[ -L "$daddyloop_bin_dir/daddy" && "$(readlink "$daddyloop_bin_dir/daddy")" = "$daddyloop_prefix/current/bin/daddy" ]] || { printf 'Existing daddy command preserved; choose another DADDYLOOP_BIN_DIR.\n' >&2; exit 1; }
fi
if [[ -e "$daddyloop_prefix/current" && ! -L "$daddyloop_prefix/current" ]]; then printf 'Existing current directory preserved.\n' >&2; exit 1; fi
ln -s "$daddyloop_destination" "$daddyloop_tmp/current"
mv -Tf -- "$daddyloop_tmp/current" "$daddyloop_prefix/current"
[[ -L "$daddyloop_bin_dir/daddy" ]] || ln -s "$daddyloop_prefix/current/bin/daddy" "$daddyloop_bin_dir/daddy"
printf '\nInstalled daddyloop %s: %s/daddy\n' "$daddyloop_version" "$daddyloop_bin_dir"
case ":$PATH:" in *":$daddyloop_bin_dir:"*) ;; *) printf 'Add to PATH in your shell profile: %s\n' "$daddyloop_bin_dir" ;; esac
if $daddyloop_setup; then
  if command -v sudo >/dev/null && ! sudo -n true 2>/dev/null && [[ -r /dev/tty ]]; then sudo -v < /dev/tty; fi
  daddyloop_node="$daddyloop_destination/node/bin/node"
  daddyloop_selected="$("$daddyloop_node" -e 'console.log(require(process.argv[1]).modules.join(","))' "$daddyloop_tmp/selection.json")"
  "$daddyloop_bin_dir/daddy" init --yes --modules "$daddyloop_selected"
fi
