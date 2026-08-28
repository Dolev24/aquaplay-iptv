#!/usr/bin/env bash
# build.sh — package AquaPlay IPTV as a Tizen .wgt and (optionally) install it.
#
#   ./tools/build.sh                 # build the .wgt only
#   ./tools/build.sh 192.168.1.50    # build, connect to that TV, install
#
# Requires Tizen Studio's CLI on PATH (tizen, sdb) and a signing profile
# named in TIZEN_PROFILE (default: "dev"). See README for one-time setup.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/.dist"
PROFILE="${TIZEN_PROFILE:-dev}"
TV_IP="${1:-}"

command -v tizen >/dev/null 2>&1 || {
  echo "error: 'tizen' CLI not found on PATH."
  echo "       Add <tizen-studio>/tools/ide/bin to your PATH."
  exit 1
}

echo "==> staging"
rm -rf "$DIST"
mkdir -p "$DIST"
# Ship only what the TV needs. hls.min.js, node_modules and tools stay behind.
cp "$ROOT/index.html" "$ROOT/config.xml" "$ROOT/icon.png" "$DIST/"
cp -r "$ROOT/css" "$ROOT/js" "$DIST/"

echo "==> building"
tizen build-web -e ".*" -e "node_modules/*" -e "tools/*" -- "$DIST"

echo "==> packaging (profile: $PROFILE)"
tizen package -t wgt -s "$PROFILE" -- "$DIST/.buildResult"

WGT="$(find "$DIST/.buildResult" -maxdepth 1 -name '*.wgt' | head -1)"
[ -n "$WGT" ] || { echo "error: no .wgt produced"; exit 1; }
cp "$WGT" "$ROOT/$(basename "$WGT")"
echo "==> built: $ROOT/$(basename "$WGT")"

if [ -n "$TV_IP" ]; then
  echo "==> connecting to $TV_IP"
  sdb connect "$TV_IP"
  TARGET="$(sdb devices | awk 'NR>1 && $1 != "" {print $3; exit}')"
  [ -n "$TARGET" ] || { echo "error: TV not listed by sdb. Is Developer Mode on?"; exit 1; }
  echo "==> installing to $TARGET"
  tizen install -n "$(basename "$WGT")" -t "$TARGET" -- "$DIST/.buildResult"
  echo "==> done. Launch 'AquaPlay IPTV' from the TV's Apps row."
fi
