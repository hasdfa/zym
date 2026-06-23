/*
 * Lightweight regex + replacement syntax highlighting for the search bar's
 * `Gtk.Entry` inputs. A GtkEntry can't render Pango markup, so we color character
 * ranges with a `PangoAttrList` via `gtk_entry_set_attributes`. Used only while
 * the bar is in regex mode; an empty list clears it otherwise.
 *
 * The tokenizer is deliberately shallow — it colors metacharacters, groups,
 * character classes, and escapes (and `$`-refs in the replacement) — enough to
 * read a pattern at a glance, not a full regex parser.
 */
import { Pango } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';

interface Span {
  start: number; // char offset (inclusive)
  end: number; // char offset (exclusive)
  color: string; // #rrggbb
}

// Regex tokens reuse the theme's syntax palette so they match the editor's colors
// (with theme-token fallbacks — never an inline literal).
const COLOR = {
  meta: theme.syntax.keyword ?? theme.ui.text.accent, // . ^ $ | * + ? { }
  group: theme.syntax.punctuation ?? theme.ui.status.info, // ( )
  charClass: theme.syntax.type ?? theme.ui.status.warning, // [ … ]
  escape: theme.syntax['string.escape'] ?? theme.syntax.string ?? theme.ui.status.info, // \x
  ref: theme.syntax.constant ?? theme.syntax.number ?? theme.ui.status.warning, // $1 $& … in the replacement
};

/** Color spans for a regex pattern. */
export function regexSpans(source: string): Span[] {
  const spans: Span[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; ) {
    const c = source[i];
    if (c === '\\') {
      spans.push({ start: i, end: Math.min(i + 2, source.length), color: COLOR.escape });
      i += 2;
      continue;
    }
    if (inClass) {
      spans.push({ start: i, end: i + 1, color: COLOR.charClass });
      if (c === ']') inClass = false;
      i++;
      continue;
    }
    if (c === '[') {
      spans.push({ start: i, end: i + 1, color: COLOR.charClass });
      inClass = true;
    } else if (c === '(' || c === ')') {
      spans.push({ start: i, end: i + 1, color: COLOR.group });
    } else if ('.^$|*+?{}'.includes(c)) {
      spans.push({ start: i, end: i + 1, color: COLOR.meta });
    }
    i++;
  }
  return spans;
}

/** Color spans for a JS replacement string (`$1`, `$&`, `` $` ``, `$'`, `$$`, `$<name>`). */
export function replacementSpans(source: string): Span[] {
  const spans: Span[] = [];
  const re = /\$(?:\d+|[&$`']|<[^>]*>)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length, color: COLOR.ref });
  }
  return spans;
}

/** Apply `spans` over `entry` (whose text is `source`), replacing any prior attributes. */
export function applySpans(entry: any, source: string, spans: Span[]): void {
  const list = (Pango.AttrList as any).new();
  for (const span of spans) {
    const [r, g, b] = rgb16(span.color);
    const attr = (Pango as any).attrForegroundNew(r, g, b);
    attr.startIndex = byteLength(source.slice(0, span.start));
    attr.endIndex = byteLength(source.slice(0, span.end));
    list.insert(attr);
  }
  entry.setAttributes(list);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** `#rrggbb` → 16-bit-per-channel RGB (Pango's color depth). */
function rgb16(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) * 257,
    parseInt(h.slice(2, 4), 16) * 257,
    parseInt(h.slice(4, 6), 16) * 257,
  ];
}
