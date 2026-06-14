/*
 * Font helpers: bridge the GNOME/Pango font world to GTK CSS.
 *
 * GSettings stores fonts as Pango font-description strings (e.g.
 * "JetBrainsMono Nerd Font Light 11"), where the trailing tokens are the weight
 * and point size, not part of the family name. Dropping them naively leaves an
 * invalid CSS family, so we parse with Pango and emit each property explicitly.
 */
import { Gio, Pango } from './gi.ts';

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

/** The OS monospace font (org.gnome.desktop.interface monospace-font-name) as CSS. */
export function monospaceFontCss(): FontCss {
  const settings = new Gio.Settings({ schemaId: 'org.gnome.desktop.interface' });
  return fontDescriptionToCss((settings as any).getString('monospace-font-name'));
}
