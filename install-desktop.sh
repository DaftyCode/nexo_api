#!/usr/bin/env bash
# Builds the Nexo API desktop app for this computer and installs it without opening an
# installer: through APT, DNF or Zypper on Linux and by copying the app on macOS.
#
#   bash install-desktop.sh                     build and install
#   bash install-desktop.sh --package <file>    install an existing .deb, .rpm, .AppImage or .app
#   bash install-desktop.sh --no-launch         do not start the app afterwards
#   bash install-desktop.sh --skip-system-install   use already installed build prerequisites
set -euo pipefail
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

package=''
launch=true
build_options=()
while [ $# -gt 0 ]; do
  case "$1" in
    --package) package="${2:?--package needs a file}"; shift 2 ;;
    --no-launch) launch=false; shift ;;
    --skip-system-install) build_options+=(--skip-system-install); shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}
newest() {
  # Newest file matching a glob, or nothing.
  ls -t $1 2>/dev/null | head -n 1 || true
}

case "$(uname -s)" in
  Darwin)
    if [ -z "$package" ]; then
      echo 'Building the macOS application for this computer...'
      APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}" bash build.sh --bundles app ${build_options[@]+"${build_options[@]}"}
      package='target/release/bundle/macos/Nexo API.app'
    fi
    [ -d "$package" ] || { echo "Application not found: $package" >&2; exit 1; }
    destination=/Applications
    [ -w "$destination" ] || { destination="$HOME/Applications"; mkdir -p "$destination"; }
    echo "Installing into $destination..."
    rm -rf "$destination/Nexo API.app"
    ditto "$package" "$destination/Nexo API.app"
    # A locally built app is trusted; remove the quarantine flag set if it was copied from elsewhere.
    xattr -dr com.apple.quarantine "$destination/Nexo API.app" 2>/dev/null || true
    echo "Nexo API is installed in $destination."
    if "$launch"; then open "$destination/Nexo API.app"; fi
    ;;
  Linux)
    if command -v apt-get >/dev/null 2>&1; then format=deb
    elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then format=rpm
    else format=appimage
    fi
    if [ -z "$package" ]; then
      echo "Building the $format package for this computer..."
      NO_STRIP="${NO_STRIP:-true}" bash build.sh --bundles "$format" ${build_options[@]+"${build_options[@]}"}
      package="$(newest "target/release/bundle/$format/*.$( [ "$format" = appimage ] && echo AppImage || echo "$format")")"
    fi
    [ -n "$package" ] && [ -f "$package" ] || { echo 'No package was produced. Check the build output above.' >&2; exit 1; }
    package="$(cd "$(dirname "$package")" && pwd)/$(basename "$package")"
    case "$package" in
      *.deb)
        echo "Installing $package with APT..."
        as_root apt-get install -y "$package"
        ;;
      *.rpm)
        if command -v dnf >/dev/null 2>&1; then
          echo "Installing $package with DNF..."
          as_root dnf install -y "$package"
        else
          echo "Installing $package with Zypper..."
          as_root zypper --non-interactive install --allow-unsigned-rpm "$package"
        fi
        ;;
      *.AppImage)
        target="$HOME/.local/bin/nexo-api.AppImage"
        mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
        install -m 0755 "$package" "$target"
        cat > "$HOME/.local/share/applications/nexo-api.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Nexo API
Exec=$target
Categories=Development;
DESKTOP
        echo "Nexo API is installed in $target."
        ;;
      *) echo "Unsupported package: $package" >&2; exit 1 ;;
    esac
    echo 'Nexo API is installed.'
    if "$launch"; then
      # The executable the package installed in /usr/bin, whatever its name.
      binary=''
      case "$package" in
        *.deb) binary="$(dpkg -L "$(dpkg-deb -f "$package" Package)" 2>/dev/null | grep '^/usr/bin/' | head -n 1 || true)" ;;
        *.rpm) binary="$(rpm -qlp "$package" 2>/dev/null | grep '^/usr/bin/' | head -n 1 || true)" ;;
      esac
      [ -n "$binary" ] || binary="${target:-}"
      if [ -n "$binary" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        nohup "$binary" >/dev/null 2>&1 &
      fi
    fi
    ;;
  *)
    echo 'On Windows run: .\install-desktop.ps1' >&2
    exit 1
    ;;
esac
