/*
 * highlightRuns — the pure sweep that flattens overlapping highlight captures
 * into non-overlapping styled runs. Extracted from SyntaxController so the
 * stacking semantics are unit-testable without GTK (the controller maps a run's
 * resolved values to TextTags and applies them).
 *
 * Two kinds of styling compose differently, on purpose:
 *
 *  - **Foreground color** uses tree-sitter's "innermost wins, *with suppression*":
 *    the narrowest capture covering a point decides the color — even when that
 *    capture has none (null), so a narrow uncolored identifier shows the default
 *    foreground instead of bleeding a broader `@function` color. Ties break toward
 *    the later capture (injected layers are gathered after the base, so they win).
 *
 *  - **Decorations** (background, scale, bold/italic/underline/strikethrough)
 *    *layer* — they are NOT suppressed by a narrower token. Background and scale
 *    take the innermost capture that actually has one (so a code span's background
 *    covers the whole span even where inner tokens recolor the text, and a heading
 *    keeps its scale over an inline-code run inside it). The booleans are additive
 *    (nested `***bold italic***` is both).
 *
 * Generic over the tag type `C` so tests can use plain string sentinels.
 */

/** One capture's styling contribution over `[start, end)`. */
export interface StyleSpan<C> {
  start: number;
  end: number;
  /** Position in the capture stream; later breaks color ties. */
  idx: number;
  color: C | null;
  background: C | null;
  /** Full-line (paragraph) background — for block code, vs `background`'s text-only. */
  lineBackground: C | null;
  scale: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

/** A resolved, non-overlapping run with the styling to apply over it. */
export interface StyleRun<C> {
  start: number;
  end: number;
  color: C | null;
  background: C | null;
  lineBackground: C | null;
  scale: number | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

/** Resolve the styling active over one elementary interval. */
function resolveInterval<C>(active: Set<StyleSpan<C>>): Omit<StyleRun<C>, 'start' | 'end'> {
  let inner: StyleSpan<C> | null = null; // innermost span (for color, with suppression)
  let innerW = Infinity, innerIdx = -1;
  let background: C | null = null, bgW = Infinity, bgIdx = -1;
  let lineBackground: C | null = null, lbgW = Infinity, lbgIdx = -1;
  let scale: number | null = null, scW = Infinity, scIdx = -1;
  let bold = false, italic = false, underline = false, strikethrough = false;

  for (const s of active) {
    const w = s.end - s.start;
    if (w < innerW || (w === innerW && s.idx > innerIdx)) { inner = s; innerW = w; innerIdx = s.idx; }
    if (s.background !== null && (w < bgW || (w === bgW && s.idx > bgIdx))) {
      background = s.background; bgW = w; bgIdx = s.idx;
    }
    if (s.lineBackground !== null && (w < lbgW || (w === lbgW && s.idx > lbgIdx))) {
      lineBackground = s.lineBackground; lbgW = w; lbgIdx = s.idx;
    }
    if (s.scale !== null && (w < scW || (w === scW && s.idx > scIdx))) {
      scale = s.scale; scW = w; scIdx = s.idx;
    }
    bold ||= s.bold;
    italic ||= s.italic;
    underline ||= s.underline;
    strikethrough ||= s.strikethrough;
  }
  return { color: inner ? inner.color : null, background, lineBackground, scale, bold, italic, underline, strikethrough };
}

function isBlank<C>(r: Omit<StyleRun<C>, 'start' | 'end'>): boolean {
  return r.color === null && r.background === null && r.lineBackground === null &&
    r.scale === null && !r.bold && !r.italic && !r.underline && !r.strikethrough;
}

function sameStyle<C>(a: Omit<StyleRun<C>, 'start' | 'end'>, b: Omit<StyleRun<C>, 'start' | 'end'>): boolean {
  return a.color === b.color && a.background === b.background && a.lineBackground === b.lineBackground &&
    a.scale === b.scale && a.bold === b.bold && a.italic === b.italic &&
    a.underline === b.underline && a.strikethrough === b.strikethrough;
}

/**
 * Flatten overlapping spans into non-overlapping runs, merging adjacent runs with
 * identical styling. Blank runs (no styling) are dropped (they're the gaps). The
 * input order is irrelevant except that `idx` decides color ties.
 */
export function computeStyleRuns<C>(spans: StyleSpan<C>[]): StyleRun<C>[] {
  const points = new Set<number>();
  const startsAt = new Map<number, StyleSpan<C>[]>();
  const endsAt = new Map<number, StyleSpan<C>[]>();
  for (const s of spans) {
    if (s.start >= s.end) continue; // zero-width paints nothing
    points.add(s.start);
    points.add(s.end);
    (startsAt.get(s.start) ?? startsAt.set(s.start, []).get(s.start)!).push(s);
    (endsAt.get(s.end) ?? endsAt.set(s.end, []).get(s.end)!).push(s);
  }
  const sorted = [...points].sort((a, b) => a - b);

  const active = new Set<StyleSpan<C>>();
  const runs: StyleRun<C>[] = [];
  let cur: StyleRun<C> | null = null;
  const flush = () => { if (cur) { runs.push(cur); cur = null; } };

  for (let i = 0; i < sorted.length - 1; i++) {
    const p = sorted[i];
    for (const s of endsAt.get(p) ?? []) active.delete(s);
    for (const s of startsAt.get(p) ?? []) active.add(s);

    const style = resolveInterval(active);
    if (isBlank(style)) { flush(); continue; }
    if (cur && sameStyle(cur, style)) cur.end = sorted[i + 1];
    else { flush(); cur = { start: p, end: sorted[i + 1], ...style }; }
  }
  flush();
  return runs;
}
