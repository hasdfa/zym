/*
 * diffNav — helpers for hunk navigation in the read-only diff panes. Drives the
 * pane's GtkSource.View directly (place the cursor at a row and scroll it into
 * view) so no extra TextEditor surface is needed; best-effort and guarded.
 */
import type { SourceView } from '../../gi.ts';

/** Place the cursor at `row` (0-based) and scroll it into view. */
export function revealRow(view: SourceView, row: number): void {
  try {
    const buffer: any = (view as any).getBuffer();
    const res = buffer.getIterAtLine(row);
    const iter = Array.isArray(res) ? res[1] : res;
    if (!iter) return;
    buffer.placeCursor(iter);
    (view as any).scrollToIter(iter, 0.2, true, 0, 0.3);
  } catch {
    // Navigation is best-effort (e.g. before the view is realized).
  }
}

/** The buffer rows where each changed region starts, given per-row diff kinds
 *  (a region is a maximal run of non-`context` rows — added/removed/filler). */
export function changeStartRows(kinds: readonly string[]): number[] {
  const rows: number[] = [];
  for (let i = 0; i < kinds.length; i++) {
    const changed = kinds[i] !== 'context';
    const prevContext = i === 0 || kinds[i - 1] === 'context';
    if (changed && prevContext) rows.push(i);
  }
  return rows;
}
