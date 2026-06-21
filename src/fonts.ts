/*
 * Font helpers: bridge the GNOME/Pango font world to GTK CSS.
 *
 * GSettings stores fonts as Pango font-description strings (e.g.
 * "JetBrainsMono Nerd Font Light 11"), where the trailing tokens are the weight
 * and point size, not part of the family name. Dropping them naively leaves an
 * invalid CSS family, so we parse with Pango and emit each property explicitly.
 *
 * The single source of truth is the `fonts` store (bottom of this file): it owns
 * the app's monospace/UI fonts and follows the GNOME interface fonts live. It
 * publishes them three ways, one per consumer kind:
 *   - **CSS** — reactive custom properties on `#AppWindow` (`--t-font-ui-family`,
 *     `--t-font-monospace`, …; see `themeFontCssVariables`-style block in `css()`).
 *     A root `font-family: var(--t-font-ui-family)` baseline makes every widget
 *     follow the UI font by inheritance; monospace surfaces opt in with
 *     `font: var(--t-font-monospace)` (or `font-family: var(--t-font-monospace-family)`).
 *   - **Pango markup** — read the live family (`fonts.monospaceFamily` /
 *     `fonts.uiFamily`) at render time; markup can't read CSS variables.
 *   - **Font-description consumers** (e.g. VTE) — `fonts.monospaceDescription()` plus
 *     `fonts.onChange(...)` to re-apply on change.
 * Change the font in one place and everything re-applies. The bare functions below
 * are its primitives.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gio, Pango, PangoCairo } from './gi.ts';
import { styles } from './styles.ts';

/** Pango family name of the bundled icon font (see assets/fonts). */
export const ICON_FONT_FAMILY = 'Symbols Nerd Font Mono';

const BUNDLED_FONTS = ['SymbolsNerdFontMono-Regular.ttf'];

/**
 * Register the fonts bundled under assets/fonts with GTK's default fontmap, so
 * the file-tree glyph icons render regardless of what's installed system-wide.
 * Must run after GTK is initialized (i.e. inside app startup/activate).
 */
export function registerBundledFonts(): void {
  const dir = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
  const fontMap = PangoCairo.FontMap.getDefault();
  for (const file of BUNDLED_FONTS) {
    if (!fontMap.addFontFile(Path.join(dir, file)))
      console.warn(`quilx: failed to load bundled font ${file}`);
  }
}

export interface FontCss {
  family: string;       // CSS-quoted family, e.g. '"JetBrainsMono Nerd Font"'
  weight: number;       // CSS numeric weight (Pango weights are already 100–1000)
  style: string;        // 'normal' | 'italic' | 'oblique'
  sizePt: number | null; // point size, or null when unspecified
}

/** Parse a Pango font-description string into CSS font properties. */
export function fontDescriptionToCss(description: string): FontCss {
  const desc = Pango.FontDescription.fromString(description);

  const family = desc.getFamily() || 'monospace';
  const weight = desc.getWeight(); // Pango.Weight values equal CSS numeric weights
  const pangoStyle = desc.getStyle();
  const style =
    pangoStyle === Pango.Style.ITALIC ? 'italic' :
    pangoStyle === Pango.Style.OBLIQUE ? 'oblique' : 'normal';

  // getSize() is in Pango units (PANGO_SCALE per point) unless absolute (device
  // pixels), which we don't translate to CSS pt; skip the size in that case.
  const sizePt = desc.getSizeIsAbsolute() ? null : desc.getSize() / Pango.SCALE;

  return { family: `"${family}"`, weight, style, sizePt };
}

function familyOf(description: string, fallback: string): string {
  return Pango.FontDescription.fromString(description).getFamily() || fallback;
}

