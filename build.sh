#!/usr/bin/env bash
set -euo pipefail
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
node_version=$(tr -d '\r\n' < .node-version)
if ! [[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Invalid .node-version' >&2; exit 1
fi
case "$(uname -s)" in
  Darwin) node_os=darwin ;;
  Linux) node_os=linux ;;
  *) echo 'Use build.ps1 on Windows; this script supports macOS and Linux.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  arm64|aarch64) node_arch=arm64 ;;
  *) echo 'Unsupported CPU architecture' >&2; exit 1 ;;
esac
check_only=false
for argument in "$@"; do if [ "$argument" = '--check' ]; then check_only=true; fi; done
node_directory="$PWD/.build-tools/node/node-v$node_version-$node_os-$node_arch"
node_executable="$node_directory/bin/node"
if command -v node >/dev/null 2>&1 && [ "$(node --version)" = "v$node_version" ] && [ "$(node -p 'process.arch')" = "$node_arch" ] && command -v npm >/dev/null 2>&1; then
  node_executable=$(command -v node)
elif [ ! -x "$node_executable" ]; then
  if "$check_only"; then echo "Node $node_version is not prepared. Run bash build.sh without --check." >&2; exit 1; fi
  command -v curl >/dev/null 2>&1 || { echo 'Install curl with your OS package manager, then rerun this script.' >&2; exit 1; }
  archive_name="node-v$node_version-$node_os-$node_arch.tar.gz"
  release_url="https://nodejs.org/dist/v$node_version"
  mkdir -p .build-tools/downloads .build-tools/node
  echo "Preparing official Node $node_version (SHA-256 verified)..."
  curl --fail --location --connect-timeout 20 --max-time 120 --proto '=https' --tlsv1.2 "$release_url/SHASUMS256.txt" -o .build-tools/downloads/SHASUMS256.txt
  expected=$(awk -v name="$archive_name" '$2 == name { print $1 }' .build-tools/downloads/SHASUMS256.txt)
  if ! [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]]; then echo 'No official Node archive checksum found' >&2; exit 1; fi
  archive_path=".build-tools/downloads/$archive_name"
  checksum() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
  }
  if [ ! -f "$archive_path" ] || [ "$(checksum "$archive_path")" != "$expected" ]; then
    curl --fail --location --connect-timeout 20 --max-time 180 --proto '=https' --tlsv1.2 "$release_url/$archive_name" -o "$archive_path"
  fi
  if [ "$(checksum "$archive_path")" != "$expected" ]; then echo 'Node checksum mismatch. Nothing was executed.' >&2; exit 1; fi
  tar -xzf "$archive_path" -C .build-tools/node
fi
if [ "$("$node_executable" --version)" != "v$node_version" ]; then echo 'Cached Node version does not match .node-version' >&2; exit 1; fi
export PATH="$(dirname "$node_executable"):$PATH"
export NEXO_NODE_BINARY="$node_executable"
exec "$node_executable" tools/bootstrap/build.mjs "$@"
