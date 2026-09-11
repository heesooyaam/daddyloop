#!/usr/bin/env bash
set -euo pipefail
umask 077
daddyloop_version="0.11.0"
daddyloop_default_prefix="$HOME/.local/share/daddyloop"
daddyloop_prefix="${DADDYLOOP_INSTALL_DIR:-$daddyloop_default_prefix}"
daddyloop_bin_dir="${DADDYLOOP_BIN_DIR:-$HOME/.local/bin}"
daddyloop_base="${DADDYLOOP_DOWNLOAD_BASE:-https://github.com/heesooyaam/daddyloop/releases/download/v$daddyloop_version}"
daddyloop_setup=true
daddyloop_yes=false
for daddyloop_arg in "$@"; do
  case "$daddyloop_arg" in
    --no-setup) daddyloop_setup=false ;;
    --yes) daddyloop_yes=true ;;
    --help) printf 'Install daddyloop, the daddy CLI and bundled Node/Codex/GitHub tools.\nOptions: --yes (default setup), --no-setup (files only)\n'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$daddyloop_arg" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" = Linux ]] || { printf 'The managed server release currently supports Linux. Use the web panel from other devices.\n' >&2; exit 1; }
case "$(uname -m)" in x86_64) daddyloop_arch=x64 ;; aarch64|arm64) daddyloop_arch=arm64 ;; *) printf 'Unsupported architecture\n' >&2; exit 1 ;; esac
command -v curl >/dev/null || { printf 'curl is required to download the release.\n' >&2; exit 1; }
command -v tar >/dev/null || { printf 'tar is required to unpack the release.\n' >&2; exit 1; }
if ! command -v git >/dev/null; then
  if command -v apt-get >/dev/null && command -v sudo >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends git ca-certificates
  else printf 'Git is required; install it with your system package manager and rerun this command.\n' >&2; exit 1; fi
fi
mkdir -p "$daddyloop_prefix/releases" "$daddyloop_bin_dir"
daddyloop_lock="$daddyloop_prefix/.install-lock"
mkdir "$daddyloop_lock" 2>/dev/null || { printf 'An installation lock exists: %s\n' "$daddyloop_lock" >&2; exit 1; }
daddyloop_tmp=""
trap '[[ -z "$daddyloop_tmp" ]] || rm -rf -- "$daddyloop_tmp"; rmdir -- "$daddyloop_lock"' EXIT
daddyloop_tmp="$(mktemp -d "$daddyloop_prefix/releases/.install-XXXXXXXX")"
daddyloop_asset="daddyloop-linux-$daddyloop_arch.tar.gz"
curl -fL --retry 3 --connect-timeout 20 "$daddyloop_base/$daddyloop_asset" -o "$daddyloop_tmp/$daddyloop_asset"
curl -fL --retry 3 --connect-timeout 20 "$daddyloop_base/$daddyloop_asset.sha256" -o "$daddyloop_tmp/checksum"
daddyloop_expected="$(awk '{print $1; exit}' "$daddyloop_tmp/checksum")"
daddyloop_actual="$(sha256sum "$daddyloop_tmp/$daddyloop_asset")"
daddyloop_actual="${daddyloop_actual%% *}"
[[ "$daddyloop_expected" = "$daddyloop_actual" ]] || { printf 'Release checksum mismatch; installation stopped.\n' >&2; exit 1; }
tar -tzf "$daddyloop_tmp/$daddyloop_asset" > "$daddyloop_tmp/entries"
while IFS= read -r daddyloop_entry; do
  case "$daddyloop_entry" in daddyloop|daddyloop/*) ;; *) printf 'Invalid archive root\n' >&2; exit 1 ;; esac
  case "/$daddyloop_entry/" in *'/../'*) printf 'Invalid archive path\n' >&2; exit 1 ;; esac
done < "$daddyloop_tmp/entries"
tar -xzf "$daddyloop_tmp/$daddyloop_asset" -C "$daddyloop_tmp"
daddyloop_payload="$daddyloop_tmp/daddyloop"
daddyloop_installed_version="$("$daddyloop_payload/bin/daddy" --version)"
[[ "$daddyloop_installed_version" = "$daddyloop_version" ]] || { printf 'Release version mismatch\n' >&2; exit 1; }
daddyloop_destination="$daddyloop_prefix/releases/$daddyloop_version"
if [[ -e "$daddyloop_destination" ]]; then
  [[ -f "$daddyloop_destination/.archive-sha256" ]] && [[ "$(cat "$daddyloop_destination/.archive-sha256")" = "$daddyloop_expected" ]] || { printf 'Existing version differs and was preserved. Install a new version instead of overwriting it.\n' >&2; exit 1; }
else
  printf '%s\n' "$daddyloop_expected" > "$daddyloop_payload/.archive-sha256"
  mv -- "$daddyloop_payload" "$daddyloop_destination"
fi
for daddyloop_command in daddy; do
  if [[ -e "$daddyloop_bin_dir/$daddyloop_command" || -L "$daddyloop_bin_dir/$daddyloop_command" ]]; then
    [[ -L "$daddyloop_bin_dir/$daddyloop_command" && "$(readlink "$daddyloop_bin_dir/$daddyloop_command")" = "$daddyloop_prefix/current/bin/daddy" ]] || { printf 'Existing %s command preserved; choose another DADDYLOOP_BIN_DIR.\n' "$daddyloop_command" >&2; exit 1; }
  fi
done
if [[ -e "$daddyloop_prefix/current" && ! -L "$daddyloop_prefix/current" ]]; then printf 'Existing non-symlink current directory preserved.\n' >&2; exit 1; fi
ln -s "$daddyloop_destination" "$daddyloop_tmp/current"
mv -Tf -- "$daddyloop_tmp/current" "$daddyloop_prefix/current"
for daddyloop_command in daddy; do
  if [[ ! -L "$daddyloop_bin_dir/$daddyloop_command" ]]; then ln -s "$daddyloop_prefix/current/bin/daddy" "$daddyloop_bin_dir/$daddyloop_command"; fi
done
printf '\nInstalled daddyloop %s: %s/daddy\n' "$daddyloop_version" "$daddyloop_bin_dir"
case ":$PATH:" in *":$daddyloop_bin_dir:"*) ;; *) printf 'Add this directory to PATH in your shell profile: %s\n' "$daddyloop_bin_dir" ;; esac
if $daddyloop_setup; then
  if command -v sudo >/dev/null && ! sudo -n true 2>/dev/null && [[ -r /dev/tty ]]; then
    printf 'One-time administrator authentication is needed to install the persistent service.\n'
    sudo -v < /dev/tty
  fi
  if $daddyloop_yes; then "$daddyloop_bin_dir/daddy" init --yes
  elif [[ -r /dev/tty ]]; then "$daddyloop_bin_dir/daddy" init < /dev/tty
  else "$daddyloop_bin_dir/daddy" init --yes; fi
fi
