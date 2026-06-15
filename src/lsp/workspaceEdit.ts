/*
 * WorkspaceEdit handling — the shared core behind code actions, rename, and
 * formatting. Pure and GTK-free: it normalizes an LSP `WorkspaceEdit` into
 * per-file `TextEdit`s and applies `TextEdit`s to a string. The UI layer reads
 * the result back into open buffers / disk.
 *
 * Applying edits to a string: LSP guarantees edits within one document don't
 * overlap, so we resolve each edit's range to absolute (UTF-16) string offsets
 * and splice from the end backward — earlier offsets stay valid as we go.
 */
import type { TextEdit, WorkspaceEdit, Position } from 'vscode-languageserver-protocol';
import type { PositionEncoding } from './position.ts';

/** The text edits for a single file. */
export interface FileEdits {
  uri: string;
  edits: TextEdit[];
}

/**
 * Flatten a `WorkspaceEdit` to per-file text edits. Handles both the `changes`
 * map and `documentChanges` (the `TextDocumentEdit` entries). Resource operations
 * (create/rename/delete file) are not text edits and are reported separately.
 */
export function normalizeWorkspaceEdit(edit: WorkspaceEdit): { files: FileEdits[]; resourceOps: number } {
  const files: FileEdits[] = [];
  let resourceOps = 0;
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ('textDocument' in change && 'edits' in change) {
        files.push({ uri: change.textDocument.uri, edits: change.edits as TextEdit[] });
      } else {
        resourceOps++; // create/rename/delete file — applied by the UI layer later
      }
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) files.push({ uri, edits });
  }
  return { files, resourceOps };
}

/** Apply LSP `TextEdit`s to `text`, returning the new text. */
export function applyTextEdits(text: string, edits: TextEdit[], enc: PositionEncoding = 'utf-16'): string {
  if (edits.length === 0) return text;
  const lineStarts = lineStartOffsets(text);
  const resolved = edits.map((e) => ({
    start: offsetAt(text, lineStarts, e.range.start, enc),
    end: offsetAt(text, lineStarts, e.range.end, enc),
    newText: e.newText,
  }));
  // Apply last-first so each splice doesn't shift the offsets still to come.
  resolved.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of resolved) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/** UTF-16 (JS string) offset of each line's start in `text`. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Absolute UTF-16 offset in `text` for an LSP position (clamped to bounds). */
function offsetAt(text: string, lineStarts: number[], pos: Position, enc: PositionEncoding): number {
  if (pos.line >= lineStarts.length) return text.length;
  const lineStart = lineStarts[pos.line];
  const lineEnd = pos.line + 1 < lineStarts.length ? lineStarts[pos.line + 1] : text.length;
  return lineStart + characterToUtf16(text.slice(lineStart, lineEnd), pos.character, enc);
}

/** An LSP character offset (in `enc` units) → UTF-16 offset within `lineText`. */
function characterToUtf16(lineText: string, character: number, enc: PositionEncoding): number {
  if (enc === 'utf-16') return Math.min(character, lineText.length);
  let units = 0;
  let utf16 = 0;
  for (const ch of lineText) {
    const width = enc === 'utf-8' ? Buffer.byteLength(ch, 'utf8') : 1; // utf-32: one per codepoint
    if (units + width > character) break;
    units += width;
    utf16 += ch.length;
  }
  return utf16;
}
