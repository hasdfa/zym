# Adwaita styling migration — plan & findings

A plan to make zym's theming follow **libadwaita's design language** (its CSS
variables) instead of our own bespoke palette, plus the reusable scaffolding that
was built and kept for it. The original full migration was **not** landed: the
invasive consumer/CSS/theme-JSON changes were reverted, and only the self-contained,
dormant bridge below remains in the tree. This document is the handoff for picking it
up again.

See also `docs/styling.md` (current `--t-ui-*` token model) and `docs/theming.md`
(owned theme format). Those still describe the **current** bespoke model, which is
what ships today.

## Goal

- Chrome colors (surfaces, borders, status, accent, shadows, selection) come from
  **libadwaita** at runtime, so zym tracks the system light/dark Adwaita theme.
- The theme **JSON on disk** carries only what Adwaita can't express: editor **syntax**
  highlighting plus editor-domain tints (`search` / `diff` / `flash` / `pr`).
- The runtime **`theme` object** stays the single source consumers read (plain
  property access); chrome fields are filled at load by resolving Adwaita's variables.
- On-disk theme format mirrors the runtime `Theme` object 1:1 — every field optional;
  omitted chrome is filled from Adwaita.

## What's in the tree now (the kept, reusable scaffolding)

All of this is **dormant** — nothing in the app imports the bridge, so it changes no
rendering. It is the mechanism only; the migration that would wire it up was reverted.

- **`src/theme/cssColor.ts`** — the bridge. Resolves a CSS-variable color name
  (`--accent-color`, `--error-color`, …) to a concrete `#rrggbb[aa]` string for the
  consumers that *can't* read CSS: Pango markup (`<span foreground=…>`), `GtkTextTag`,
  draw-func colors, and the GtkSourceView scheme XML. Exports:
  - `lookupCSSColor(theme, name)` — resolve a color name. Three layers:
    1. **app registry** (`APP_COLORS`) — our first-class tokens libadwaita lacks
       (`--info-*`, `--hint-*`).
    2. **GTK named-color registry** via `StyleContext.lookup_color` — reads
       libadwaita's `@define-color` names (underscore form: `accent_color`), which
       libadwaita keeps alongside its CSS variables. (Deprecated GTK4 API, still
       functional.)
    3. **static fallback** (`FALLBACK_COLORS`) — for headless / no-display runs.
    Scheme comes from `theme.appearance`; cached by `scheme:name`. No `Gdk.RGBA` or
    `color-bits` leaks — everything is `#rrggbb[aa]` strings end to end.
  - `lookupCSSColorAlpha(theme, name, factor)` — same, scaling alpha (the non-CSS
    analogue of CSS `alpha(var(--…), f)`).
  - `gdkRgbaToString(rgba)` — the single `Gdk.RGBA` → string boundary.
- **`src/theme/theme.ts`** — the color tables the bridge reads (design-language
  knowledge lives with the other design tokens):
  - `APP_COLORS` — `--info-*` / `--hint-*` (`-color`/`-bg-color`/`-fg-color` triplets,
    light + dark) — the semantic tokens libadwaita has no variable for.
  - `FALLBACK_COLORS` — a static snapshot of the libadwaita colors we map onto, per
    scheme, captured by the probe.
  - `appColorVariables(scheme)` — emits `APP_COLORS` as CSS declarations (the CSS-side
    half of the bridge). **Not wired into any stylesheet** in the current tree.
  - `export type Scheme = 'light' | 'dark'`.
- **`src/theme/cssColor.test.ts`** — headless tests for the display-free layers
  (app-registry resolution, static fallback, `gdkRgbaToString`).
- **`src/poc/adwaita-probe.ts`** — the validation probe (see below). Standalone; not
  imported by the app.

## Key findings (from the probe)

`StyleContext.lookup_color` resolves libadwaita's `@define-color` registry. **Validated
against the full catalog**: 92/106 color vars resolve; all the ones we need do. Notable
non-resolvers, and what to do instead:

- `--border-color` — it's `currentColor @ --border-opacity`, CSS-only. For non-CSS
  consumers, derive manually (window-fg @ ~15%).
