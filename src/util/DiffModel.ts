/*
 * DiffModel — the structured input a diff viewer renders, computed from two
 * texts via the line-level `diffLines`. Pure and GTK-free (unit-tested); the
 * editor's diff panes consume it.
 *
 * `lines` is the unified line list (context + removed + added, in file order) —
 * exactly the rows a synthesized inline (unified) buffer holds, each tagged with
 * its `kind` (for the line decoration + gutter glyph) and its source rows.
 * `hunks` are the contiguous changed regions, for hunk navigation / fold-unchanged
 * (each points at a `lines` row range). See docs/text-editor/diff.md.
 */
import { diffWordsWithSpace } from 'diff';
import { diffLines } from './lineDiff.ts';

export type DiffLineKind = 'context' | 'added' | 'removed';

/** A changed character span within a line, as codepoint offsets `[start, end)`. */
export type WordRange = [start: number, end: number];

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 0-based row in the old text, or null for an added line. */
  oldRow: number | null;
  /** 0-based row in the new text, or null for a removed line. */
  newRow: number | null;
  /** For a modified line (a removed↔added pair that share content), the char
   *  spans that actually changed within this line — for intra-line highlighting. */
  wordRanges?: WordRange[];
}

export interface DiffHunk {
  /** Index of the hunk's first line in `DiffModel.lines` (the unified buffer row). */
  startRow: number;
  /** Number of `lines` rows the hunk spans. */
  rowCount: number;
  added: number;
  removed: number;
  /** First old/new rows the hunk touches (null when it has none of that side). */
  oldStart: number | null;
  newStart: number | null;
}

export interface DiffModel {
  lines: DiffLine[];
  hunks: DiffHunk[];
  stats: { added: number; removed: number };
}

/** A diff line carrying just what buffer synthesis needs — generic over the unified
 *  `DiffLine` and the side-by-side `SideLine`. */
interface RenderableLine {
  kind: string;
  text: string;
}

/**
 * Whether a synthesized diff buffer for `lines` needs a trailing newline. Only an
 * empty *decorated* last line (added/removed/filler) needs one: GtkTextView can't
 * paint a line background on a final empty line that has no character or newline to
 * carry it. A non-empty last line — or an undecorated (context) one — needs nothing,
 * so we skip it and avoid a spurious trailing blank row in the common case.
 */
export function needsTrailingNewline(lines: readonly RenderableLine[]): boolean {
  const last = lines[lines.length - 1];
  return !!last && last.text === '' && last.kind !== 'context';
}

/**
 * Text for a synthesized diff buffer: the line texts joined by newlines, terminated
 * only when `needsTrailingNewline` (so an empty changed last line keeps its background
 * without forcing a blank row onto every diff). `terminate` can be forced — the
 * side-by-side panes terminate in lockstep so they stay equal-height for scroll-sync.
 */
export function diffBufferText(
  lines: readonly RenderableLine[],
  terminate: boolean = needsTrailingNewline(lines),
): string {
  return lines.map((line) => line.text).join('\n') + (terminate ? '\n' : '');
}

/** Split text into lines, treating a single trailing newline as a terminator
 *  (so "a\nb" and "a\nb\n" both yield ["a", "b"]); "" yields []. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Compute the diff model between `oldText` and `newText`. */
export function computeDiff(oldText: string, newText: string): DiffModel {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffLines(a, b);

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op === 'eq') {
      lines.push({ kind: 'context', text: a[i], oldRow: i, newRow: j });
      i++;
      j++;
    } else if (op === 'del') {
      lines.push({ kind: 'removed', text: a[i], oldRow: i, newRow: null });
      i++;
      removed++;
    } else {
      lines.push({ kind: 'added', text: b[j], oldRow: null, newRow: j });
      j++;
      added++;
    }
  }

  const hunks = buildHunks(lines);
  annotateWordDiffs(lines, hunks);
  return { lines, hunks, stats: { added, removed } };
}

/**
 * Word-level diff of two line texts: the spans removed from `oldText` and the
 * spans added in `newText` (codepoint offsets), plus whether the lines share any
 * content (so a wholesale replacement can skip intra-line highlighting). Word-level
 * (not char-level) keeps the highlight on whole tokens — far less noisy than
 * scattering it over individual characters. Whitespace is significant
 * (`diffWordsWithSpace`), so indentation/spacing changes still show.
 */
export function computeIntraLineDiff(
  oldText: string,
  newText: string,
): { oldRanges: WordRange[]; newRanges: WordRange[]; hasCommon: boolean } {
  const oldRanges: WordRange[] = [];
  const newRanges: WordRange[] = [];
  let oi = 0;
  let ni = 0;
  let hasCommon = false;
  for (const part of diffWordsWithSpace(oldText, newText)) {
    const len = [...part.value].length; // codepoints (buffer columns are codepoints)
    if (part.added) {
      newRanges.push([ni, ni + len]);
      ni += len;
    } else if (part.removed) {
      oldRanges.push([oi, oi + len]);
      oi += len;
    } else {
      if (len > 0) hasCommon = true;
      oi += len;
      ni += len;
    }
  }
  return { oldRanges, newRanges, hasCommon };
}

