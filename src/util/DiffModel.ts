/*
 * DiffModel — the structured input a diff viewer renders, computed from two
 * texts via the line-level `diffLines`. Pure and GTK-free (unit-tested); the
 * editor's diff panes consume it.
 *
 * `lines` is the unified line list (context + removed + added, in file order) —
 * exactly the rows a synthesized inline (unified) buffer holds, each tagged with
 * its `kind` (for the line decoration + gutter glyph) and its source rows.
 * `hunks` are the contiguous changed regions, for hunk navigation / fold-unchanged
 * (each points at a `lines` row range). See tasks/code-editing/diff.md.
 */
import { diffChars } from 'diff';
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
 * Char-level diff of two line texts: the spans removed from `oldText` and the
 * spans added in `newText` (codepoint offsets), plus whether the lines share any
 * content (so a wholesale replacement can skip intra-line highlighting).
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
  for (const part of diffChars(oldText, newText)) {
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
      dels[i].wordRanges = oldRanges;
      adds[i].wordRanges = newRanges;
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
        i < dels.length ? { kind: 'removed', text: dels[i].text, wordRanges: dels[i].wordRanges } : { kind: 'filler', text: '' },
      );
      right.push(
        i < adds.length ? { kind: 'added', text: adds[i].text, wordRanges: adds[i].wordRanges } : { kind: 'filler', text: '' },
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
      left.push({ kind: 'context', text: line.text });
      right.push({ kind: 'context', text: line.text });
    }
  }
  flush();
  return { left, right };
}

/**
 * One collapsible region of unchanged lines (buffer-row indices; the diff buffer
 * holds the real lines verbatim — no synthesized placeholder). The hidden body is
 * `bodyStart..bodyEnd` inclusive; the placeholder block + gutter chevron attach to
 * `anchorRow` — the still-visible line just below the body (`placement: 'below'`),
 * or, for a fold at the very top of the file, the line just below it
 * (`placement: 'above'`, the band sits above that line).
 */
export interface DiffFoldInfo {
  anchorRow: number;
  placement: 'below' | 'above';
  bodyStart: number;
  bodyEnd: number;
  count: number;
}

/**
 * Plan which runs of unchanged (`context`-kind) lines to collapse, keeping
 * `context` lines on each side of every change and only folding runs with more
 * than `minHidden` interior lines. Returns the fold regions in **buffer-row
 * indices** (the diff buffer is the line list verbatim); `DiffFold` hides each
 * body and renders the placeholder as an inline widget (no buffer footprint).
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
