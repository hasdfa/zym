#!/usr/bin/env bash
#
# Build a zym .app bundle and .dmg for macOS.
#
# IMPORTANT: this MUST run on a macOS host (a real Mac or a CI `macos-*` runner).
# Docker on Linux cannot produce macOS bundles, so — unlike the Linux build —
# there is no container wrapper. It mirrors packaging/linux/build-appimage.sh:
# zym runs from TypeScript source via node-gtk, so we install the GTK stack
# (Homebrew), build the native addon, then bundle Node + the app + the GTK /
# GObject-Introspection runtime into zym.app and wrap it in a .dmg.
#
# Prerequisites (installed automatically if Homebrew is present):
#   brew install gtk4 libadwaita gtksourceview5 vte3 gobject-introspection \
#                librsvg adwaita-icon-theme node dylibbundler create-dmg
#
# zym needs GtkSourceView >= 5.18 (the annotation API). Homebrew's gtksourceview5
# is current, so this is satisfied on an up-to-date Homebrew. See docs/packaging.md.
#
set -euo pipefail

NODE_GTK_VERSION="${NODE_GTK_VERSION:-3.0.0}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$REPO/dist}"
ARCH="$(uname -m)"   # arm64 or x86_64
log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: must run on macOS"; exit 1; }
command -v brew >/dev/null || { echo "error: Homebrew required (https://brew.sh)"; exit 1; }
BREW="$(brew --prefix)"

# ---------------------------------------------------------------------------
# 1. Dependencies.
# ---------------------------------------------------------------------------
log "Installing GTK stack + tooling via Homebrew"
brew install gtk4 libadwaita gtksourceview5 vte3 gobject-introspection \
             librsvg adwaita-icon-theme node dylibbundler create-dmg || true
command -v pnpm >/dev/null || npm i -g pnpm@10

# ---------------------------------------------------------------------------
# 2. App dependencies + codegen (node-gtk pinned to the published release; the
#    dev tree's ../node-gtk link isn't available off a contributor's machine).
# ---------------------------------------------------------------------------
BUILD="$(mktemp -d)/zym"
log "Staging into $BUILD and pinning node-gtk@$NODE_GTK_VERSION"
mkdir -p "$BUILD" && cp -a "$REPO/." "$BUILD/" && cd "$BUILD"
rm -rf node_modules dist
cat > pnpm-workspace.yaml <<YAML
allowBuilds:
  native-keymap: true
  node-gtk: true
overrides:
  node-gtk: ${NODE_GTK_VERSION}
YAML

export PKG_CONFIG_PATH="$BREW/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
export GI_TYPELIB_PATH="$BREW/lib/girepository-1.0"
log "pnpm install (compiles node-gtk + native-keymap, runs codegen)"
pnpm install --no-frozen-lockfile

log "Verifying the gi: runtime loads"
cat > /tmp/zym-smoke.mjs <<'MJS'
import Gtk from 'gi:Gtk-4.0'
import Adw from 'gi:Adw-1'
import GtkSource from 'gi:GtkSource-5'
import Vte from 'gi:Vte-3.91'
if (!Gtk.Window || !Adw.Application || !GtkSource.View || !Vte.Terminal) process.exit(2)
console.log(`gi: ok — Gtk ${Gtk.MAJOR_VERSION}.${Gtk.MINOR_VERSION}`)
MJS
node --import node-gtk/register /tmp/zym-smoke.mjs

VERSION="$(node -p "require('$BUILD/package.json').version")"

# ---------------------------------------------------------------------------
# 3. .app skeleton.
# ---------------------------------------------------------------------------
APP="$OUT_DIR/zym.app"
log "Assembling $APP (zym $VERSION, $ARCH)"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" \
  "$APP/Contents/libs" "$APP/Contents/lib/girepository-1.0" "$APP/Contents/share"

sed "s/__VERSION__/$VERSION/g" "$REPO/packaging/macos/Info.plist" > "$APP/Contents/Info.plist"
cp -L "$(command -v node)" "$APP/Contents/MacOS/node"

