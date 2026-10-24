#!/usr/bin/env bash
# Install dependencies and build the app for the host platform.
# Usage: ./build_install.sh [platform] [arch]   (both default to the host)
# Builds only the unpacked app in builds/; DIST=1 also makes the installers
# (.dmg/.zip, NSIS/portable, AppImage). A host-platform build also replaces the
# installed app and relaunches it; INSTALL=0 builds only.

set -Eeuo pipefail
trap 'echo ":: ERROR: build_install.sh failed at line $LINENO (exit $?)" >&2' ERR

cd "$(dirname "$0")"

if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo "Do not run this script as root." >&2
  exit 1
fi

detect_platform() {
  case "$(uname -s)" in
  Darwin) echo "mac" ;;
  Linux)
    # WSL builds the Windows target, since that is the app the user runs.
    if grep -qEi "(microsoft|wsl)" /proc/version 2>/dev/null; then echo "win"; else echo "linux"; fi
    ;;
  MINGW* | MSYS* | CYGWIN*) echo "win" ;;
  *) echo "unknown" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
  arm64 | aarch64) echo "arm64" ;;
  x86_64 | amd64) echo "x64" ;;
  *) echo "unknown" ;;
  esac
}

platform="${1:-$(detect_platform)}"
arch="${2:-$(detect_arch)}"

if [ "$platform" = "unknown" ] || [ "$arch" = "unknown" ]; then
  echo "Could not detect platform/arch ($(uname -s) $(uname -m))." >&2
  echo "Pass them explicitly: ./build_install.sh <mac|win|linux> <x64|arm64>" >&2
  exit 1
fi

echo ":: Building InstantCognition for $platform/$arch"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.22 or newer is required and was not found on PATH." >&2
  echo "Install it from https://nodejs.org or your package manager, then re-run." >&2
  exit 1
fi

# The build and test tooling (electron-packager, jsdom) needs 22.22+.
node_ok="$(node -p 'const [a, b] = process.versions.node.split(".").map(Number); a > 22 || (a === 22 && b >= 22)')"
if [ "$node_ok" != "true" ]; then
  echo "Node.js $(node -v) is too old; this project needs 22.22 or newer." >&2
  exit 1
fi

echo ":: Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# Ship on the newest patch of the Electron major package.json names, not the
# exact lockfile pin; moving to a new major is a package.json edit. This
# rewrites package.json and package-lock.json, and the launch smoke below gates
# it. Set ELECTRON_PIN=1 for a reproducible build at the pinned version.
if [ "${ELECTRON_PIN:-0}" != "1" ]; then
  electron_major=$(node -p "require('./package.json').devDependencies.electron.replace(/^[^0-9]*/, '').split('.')[0]")
  echo ":: Updating Electron to the newest $electron_major.x release"
  npm install --save-dev "electron@$electron_major"
  echo ":: Electron $(node -p 'require("electron/package.json").version')"
fi

echo ":: Building stylesheets"
npm run build-css

echo ":: Bundling the renderer"
node scripts/build-renderer.js

echo ":: Verifying the app launches"
if [ "$platform" = "linux" ] && [ -z "${DISPLAY:-}" ]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run --auto-servernum npm run test:e2e:app
  else
    echo ":: SMOKE: N/A -- headless host without xvfb-run; launch was not verified"
  fi
else
  npm run test:e2e:app
fi

# Each build-* script ends in electron-builder, so the extra args land on it.
# --dir stops after the unpacked app, skipping the slow installer packaging.
builder_args=()
if [ "${DIST:-0}" != "1" ]; then
  builder_args=(-- --dir)
  echo ":: Building the unpacked app only (DIST=1 for installers)"
fi

case "$platform" in
mac)
  if [ "$arch" = "arm64" ]; then npm run build-mac-arm ${builder_args[@]+"${builder_args[@]}"}; else npm run build-mac-x64 ${builder_args[@]+"${builder_args[@]}"}; fi
  ;;
win)
  npm run build-win ${builder_args[@]+"${builder_args[@]}"}
  ;;
linux)
  if [ "$arch" = "arm64" ]; then npm run build-linux-arm64 ${builder_args[@]+"${builder_args[@]}"}; else npm run build-linux-x64 ${builder_args[@]+"${builder_args[@]}"}; fi
  ;;
esac

echo ":: Artifacts are in builds/"

# Replace the installed copy and restart it. Only for a build that targets this
# machine, and never in CI, where there is nothing to restart.
host_platform="$(detect_platform)"
host_arch="$(detect_arch)"