/**
 * Tidy a line's raw intra-line change spans for display:
 *  - **Merge** spans separated only by whitespace into one — many small word
 *    highlights with blank gaps between them read as noise; a single span over the
 *    whole run (the gap included) is clearer.
 *  - **Promote** a lone span that covers all of the line's non-whitespace content
 *    to the full-line background: return `[]` so the caller paints only the line
 *    background, not a redundant word highlight over (essentially) the whole line.
 *
 * `text` is the line the ranges index into; offsets are codepoints (buffer columns),
 * so slice on the codepoint array, not the UTF-16 string. Ranges come in ascending,
 * non-overlapping order (the forward scan in `computeIntraLineDiff`).
 */
export function refineWordRanges(text: string, ranges: readonly WordRange[]): WordRange[] {
  if (ranges.length === 0) return [];
  const cps = [...text];
  // Inclusive-empty: an empty slice (from >= to, e.g. adjacent spans or a line edge)
  // counts as blank, which is what we want for both the merge and the promote tests.
  const isBlank = (from: number, to: number) => cps.slice(from, to).every((c) => /\s/.test(c));

  // Merge spans whose gap is entirely whitespace into one (covering the gap).
  const merged: WordRange[] = [[ranges[0][0], ranges[0][1]]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const [start, end] = ranges[i];
    if (isBlank(last[1], start)) last[1] = end;
    else merged.push([start, end]);
  }

  // A single span flanked only by whitespace is the whole meaningful line — let the
  // line background carry it and drop the span.
  if (merged.length === 1 && isBlank(0, merged[0][0]) && isBlank(merged[0][1], cps.length)) return [];
  return merged;
}

/** Pair each hunk's removed↔added lines and attach intra-line change spans to the
 *  pairs that share content (a real modification, not a full-line replacement). */
function annotateWordDiffs(lines: DiffLine[], hunks: DiffHunk[]): void {
  for (const hunk of hunks) {
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (let row = hunk.startRow; row < hunk.startRow + hunk.rowCount; row++) {
      if (lines[row].kind === 'removed') dels.push(lines[row]);
      else if (lines[row].kind === 'added') adds.push(lines[row]);
    }
    for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
      const { oldRanges, newRanges, hasCommon } = computeIntraLineDiff(dels[i].text, adds[i].text);
      if (!hasCommon) continue; // wholly different — the full-line bg says enough
      // Refine for display; an empty result means "let the line background say it".
      const del = refineWordRanges(dels[i].text, oldRanges);
      const add = refineWordRanges(adds[i].text, newRanges);
      if (del.length) dels[i].wordRanges = del;
      if (add.length) adds[i].wordRanges = add;
    }
  }
}

export type SideLineKind = 'context' | 'added' | 'removed' | 'filler';

/** One row of a side-by-side pane. `filler` is a blank alignment pad (the other
 *  side changed). */
export interface SideLine {
  kind: SideLineKind;
  text: string;
  /** Intra-line change spans (for a modified row), copied from the source line. */
  wordRanges?: WordRange[];
  /** 0-based file row this line is (this side's old/new row); null for a filler. */
  row: number | null;
}

export interface SideBySide {
  left: SideLine[]; // old text + fillers where the new side added
  right: SideLine[]; // new text + fillers where the old side removed
}

/**
 * Split a `DiffModel` into two line-aligned panes for a side-by-side view: each
 * row pairs the old and new line (or a blank filler when only one side changed),
 * so both arrays have equal length and row N is the same content on both sides.
 * Within a changed run, removed/added lines are paired up; the shorter side is
 * padded with fillers.
 */
export function splitSides(model: DiffModel): SideBySide {
  const left: SideLine[] = [];
  const right: SideLine[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      left.push(
        i < dels.length
          ? { kind: 'removed', text: dels[i].text, wordRanges: dels[i].wordRanges, row: dels[i].oldRow }
          : { kind: 'filler', text: '', row: null },
      );
      right.push(
        i < adds.length
          ? { kind: 'added', text: adds[i].text, wordRanges: adds[i].wordRanges, row: adds[i].newRow }
          : { kind: 'filler', text: '', row: null },
      );
    }
    dels = [];
    adds = [];
  };

  for (const line of model.lines) {
    if (line.kind === 'removed') dels.push(line);
    else if (line.kind === 'added') adds.push(line);
    else {
      flush();
      left.push({ kind: 'context', text: line.text, row: line.oldRow });
      right.push({ kind: 'context', text: line.text, row: line.newRow });
    }
  }
  flush();
  return { left, right };
}

