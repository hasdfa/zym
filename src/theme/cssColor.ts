/*
 * cssColor — resolve a CSS-variable *color* to a concrete `#rrggbb[aa]` string for
 * the consumers that can't read CSS: Pango markup (`<span foreground="…">`),
 * GtkTextTag, draw-func colors, and the GtkSourceView scheme XML. CSS itself reads
 * `var(--accent-color)` natively and never needs this. This module is the *mechanism*;
 * the color knowledge it reads (APP_COLORS, FALLBACK_COLORS) lives in adwaitaColors.ts
 * with the rest of the design tokens.
 *
 * `lookupCSSColor(scheme, '--accent-color')` resolves any CSS-variable name —
 * libadwaita's *or* one of ours (info / hint) — through one path, in three layers:
 *   1. the **app-color registry** (APP_COLORS) — first-class semantic tokens that
 *      libadwaita has no variable for (info / hint).
 *   2. a **probe widget** styled with `color: var(--name)`, read back via
 *      `gtk_widget_get_color()` — GTK's full CSS engine, so it resolves everything
 *      libadwaita exposes: plain vars, `color-mix()` (e.g. `--border-color`), `alpha()`,
 *      and the named accent palette. Needs a display, so it's skipped headless. (Replaces
 *      the deprecated `style_context.lookup_color`; validated in poc/adwaita-probe.)
 *   3. the static **fallback** palette (FALLBACK_COLORS) — for headless / no-display
 *      runs (tests, offscreen snapshots) where layer 2 can't resolve.
 *
 * Everything is a `#rrggbb[aa]` string end to end: the registries hold strings, and
 * the one non-string input — the `Gdk.RGBA` from the probe's `get_color` — is stringified
 * at the boundary by `gdkRgbaToString`, so no `Gdk.RGBA` is ever passed around. The
 * light/dark **`scheme` is passed in by the caller**; this module never reads the live
 * `Adw.StyleManager`. It registers no signal handlers and owns no scheme state — callers
 * track scheme changes themselves and pass the current one. Results are **cached** by
 * `scheme:name` so a flip just routes to fresh
 * keys (layer-2 values are constant within a scheme); layer-3 results aren't cached,
 * since a display may appear after an early headless read and should then win.
 */
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import { APP_COLORS, FALLBACK_COLORS, type Scheme } from './adwaitaColors.ts';

/** A `Gdk.RGBA` (0–1 doubles) as a `#rrggbb` string, or `#rrggbbaa` when not fully
 *  opaque. The single point where a `Gdk.RGBA` turns into the string the rest of the
 *  module passes around — call it the moment you get one (e.g. from a draw-func). */
export function gdkRgbaToString(rgba: { red: number; green: number; blue: number; alpha: number }): string {
  const byte = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const a = byte(rgba.alpha);
  const rgb = `#${hex(byte(rgba.red))}${hex(byte(rgba.green))}${hex(byte(rgba.blue))}`;
  return a === 255 ? rgb : `${rgb}${hex(a)}`;
}

/** Scale the alpha of a resolved `#rrggbb[aa]` string by `factor` (0–1), returning
 *  `#rrggbbaa`. Our resolved colors are always hex, so this is plain hex math (no
 *  color lib). The non-CSS analogue of CSS's `alpha(var(--…), factor)` — see
 *  `lookupCSSColorAlpha`. */
function withAlpha(hex: string, factor: number): string {
  const base = hex.length >= 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  const a = Math.round(Math.max(0, Math.min(1, base * factor)) * 255);
  return `${hex.slice(0, 7)}${a.toString(16).padStart(2, '0')}`;
}

// --- Resolution (the single path) -----------------------------------------

