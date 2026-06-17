/*
 * leapTargets — the pure (GTK-free) core of the leap motion: finding match
 * targets, picking a safe label set, assigning stable labels, and interpreting a
 * label-phase keypress. Split out from `Leap` so the headless vim layer
 * (`motion.js`, for `;` repeat) and the host renderer can share it, and so it is
 * unit-testable without a display.
 */
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';

// leap.nvim's default label set — picked for reachability and to avoid easy
// mistypes; matches are labeled in nearest-first order from this list (minus any
// character that could be a next search char).
export const LEAP_LABELS = 'sfnjklhodweimbuyvrgtaqpcxz';
export const PAGE_KEY = ' ';

/** A target and the key that selects it (empty `label` = a paged-out dot). */
export interface LeapTarget {
  label: string;
  range: Range;
}

/** What a keypress means during the label phase. */
export type LeapChoice =
  | { kind: 'jump'; point: Point }
  | { kind: 'page'; page: number }
  | { kind: 'miss' };

/** Escape a literal string for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Stable key for a match — its start position. */
function keyOf(range: Range): string {
  return `${range.start.row}:${range.start.column}`;
}

/** Number of label pages for `count` matches given a label set of `size`. */
export function pageCount(count: number, size: number): number {
  return size > 0 ? Math.ceil(count / size) : 1;
}

/**
 * Every match of the literal `pattern` within `range`, ordered nearest-first
 * relative to `cursor`. Directional (forward keeps matches after the cursor,
 * backward those before it) unless `bidirectional`, which keeps both and orders
 * by distance (forward winning ties). Case-sensitive, like leap's default. Pure
 * (uses only the buffer scan), so it is headless-testable.
 */
export function computeLeapTargets(
  editor: EditorModel,
  pattern: string,
  opts: { reverse: boolean; cursor: Point; range: Range; bidirectional?: boolean },
): Range[] {
  if (pattern.length === 0) return [];
  const regex = new RegExp(escapeRegExp(pattern), 'g');
  const matches: Range[] = [];
  editor.scanInBufferRange(regex, opts.range, ({ range }) => matches.push(range));

  const { reverse, cursor, bidirectional } = opts;
  if (bidirectional) {
    return matches
      .filter((m) => !m.start.isEqual(cursor))
      .sort((a, b) => byDistance(a.start, b.start, cursor));
  }
  const filtered = matches.filter((m) =>
    reverse ? m.start.isLessThan(cursor) : m.start.isGreaterThan(cursor),
  );
  // Nearest-first: ascending from the cursor going forward, descending going back.
  filtered.sort((a, b) => (reverse ? b.start.compare(a.start) : a.start.compare(b.start)));
  return filtered;
}

/** Order two points by distance from `cursor` (rows, then columns), with a
 *  forward (after-cursor) target winning an exact tie. */
function byDistance(a: Point, b: Point, cursor: Point): number {
  const ra = Math.abs(a.row - cursor.row);
  const rb = Math.abs(b.row - cursor.row);
  if (ra !== rb) return ra - rb;
  const ca = Math.abs(a.column - cursor.column);
  const cb = Math.abs(b.column - cursor.column);
  if (ca !== cb) return ca - cb;
  return (a.isGreaterThan(cursor) ? 0 : 1) - (b.isGreaterThan(cursor) ? 0 : 1);
}

/** The set of characters that immediately follow a match — the keys that, typed
 *  next, would narrow the search. Excluding these from the label set keeps a
 *  narrowing keystroke from being read as a label. */
export function leapNextChars(editor: EditorModel, matches: Range[]): Set<string> {
  const chars = new Set<string>();
  for (const m of matches) {
    const next = editor.getTextInBufferRange(new Range(m.end, new Point(m.end.row, m.end.column + 1)));
    if (next) chars.add(next);
  }
  return chars;
}

/** The label set minus any character that could be a next search char. */
export function safeLeapLabels(nextChars: Set<string>): string {
  let labels = '';
  for (const ch of LEAP_LABELS) if (!nextChars.has(ch)) labels += ch;
  return labels;
}

/**
 * Assign labels to one page of `matches` by identity. `page` selects the window
 * of `matches` (size = `labels.length`) that receives letters; the rest get no
 * label (rendered as dots). `prior` carries the previous round's assignment so a
 * surviving match keeps its letter as the search narrows. Returns the per-match
 * labeling (`label: ''` = no label) and the new assignment to thread forward.
 */
export function assignLeapLabels(
  matches: Range[],
  labels: string,
  page: number,
  prior?: Map<string, string>,
): { labeled: LeapTarget[]; assigned: Map<string, string> } {
  const size = labels.length;
  const assigned = new Map<string, string>();
  if (size === 0) {
    return { labeled: matches.map((range) => ({ range, label: '' })), assigned };
  }

  const start = page * size;
  const windowKeys = new Set(matches.slice(start, start + size).map(keyOf));
  // Carry over a prior label for any in-window match still present (stability).
  const used = new Set<string>();
  for (const m of matches) {
    const k = keyOf(m);
    const prev = windowKeys.has(k) ? prior?.get(k) : undefined;
    if (prev) {
      assigned.set(k, prev);
      used.add(prev);
    }
  }
  // Fresh labels (those not already carried) go to the remaining in-window matches.
  const pool = [...labels].filter((ch) => !used.has(ch));
  let next = 0;
  const labeled = matches.map((range) => {
    const k = keyOf(range);
    let label = assigned.get(k);
    if (!label && windowKeys.has(k) && next < pool.length) {
      label = pool[next++];
      assigned.set(k, label);
    }
    return { range, label: label ?? '' };
  });
  return { labeled, assigned };
}

/**
 * Interpret a label-phase keypress against the current `labeled` targets on
 * `page` of `pages`: Space (with further pages) advances the page; a key equal to
 * a shown label jumps to that target; anything else misses (so the caller can
 * treat the key as a narrowing search char).
 */
export function resolveLeapChoice(
  labeled: LeapTarget[],
  page: number,
  pages: number,
  key: string,
): LeapChoice {
  if (key === PAGE_KEY && pages > 1) return { kind: 'page', page: (page + 1) % pages };
  const hit = labeled.find((t) => t.label !== '' && t.label === key);
  return hit ? { kind: 'jump', point: hit.range.start } : { kind: 'miss' };
}