- `--accent-blue … --accent-slate` (named accent palette) — use the numbered palette
  (`--blue-3`, etc.) instead.
- opacity / radius vars (`--dim-opacity`, `--card-radius`, …) — not colors; read in CSS
  directly or hard-code the non-CSS equivalent.

GTK CSS itself supports `var()`, `alpha(var(--x), f)`, `mix(...)`, `shade(...)` — so the
CSS side can read Adwaita variables natively; the bridge is only for the non-CSS sinks.

## Token → Adwaita mapping reference

| our token | Adwaita | notes |
| --- | --- | --- |
| `editor.foreground` / `background` | `--view-fg-color` / `--view-bg-color` | Slice 5 |
| `editor.lineNumber` | `--view-fg-color @ --dim-opacity` | derive |
| `text.muted` | `--window-fg-color @ --dim-opacity` / `.dim-label` / Pango `alpha="55%"` | native idiom |
| `text.accent` | `--accent-color` | Slice 2 |
| `border` | `--border-color` (CSS) / window-fg @ ~15% (non-CSS) | Slice 3 |
| `shadow` | `--shade-color` | Slice 4 |
| `surface.popover` | `--popover-bg-color` (floating) / `--card-bg-color` (cards) | per-context |
| `surface.selected` | `alpha(var(--accent-bg-color), 0.25)` (focused) / `0.1` (unfocused) | Slice 4 |
| `status.{success,warning,error}` | `--{success,warning,error}-color` | Slice 1 |
| `status.info` / `hint` | `APP_COLORS` `--info-*` / `--hint-*` (first-class, ours) | Slice 1 |
| `search` / `diff` / `flash` / `pr` / `syntax` | — no Adwaita equivalent — | **keep in theme JSON** |

Selection-background idiom (from `LocationList`): unfocused row
`alpha(var(--accent-bg-color), 0.1)`, focused (`:focus-within`)
`alpha(var(--accent-bg-color), 0.25)`. Tool status (warning/error) is best expressed
with Adwaita's semantic style classes (`.warning` / `.error`) rather than inline color.

## The architecture (decided, not yet built): loader fills `theme`

Consumers must **not** call `lookupCSSColor(theme, …)` directly. Instead the **loader
fills concrete values into `theme`** and consumers read plain properties. Two confirmed
decisions:

1. **Live, rebuilt post-display.** The loader fills via the bridge; a `refillTheme()`
   re-resolves in place once the display exists and on `Adw.StyleManager::notify::dark`.
2. The on-disk `ui` block mirrors the runtime `Theme.ui` 1:1; every field optional;
   omitted chrome filled from Adwaita.

Reify `theme.ui.state` as a `Record<StateName, SemanticState>`:

```ts
type StateName = 'accent' | 'success' | 'warning' | 'error' | 'info' | 'hint' | 'destructive';
interface SemanticState {
  flat:   { foreground: string; background: string };  // standalone; bg = 'transparent'
  filled: { foreground: string; background: string };
}
// theme.ui.state: Record<StateName, SemanticState>
```

Filled at load by resolving Adwaita vars:

| field | source (CSS var) |
| --- | --- |
| `state.error.flat.foreground` | `--error-color` |
| `state.error.flat.background` | `transparent` |
| `state.error.filled.foreground` | `--error-fg-color` |
| `state.error.filled.background` | `--error-bg-color` |

(Same pattern for the other states; `info`/`hint` resolve from `APP_COLORS`, the rest
from libadwaita.) `text.accent` becomes `state.accent.flat.foreground`; `status.*`
becomes `state.*`. Surfaces come back as resolved runtime fields (not in JSON):
`theme.ui.surface.popover` ← `--popover-bg-color`, `surface.selected` ←
`--accent-bg-color @ 25%`.

### Loader plan (`src/theme/theme.ts`)

- Make `lookupCSSColor` callable with just `(scheme, name)` (the loader is mid-build and
  has no full `theme`). **Watch the import cycle** `theme.ts` ↔ `cssColor.ts` (cssColor
  imports `APP_COLORS`/`FALLBACK_COLORS`/`Scheme` from theme.ts): ES live-bindings make a
  function-only cycle safe, but the team avoids cycles — consider a third tiny module
  (`adwaitaColors.ts`) imported by both, or merge the resolver into theme.ts.
