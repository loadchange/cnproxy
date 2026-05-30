#!/bin/bash
# Build the cnproxy sidecar binary for the current platform (Node.js / @yao-pkg/pkg).
# Places it in cnproxy-app/src-tauri/binaries/ with the Tauri target-triple naming.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BINDIR="${ROOT_DIR}/cnproxy-app/src-tauri/binaries"
DIST="${ROOT_DIR}/dist"

OS=$(uname -s)
ARCH=$(uname -m)

case "$OS" in
  Darwin) TRIPLE_OS="apple-darwin";    PKG_OS="macos" ;;
  Linux)  TRIPLE_OS="unknown-linux-gnu"; PKG_OS="linux" ;;
  *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64)        TRIPLE_ARCH="x86_64";  PKG_ARCH="x64" ;;
  arm64|aarch64) TRIPLE_ARCH="aarch64"; PKG_ARCH="arm64" ;;
  *)             echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

TARGET="${TRIPLE_ARCH}-${TRIPLE_OS}"
PKG_TARGET="node22-${PKG_OS}-${PKG_ARCH}"
mkdir -p "$BINDIR"

echo "Building cnproxy sidecar for ${TARGET} (${PKG_TARGET})..."
cd "$ROOT_DIR"

# Bundle + compile a native single-file binary for this platform only.
node scripts/build.mjs --pkg --targets "$PKG_TARGET"

# pkg names the output after the bundle basename (cnproxy.cjs → cnproxy).
SRC_BIN="${DIST}/cnproxy"
[ -f "${DIST}/cnproxy.exe" ] && SRC_BIN="${DIST}/cnproxy.exe"

cp "$SRC_BIN" "$BINDIR/cnproxy-$TARGET"
chmod +x "$BINDIR/cnproxy-$TARGET"
echo "Done: $BINDIR/cnproxy-$TARGET"
