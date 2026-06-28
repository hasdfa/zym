# System integration

How zym tracks the host desktop's settings — light/dark appearance,
accent, and fonts — and keeps the running UI in sync when the user
changes them. The guiding rule: **OS appearance and font changes must be
followed through at runtime**, without a restart.

Fonts react live. The light/dark preference only partially reacts (the
Adwaita-fallback editor scheme and the terminal flip, but not the zym
theme palette). This page records what reacts today, where the gaps are,
and the plan to close them.

## Goal

When the user changes a relevant desktop setting, the corresponding
zym surface updates live:

- **Light ⇄ dark** → editor scheme, syntax colors, chrome
  (header/status/tree), pickers/popovers, terminal — and, ideally, the
  active theme (swap a light/dark theme file pair).
- **Monospace font / size**
  (`org.gnome.desktop.interface monospace-font-name`) → editor,
  terminal, pickers, anything monospace.
- **UI font** (`…interface font-name`) → proportional text (e.g.
  command-picker descriptions, labels).
- **Accent color** (where we honor it) → match highlight, action rows.

## Current state

What exists, and whether it reacts to a live change:

- **Editor color scheme** — `TextEditor.followSystemColorScheme`
  (`src/ui/TextEditor/TextEditor.ts`) subscribes to `Adw.StyleManager`
  `notify::dark`, re-applies the GtkSource scheme, and re-runs
  `syntax.restyle()`. ✅ *reacts* — **but only when the theme defines no
  `editor.background`**: a theme with its own background gets a fixed
  `createSourceScheme(theme)` built once that does not follow the OS;
  otherwise it swaps between `Adwaita` / `Adwaita-dark`.
- **Terminal colors** — `Terminal.followSystemColorScheme`
  (`src/ui/Terminal.ts`) calls `setColors(null, null, null)` so VTE
  inherits libadwaita's themed fg/bg, which flip with the system scheme.
  ✅ *reacts passively* (no explicit handler).
- **Active theme** — `export const theme = loadTheme('zym')`
  (`src/theme/theme.ts`) loads a **fixed** single theme file
  (`zym.json`, our owned format — see [theming.md](theming.md)) at
  module load. The whole `theme.ui.*` / `theme.syntax.*` palette is
  static. ❌ does **not** follow OS light/dark; there is no light↔dark
  variant swap.
- **`core.followSystemColorScheme` config** — declared in `CONFIG_SCHEMA`
  (`src/zym.ts`, default `true`) but **not read anywhere**. ❌ dead
  setting; should gate the follow-the-OS behavior once it exists.
- **Fonts** — ✅ centralized in the `fonts` store (`FontStore` in
  `src/fonts.ts`). One reactive stylesheet
  (`styles.add(() => …)`, re-applied via the handle's `refresh()`) carries every CSS widget's
  font — components register a selector via `fonts.monospace(sel)` /
  `fonts.ui(sel)` instead of inlining declarations; Pango-markup callers
  read the live `fonts.monospaceFamily` / `fonts.uiFamily` at render
  time; `Terminal` subscribes via `fonts.onChange`. The store's `init()`
  watches `org.gnome.desktop.interface`'s `changed` signal for
  `monospace-font-name` / `font-name` and calls `reload()` live;
  `reload()` is public so a future user font setting drives the same
  path. Terminal, editor signature/hover, completion docs, and all
  pickers update without a restart.
- **Match-highlight / accent** — `HIGHLIGHT_COLOR = theme.ui.text.accent`
  (`src/ui/Picker.ts`) is a module-load constant baked into row Pango
  markup. ❌ static (follows neither a theme change nor the OS accent).
- **Color palette is centralized** — ✅ chrome/syntax/picker colors come
  from `theme.ui.*` / `theme.syntax.*`. The loader resolves every
  `ThemeUi` field at load (`adaptTheme` in `src/theme/theme.ts`
  deep-merges the file's nested `ui` over `DEFAULT_THEME.ui`), so
  consumers read `theme.ui.editor.background`-style paths that mirror the
  theme JSON 1:1, every field guaranteed filled. A theme may omit
  `editor.background`; the loader fills it and records the omission as
  `followSystemScheme` (the "follow the system scheme" signal). Semantic
  tokens carry the formerly hardcoded values: `shadow`, `flash`, the diff
  tints `diff.added`/`diff.removed`/`diff.addedWord`/`diff.removedWord`
  (derived from `status.success`/`status.error` per appearance) +
  `diff.filler`/`diff.fold`, and `pr.open`/`pr.merged`/`pr.closed`.
  Regex-input highlighting (`src/ui/TextEditor/regexHighlight.ts`) reuses
  `theme.syntax` captures
  (keyword/punctuation/type/string.escape/constant) instead of its own
  colors. Colors are baked at module load today, so "restyle on theme
  change" below is mostly a re-emit of the keyed stylesheets +
  Pango-markup rebuilds, not a literal hunt. Known exceptions still
  holding hardcoded literals:
  `src/ui/TextEditor/buildDefinitionPeek.ts` (`?? '#1e1e1e'` /
  `?? '#e0e0e0'` fallbacks) and `plugins/color-preview/colors.ts`
  (black/white swatch contrast).

## Gaps (the "not followed through" list)

1. OS **light ⇄ dark** change → the zym theme palette (chrome, syntax,
   picker colors) does not switch; only the Adwaita-fallback editor
   scheme + terminal do.
2. **Accent** change → match highlight unchanged.
3. `core.followSystemColorScheme` does nothing.

## Plan

A single owner for desktop-settings signals, plus making the consumers
re-appliable.

- [ ] **`SystemSettings` watcher** — one module that holds the relevant
  `Gio.Settings` (`org.gnome.desktop.interface`) and `Adw.StyleManager`,
  subscribes to their `changed::monospace-font-name`,
  `changed::font-name`, `changed::color-scheme` (+ accent) /
  `notify::dark`, and emits coarse signals: `onFontsChanged`,
  `onAppearanceChanged`. Lives under `zym.system` (global).
- [ ] **Theme follows appearance** — author a light/dark theme file pair
  (e.g. `zym.json` + `zym-light.json`, each declaring its
  `appearance`) and pick by `StyleManager.getDark()`; re-load + re-emit a
  `theme:changed` on appearance change. Gate on
  `core.followSystemColorScheme`; when off, keep the user's chosen theme.
  Requires `theme` to become swappable (today it's a frozen
  `export const`) — a `theme:changed` event the chrome/pickers/syntax
  subscribe to (mirrors how `notify::dark` already drives the editor
  scheme). See [theming.md](theming.md).
- [ ] **Restyle on theme change**
- [ ] **Wire `core.followSystemColorScheme`** — when false, ignore OS
  appearance and hold the configured variant; when true (default),
  follow it.
- [ ] **Lint guardrail (color drift)** — a check that fails CI when a hex
  / `rgb()` / `foreground="white"` literal appears outside `src/theme/**`,
  so colors can't creep back inline. Would need an allowlist for the known
  exceptions above (peek fallbacks, ANSI palette, color-preview swatches).

## Notes / decisions

- Prefer driving as much as possible through **CSS variables + a single
  dynamic stylesheet** (a `styles.add(() => …)` render sheet, re-applied via the
  handle's `refresh()`) so one re-emit updates every CSS
  consumer, rather than per-widget imperative re-styling. Colors baked
  into Pango markup at row-build time (picker highlight) can't be CSS vars
  — those callers must rebuild on the signal instead.
- The editor already proves the pattern (`notify::dark` → re-apply).
  Generalize it rather than scattering per-widget subscriptions.
