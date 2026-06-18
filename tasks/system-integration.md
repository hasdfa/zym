# System integration

How quilx tracks the host desktop's settings — light/dark appearance, accent,
and fonts — and keeps the running UI in sync when the user changes them. The
guiding rule: **OS appearance and font changes must be followed through at
runtime**, without a restart.

Fonts now react live. The light/dark preference only partially reacts (the
Adwaita-fallback editor scheme and the terminal flip, but the quilx theme palette
does not). This page records what already reacts, where the gaps are, and the
plan to close them.

## Goal

When the user changes a relevant desktop setting, the corresponding quilx surface
updates live:

- **Light ⇄ dark** → editor scheme, syntax colors, chrome (header/status/tree),
  pickers/popovers, terminal — and, ideally, the active theme variant.
- **Monospace font / size** (`org.gnome.desktop.interface monospace-font-name`)
  → editor, terminal, pickers, anything monospace.
- **UI font** (`…interface font-name`) → proportional text (e.g. command-picker
  descriptions, labels).
- **Accent color** (where we honor it) → match highlight, action rows.

## Current state

What exists, and whether it reacts to a live change:

- **Editor color scheme** — `TextEditor.followSystemColorScheme`
  (`src/ui/TextEditor/TextEditor.ts`) subscribes to `Adw.StyleManager`
  `notify::dark`, re-applies the GtkSource scheme, and re-runs `syntax.restyle()`.
  ✅ *reacts* — **but only when the theme defines no `ui.bg`**: a theme with its
  own background gets a fixed `createSourceScheme(theme)` built once that does not
  follow the OS; otherwise it swaps between `Adwaita` / `Adwaita-dark`.
- **Terminal colors** — `Terminal.followSystemColorScheme` (`src/ui/Terminal.ts`)
  calls `setColors(null, null, null)` so VTE inherits libadwaita's themed fg/bg,
  which flip with the system scheme. ✅ *reacts passively* (no explicit handler).
- **Active theme** — `export const theme = loadTheme('quilx')`
  (`src/theme/theme.ts`) picks a **fixed** Zed variant (`family.themes[0]`, the
  first in the family) at module load. The whole `theme.ui.*` / `theme.syntax.*`
  palette is static. ❌ does **not** follow OS light/dark; there is no light↔dark
  variant swap.
- **`core.followSystemColorScheme` config** — declared in `CONFIG_SCHEMA`
  (`src/quilx.ts`, default `true`) but **not read anywhere**. ❌ dead setting;
  should gate the follow-the-OS behavior once it exists.
- **Fonts** — ✅ centralized in the `fonts` store (`FontStore` in `src/fonts.ts`).
  One reactive stylesheet (`styles.set(..., { key: 'app-fonts' })`) carries every
  CSS widget's font — components register a selector via `fonts.monospace(sel)` /
  `fonts.ui(sel)` instead of inlining declarations; Pango-markup callers read the
  live `fonts.monospaceFamily` / `fonts.uiFamily` at render time; `Terminal`
  subscribes via `fonts.onChange`. The store's `init()` watches
  `org.gnome.desktop.interface`'s `changed` signal for `monospace-font-name` /
  `font-name` and calls `reload()` live; `reload()` is public so a future user
  font setting drives the same path. Terminal, editor signature/hover, completion
  docs, and all pickers update without a restart.
- **Match-highlight / accent** — `HIGHLIGHT_COLOR = theme.ui.textAccent`
  (`src/ui/Picker.ts`) is a module-load constant baked into row Pango markup.
  ❌ static (follows neither a theme change nor the OS accent).