/**
 * The application font store — the single place the app's monospace/UI fonts are
 * defined and kept in sync. It publishes them as reactive CSS variables on the root
 * `#AppWindow` (plus a UI-font baseline), and exposes live family names + a
 * font-description for the consumers that can't read CSS:
 *
 *  - **CSS** — read `var(--t-font-monospace)` / `var(--t-font-monospace-family)` /
 *    `var(--t-font-ui-family)` (full list below) in a component's own stylesheet.
 *    Don't inline a family literal. The root `#AppWindow` baseline applies the UI
 *    font to everything by inheritance, so only monospace surfaces need a rule.
 *  - **Pango markup** — read `fonts.monospaceFamily` / `fonts.uiFamily` at render
 *    time, so `face="…"`/`font_family="…"` reflect the current font.
 *  - **Font-description consumers** (e.g. VTE) — `fonts.monospaceDescription()` plus
 *    `fonts.onChange(...)` to re-apply when the font changes.
 *
 * Published CSS variables (on `#AppWindow`, re-set on every change) — the same full
 * set for each role (`ui`, `monospace`):
 *  - `--t-font-<role>-family`, `--t-font-<role>-weight`, `--t-font-<role>-style`
 *  - `--t-font-<role>-size?` and `--t-font-<role>?` (the `font` shorthand)
 * The `*-size` and shorthand vars are omitted when the font carries no point size
 * (an absolute/device-pixel description), since a `font` shorthand needs a size.
 *
 * It follows the GNOME interface fonts live; `reload()` is public so a future user
 * font setting can drive the same path. See docs/styling.md → Fonts.
 */
class FontStore {
  private readonly settings = new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' });
  private readonly listeners = new Set<() => void>();
  private ready = false; // the display (and so `styles.set`) isn't available until init

  private _monoCss: FontCss = fontDescriptionToCss(this.monoName());
  private _uiCss: FontCss = fontDescriptionToCss(this.uiName());
  private _monoFamily = familyOf(this.monoName(), 'monospace');
  private _uiFamily = familyOf(this.uiName(), 'sans-serif');

  /** The monospace family name (unquoted), for Pango `face=`/`font_family=`. */
  get monospaceFamily(): string {
    return this._monoFamily;
  }
  /** The UI (proportional) family name (unquoted), for Pango markup. */
  get uiFamily(): string {
    return this._uiFamily;
  }
  /** The monospace font as a Pango.FontDescription (e.g. for VTE). */
  monospaceDescription(): InstanceType<typeof Pango.FontDescription> {
    return Pango.FontDescription.fromString(this.monoName());
  }

  /** Subscribe to font changes (system or, later, user config). Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Install the central font stylesheet and follow system changes. Call once
   *  after `installStyles()` (when the display exists). */
  init(): void {
    this.ready = true;
    this.apply();
    this.settings.on('changed', (key: string) => {
      if (key === 'monospace-font-name' || key === 'font-name') this.reload();
    });
  }

  /** Recompute the fonts, re-apply the sheet, and notify subscribers. */
  reload(): void {
    this._monoCss = fontDescriptionToCss(this.monoName());
    this._uiCss = fontDescriptionToCss(this.uiName());
    this._monoFamily = familyOf(this.monoName(), 'monospace');
    this._uiFamily = familyOf(this.uiName(), 'sans-serif');
    this.apply();
    for (const cb of [...this.listeners]) cb();
  }

  private apply(): void {
    if (!this.ready) return; // changes before init() are flushed by init()
    styles.set(this.css(), { key: 'app-fonts' });
  }

  /** The reactive font sheet: the `--t-font-*` variables + the UI-font baseline,
   *  both on `#AppWindow` so every descendant inherits the UI font. */
  private css(): string {
    return `#AppWindow {\n${this.variables()}\n  font-family: var(--t-font-ui-family);\n}`;
  }

  private variables(): string {
    return [...this.fontVars('ui', this._uiCss), ...this.fontVars('monospace', this._monoCss)]
      .map((l) => `  ${l}`)
      .join('\n');
  }

  /** The full set of `--t-font-<role>-*` declarations for one font: family, weight,
   *  style, and — when the font carries a point size — size plus the `font` shorthand
   *  (`--t-font-<role>`). The `*-size` and shorthand are omitted for an absolute
   *  (device-pixel) description, since a `font` shorthand needs a point size. */
  private fontVars(role: 'ui' | 'monospace', f: FontCss): string[] {
    const lines = [
      `--t-font-${role}-family: ${f.family};`,
      `--t-font-${role}-weight: ${f.weight};`,
      `--t-font-${role}-style: ${f.style};`,
    ];
    if (f.sizePt) {
      lines.push(`--t-font-${role}-size: ${f.sizePt}pt;`);
      lines.push(`--t-font-${role}: ${f.style} ${f.weight} ${f.sizePt}pt ${f.family};`);
    }
    return lines;
  }

  private monoName(): string {
    return (this.settings as any).getString('monospace-font-name') as string;
  }
  private uiName(): string {
    return (this.settings as any).getString('font-name') as string;
  }
}

/** The application's single font store. */
export const fonts = new FontStore();
