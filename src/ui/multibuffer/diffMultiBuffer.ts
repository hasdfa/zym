/*
 * diffMultiBuffer — assemble a CONTINUOUS multi-file diff into the projection model the diff
 * multibuffer surface renders (tasks/code-editing/multibuffer.md, Phase 3b / G5 — the editable
 * diff that replaces GitStagingView). For each changed file it emits a filename header block,
 * then the file's diff WINDOWED like a real diff — changed hunks plus a few lines of context,
 * with long unchanged runs elided to a `⋯ N unchanged lines` gap row — via `diffRows` +
 * `rowsToItems` (context/added → editable new-side rows, removed → read-only phantom old-side
 * rows). It also returns the per-row diff KIND the surface paints as added/removed backgrounds.
 *
 * Pure + GTK-free: the surface materializes a `ViewProjection` over the sources, paints each
 * side from its own grammar (`ExcerptSyntaxProjection`), and applies the decorations from
 * `rowKinds`. Eliding here keeps the diff readable without needing live folds.
 */
import type { Item } from '../TextEditor/ViewProjection.ts';
import { diffRows, rowsToItems } from './diffSegments.ts';
import * as Path from 'node:path';

/** One changed file: its base (old / HEAD) and current (new / working) content. */
export interface DiffFile {
  path: string;
  /** Header label; defaults to a path relative to `cwd` (or the basename). */
  label?: string;
  oldText: string;
  newText: string;
}

/** The kind of each projection row, for decorations / gutters. */
export type DiffRowKind = 'header' | 'blank' | 'gap' | 'context' | 'added' | 'removed';

export interface DiffMultiBuffer {
  /** The ordered projection items for `ViewProjection.build`. */
  items: Item[];
  /** Per projection row (0-based), aligned with the materialized view. */
  rowKinds: DiffRowKind[];
  /** Per projection row: the 1-based OLD / NEW file line number, or null (header/gap/blank,
   *  and the side a row doesn't exist on — added has no old, removed no new). For the gutters. */
  oldNums: (number | null)[];
  newNums: (number | null)[];
  /** Source key → its line array, for `resolveLines` + parsing. The new side of file `p` is
   *  keyed `new:<p>`, the old (base) side `old:<p>` — two sources, same grammar. */
  sources: Map<string, string[]>;
  /** Source key → the path whose grammar highlights it. */
  language: Map<string, string>;
  /** Widget-header mode only: where each file's header widget anchors (the view row its content
   *  starts on, since no header/blank rows are emitted into the buffer). */
  headerAnchors: Array<{ path: string; label: string; viewRow: number }>;
}

export interface DiffLayoutOptions {
  /** `'block'` (default) emits a filename header text row + a blank separator per file;
   *  `'widget'` emits neither (the surface draws a header widget above each file via
   *  `headerAnchors`), so the filename isn't navigable buffer text. */
  headers?: 'block' | 'widget';
}

const newKey = (path: string): string => `new:${path}`;
const oldKey = (path: string): string => `old:${path}`;
const OP_KIND = { eq: 'context', ins: 'added', del: 'removed' } as const;

// Lines of unchanged context kept around each change; unchanged runs longer than this on a
// side collapse to a `⋯` gap. A gap shorter than MIN_ELIDE is shown instead (eliding it saves
// nothing). Matches the search multibuffer's context feel.
const CONTEXT = 3;
const MIN_ELIDE = 2;

/** Assemble the windowed diff projection for `files`. `cwd` (optional) relativizes labels. */
export function buildDiffMultiBuffer(files: DiffFile[], cwd?: string, opts: DiffLayoutOptions = {}): DiffMultiBuffer {
  const widgetHeaders = opts.headers === 'widget';
  const items: Item[] = [];
  const rowKinds: DiffRowKind[] = [];
  const oldNums: (number | null)[] = [];
  const newNums: (number | null)[] = [];
  const sources = new Map<string, string[]>();
  const language = new Map<string, string>();
  const headerAnchors: DiffMultiBuffer['headerAnchors'] = [];
  const split = (text: string): string[] => text.split('\n');
  // Emit one row: its kind + the old/new line numbers it carries.
  const block = (kind: DiffRowKind): void => {
    rowKinds.push(kind);
    oldNums.push(null);
    newNums.push(null);
  };

  files.forEach((file, fileIndex) => {
    const nKey = newKey(file.path);
    const oKey = oldKey(file.path);
    const oldLines = split(file.oldText);
    const newLines = split(file.newText);
    sources.set(nKey, newLines);
    sources.set(oKey, oldLines);
    language.set(nKey, file.path);
    language.set(oKey, file.path);

    const label = file.label ?? (cwd ? Path.relative(cwd, file.path) : Path.basename(file.path));
    if (widgetHeaders) {
      // No header/blank rows in the buffer — the surface anchors a header widget above the row
      // the file's content starts on (recorded now, before its first row is emitted).
      headerAnchors.push({ path: file.path, label, viewRow: rowKinds.length });
    } else {
      if (fileIndex > 0) {
        items.push({ type: 'block', block: { kind: 'blank', text: '' } });
        block('blank');
      }
      items.push({ type: 'block', block: { kind: 'header', text: label } });
      block('header');
    }

    const recs = diffRows(oldLines, newLines);

    // Mark every row within CONTEXT of a change as visible; the rest are elided gaps.
    const visible = new Array(recs.length).fill(false);
    let anyChange = false;
    recs.forEach((r, i) => {
      if (r.op === 'eq') return;
      anyChange = true;
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(recs.length - 1, i + CONTEXT); k++) visible[k] = true;
    });
    // Show, don't elide, gaps shorter than MIN_ELIDE.
    for (let i = 0; i < recs.length; ) {
      if (visible[i]) { i++; continue; }
      let j = i;
      while (j < recs.length && !visible[j]) j++;
      if (j - i < MIN_ELIDE) for (let k = i; k < j; k++) visible[k] = true;
      i = j;
    }

    if (!anyChange) {
      // No changes (a changed-file list wouldn't include this, but stay total): elide all.
      if (recs.length > 0) {
        items.push({ type: 'block', block: { kind: 'gap', text: gapLabel(recs.length) } });
        block('gap');
      }
      return;
    }

    for (let i = 0; i < recs.length; ) {
      if (visible[i]) {
        let j = i;
        while (j < recs.length && visible[j]) j++;
        const window = recs.slice(i, j);
        items.push(...rowsToItems(window, nKey, oKey).items);
        for (const rec of window) {
          rowKinds.push(OP_KIND[rec.op]);
          oldNums.push(rec.op === 'ins' ? null : rec.oldRow + 1);
          newNums.push(rec.op === 'del' ? null : rec.newRow + 1);
        }
        i = j;
      } else {
        let j = i;
        while (j < recs.length && !visible[j]) j++;
        items.push({ type: 'block', block: { kind: 'gap', text: gapLabel(j - i) } });
        block('gap');
        i = j;
      }
    }
  });

  return { items, rowKinds, oldNums, newNums, sources, language, headerAnchors };
}

function gapLabel(count: number): string {
  return `⋯ ${count} unchanged line${count === 1 ? '' : 's'}`;
}
