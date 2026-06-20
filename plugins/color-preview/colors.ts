/*
 * Pure color-literal parsing + contrast for the color-preview plugin. Kept free
 * of GTK so it's unit-testable.
 *
 * Recognizes the *unambiguous* CSS color tokens — hex (`#rgb`/`#rgba`/`#rrggbb`/
 * `#rrggbbaa`) and the `rgb()`/`rgba()`/`hsl()`/`hsla()` functional notations
 * (comma- or space-separated, optional `/ alpha`, channels as numbers or `%`).
 * Named colors (`red`, `rebeccapurple`) are intentionally omitted: matched by a
 * bare-word regex they'd tint identifiers and prose, so they need tree-sitter
 * scoping — a follow-up, not this background-tint pass.
 */

/** r, g, b in 0–255; a in 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface TintColors {
  /** The literal's own color (a `#rrggbb(aa)` string), used as the tag background. */
  background: string;
  /** Black or white, whichever reads on `background`, for the tinted text. */
  foreground: string;
}

/**
 * The single regex the plugin scans the buffer with (global, case-insensitive).
 * Hex alternatives are ordered long→short so the longest wins; the trailing `\b`
 * keeps `#fff` from matching inside `#fffword`. The functional forms grab to the
 * closing paren and are validated by the parser (a malformed `rgb(...)` parses to
 * null and is simply skipped).
 */
export const COLOR_LITERAL_RE =
  /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;

/** Parse one color literal to RGBA, or null if it isn't a form we render. */
export function parseColorLiteral(text: string): Rgba | null {
  const s = text.trim().toLowerCase();
  if (s.startsWith('#')) return parseHex(s);
  if (s.startsWith('rgb')) return parseRgbFn(s);
  if (s.startsWith('hsl')) return parseHslFn(s);
  return null;
}

/** Parse a literal and pair its color with a readable contrast foreground. */
export function colorTint(text: string): TintColors | null {
  const rgba = parseColorLiteral(text);
  if (!rgba) return null;
  return { background: toHex(rgba), foreground: contrastColor(rgba) };
}

// --- parsing ---------------------------------------------------------------

function parseHex(s: string): Rgba | null {
  const h = s.slice(1);
  const dup = (c: string): number => parseInt(c + c, 16);
  const pair = (i: number): number => parseInt(h.slice(i, i + 2), 16);
  switch (h.length) {
    case 3:
      return { r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: 1 };
    case 4:
      return { r: dup(h[0]), g: dup(h[1]), b: dup(h[2]), a: dup(h[3]) / 255 };
    case 6:
      return { r: pair(0), g: pair(2), b: pair(4), a: 1 };
    case 8:
      return { r: pair(0), g: pair(2), b: pair(4), a: pair(6) / 255 };
    default:
      return null;
  }
}

function parseRgbFn(s: string): Rgba | null {
  const parts = fnArgs(s);
  if (parts.length < 3) return null;
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  if (r === null || g === null || b === null) return null;
  return { r, g, b, a: parts[3] != null ? alpha(parts[3]) : 1 };
}

function parseHslFn(s: string): Rgba | null {
  const parts = fnArgs(s);
  if (parts.length < 3) return null;
  const h = parseFloat(parts[0]);
  const sat = percent(parts[1]);
  const light = percent(parts[2]);
  if (Number.isNaN(h) || sat === null || light === null) return null;
  const { r, g, b } = hslToRgb(((h % 360) + 360) % 360, sat, light);
  return { r, g, b, a: parts[3] != null ? alpha(parts[3]) : 1 };
}

/** The arguments inside a `name(...)` call, split on commas, whitespace, or `/`. */
function fnArgs(s: string): string[] {
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open === -1 || close <= open) return [];
  return s.slice(open + 1, close).split(/[\s,/]+/).filter(Boolean);
}

/** An rgb channel: `255` or `100%` → 0–255, or null if unparseable. */
function channel(v: string): number | null {
  if (v.endsWith('%')) {
    const p = parseFloat(v);
    return Number.isNaN(p) ? null : clamp(Math.round((p / 100) * 255), 0, 255);
  }
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : clamp(Math.round(n), 0, 255);
}

/** An s/l percentage → 0–1, or null. */
function percent(v: string): number | null {
  const p = parseFloat(v);
  return Number.isNaN(p) ? null : clamp(p / 100, 0, 1);
}

/** An alpha: `0.5` or `50%` → 0–1 (defaults to opaque on garbage). */
function alpha(v: string): number {
  const n = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  return Number.isNaN(n) ? 1 : clamp(n, 0, 1);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] =
    h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

// --- output ----------------------------------------------------------------

/** `#rrggbb`, plus `aa` when the color is translucent. */
function toHex({ r, g, b, a }: Rgba): string {
  const h2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  const base = `#${h2(r)}${h2(g)}${h2(b)}`;
  return a < 1 ? base + h2(a * 255) : base;
}

/** Black or white text for the given background, by relative luminance. Alpha is
 *  ignored (a translucent tint blends toward the editor background, which is
 *  usually dark/light enough that the opaque choice still reads). */
function contrastColor({ r, g, b }: Rgba): string {
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
