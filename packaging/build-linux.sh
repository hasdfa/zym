#!/usr/bin/env bash
#
# Host-side driver for the Linux AppImage build. Spins up an ubuntu:24.04
# container and runs packaging/linux/build-appimage.sh inside it, dropping the
# resulting AppImage into ./dist (override with $OUT_DIR).
#
# Plain usage (machine with Docker + internet):
#     packaging/build-linux.sh
#
# Optional environment:
#   OUT_DIR         where to write the AppImage           (default: <repo>/dist)
#   ZYM_TOOLS_DIR   dir with cached appimagetool.AppImage / runtime-x86_64 /
#                   excludelist / node tarball, to avoid re-downloading
#   ZYM_CA_FILE     extra CA cert to trust inside the container (proxied envs)
#   HTTPS_PROXY     forwarded to the container; also switches it to --network host
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist}"
# ZYM_BASE_IMAGE lets a CI/dev setup point at a prebaked image (apt deps + Node
# already installed) to skip the slow provisioning; defaults to stock Ubuntu.
# ubuntu:26.04 is required: zym uses the GtkSourceView 5.18 annotation API, which
# older Ubuntu releases (24.04 = 5.12) do not ship. See docs/packaging.md.
IMAGE="${ZYM_BASE_IMAGE:-ubuntu:26.04}"
mkdir -p "$OUT_DIR"

args=(--rm
  -v "$REPO:/src:ro"
  -v "$OUT_DIR:/out"
  -e "NODE_VERSION=${NODE_VERSION:-22.22.2}"
  -e "NODE_GTK_VERSION=${NODE_GTK_VERSION:-3.0.0}")

[[ -n "${ZYM_TOOLS_DIR:-}" ]] && args+=(-v "$ZYM_TOOLS_DIR:/tools:ro")
[[ -n "${ZYM_CA_FILE:-}" ]]   && args+=(-v "$ZYM_CA_FILE:/ca.crt:ro")
if [[ -n "${HTTPS_PROXY:-}" ]]; then
  # The egress proxy listens on the host loopback; share its net namespace.
  args+=(--network host -e "HTTPS_PROXY=$HTTPS_PROXY")
fi

echo "==> Building zym AppImage into $OUT_DIR"
docker run "${args[@]}" "$IMAGE" bash /src/packaging/linux/build-appimage.sh
echo "==> Done:"
ls -la "$OUT_DIR"/*.AppImage