- Build `theme.ui.state` + resolved `theme.ui.surface.*` (+ later `editor`, `border`,
  `text`) by resolving Adwaita vars; deep-merge on-disk overrides over them.
- `refillTheme()` mutates the existing `theme` object in place, so render-time readers
  see live values.

### Liveness caveat

`const C = theme.ui.state.error.flat.foreground` at module-init captures the *string*; a
later `refillTheme()` won't update it. Many consumers are module-init consts. To make
them live, **defer the `AppWindow` import into `onActivate`** so UI-module consts
evaluate *after* the first post-display refill (do that first refill in `onActivate`
before constructing AppWindow). Without this, "live" only covers render-time reads — a
pre-existing limitation (the theme was always load-constant), so not a regression.

## Migration slices (incremental; the order chosen previously)

Each slice: migrate CSS + non-CSS consumers → fill the value in `theme` at load → delete
the on-disk/schema field if chrome-owned → `tsc` (it enumerates missed consumers) → test
→ runtime-smoke → commit.

- **Slice 1 — status** (`status.{success,warning,error,info,hint}`). CSS →
  `var(--{success,warning,error}-color)` / `var(--info-color)`; non-CSS →
  `state.*`. Diff tints derive from Adwaita success/error per scheme.
- **Slice 2 — accent + muted** (`text.accent`, `text.muted`). accent → `state.accent`;
  muted → native idiom (CSS `opacity: var(--dim-opacity)` / `.dim-label`; Pango
  `alpha="55%"`; tag/draw sinks resolve `--window-fg-color @ dim-opacity` at load).
- **Slice 3 — border** (`border`). CSS → `var(--border-color)`; non-CSS → window-fg @
  `--border-opacity` (~15%) at load (lookup_color can't resolve `--border-color`).
- **Slice 4 — surfaces + shadow** (`surface.{popover,selected}`, `shadow`). CSS →
  `var(--popover-bg-color)` / `var(--card-bg-color)` /
  `alpha(var(--accent-bg-color), 0.25)` / `var(--shade-color)`.
- **Slice 5 — editor** (`editor.{foreground,background,lineNumber}`) → `--view-fg-color`
  / `--view-bg-color` / `--view-fg-color @ dim`. **Riskiest:** reworks
  `createSourceScheme.ts` + the `followSystemScheme` logic. After this the theme JSON
  retains only `syntax` + `search`/`diff`/`flash`/`pr`.
- **Final** — update `docs/styling.md` + `docs/theming.md` (reduced token set, the
  `theme.ui.state` model, the bridge); verify against system Adwaita **light AND dark**;
  remove `src/poc/adwaita-probe.ts`.

> The earlier abandoned attempt landed Slice 1 + Slice 4 in the *old* "consumers call
> `lookupCSSColor` directly" style, then decided on the loader-fills model above — which
> would have required reworking those call sites. When restarting, build everything on
> the loader-fills model from the start.

## Gotchas

- **`tsc` is the completeness check.** Deleting a `ThemeUi` field makes the compiler list
  every remaining consumer. CSS-string consumers (`var(--t-ui-…)` in template literals)
  are **not** type-checked — grep for them: `rg 't-ui-<token>' src --type ts`.
- A detached `Gtk.Label`'s style context survives GC in node-gtk (the bridge caches one)
  — verified.
- libadwaita real vars include `--popover-bg-color`, `--card-bg-color`, `--shade-color`,
  `--accent-bg-color`, `--{success,warning,error}-color`. `--info-color` / `--hint-color`
  are **ours** (emitted via `appColorVariables`).
- Commands per the worktree's tooling: typecheck `node_modules/.bin/tsc --noEmit`; tests
  `node --test 'src/theme/*.test.ts'` (glob form — a *directory* run hits a harmless
  node-gtk at-exit SIGSEGV); lint `node_modules/.bin/eslint <files>`.
- Leak / GC behavior is **not observable under `node --test`** — WeakRef-style leak
  checks need the live app / CDP, not the unit harness.
