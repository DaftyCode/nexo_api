#!/usr/bin/env bash
# Installs the Nexo API web version on this computer and starts it.
#
# The first run prepares Node, Rust and the dependencies (through build.sh), builds the web
# site and the API server, starts both in the background and opens the browser. Later runs
# start the installed version directly, rebuilding only when the sources changed.
#
#   bash install-web.sh             install if needed, start and open the browser
#   bash install-web.sh --stop      stop the background services
#   bash install-web.sh --status    show whether it is running
#   bash install-web.sh --rebuild   rebuild before starting
#   bash install-web.sh --no-open   do not open the browser
set -euo pipefail
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

version=$(tr -d '\r\n' < .node-version)
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo 'On Windows run: .\install-web.ps1' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo 'Unsupported CPU architecture' >&2; exit 1 ;;
esac

find_node() {
  local prepared="$PWD/.build-tools/node/node-v$version-$os-$arch/bin/node"
  if [ -x "$prepared" ]; then echo "$prepared"; return; fi
  if command -v node >/dev/null 2>&1 && [ "$(node --version)" = "v$version" ] && command -v npm >/dev/null 2>&1; then
    command -v node
  fi
}

node="$(find_node || true)"
cargo_ok=false
if [ -x "$HOME/.cargo/bin/cargo" ] || command -v cargo >/dev/null 2>&1; then cargo_ok=true; fi
case " $* " in
  *" --stop "*|*" --status "*) ;;
  *)
    if [ -z "$node" ] || [ ! -f node_modules/.package-lock.json ] || ! "$cargo_ok"; then
      echo 'Preparing Node, Rust and dependencies (first run only)...'
      bash build.sh --prepare-only
      node="$(find_node || true)"
    fi
    ;;
esac
if [ -z "$node" ]; then
  echo "Node $version is not available. Run: bash build.sh --prepare-only" >&2
  exit 1
fi
export PATH="$(dirname "$node"):$HOME/.cargo/bin:$PATH"
exec "$node" tools/install/web.mjs "$@"
