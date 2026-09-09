#!/usr/bin/env bash
set -euo pipefail
umask 077
reviewloop_version="0.4.2"
reviewloop_prefix="${REVIEWLOOP_INSTALL_DIR:-$HOME/.local/share/reviewloop}"
reviewloop_bin_dir="${REVIEWLOOP_BIN_DIR:-$HOME/.local/bin}"
reviewloop_base="${REVIEWLOOP_DOWNLOAD_BASE:-https://github.com/heesooyaam/reviewloop/releases/download/v$reviewloop_version}"
reviewloop_setup=true
reviewloop_yes=false
for reviewloop_arg in "$@"; do
  case "$reviewloop_arg" in
    --no-setup) reviewloop_setup=false ;;
    --yes) reviewloop_yes=true ;;
    --help) printf 'Install Reviewloop, its CLI and bundled Node/Codex/GitHub tools.\nOptions: --yes (default setup), --no-setup (files only)\n'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$reviewloop_arg" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" = Linux ]] || { printf 'The managed server release currently supports Linux. Use the web panel from other devices.\n' >&2; exit 1; }
case "$(uname -m)" in x86_64) reviewloop_arch=x64 ;; aarch64|arm64) reviewloop_arch=arm64 ;; *) printf 'Unsupported architecture\n' >&2; exit 1 ;; esac
command -v curl >/dev/null || { printf 'curl is required to download the release.\n' >&2; exit 1; }
command -v tar >/dev/null || { printf 'tar is required to unpack the release.\n' >&2; exit 1; }
if ! command -v git >/dev/null; then
  if command -v apt-get >/dev/null && command -v sudo >/dev/null; then
    sudo apt-get update
    sudo apt-get install -y --no-install-recommends git ca-certificates
  else printf 'Git is required; install it with your system package manager and rerun this command.\n' >&2; exit 1; fi
fi
mkdir -p "$reviewloop_prefix/releases" "$reviewloop_bin_dir"
reviewloop_lock="$reviewloop_prefix/.install-lock"
mkdir "$reviewloop_lock" 2>/dev/null || { printf 'An installation lock exists: %s\n' "$reviewloop_lock" >&2; exit 1; }
reviewloop_tmp=""
trap '[[ -z "$reviewloop_tmp" ]] || rm -rf -- "$reviewloop_tmp"; rmdir -- "$reviewloop_lock"' EXIT
reviewloop_tmp="$(mktemp -d "$reviewloop_prefix/releases/.install-XXXXXXXX")"
reviewloop_asset="reviewloop-linux-$reviewloop_arch.tar.gz"
curl -fL --retry 3 --connect-timeout 20 "$reviewloop_base/$reviewloop_asset" -o "$reviewloop_tmp/$reviewloop_asset"
curl -fL --retry 3 --connect-timeout 20 "$reviewloop_base/$reviewloop_asset.sha256" -o "$reviewloop_tmp/checksum"
reviewloop_expected="$(awk '{print $1; exit}' "$reviewloop_tmp/checksum")"
reviewloop_actual="$(sha256sum "$reviewloop_tmp/$reviewloop_asset")"
reviewloop_actual="${reviewloop_actual%% *}"
[[ "$reviewloop_expected" = "$reviewloop_actual" ]] || { printf 'Release checksum mismatch; installation stopped.\n' >&2; exit 1; }
tar -tzf "$reviewloop_tmp/$reviewloop_asset" > "$reviewloop_tmp/entries"
while IFS= read -r reviewloop_entry; do
  case "$reviewloop_entry" in reviewloop|reviewloop/*) ;; *) printf 'Invalid archive root\n' >&2; exit 1 ;; esac
  case "/$reviewloop_entry/" in *'/../'*) printf 'Invalid archive path\n' >&2; exit 1 ;; esac
done < "$reviewloop_tmp/entries"
tar -xzf "$reviewloop_tmp/$reviewloop_asset" -C "$reviewloop_tmp"
reviewloop_payload="$reviewloop_tmp/reviewloop"
reviewloop_installed_version="$("$reviewloop_payload/bin/reviewctl" --version)"
[[ "$reviewloop_installed_version" = "$reviewloop_version" ]] || { printf 'Release version mismatch\n' >&2; exit 1; }
reviewloop_destination="$reviewloop_prefix/releases/$reviewloop_version"
if [[ -e "$reviewloop_destination" ]]; then
  [[ -f "$reviewloop_destination/.archive-sha256" ]] && [[ "$(cat "$reviewloop_destination/.archive-sha256")" = "$reviewloop_expected" ]] || { printf 'Existing version differs and was preserved. Install a new version instead of overwriting it.\n' >&2; exit 1; }
else
  printf '%s\n' "$reviewloop_expected" > "$reviewloop_payload/.archive-sha256"
  mv -- "$reviewloop_payload" "$reviewloop_destination"
fi
if [[ -e "$reviewloop_bin_dir/reviewctl" || -L "$reviewloop_bin_dir/reviewctl" ]]; then
  [[ -L "$reviewloop_bin_dir/reviewctl" && "$(readlink "$reviewloop_bin_dir/reviewctl")" = "$reviewloop_prefix/current/bin/reviewctl" ]] || { printf 'Existing reviewctl command preserved; choose another REVIEWLOOP_BIN_DIR.\n' >&2; exit 1; }
fi
if [[ -e "$reviewloop_prefix/current" && ! -L "$reviewloop_prefix/current" ]]; then printf 'Existing non-symlink current directory preserved.\n' >&2; exit 1; fi
ln -s "$reviewloop_destination" "$reviewloop_tmp/current"
mv -Tf -- "$reviewloop_tmp/current" "$reviewloop_prefix/current"
if [[ ! -L "$reviewloop_bin_dir/reviewctl" ]]; then ln -s "$reviewloop_prefix/current/bin/reviewctl" "$reviewloop_bin_dir/reviewctl"; fi
printf '\nInstalled Reviewloop %s: %s/reviewctl\n' "$reviewloop_version" "$reviewloop_bin_dir"
case ":$PATH:" in *":$reviewloop_bin_dir:"*) ;; *) printf 'Add this directory to PATH in your shell profile: %s\n' "$reviewloop_bin_dir" ;; esac
if $reviewloop_setup; then
  if command -v sudo >/dev/null && ! sudo -n true 2>/dev/null && [[ -r /dev/tty ]]; then
    printf 'One-time administrator authentication is needed to install the persistent service.\n'
    sudo -v < /dev/tty
  fi
  if $reviewloop_yes; then "$reviewloop_bin_dir/reviewctl" init --yes
  elif [[ -r /dev/tty ]]; then "$reviewloop_bin_dir/reviewctl" init < /dev/tty
  else "$reviewloop_bin_dir/reviewctl" init --yes; fi
fi
