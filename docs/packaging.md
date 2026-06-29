# Packaging & releases

How zym is built into distributable artifacts and uploaded to GitHub Releases.

zym is **run straight from TypeScript source** via node-gtk's `gi:` import hooks
(`node --import node-gtk/register src/index.ts`); there is no compile/bundle of
the app itself. "Building a release" therefore means: install the GTK stack,
build the native `node-gtk` addon, run the codegen (`generate-types` +
`generate-icons`), then bundle **Node + the app payload + the entire
GTK/GObject-Introspection runtime** into a per-OS package.

Artifacts (per `package.json` version):

| OS    | Artifact                          | Builder                          |
| ----- | --------------------------------- | -------------------------------- |
| Linux | `zym-<version>-x86_64.AppImage`   | `packaging/build-linux.sh` (Docker) |
| macOS | `zym-<version>-macos-<arch>.dmg`  | `packaging/macos/build-macos.sh` (must run on macOS) |

## node-gtk pin

The dev tree links node-gtk from a local sibling checkout
(`pnpm-workspace.yaml` → `overrides: node-gtk: link:../node-gtk`). That checkout
is not available off a contributor's machine, so the release builds **replace
that override with the published `node-gtk@3.0.0`** (the version whose `gi:`
ESM API and `node-gtk/register` `--import` hook zym targets — `package.json`'s
`^2.1.0` is stale). 3.0.0 ships no prebuilt for every ABI, so it compiles from
source in the build environment. Override the version with `NODE_GTK_VERSION`.

## Linux (AppImage, via Docker)

`packaging/build-linux.sh` runs `packaging/linux/build-appimage.sh` inside an
**`ubuntu:26.04`** container. 26.04 is required: zym uses the GtkSourceView
**5.18** annotation API (`GtkSource.AnnotationStyle`, `GtkSource.Annotation`),
and older Ubuntu ships 5.12/5.16 — the app hard-crashes at import on those.
26.04 provides GTK 4.22, libadwaita 1.9, GtkSourceView 5.18, Vte 0.84.

```sh
packaging/build-linux.sh                 # -> dist/zym-<version>-x86_64.AppImage
```

Environment knobs (all optional): `OUT_DIR`, `ZYM_BASE_IMAGE` (prebaked image to
skip apt provisioning), `ZYM_TOOLS_DIR` (cached `appimagetool` / `runtime-x86_64`
/ `excludelist` / Node tarball), `ZYM_CA_FILE` + `HTTPS_PROXY` (proxied sandboxes;
the script switches apt to https mirrors and the container to `--network host`).

### Bundling the GTK runtime

node-gtk **dlopens** the GTK libraries through libgirepository at runtime, so no
ELF tool (`ldd`, `linuxdeploy`) can discover them from the binaries. The build
bundles them in three passes:

1. **Typelibs** — copy every `*.typelib` into `usr/lib/girepository-1.0`.
2. **Library closure** — seed with the libraries the typelibs dlopen
   (`libgtk-4`, `libadwaita`, `libgtksourceview-5`, `libvte`, `librsvg`,
   `libgirepository`) *plus the seeds themselves* (they are graph leaves —
   nothing depends on gtksourceview/vte/adwaita, so a dependency-only walk drops
   them), then `ldd`-resolve the transitive closure of those + the pixbuf
   loaders + Node + the `.node` addons, minus the AppImage **excludelist** (glibc,
   libstdc++, libGL, fontconfig, freetype, X11, … come from the host).
3. **Typelib-referenced libs** — some typelibs name a dylib nothing ELF-links
   (e.g. `HarfBuzz-0.0` → `libharfbuzz-gobject.so.0`, `cairo-1.0` →
   `libcairo-gobject`); scan each bundled typelib's strings and bundle those too.

Plus: gdk-pixbuf loaders (the cache is regenerated in `AppRun` at launch so its
paths are valid on the user's machine), compiled GSettings schemas, the Adwaita
icon theme, the desktop entry and icon. `AppRun` points
`LD_LIBRARY_PATH` / `GI_TYPELIB_PATH` / `XDG_DATA_DIRS` / `GSETTINGS_SCHEMA_DIR`
at the bundle, then execs Node on `src/index.ts`.

### Runtime floor

Building on 26.04 sets the host floor at its glibc (~2.41) and pulls bleeding-edge
GTK — appropriate, since the GtkSourceView 5.18 requirement already limits zym to
very recent Linux desktops. The app's own runtime tools (`git`, `ripgrep`, the
language servers) are expected on the user's `PATH`, as when running from source.

## macOS (.app + .dmg)

Docker on Linux cannot produce macOS bundles, so `packaging/macos/build-macos.sh`
**must run on a macOS host** (a Mac or a CI `macos-*` runner). It mirrors the
Linux flow with Homebrew (`gtk4 libadwaita gtksourceview5 vte3
gobject-introspection librsvg node dylibbundler create-dmg`) and `dylibbundler`
for the dylib closure (seeded with the same GI-dlopened libraries), emitting
`zym.app` and a `.dmg`. Homebrew's current `gtksourceview5` satisfies the 5.18
requirement.

## Validation status

The Linux AppImage is built and validated **self-contained**: in a clean
`ubuntu:26.04` container with **no** GTK4/GtkSourceView/libadwaita/Vte installed,
it launches under Xvfb and maps its editor window (every GTK library resolves
from the bundle, zero "failed to load" errors) — and an empty editor runs
indefinitely. Full file-editing could not be verified here because the container
has no GPU: rendering a file's content **segfaults under headless software
rendering (Xvfb/llvmpipe)**, which does not reproduce on real desktop hardware
(the bundling is provably complete — the crash is in GTK rendering, not a missing
library). macOS is unverified in CI — the script needs a macOS host to run.
