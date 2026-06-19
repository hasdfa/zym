/*
 * projectSearch — feed the multibuffer from a project-wide ripgrep search. Splits into a
 * pure part (group match rows into context-padded, merged excerpt regions — unit-tested)
 * and the I/O part (spawn `rg --json`, same streaming pattern as SearchPicker, since Node
 * promise microtasks don't resolve under node-gtk's blocked GLib loop — node-gtk#430).
 *
 * Phase 1a "validated on project-wide search": the multibuffer shows every match grouped by
 * file, each match with a few lines of context, adjacent matches merged into one region.
 */
import { spawn } from 'node:child_process';
import * as Path from 'node:path';
import type { ExcerptInput } from './MultiBufferView.ts';
import type { MatchRange } from './MultiBufferModel.ts';

const MAX_MATCHES = 1000; // cap rows parsed from rg across all files
const MAX_OUTPUT = 16 * 1024 * 1024; // cap accumulated stdout; kill rg past it
const DEFAULT_CONTEXT = 2; // lines of context each side of a match

/** Matches in one file, in file order of first appearance; `rows` are 0-based, deduped.
 *  `matches` carries each individual hit's column span (for highlighting), one per rg
 *  submatch — possibly several per row. */
export interface FileMatches {
  path: string;
  rows: number[];
  matches?: MatchRange[];
}

/**
 * Group match rows into excerpt regions: pad each match by `context` lines, merge
 * overlapping or adjacent regions (so two nearby matches share one region with a continuous
 * body rather than two with a `⋯` between), clamp to the file bounds when a `lineCount` is
 * known. Pure — the place a region-merge bug surfaces in a test.
 */
export function matchesToExcerptInputs(
  files: FileMatches[],
  opts: { context?: number; lineCount?: (path: string) => number | undefined } = {},
): ExcerptInput[] {
  const context = opts.context ?? DEFAULT_CONTEXT;
  const out: ExcerptInput[] = [];
  for (const file of files) {
    const last = (opts.lineCount?.(file.path) ?? Infinity) - 1;
    const rows = [...new Set(file.rows)].sort((a, b) => a - b);
    const regions: Array<{ startRow: number; endRow: number }> = [];
    for (const row of rows) {
      const startRow = Math.max(0, row - context);
      const endRow = Number.isFinite(last) ? Math.min(last, row + context) : row + context;
      const prev = regions[regions.length - 1];
      // Merge into the previous region when this one overlaps or merely touches it.
      if (prev && startRow <= prev.endRow + 1) prev.endRow = Math.max(prev.endRow, endRow);
      else regions.push({ startRow, endRow });
    }
    if (regions.length > 0) {
      const input: ExcerptInput = { path: file.path, regions };
      if (file.matches?.length) input.matches = file.matches; // carry match spans through to highlight
      out.push(input);
    }
  }
  return out;
}

/**
 * Run `rg --json` over `cwd` for `query` and call back with matches grouped by file (file
 * order = first match seen). `code > 1` from rg is a real error (bad regex); 0/1 are
 * matches / none.
 */
export function runProjectSearch(
  cwd: string,
  query: string,
  onDone: (result: { files?: FileMatches[]; error?: string }) => void,
): void {
  const q = query.trim();
  if (q === '') {
    onDone({ files: [] });
    return;
  }
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn('rg', ['--json', '--smart-case', '--', q], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    onDone({ error: e instanceof Error ? e.message : String(e) });
    return;
  }

  let stdout = '';
  let stderr = '';
  let done = false;
  const finish = (result: { files?: FileMatches[]; error?: string }): void => {
    if (done) return;
    done = true;
    onDone(result);
  };

  proc.on('error', (err) => {
    finish({ error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'ripgrep (rg) is not installed' : err.message });
  });
  proc.stdout?.on('data', (d) => {
    stdout += d.toString();
    if (stdout.length > MAX_OUTPUT) {
      proc.kill();
      finish({ files: parseGrouped(stdout, cwd) });
    }
  });
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });
  proc.on('close', (code) => {
    if (code !== null && code > 1) finish({ error: stderr.trim() || 'search failed' });
    else finish({ files: parseGrouped(stdout, cwd) });
  });
}

/** Codepoint column at UTF-8 byte offset `byteOffset` within `text` — rg reports submatch
 *  offsets in BYTES, but the editor's columns are codepoints (a GtkTextIter line offset). */
export function byteToColumn(text: string, byteOffset: number): number {
  return [...Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8')].length;
}

/** Parse `rg --json` stdout (one JSON object per line) into per-file 0-based match rows plus
 *  per-hit column spans (`submatches`, byte→codepoint converted). */
function parseGrouped(stdout: string, cwd: string): FileMatches[] {
  const byPath = new Map<string, { rows: number[]; matches: MatchRange[] }>();
  const order: string[] = [];
  let count = 0;
  for (const line of stdout.split('\n')) {
    if (count >= MAX_MATCHES) break;
    if (line === '') continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type !== 'match') continue;
    const relPath: string | undefined = msg.data.path?.text;
    const lineNumber: number | undefined = msg.data.line_number;
    if (relPath === undefined || lineNumber === undefined) continue; // non-UTF-8: skip
    const file = Path.join(cwd, relPath);
    let entry = byPath.get(file);
    if (!entry) { entry = { rows: [], matches: [] }; byPath.set(file, entry); order.push(file); }
    const row = lineNumber - 1; // rg is 1-based
    entry.rows.push(row);
    // Column spans (highlighting). `lines.text` is the matched line; absent on non-UTF-8
    // matches (rg emits `bytes` instead) — then we keep the row but skip its column spans.
    const lineText: string | undefined = msg.data.lines?.text;
    if (lineText !== undefined && Array.isArray(msg.data.submatches)) {
      for (const sub of msg.data.submatches) {
        if (typeof sub.start !== 'number' || typeof sub.end !== 'number') continue;
        entry.matches.push({ row, startCol: byteToColumn(lineText, sub.start), endCol: byteToColumn(lineText, sub.end) });
      }
    }
    count++;
  }
  return order.map((path) => {
    const entry = byPath.get(path)!;
    return { path, rows: entry.rows, matches: entry.matches };
  });
}
