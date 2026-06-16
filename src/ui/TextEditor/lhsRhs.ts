/*
 * lhsRhs — pure logic for the LHS/RHS text objects (a port of romgrk's
 * equal.operator). Given a line, it finds the assignment separator and returns
 * the column spans of the left- and right-hand sides, in both "inner" (trimmed,
 * separator excluded) and "a" (separator included) forms:
 *
 *     const value = [ { id: 42 } ];
 *     |---------|   |------------|     inner: lhsInner / rhsInner
 *     |-----------|-----------------|  a:     lhsA (…incl `=`) / rhsA (`=`…)
 *
 * Separators, in priority order: assignment / compound-assignment / arrow ops
 * (`=`, `+=`, `-=`, `*=`, `/=`, `>>=`, `=>`, `->`), then `:`, then a leading
 * `return`. Comparison operators (`==`, `!=`, `<=`, `>=`) are not treated as
 * separators. A trailing `;`/`,` is excluded from the RHS.
 *
 * Columns are codepoint columns (matching the editor/LSP convention), so the
 * spans are correct on lines containing non-BMP characters.
 */

/** Column spans (codepoint columns) of an assignment's sides, or null when empty. */
export interface LhsRhsRanges {
  lhsInner: [number, number] | null;
  lhsA: [number, number] | null;
  rhsInner: [number, number] | null;
  rhsA: [number, number] | null;
}

// Assignment / compound-assignment / arrow operators, longest-first so `=>`/`>>=`
// win over `=`. The lookbehind/lookahead keep comparison operators (`==`, `!=`,
// `<=`, `>=`) from being mistaken for a bare `=`.
const ASSIGN_RE = /(?<![<>=!])(>>=|\+=|-=|\*=|\/=|=>|->|=)(?!=)/;
const COLON_RE = /(?<!:):(?!:)/;
const RETURN_RE = /^(\s*)return\b/;

interface Span {
  start: number;
  end: number;
}

/** Locate the assignment separator on `line` (UTF-16 indices), or null. */
function findSeparator(line: string): Span | null {
  const assign = ASSIGN_RE.exec(line);
  if (assign) return { start: assign.index, end: assign.index + assign[0].length };
  const colon = COLON_RE.exec(line);
  if (colon) return { start: colon.index, end: colon.index + colon[0].length };
  const ret = RETURN_RE.exec(line);
  if (ret) return { start: ret[1].length, end: ret[1].length + 'return'.length };
  return null;
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t';

/** UTF-16 index → codepoint column. */
function toColumn(line: string, index: number): number {
  return [...line.slice(0, index)].length;
}

/** A non-empty `[start, end)` UTF-16 span as codepoint columns, else null. */
function span(line: string, start: number, end: number): [number, number] | null {
  if (end <= start) return null;
  return [toColumn(line, start), toColumn(line, end)];
}

/**
 * Compute the LHS/RHS spans around the assignment separator on `line`. Returns
 * null when there is no separator; individual spans are null when empty (e.g. the
 * LHS of a bare `return`).
 */
export function lhsRhsRanges(line: string): LhsRhsRanges | null {
  const firstNonBlank = line.search(/\S/);
  if (firstNonBlank === -1) return null;
  const sep = findSeparator(line);
  if (!sep) return null;

  // LHS: from the first non-blank char to the separator; inner trims the run of
  // whitespace before the separator.
  let lhsInnerEnd = sep.start;
  while (lhsInnerEnd > firstNonBlank && isSpace(line[lhsInnerEnd - 1])) lhsInnerEnd--;

  // RHS: from after the separator to end of line, minus a trailing `;`/`,` and
  // surrounding whitespace; inner also skips whitespace right after the separator.
  let rhsInnerStart = sep.end;
  while (rhsInnerStart < line.length && isSpace(line[rhsInnerStart])) rhsInnerStart++;
  let rhsEnd = line.length;
  while (rhsEnd > sep.end && isSpace(line[rhsEnd - 1])) rhsEnd--;
  if (rhsEnd > sep.end && (line[rhsEnd - 1] === ';' || line[rhsEnd - 1] === ',')) {
    rhsEnd--;
    while (rhsEnd > sep.end && isSpace(line[rhsEnd - 1])) rhsEnd--;
  }

  return {
    lhsInner: span(line, firstNonBlank, lhsInnerEnd),
    lhsA: span(line, firstNonBlank, sep.end),
    rhsInner: span(line, rhsInnerStart, rhsEnd),
    rhsA: span(line, sep.start, rhsEnd),
  };
}
