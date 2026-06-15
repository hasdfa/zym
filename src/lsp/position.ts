/*
 * Conversions between quilx `Point`/`Range` and LSP `Position`/`Range`, plus
 * `file://` URI helpers.
 *
 * Both coordinate systems are zero-based by line. The subtlety is the column:
 * quilx columns are *codepoint* offsets within a line (matching `GtkTextIter`
 * line offsets), while LSP columns ("characters") are measured in the units of
 * the negotiated position encoding — UTF-16 code units by default, optionally
 * UTF-8 bytes or UTF-32 codepoints (LSP 3.17 `general.positionEncodings`).
 *
 * Converting between the two therefore needs the text of the line, except for
 * `utf-32` where codepoints and characters coincide. JS strings are UTF-16, so
 * we walk codepoints (via the string iterator) to map offsets.
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Point } from '../text/Point.ts';
import { Range } from '../text/Range.ts';
import type { Position, Range as LspRange } from 'vscode-languageserver-protocol';

export type PositionEncoding = 'utf-8' | 'utf-16' | 'utf-32';

/** Absolute filesystem path → `file://` URI. */
export function pathToUri(path: string): string {
  return pathToFileURL(path).href;
}

/** `file://` URI → absolute filesystem path. */
export function uriToPath(uri: string): string {
  return fileURLToPath(uri);
}

/** Code-unit length of a single codepoint in the given encoding. */
function unitsFor(codepoint: string, enc: PositionEncoding): number {
  switch (enc) {
    case 'utf-8':
      // Bytes in UTF-8.
      return Buffer.byteLength(codepoint, 'utf8');
    case 'utf-16':
      // Code units in UTF-16 — exactly what JS `.length` reports.
      return codepoint.length;
    case 'utf-32':
      return 1;
  }
}

/**
 * Codepoint offset within `lineText` → LSP character offset in `enc`. Offsets
 * past the end of the line clamp to the line's length (in `enc` units).
 */
export function columnToCharacter(lineText: string, column: number, enc: PositionEncoding): number {
  if (enc === 'utf-32') return column;
  let cp = 0;
  let units = 0;
  for (const ch of lineText) {
    if (cp >= column) break;
    units += unitsFor(ch, enc);
    cp++;
  }
  return units;
}

/**
 * LSP character offset in `enc` → codepoint offset within `lineText`. Offsets
 * past the end of the line clamp to the line's codepoint length.
 */
export function characterToColumn(lineText: string, character: number, enc: PositionEncoding): number {
  if (enc === 'utf-32') return character;
  let cp = 0;
  let units = 0;
  for (const ch of lineText) {
    // Stop before a codepoint that would overshoot, so an offset landing inside
    // a multi-unit codepoint snaps down to the boundary before it.
    const next = units + unitsFor(ch, enc);
    if (next > character) break;
    units = next;
    cp++;
  }
  return cp;
}

/** Length of single-line `text` in `enc` units (utf-16 code units / utf-8 bytes / codepoints). */
function measureUnits(text: string, enc: PositionEncoding): number {
  let units = 0;
  for (const ch of text) units += unitsFor(ch, enc);
  return units;
}

/**
 * The LSP position reached by writing `text` starting at `start` — i.e. the end
 * of a range whose replaced content was `text`. Used to derive an incremental
 * change's `range.end` from its start + the old text, without the pre-edit line.
 */
export function advancePosition(start: Position, text: string, enc: PositionEncoding): Position {
  const newline = text.lastIndexOf('\n');
  if (newline === -1) {
    return { line: start.line, character: start.character + measureUnits(text, enc) };
  }
  const addedLines = text.split('\n').length - 1;
  return { line: start.line + addedLines, character: measureUnits(text.slice(newline + 1), enc) };
}

/** A `Point` and the text of its row → LSP `Position`. */
export function pointToPosition(point: Point, lineText: string, enc: PositionEncoding): Position {
  return { line: point.row, character: columnToCharacter(lineText, point.column, enc) };
}

/** An LSP `Position` and the text of its line → `Point`. */
export function positionToPoint(position: Position, lineText: string, enc: PositionEncoding): Point {
  return new Point(position.line, characterToColumn(lineText, position.character, enc));
}

/** A `Range` → LSP `Range`, using `lineAt(row)` to fetch each endpoint's line. */
export function rangeToLsp(
  range: Range,
  lineAt: (row: number) => string,
  enc: PositionEncoding,
): LspRange {
  return {
    start: pointToPosition(range.start, lineAt(range.start.row), enc),
    end: pointToPosition(range.end, lineAt(range.end.row), enc),
  };
}

/** An LSP `Range` → `Range`, using `lineAt(row)` to fetch each endpoint's line. */
export function lspToRange(
  range: LspRange,
  lineAt: (row: number) => string,
  enc: PositionEncoding,
): Range {
  return new Range(
    positionToPoint(range.start, lineAt(range.start.line), enc),
    positionToPoint(range.end, lineAt(range.end.line), enc),
  );
}