quit_installed_app() {
  # Match the installed executable path, not the string "InstantCognition":
  # a bare -f match hits any process whose command line mentions the repo,
  # including the shell running this script.
  local exec_path="$1/Contents/MacOS/InstantCognition"
  osascript -e 'quit app "InstantCognition"' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "^${exec_path}" >/dev/null 2>&1 || return 0
    sleep 1
  done
  echo ":: App did not quit on request; stopping it"
  pkill -f "^${exec_path}" >/dev/null 2>&1 || true
  sleep 2
}

mac_apps_dir() {
  local user_apps="$HOME/Applications" system_apps="/Applications"
  if [ -d "$user_apps" ] && [ -w "$user_apps" ]; then
    echo "$user_apps"
  elif [ -w "$system_apps" ]; then
    echo "$system_apps"
  else
    mkdir -p "$user_apps"
    echo "$user_apps"
  fi
}

install_mac_app() {
  local src=""
  for candidate in "builds/mac-$arch" "builds/mac"; do
    if [ -d "$candidate/InstantCognition.app" ]; then
      src="$candidate/InstantCognition.app"
      break
    fi
  done
  if [ -z "$src" ]; then
    echo ":: INSTALL: N/A -- no InstantCognition.app under builds/; nothing to install" >&2
    return 0
  fi

  local apps_path
  apps_path="$(mac_apps_dir)"
  local dest="$apps_path/InstantCognition.app"

  quit_installed_app "$dest"

  echo ":: Installing to $dest"
  rm -rf "$dest"
  # ditto, not cp: it preserves the code signature and extended attributes that
  # a plain copy strips, which Gatekeeper then rejects.
  ditto "$src" "$dest"

  # Ad-hoc re-sign: copying between volumes can invalidate the signature, and an
  # invalid one makes macOS refuse to launch the app.
  echo ":: Re-signing $dest"
  codesign --force --deep --sign - "$dest" 2>/dev/null || echo ":: WARNING: re-signing failed"
  codesign --verify --deep --strict "$dest" 2>/dev/null && echo ":: Code signature OK" || echo ":: WARNING: code signature verification failed"

  echo ":: Launching $dest"
  open "$dest"
}

windows_desktop_dir() {
  local user="${WINDOWS_USER:-}"
  if [ -z "$user" ] && [ -x /mnt/c/Windows/System32/cmd.exe ]; then
    user="$(cd /mnt/c && cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r\n')"
  fi
  [ -n "$user" ] || return 1
  for candidate in "/mnt/c/Users/$user/OneDrive/Desktop" "/mnt/c/Users/$user/Desktop"; do
    if [ -d "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

install_win_app() {
  local src="builds/win-unpacked"
  [ -d "$src" ] || src="builds/win-unpacked-$arch"
  if [ ! -d "$src" ]; then
    echo ":: INSTALL: N/A -- no unpacked Windows build under builds/; nothing to install" >&2
    return 0
  fi

  local desktop
  if ! desktop="$(windows_desktop_dir)"; then
    echo ":: INSTALL: N/A -- could not locate the Windows Desktop; set WINDOWS_USER to the account name" >&2
    return 0
  fi

  local dest="$desktop/InstantCognition"
  echo ":: Stopping any running InstantCognition.exe"
  /mnt/c/Windows/System32/taskkill.exe /F /IM InstantCognition.exe >/dev/null 2>&1 || true
  sleep 3

  echo ":: Installing to $dest"
  mkdir -p "$dest"
  cp -rf "$src"/* "$dest/"

  # The exe resolves its resources relative to the working directory, so it is
  # launched through a .bat that cd's into the install first.
  local launcher="$dest/launch.bat"
  {
    echo "@echo off"
    echo "cd /d \"%~dp0\""
    echo "start \"\" \"InstantCognition.exe\""
    echo "exit"
  } >"$launcher"

  echo ":: Launching $dest/InstantCognition.exe"
  (cd /mnt/c && cmd.exe /c "$(wslpath -w "$launcher")" >/dev/null 2>&1) &
}

if [ "${INSTALL:-1}" = "0" ]; then
  echo ":: INSTALL: skipped (INSTALL=0)"
elif [ -n "${CI:-}" ]; then
  echo ":: INSTALL: N/A -- CI run"
elif [ "$platform" != "$host_platform" ] || [ "$arch" != "$host_arch" ]; then
  echo ":: INSTALL: N/A -- built $platform/$arch on $host_platform/$host_arch"
elif [ "$platform" = "mac" ]; then
  install_mac_app
elif [ "$platform" = "win" ]; then
  install_win_app
else
  echo ":: INSTALL: N/A -- no install step defined for $platform"
fi

echo ":: Done."