/**
 * One collapsible region of unchanged lines (buffer-row indices; the diff buffer
 * holds the real lines verbatim). The body to collapse is `bodyStart..bodyEnd`
 * inclusive, with `count` lines. A diff view hands these to the editor as provided
 * folds (SyntaxController.setProvidedFolds), which collapses each run, whole, to a
 * `⋯ N unchanged lines` placeholder via the fold projection. (`anchorRow`/`placement`
 * are legacy positioning hints, unused now.)
 */
export interface DiffFoldInfo {
  anchorRow: number;
  placement: 'below' | 'above';
  bodyStart: number;
  bodyEnd: number;
  count: number;
  /** The collapsed placeholder text. Filled by the caller (it needs the line
   *  texts — see `diffFoldLabel`); `foldUnchanged` leaves it unset. */
  label?: string;
}

/** Leading-whitespace width (spaces/tabs) of `s`. */
function leadingIndent(s: string): number {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/**
 * The placeholder text for a collapsed unchanged run, à la `git diff`'s hunk
 * header: the nearest preceding line that is *less indented* than the run (its
 * enclosing scope — a function/class/block header), trimmed. Closing-bracket lines
 * are skipped (they're the end of a sibling block, not an enclosing header). Falls
 * back to `⋯ N unchanged lines` when there's no such line (e.g. a top-level run).
 */
export function diffFoldLabel(lines: readonly { text: string }[], bodyStart: number, count: number): string {
  const ref = leadingIndent(lines[bodyStart]?.text ?? '');
  for (let k = bodyStart - 1; k >= 0; k--) {
    const text = lines[k]?.text ?? '';
    const trimmed = text.trim();
    if (trimmed === '' || /^[)}\]]/.test(trimmed)) continue; // blank / closing bracket
    if (leadingIndent(text) < ref) return trimmed;
  }
  return `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`;
}

/**
 * Plan which runs of unchanged (`context`-kind) lines to collapse, keeping
 * `context` lines on each side of every change and only folding runs with more
 * than `minHidden` interior lines. Returns the fold regions in **buffer-row
 * indices** (the diff buffer is the line list verbatim); a diff view supplies them
 * to the editor (as provided folds), collapsing each body to a `⋯ N unchanged lines`
 * placeholder via the fold projection.
 *
 * Generic over any line carrying a `kind` (unified `DiffLine` or `SideLine`), so
 * the two side-by-side panes — whose context lines sit at identical rows — fold
 * in lockstep from matching plans.
 */
export function foldUnchanged<T extends { kind: string }>(
  lines: readonly T[],
  options: { context?: number; minHidden?: number } = {},
): DiffFoldInfo[] {
  const context = options.context ?? 3;
  const minHidden = options.minHidden ?? 2;

  const folds: DiffFoldInfo[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'context') {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].kind === 'context') j++;
    // The run spans [i, j-1]. Keep `context` lines next to an adjacent change;
    // a run touching the buffer edge has no change on that side, so keep none.
    const keepTop = i > 0 ? context : 0;
    const keepBottom = j < lines.length ? context : 0;
    const top = i + keepTop;
    const bottom = j - 1 - keepBottom;
    if (bottom - top + 1 >= minHidden) {
      // Anchor on the still-visible line just below the body; a leading fold (no
      // line above) anchors on the line just above (the band goes above it).
      if (top > 0) folds.push({ anchorRow: top - 1, placement: 'below', bodyStart: top, bodyEnd: bottom, count: bottom - top + 1 });
      else if (bottom + 1 < lines.length) folds.push({ anchorRow: bottom + 1, placement: 'above', bodyStart: top, bodyEnd: bottom, count: bottom - top + 1 });
      // else: the fold spans the whole buffer (no changes) → nothing to anchor to.
    }
    i = j;
  }
  return folds;
}

/** Group consecutive changed (non-context) lines into hunks. */
function buildHunks(lines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start = -1;
  for (let row = 0; row <= lines.length; row++) {
    const changed = row < lines.length && lines[row].kind !== 'context';
    if (changed && start === -1) {
      start = row;
    } else if (!changed && start !== -1) {
      hunks.push(makeHunk(lines, start, row));
      start = -1;
    }
  }
  return hunks;
}

function makeHunk(lines: DiffLine[], start: number, end: number): DiffHunk {
  let added = 0;
  let removed = 0;
  let oldStart: number | null = null;
  let newStart: number | null = null;
  for (let row = start; row < end; row++) {
    const line = lines[row];
    if (line.kind === 'added') added++;
    else if (line.kind === 'removed') removed++;
    if (oldStart === null && line.oldRow !== null) oldStart = line.oldRow;
    if (newStart === null && line.newRow !== null) newStart = line.newRow;
  }
  return { startRow: start, rowCount: end - start, added, removed, oldStart, newStart };
}
