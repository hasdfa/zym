/*
 * lsColors — parse the `$LS_COLORS` environment variable (as produced by GNU
 * `dircolors`) into per-file styles, for coloring file names the way `ls --color`
 * does.
 *
 * `LS_COLORS` is a colon-separated list of `key=sgr` pairs: two-letter type codes
 * (`di` directory, `ln` symlink, `ex` executable, `fi` regular file, …) and glob
 * patterns (`*.tar=…`, `*~=…`). Each value is an ANSI SGR sequence (`01;34` =
 * bold blue). We resolve a name to its winning style and expose the foreground as
 * a hex color plus bold/underline flags, ready to drop into Pango markup.
 *
 * Unset/empty `$LS_COLORS` yields `null` from `fromEnv`, so callers degrade to
 * their default rendering with no special-casing.
 */

export interface LsColorStyle {
  /** Foreground color as `#rrggbb`, if the SGR set one. */
  fg?: string;
  bold?: boolean;
  underline?: boolean;
}

// The 16 ANSI colors (xterm defaults): indices 0–7 normal, 0–7 bright. A bold
// 30–37 foreground is rendered from the bright row, matching common terminals.
const NORMAL = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
];
const BRIGHT = [
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];

const hex = (n: number) => n.toString(16).padStart(2, '0');
const rgb = (r: number, g: number, b: number) => `#${hex(r)}${hex(g)}${hex(b)}`;

/** Map an xterm 256-color index to `#rrggbb`. */
function xterm256(n: number): string {
  if (n < 8) return NORMAL[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const c = n - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return rgb(levels[Math.floor(c / 36) % 6], levels[Math.floor(c / 6) % 6], levels[c % 6]);
  }
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

/** Turn an SGR sequence (e.g. `01;38;5;208`) into a style. */
function sgrToStyle(sgr: string): LsColorStyle {
  const codes = sgr.split(';').map((s) => Number(s) || 0);
  const style: LsColorStyle = {};
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 1) style.bold = true;
    else if (c === 4) style.underline = true;
    else if (c >= 30 && c <= 37) style.fg = (style.bold ? BRIGHT : NORMAL)[c - 30];
    else if (c >= 90 && c <= 97) style.fg = BRIGHT[c - 90];
    else if (c === 38) {
      if (codes[i + 1] === 5) {
        style.fg = xterm256(codes[i + 2] ?? 0);
        i += 2;
      } else if (codes[i + 1] === 2) {
        style.fg = rgb(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
        i += 4;
      }
    }
    // 0 (reset), 39 (default fg), and background codes (40–49/100–107) are ignored.
  }
  return style;
}

export class LsColors {
  // Two-letter type codes (`di`, `ln`, `ex`, `fi`, …) → style.
  private types = new Map<string, LsColorStyle>();
  // Glob patterns, stored as the literal suffix after the leading `*` (e.g.
  // `.tar`, `~`); a name matches the longest suffix it ends with.
  private patterns: Array<{ suffix: string; style: LsColorStyle }> = [];

  constructor(spec: string) {
    for (const entry of spec.split(':')) {
      if (entry === '') continue;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      const key = entry.slice(0, eq);
      const style = sgrToStyle(entry.slice(eq + 1));
      if (key.startsWith('*')) this.patterns.push({ suffix: key.slice(1), style });
      else this.types.set(key, style);
    }
  }

  /** Build from `$LS_COLORS` (or a passed value); `null` when it's unset/empty. */
  static fromEnv(value: string | undefined = process.env.LS_COLORS): LsColors | null {
    return value ? new LsColors(value) : null;
  }

  /**
   * The style for a file `name` of the given kind. Type codes win for
   * directories/symlinks/executables; otherwise the longest matching glob suffix
   * (e.g. `*.tar.gz` over `*.gz`), falling back to the regular-file style (`fi`).
   */
  styleFor(name: string, kind: { isDir?: boolean; isSymlink?: boolean; isExec?: boolean } = {}): LsColorStyle | undefined {
    if (kind.isSymlink && this.types.has('ln')) return this.types.get('ln');
    if (kind.isDir) return this.types.get('di');
    if (kind.isExec && this.types.has('ex')) return this.types.get('ex');
    let best: LsColorStyle | undefined;
    let bestLen = -1;
    for (const p of this.patterns) {
      if (p.suffix.length > bestLen && name.endsWith(p.suffix)) {
        best = p.style;
        bestLen = p.suffix.length;
      }
    }
    return best ?? this.types.get('fi');
  }
}