APPROOT="$APP/Contents/Resources/app"
mkdir -p "$APPROOT"
cp -a "$BUILD/src" "$BUILD/plugins" "$BUILD/assets" "$BUILD/package.json" "$BUILD/node_modules" "$APPROOT/"
find "$APPROOT" -type f \( -name '*.test.ts' -o -name '*.map' \) -delete 2>/dev/null || true
rm -rf "$APPROOT/src/poc" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. Typelibs + the dylib closure (mirrors the Linux build: GI dlopens the GTK
#    dylibs, so otool/dylibbundler can't discover them — seed them explicitly).
# ---------------------------------------------------------------------------
log "Bundling GI typelibs"
cp -L "$BREW"/lib/girepository-1.0/*.typelib "$APP/Contents/lib/girepository-1.0/"

log "Bundling dylibs with dylibbundler"
seeds=()
for n in libgtk-4.1.dylib libadwaita-1.0.dylib libgtksourceview-5.0.dylib \
         libvte-2.91-gtk4.0.dylib librsvg-2.2.dylib libgirepository-1.0.1.dylib; do
  p="$(ls "$BREW"/lib/"$n" 2>/dev/null || true)"; [[ -n "$p" ]] && seeds+=("-x" "$p")
done
while IFS= read -r addon; do seeds+=("-x" "$addon"); done \
  < <(find "$APPROOT/node_modules" -name '*.node')
# -of overwrite, -b also process the -x inputs, install names -> @executable_path/../libs
dylibbundler -of -b -cd -d "$APP/Contents/libs" -p '@executable_path/../libs' "${seeds[@]}"

# pixbuf loaders (SVG icons), schemas, icon theme
log "Bundling gdk-pixbuf loaders, schemas, icon theme"
PIX="$(ls -d "$BREW"/lib/gdk-pixbuf-2.0/2.10.0 2>/dev/null | head -1 || true)"
if [[ -n "$PIX" ]]; then
  mkdir -p "$APP/Contents/lib/gdk-pixbuf-2.0/2.10.0/loaders"
  cp -L "$PIX"/loaders/*.so "$APP/Contents/lib/gdk-pixbuf-2.0/2.10.0/loaders/" 2>/dev/null || true
fi
mkdir -p "$APP/Contents/share/glib-2.0/schemas"
cp -a "$BREW"/share/glib-2.0/schemas/*.xml "$APP/Contents/share/glib-2.0/schemas/" 2>/dev/null || true
"$BREW"/bin/glib-compile-schemas "$APP/Contents/share/glib-2.0/schemas/" 2>/dev/null || true
cp -a "$BREW"/share/icons/Adwaita "$APP/Contents/share/icons/" 2>/dev/null || true

# icon: convert the SVG to .icns if tooling is present
if command -v rsvg-convert >/dev/null && command -v iconutil >/dev/null; then
  ICON="$(mktemp -d)/zym.iconset"; mkdir -p "$ICON"
  for s in 16 32 64 128 256 512; do
    rsvg-convert -w $s -h $s "$REPO/packaging/zym.svg" -o "$ICON/icon_${s}x${s}.png"
    rsvg-convert -w $((s*2)) -h $((s*2)) "$REPO/packaging/zym.svg" -o "$ICON/icon_${s}x${s}@2x.png"
  done
  iconutil -c icns "$ICON" -o "$APP/Contents/Resources/zym.icns" || true
fi

# ---------------------------------------------------------------------------
# 5. Launcher.
# ---------------------------------------------------------------------------
log "Writing launcher"
cat > "$APP/Contents/MacOS/zym" <<'LAUNCH'
#!/bin/bash
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # Contents
export DYLD_LIBRARY_PATH="$HERE/libs:${DYLD_LIBRARY_PATH:-}"
export GI_TYPELIB_PATH="$HERE/lib/girepository-1.0"
export GDK_PIXBUF_MODULEDIR="$HERE/lib/gdk-pixbuf-2.0/2.10.0/loaders"
export GSETTINGS_SCHEMA_DIR="$HERE/share/glib-2.0/schemas"
export XDG_DATA_DIRS="$HERE/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
APP="$HERE/Resources/app"
exec "$HERE/MacOS/node" \
  --import "$APP/node_modules/node-gtk/lib/esm/register.mjs" \
  "$APP/src/index.ts" "$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/zym"

# ---------------------------------------------------------------------------
# 6. .dmg.
# ---------------------------------------------------------------------------
log "Creating .dmg"
mkdir -p "$OUT_DIR"
DMG="$OUT_DIR/zym-${VERSION}-macos-${ARCH}.dmg"
rm -f "$DMG"
if command -v create-dmg >/dev/null; then
  create-dmg --volname "zym $VERSION" --app-drop-link 420 180 \
    --icon "zym.app" 140 180 "$DMG" "$APP" || \
    hdiutil create -volname "zym $VERSION" -srcfolder "$APP" -ov -format UDZO "$DMG"
else
  hdiutil create -volname "zym $VERSION" -srcfolder "$APP" -ov -format UDZO "$DMG"
fi
log "Built $APP and $DMG"