const cache = new Map<string, string>();
// Cached once it exists; `??=` keeps retrying while null so an early headless read
// doesn't pin it. No display → no GTK widgets, so layer 2 is skipped (tests/offscreen).
let display: InstanceType<typeof Gdk.Display> | null = null;
// One display-wide provider holding a `#<id> { color: var(--name); }` rule per probed
// variable; reloaded as new names appear. A fresh probe label reads a rule back through
// GTK's CSS engine (see `probeResolve`).
let probeProvider: InstanceType<typeof Gtk.CssProvider> | null = null;
// CSS-variable name → the probe element id carrying its `color: var(--name)` rule.
const probeIds = new Map<string, string>();

/**
 * Resolve a CSS-variable color (live scheme) to a string via a probe widget's computed
 * `color`, or `null` when there's no display (headless) — the non-deprecated replacement
 * for `lookup_color`. Styling a probe `color: var(--name)` and reading it back with
 * `gtk_widget_get_color()` runs the full CSS engine, so `color-mix()` (`--border-color`),
 * `alpha()`, and the named accent palette all resolve — not just `@define-color` names.
 *
 * The label is built **fresh per call**: a reused label freezes at the scheme it first
 * computed and never tracks an `Adw.StyleManager` dark/light flip, whereas a fresh,
 * unrooted label resolves synchronously against the display's providers (no realize /
 * present needed). The `scheme:name` cache in `lookupCSSColor` means a fresh label is
 * only built on a cache miss.
 */
function probeResolve(name: string): string | null {
  display ??= Gdk.Display.getDefault();
  if (!display) return null; // headless → caller falls through to FALLBACK_COLORS
  let id = probeIds.get(name);
  if (id === undefined) {
    id = `zymColorProbe_${name.replace(/^--/, '').replace(/[^a-z0-9]/gi, '_')}`;
    probeIds.set(name, id);
    if (!probeProvider) {
      probeProvider = new Gtk.CssProvider();
      Gtk.StyleContext.addProviderForDisplay(display, probeProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
    }
    // Reload with a color rule for every probed variable seen so far.
    probeProvider.loadFromString([...probeIds].map(([n, i]) => `#${i} { color: var(${n}); }`).join('\n'));
  }
  const label = new Gtk.Label(); // fresh per resolve — tracks the live scheme
  label.setName(id);
  // node-gtk returns the out `GdkRGBA` directly for `void get_color(out color)`.
  const rgba = label.getColor();
  return rgba ? gdkRgbaToString(rgba) : null;
}

/**
 * Resolve a CSS-variable color to a `#rrggbb[aa]` string for interpolation into Pango
 * markup / GtkTextTag / scheme XML — the single path, in three layers: app registry →
 * CSS-engine probe → static fallback. The caller passes the `scheme` and keeps it in step
 * with the live Adwaita scheme, so GTK (which always reports the live scheme) agrees.
 * Throws if the name resolves nowhere (an unknown variable).
 */
export function lookupCSSColor(scheme: Scheme, name: string): string {
  const key = `${scheme}:${name}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  // 1. app registry — scheme-keyed literal, display-independent, safe to cache.
  const app = APP_COLORS[name];
  if (app) {
    cache.set(key, app[scheme]);
    return app[scheme];
  }

  // 2. live libadwaita value — probe the CSS engine (returns null headless, where the
  //    static fallback below answers instead).
  const probed = probeResolve(name);
  if (probed !== null) {
    cache.set(key, probed);
    return probed;
  }

  // 3. static fallback — used headless; NOT cached (a display may arrive later and
  //    should then win over this approximation).
  const fb = FALLBACK_COLORS[name];
  if (fb) return fb[scheme];

  throw new Error(`lookupCSSColor: cannot resolve "${name}"`);
}

/**
 * Like `lookupCSSColor`, but scales the resolved color's alpha by `factor` (0–1) —
 * the non-CSS equivalent of CSS's `alpha(var(--…), factor)`, for GtkTextTag / draw-func
 * backgrounds that want a translucent shade (e.g. a selection background of
 * `--accent-bg-color` at 25%). Returns `#rrggbbaa`.
 */
export function lookupCSSColorAlpha(scheme: Scheme, name: string, factor: number): string {
  return withAlpha(lookupCSSColor(scheme, name), factor);
}