- **Color palette is centralized** — ✅ chrome/syntax/picker colors come from
  `theme.ui.*` / `theme.syntax.*`. The loader resolves every `UiColors` field at
  load (`adaptZedTheme` in `src/theme/theme.ts` coalesces each `pick()` with a
  `DEFAULT_UI` fallback), so most consumers read bare `theme.ui.X`. `bg` stays
  optional (its absence is the "follow the system scheme" signal); `fg` defaults
  to white. Semantic tokens carry what used to be hardcoded: `shadow`, `flash`,
  `diffAddedBg`/`diffRemovedBg`/`diffAddedWordBg`/`diffRemovedWordBg`/
  `diffFillerBg`/`diffFoldBg`, and `prOpen`/`prMerged`/`prClosed`. Regex-input
  highlighting (`src/ui/TextEditor/regexHighlight.ts`) reuses `theme.syntax`
  captures (keyword/punctuation/type/string.escape/constant) instead of its own
  colors. Static today (baked at module load) — so "restyle on theme change"
  below is mostly a re-emit of the keyed stylesheets + Pango-markup rebuilds, not
  a literal hunt. Known exceptions still holding hardcoded literals:
  `src/ui/TextEditor/buildDefinitionPeek.ts` (`?? '#1e1e1e'` / `?? '#e0e0e0'`
  fallbacks), `src/util/lsColors.ts` (the fixed ANSI terminal palette), and
  `src/plugins/color-preview/colors.ts` (black/white swatch contrast).

## Gaps (the "not followed through" list)

1. ~~Desktop **monospace font** change → editor / terminal / pickers keep the old
   font until restart.~~ ✅ fixed — the `fonts` store re-applies live.
2. ~~Desktop **UI font** change → open pickers/labels keep the old font.~~ ✅ the
   `fonts` store re-applies CSS live; Pango-markup labels update on next render.
3. OS **light ⇄ dark** change → the quilx theme palette (chrome, syntax, picker
   colors) does not switch; only the Adwaita-fallback editor scheme + terminal
   do.
4. **Accent** change → match highlight unchanged.
5. `core.followSystemColorScheme` does nothing.

## Plan

A single owner for desktop-settings signals, plus making the consumers
re-appliable.

- [ ] **`SystemSettings` watcher** — one module that holds the relevant
  `Gio.Settings` (`org.gnome.desktop.interface`) and `Adw.StyleManager`,
  subscribes to their `changed::monospace-font-name`, `changed::font-name`,
  `changed::color-scheme` (+ accent) / `notify::dark`, and emits coarse signals:
  `onFontsChanged`, `onAppearanceChanged`. Lives under `quilx.system` (global).
- [ ] **Make fonts reactive** — drop the cached `MONOSPACE` const / one-shot
  `setFont`; have font consumers re-read on `onFontsChanged`. Options: a small
  CSS-variable layer for monospace (so a single re-emit restyles all CSS users),
  plus `terminal.setFont(...)` / editor font re-apply on the signal.
- [ ] **Theme follows appearance** — load the quilx theme **family** (it already
  has light + dark variants) and select the variant from `StyleManager.getDark()`;
  re-pick + re-emit a `theme:changed` on appearance change. Gate on
  `core.followSystemColorScheme`; when off, keep the user's chosen variant.
  Requires `theme` to become swappable (today it's a frozen `export const`) —
  a `theme:changed` event the chrome/pickers/syntax subscribe to (mirrors how
  `notify::dark` already drives the editor scheme).
- [ ] **Restyle on theme change** — the chrome styles (`AppWindow.applyChromeStyles`,
  already keyed/replaceable), picker highlight color, syntax controller, and
  diagnostics colors re-apply from the new palette. *Unblocked:* colors are now
  centralized in `theme.ui.*` (see Current state), so each consumer just re-reads
  the palette — no scattered literals to chase.
- [ ] **Wire `core.followSystemColorScheme`** — when false, ignore OS appearance
  and hold the configured variant; when true (default), follow it.
- [ ] **Lint guardrail (color drift)** — a check that fails CI when a hex /
  `rgb()` / `foreground="white"` literal appears outside `src/theme/**`, so colors
  can't creep back inline. Not yet added; would need an allowlist for the known
  exceptions above (peek fallbacks, ANSI palette, color-preview swatches).

## Notes / decisions

- Prefer driving as much as possible through **CSS variables + a single
  `Gtk.CssProvider` reload** (see `src/styles.ts`, which already supports keyed,
  replaceable stylesheets) so one re-emit updates every CSS consumer, rather than
  per-widget imperative re-styling. Colors baked into Pango markup at row-build
  time (picker highlight) can't be CSS vars — those callers must rebuild on the
  signal instead.
- The editor already proves the pattern (`notify::dark` → re-apply). Generalize
  it rather than scattering per-widget subscriptions.
