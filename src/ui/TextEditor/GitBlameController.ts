/*
 * GitBlameController — current-line git blame as end-of-line virtual text, per view
 * (GitLens-style). Toggled by `git:blame-toggle`; while on, the line under the cursor
 * trails "Author, N days ago • summary" for the commit that last touched it.
 *
 * Built on `VirtualText` (the native annotation API), mirroring `InlayHintController`:
 * one flat annotation pushed per render. Blame is fetched once for the whole file
 * (`git blame --line-porcelain`) and cached by path; cursor moves and fold toggles just
 * re-place the single annotation from the cache (no new git call). An edit invalidates
 * the cache, so the next render re-blames.
 *
 * Blame reflects the file on disk (HEAD + committed history); a line with uncommitted
 * changes shows "Uncommitted changes" rather than stale authorship.
 */
import * as Path from 'node:path';
import type { SourceView } from '../../gi.ts';
import { VirtualText } from './VirtualText.ts';
import { git, repoRoot } from '../../git.ts';

interface BlameLine {
  sha: string;
  author: string;
  timestamp: number; // author-time, epoch seconds
  summary: string;
}

const UNCOMMITTED_SHA = '0000000000000000000000000000000000000000';

export class GitBlameController {
  private readonly annotations: VirtualText;
  private enabled = false;
  private disposed = false;
  private cache: Map<number, BlameLine> | null = null;
  private cacheFile: string | null = null; // the file `cache` was blamed from
  private seq = 0; // drops stale async blame responses

  // Absolute path of the file in this view, or null (buffer-only editor).
  private readonly getFile: () => string | null;
  // The cursor's VIEW row (0-based).
  private readonly getCursorViewRow: () => number;
  // VIEW row → MODEL (file) line: folds collapse text, so the two diverge.
  private readonly viewRowToModelLine: (viewRow: number) => number;

  constructor(
    view: SourceView,
    getFile: () => string | null,
    getCursorViewRow: () => number,
    viewRowToModelLine: (viewRow: number) => number,
  ) {
    this.annotations = new VirtualText(view);
    this.getFile = getFile;
    this.getCursorViewRow = getCursorViewRow;
    this.viewRowToModelLine = viewRowToModelLine;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Flip the annotation on/off; returns the new state. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.enabled) this.render();
    else this.annotations.clear();
    return this.enabled;
  }

  /** Cursor moved — re-place the annotation on the new line (cache hit: synchronous). */
  onCursorMoved(): void {
    if (this.enabled) this.render();
  }

  /** A fold opened/closed — view rows shifted under the cursor; re-place. */
  rerender(): void {
    if (this.enabled) this.render();
  }

  /** The file content/identity changed — drop the cache so the next render re-blames. */
  invalidate(): void {
    this.cache = null;
    this.cacheFile = null;
    if (this.enabled) this.render();
  }

  private render(): void {
    if (this.disposed || !this.enabled) return;
    const file = this.getFile();
    if (!file) return void this.annotations.clear();
    const root = repoRoot(Path.dirname(file));
    if (!root) return void this.annotations.clear();
    if (this.cache && this.cacheFile === file) {
      this.paint(file);
      return;
    }
    const token = ++this.seq;
    const rel = Path.relative(root, file);
    git(root, ['blame', '--line-porcelain', '--', rel], (ok, stdout) => {
      if (this.disposed || token !== this.seq) return; // superseded / torn down
      if (!ok) return void this.annotations.clear();
      this.cache = parseBlame(stdout);
      this.cacheFile = file;
      if (this.enabled) this.paint(file);
    });
  }

  /** Place the single annotation for the cursor's current line, from the cache. */
  private paint(file: string): void {
    if (!this.cache || this.cacheFile !== file) return;
    const viewRow = this.getCursorViewRow();
    const info = this.cache.get(this.viewRowToModelLine(viewRow));
    if (!info) return void this.annotations.clear();
    this.annotations.setAnnotations([{ line: viewRow, text: formatBlame(info), style: 'none' }]);
  }

  dispose(): void {
    this.disposed = true;
    this.annotations.dispose();
  }
}

/** Parse `git blame --line-porcelain` into a map of MODEL line (0-based) → blame.
 *  Each line is a full porcelain block: a `<sha> <orig> <final>` header, repeated
 *  `author`/`author-time`/`summary` fields, then a `\t`-prefixed content line. */
export function parseBlame(out: string): Map<number, BlameLine> {
  const map = new Map<number, BlameLine>();
  const headerRe = /^([0-9a-f]{40}) \d+ (\d+)/;
  let cur: { sha: string; finalLine: number; author: string; timestamp: number; summary: string } | null = null;
  for (const line of out.split('\n')) {
    const header = headerRe.exec(line);
    if (header) {
      cur = { sha: header[1], finalLine: Number(header[2]), author: '', timestamp: 0, summary: '' };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('author ')) {
      cur.author = line.slice(7);
    } else if (line.startsWith('author-time ')) {
      cur.timestamp = Number(line.slice(12));
    } else if (line.startsWith('summary ')) {
      cur.summary = line.slice(8);
    } else if (line.startsWith('\t')) {
      map.set(cur.finalLine - 1, { sha: cur.sha, author: cur.author, timestamp: cur.timestamp, summary: cur.summary });
      cur = null;
    }
  }
  return map;
}

function formatBlame(info: BlameLine): string {
  if (info.sha === UNCOMMITTED_SHA) return 'You • Uncommitted changes';
  return `${info.author}, ${relativeTime(info.timestamp)} • ${info.summary}`;
}

/** Coarse "N units ago" for an epoch-seconds timestamp. */
function relativeTime(epochSeconds: number): string {
  if (!epochSeconds) return 'unknown';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];
  let value = seconds;
  for (const [size, name] of units) {
    if (value < size) {
      const n = Math.floor(value);
      return n <= 0 ? `just now` : `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
    value /= size;
  }
  return 'just now';
}
