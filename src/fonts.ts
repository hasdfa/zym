/*
 * Font helpers: bridge the GNOME/Pango font world to GTK CSS.
 *
 * GSettings stores fonts as Pango font-description strings (e.g.
 * "JetBrainsMono Nerd Font Light 11"), where the trailing tokens are the weight
 * and point size, not part of the family name. Dropping them naively leaves an
 * invalid CSS family, so we parse with Pango and emit each property explicitly.
 *
 * The single source of truth is the `fonts` store (bottom of this file): it owns
 * the app's monospace/UI fonts, follows the GNOME interface fonts live, and lets
 * any consumer attach to it — CSS widgets register a selector (`fonts.monospace`),
 * Pango-markup callers read the live family (`fonts.monospaceFamily`), and
 * widgets taking a font description subscribe (`fonts.onChange`). Change the font
 * in one place and everything re-applies. The bare functions below are its
 * primitives.
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
  /** The above as a CSS declaration block (no selector). */
  declarations: string;
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

  const decls = [
    `font-family: "${family}";`,
    `font-weight: ${weight};`,
    `font-style: ${style};`,
  ];
  if (sizePt) decls.push(`font-size: ${sizePt}pt;`);

  return { family: `"${family}"`, weight, style, sizePt, declarations: decls.join(' ') };
}

function familyOf(description: string, fallback: string): string {
  return Pango.FontDescription.fromString(description).getFamily() || fallback;
}

/**
 * The application font store — the single place the app's monospace/UI fonts are
 * defined and kept in sync. Three ways to attach:
 *
 *  - CSS widgets: `fonts.monospace('#MyWidget')` registers a selector that gets
 *    the monospace font from one central, reactive stylesheet (no per-component
 *    inlined declarations). `fonts.ui(selector)` does the same with the UI font.
 *  - Pango markup: read `fonts.monospaceFamily` / `fonts.uiFamily` at render time
 *    (live values), so `face="…"`/`font_family="…"` always reflect the current
 *    font.
 *  - Font-description consumers (e.g. VTE): `fonts.monospaceDescription()` plus
 *    `fonts.onChange(...)` to re-apply when the font changes.
 *
 * It follows the GNOME interface fonts live; `reload()` is public so a future
 * user font setting can drive the same path.
 */
class FontStore {
  private readonly settings = new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' });
  private readonly monoSelectors = new Set<string>();
  private readonly uiSelectors = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private ready = false; // the display (and so `styles.set`) isn't available until init

  private _monoCss: FontCss = fontDescriptionToCss(this.monoName());
  private _monoFamily = familyOf(this.monoName(), 'monospace');
  private _uiFamily = familyOf(this.uiName(), 'sans-serif');

  /** The monospace font as parsed CSS (family/weight/size + declaration block). */
  get monospaceCss(): FontCss {
    return this._monoCss;
  }
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

  /** Give `selector` the app monospace font via the central reactive sheet. */
  monospace(selector: string): void {
    this.monoSelectors.add(selector);
    this.apply();
  }
  /** Give `selector` the app UI (proportional) font via the central sheet. */
  ui(selector: string): void {
    this.uiSelectors.add(selector);
    this.apply();
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
    this._monoFamily = familyOf(this.monoName(), 'monospace');
    this._uiFamily = familyOf(this.uiName(), 'sans-serif');
    this.apply();
    for (const cb of [...this.listeners]) cb();
  }

  private apply(): void {
    if (!this.ready) return; // registrations before init() are flushed by init()
    styles.set(this.css(), { key: 'app-fonts' });
  }

  private css(): string {
    const rules: string[] = [];
    if (this.monoSelectors.size)
      rules.push(`${[...this.monoSelectors].join(',\n')} { ${this._monoCss.declarations} }`);
    if (this.uiSelectors.size)
      rules.push(`${[...this.uiSelectors].join(',\n')} { font-family: "${this._uiFamily}"; }`);
    return rules.join('\n');
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
