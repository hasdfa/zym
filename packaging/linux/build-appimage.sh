#!/usr/bin/env bash
#
# Build a self-contained zym AppImage for Linux/x86_64.
#
# Runs inside an ubuntu:26.04 container (see packaging/build-linux.sh for the
# host-side wrapper). 26.04 is required for GtkSourceView 5.18 (the annotation
# API zym uses). zym is run straight from TypeScript source via node-gtk's
# `gi:` import hooks, so this does not "compile" the app — it installs the GTK
# stack, builds the native node-gtk addon, then bundles node + the app + the
# whole GTK/GObject-Introspection runtime into an AppImage.
#
# See docs/packaging.md for the why behind each step.
#
# Inputs (bind-mounted by the wrapper):
#   /src        repo (read-only)
#   /out        output directory for the .AppImage
#   /tools      cached appimagetool / runtime-x86_64 / excludelist / node tarball (optional)
#   /ca.crt     extra CA certificate (optional; for proxied sandboxes)
# Env:
#   HTTPS_PROXY   optional; when set, apt + curl + npm are routed through it
#   NODE_VERSION  Node.js to bundle (default 22.22.2)
#
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.22.2}"
NODE_GTK_VERSION="${NODE_GTK_VERSION:-3.0.0}"
ARCH="x86_64"
TRIPLET="x86_64-linux-gnu"
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 0. Network plumbing (only meaningful inside a proxied sandbox; a no-op when
#    HTTPS_PROXY is unset, i.e. a normal build host with direct internet).
# ---------------------------------------------------------------------------
if [[ -n "${HTTPS_PROXY:-}" ]]; then
  log "Routing apt/curl/npm through $HTTPS_PROXY"
  export https_proxy="$HTTPS_PROXY"
  # The egress proxy only tunnels HTTPS CONNECT, so use https apt mirrors.
  sed -i 's|http://archive.ubuntu.com|https://archive.ubuntu.com|g; s|http://security.ubuntu.com|https://security.ubuntu.com|g' \
    /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true
  {
    echo "Acquire::https::Proxy \"$HTTPS_PROXY\";"
    [[ -f /ca.crt ]] && echo 'Acquire::https::CaInfo "/ca.crt";'
  } > /etc/apt/apt.conf.d/01proxy
fi
if [[ -f /ca.crt ]]; then
  export NODE_EXTRA_CA_CERTS=/ca.crt SSL_CERT_FILE=/ca.crt CURL_CA_BUNDLE=/ca.crt
  export npm_config_cafile=/ca.crt
fi

# ---------------------------------------------------------------------------
# 1. Build + runtime dependencies.
# ---------------------------------------------------------------------------
log "Installing GTK stack and build tooling via apt"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential pkg-config python3 ca-certificates curl xz-utils file zsync squashfs-tools \
  libgtk-4-dev libadwaita-1-dev libgtksourceview-5-dev libvte-2.91-gtk4-dev \
  gobject-introspection libgirepository1.0-dev \
  libx11-dev libxkbfile-dev \
  librsvg2-common librsvg2-bin libglib2.0-bin gsettings-desktop-schemas \
  adwaita-icon-theme hicolor-icon-theme shared-mime-info desktop-file-utils

# ---------------------------------------------------------------------------
# 2. Node.js (prefer a cached tarball; else download the official build).
# ---------------------------------------------------------------------------
NODE_DIR="/opt/node-v${NODE_VERSION}-linux-x64"
if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  log "Installing Node.js v$NODE_VERSION"
  TARBALL="/tools/node-v${NODE_VERSION}-linux-x64.tar.xz"
  if [[ ! -f "$TARBALL" ]]; then
    TARBALL="/tmp/node.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$TARBALL"
  fi
  tar -xf "$TARBALL" -C /opt
fi
export PATH="$NODE_DIR/bin:$PATH"
corepack enable 2>/dev/null || npm i -g pnpm@10 >/dev/null 2>&1
node --version

# ---------------------------------------------------------------------------
# 3. Install zym dependencies and run its codegen.
#    The dev tree links node-gtk from a local sibling checkout (../node-gtk);
#    that isn't available off a contributor's machine, so for releases we pin
#    the published node-gtk that matches zym's `gi:` API. See docs/packaging.md.
# ---------------------------------------------------------------------------
APP=/build
log "Staging repo into $APP and pinning node-gtk@$NODE_GTK_VERSION"
rm -rf "$APP" && mkdir -p "$APP" && cp -a /src/. "$APP/"
cd "$APP"
rm -rf node_modules
cat > pnpm-workspace.yaml <<YAML
allowBuilds:
  native-keymap: true
  node-gtk: true
overrides:
  node-gtk: ${NODE_GTK_VERSION}
YAML

log "pnpm install (compiles node-gtk + native-keymap, runs codegen)"
pnpm install --no-frozen-lockfile

log "Verifying the gi: runtime loads headlessly"
cat > /tmp/smoke.mjs <<'MJS'
import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import GtkSource from 'gi:GtkSource-5'
import Vte from 'gi:Vte-3.91'
if (!Gtk.Window || !Adw.Application || !GtkSource.View || !Vte.Terminal) process.exit(2)
console.log(`gi: ok — Gtk ${Gtk.MAJOR_VERSION}.${Gtk.MINOR_VERSION}, Adw, GtkSource, Vte`)
MJS
node --import node-gtk/register /tmp/smoke.mjs

VERSION="$(node -p "require('$APP/package.json').version")"
log "zym version: $VERSION"

# ---------------------------------------------------------------------------
# 4. Lay out the AppDir.
# ---------------------------------------------------------------------------
APPDIR=/work/zym.AppDir
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/lib" \
         "$APPDIR/usr/lib/girepository-1.0" \
         "$APPDIR/usr/share/glib-2.0/schemas" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/scalable/apps"

log "Copying Node.js runtime and the zym payload"
cp -L "$NODE_DIR/bin/node" "$APPDIR/usr/bin/node"
APPROOT="$APPDIR/usr/lib/zym"
mkdir -p "$APPROOT"
# Runtime payload only: source, plugins, bundled assets, deps and the codegen
# output. Dev-only files (tests, poc, docs, tsconfig) are intentionally dropped.
cp -a "$APP/src" "$APP/plugins" "$APP/assets" "$APPROOT/"
cp -a "$APP/package.json" "$APPROOT/"
cp -a "$APP/node_modules" "$APPROOT/"
find "$APPROOT" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "$APPROOT" -type f \( -name '*.test.ts' -o -name '*.map' \) -delete 2>/dev/null || true
rm -rf "$APPROOT/src/poc" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. Bundle the GObject-Introspection typelibs the app loads at runtime.
#    node-gtk dlopens these via libgirepository, so no ELF tool can discover
#    them — they must be copied explicitly.
# ---------------------------------------------------------------------------
log "Bundling GI typelibs"
cp -aL /usr/lib/$TRIPLET/girepository-1.0/*.typelib "$APPDIR/usr/lib/girepository-1.0/"

# ---------------------------------------------------------------------------
# 6. Bundle the shared-library closure of the native addons + the GTK libs the
#    typelibs point at, minus the libraries a desktop host always provides
#    (glibc, libstdc++, libGL, fontconfig, X11, ... — the AppImage excludelist).
# ---------------------------------------------------------------------------
log "Computing shared-library closure"
EXCL=/tools/excludelist
if [[ ! -f "$EXCL" ]]; then
  EXCL=/tmp/excludelist
  curl -fsSL https://raw.githubusercontent.com/AppImage/pkg2appimage/master/excludelist -o "$EXCL"
fi
grep -vE '^\s*#|^\s*$' "$EXCL" | awk '{print $1}' | sort -u > /tmp/excl.clean

# Libraries we must bundle outright: the typelib targets node-gtk dlopens. They
# are leaves of the dependency graph (nothing else depends on them), so they
# would be missed if we only walked dependencies — include them explicitly.
libseeds=()
for soname in libgtk-4.so.1 libadwaita-1.so.0 libgtksourceview-5.so.0 \
              libvte-2.91-gtk4.so.0 librsvg-2.so.2 libgirepository-1.0.so.1; do
  p="$(find /usr/lib/$TRIPLET -name "$soname" 2>/dev/null | head -1)"
  [[ -n "$p" ]] && libseeds+=("$p")
done
PIXDIR="/usr/lib/$TRIPLET/gdk-pixbuf-2.0/2.10.0"

# Everything to feed `ldd` (resolves the full transitive closure per file):
# the seed libs themselves, the pixbuf loaders, the bundled node, the addons.
ldd_inputs=("${libseeds[@]}" "$PIXDIR"/loaders/*.so "$APPDIR/usr/bin/node")
while IFS= read -r n; do ldd_inputs+=("$n"); done < <(find "$APPROOT/node_modules" -name '*.node')

{
  printf '%s\n' "${libseeds[@]}"               # the seeds themselves
  for s in "${ldd_inputs[@]}"; do ldd "$s" 2>/dev/null | awk '/=>/{print $3}'; done
} | grep -E '^/' | sort -u > /tmp/alllibs.txt

copied=0
while IFS= read -r lib; do
  bn="$(basename "$lib")"
  grep -qxF "$bn" /tmp/excl.clean && continue
  [[ -e "$APPDIR/usr/lib/$bn" ]] && continue
  cp -L "$lib" "$APPDIR/usr/lib/$bn" && copied=$((copied+1))
done < /tmp/alllibs.txt
log "Bundled $copied shared libraries"

# Typelibs name a shared library that GI dlopens but that nothing ELF-links
# (e.g. HarfBuzz-0.0 -> libharfbuzz-gobject.so.0, cairo-1.0 -> libcairo-gobject).
# Walk every bundled typelib, bundle each referenced .so (+ its deps) that the
# host doesn't already provide.
log "Bundling typelib-referenced shared libraries"
extra=0
for sn in $(strings "$APPDIR"/usr/lib/girepository-1.0/*.typelib 2>/dev/null \
            | grep -oE 'lib[A-Za-z0-9_.+-]+\.so(\.[0-9]+)*' | sort -u); do
  grep -qxF "$sn" /tmp/excl.clean && continue
  [[ -e "$APPDIR/usr/lib/$sn" ]] && continue
  src="$(ldconfig -p 2>/dev/null | awk -v s="$sn" '$1==s{print $NF; exit}')"
  [[ -z "$src" ]] && src="$(find /usr/lib/$TRIPLET -name "$sn" 2>/dev/null | head -1)"
  [[ -n "$src" && -e "$src" ]] || continue
  cp -L "$src" "$APPDIR/usr/lib/$sn" && extra=$((extra+1))
  ldd "$src" 2>/dev/null | awk '/=>/{print $3}' | grep -E '^/' | while IFS= read -r d; do
    db="$(basename "$d")"
    grep -qxF "$db" /tmp/excl.clean && continue
    [[ -e "$APPDIR/usr/lib/$db" ]] || cp -L "$d" "$APPDIR/usr/lib/$db"
  done
done
log "Bundled $extra additional typelib-referenced libraries"

# ---------------------------------------------------------------------------
# 7. GdkPixbuf loaders (for SVG/PNG icons), GSettings schemas, icon theme.
# ---------------------------------------------------------------------------
log "Bundling gdk-pixbuf loaders, schemas and icon theme"
mkdir -p "$APPDIR/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders"
cp -L "$PIXDIR"/loaders/*.so "$APPDIR/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders/"
# The loaders.cache is regenerated at launch (AppRun) so paths are absolute and
# correct on the user's machine; ship the query binary used to do it.
QL="$(find /usr/lib/$TRIPLET/gdk-pixbuf-2.0 /usr/bin -name 'gdk-pixbuf-query-loaders*' 2>/dev/null | head -1)"
cp -L "$QL" "$APPDIR/usr/bin/gdk-pixbuf-query-loaders"

cp -a /usr/share/glib-2.0/schemas/*.xml "$APPDIR/usr/share/glib-2.0/schemas/" 2>/dev/null || true
glib-compile-schemas "$APPDIR/usr/share/glib-2.0/schemas/" >/dev/null 2>&1 || true

cp -a /usr/share/icons/Adwaita "$APPDIR/usr/share/icons/" 2>/dev/null || true
cp -aL /usr/share/icons/hicolor/index.theme "$APPDIR/usr/share/icons/hicolor/" 2>/dev/null || true
cp -a /usr/share/mime "$APPDIR/usr/share/" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 8. Desktop entry, icon and AppRun launcher.
# ---------------------------------------------------------------------------
log "Installing desktop entry, icon and AppRun"
cp /src/packaging/zym.desktop "$APPDIR/usr/share/applications/zym.desktop"
cp /src/packaging/zym.desktop "$APPDIR/zym.desktop"
cp /src/packaging/zym.svg "$APPDIR/usr/share/icons/hicolor/scalable/apps/zym.svg"
cp /src/packaging/zym.svg "$APPDIR/zym.svg"
rsvg-convert -w 256 -h 256 /src/packaging/zym.svg -o "$APPDIR/zym.png"
cp "$APPDIR/zym.png" "$APPDIR/.DirIcon"

cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/bash
# zym AppImage launcher — point the bundled GTK/GI runtime at itself, then run
# zym from source through node-gtk's gi: import hooks.
HERE="$(dirname "$(readlink -f "${0}")")"
export LD_LIBRARY_PATH="$HERE/usr/lib:${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GI_TYPELIB_PATH="$HERE/usr/lib/girepository-1.0"
export XDG_DATA_DIRS="$HERE/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
export GSETTINGS_SCHEMA_DIR="$HERE/usr/share/glib-2.0/schemas"

# Regenerate the pixbuf loader cache with paths valid on this machine.
PIXBASE="$HERE/usr/lib/gdk-pixbuf-2.0/2.10.0"
export GDK_PIXBUF_MODULEDIR="$PIXBASE/loaders"
CACHE="${TMPDIR:-/tmp}/zym-gdk-pixbuf-loaders.cache.$$"
if "$HERE/usr/bin/gdk-pixbuf-query-loaders" "$PIXBASE"/loaders/*.so > "$CACHE" 2>/dev/null; then
  export GDK_PIXBUF_MODULE_FILE="$CACHE"
  trap 'rm -f "$CACHE"' EXIT
fi

APP="$HERE/usr/lib/zym"
exec "$HERE/usr/bin/node" \
  --import "$APP/node_modules/node-gtk/lib/esm/register.mjs" \
  "$APP/src/index.ts" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# ---------------------------------------------------------------------------
# 9. Pack the AppImage.
# ---------------------------------------------------------------------------
log "Packing AppImage with appimagetool"
AIT=/tmp/appimagetool
if [[ -f /tools/appimagetool.AppImage ]]; then
  cp /tools/appimagetool.AppImage "$AIT"
else
  curl -fsSL https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -o "$AIT"
fi
chmod +x "$AIT"
RUNTIME=/tools/runtime-x86_64
[[ -f "$RUNTIME" ]] || RUNTIME=""

mkdir -p /out
OUTFILE="/out/zym-${VERSION}-${ARCH}.AppImage"
# No FUSE in the build container -> extract-and-run; skip appstream validation.
export APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$ARCH"
RUNTIME_ARG=()
[[ -n "$RUNTIME" ]] && RUNTIME_ARG=(--runtime-file "$RUNTIME")
"$AIT" --no-appstream "${RUNTIME_ARG[@]}" "$APPDIR" "$OUTFILE"

chmod +x "$OUTFILE"
log "Built $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"
