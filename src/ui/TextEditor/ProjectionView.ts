/*
 * ProjectionView — the per-view materialization + sync layer that sits on top of
 * ViewProjection (Phase 2b/2c of tasks/code-editing/multibuffer.md). It owns ONE view
 * `GtkSource.Buffer`, materialized from a `ViewProjection` over a set of source buffers, and
 * keeps the two in lock-step:
 *
 *   - reverse-sync (source → view): a change in a source buffer is mirrored into the view
 *     buffer at its projected location (Phase 2b);
 *   - write-through (view → source): an edit in the view buffer is routed to `(segment,
 *     sourceOffset)` → the right source buffer (Phase 2c).
 *
 * This generalizes today's `Document.createView`/`forward`/`propagate` (which sync ONE model
 * buffer to ONE view) to N sources stitched into one view, with the coordinate map +
 * editability gating delegated to `ViewProjection`. The single full-file source is the
 * IDENTITY case: `viewToSource`/`sourceToView` short-circuit, so the sync is a 1:1 mirror —
 * byte-for-byte today's Document behavior, which the headless tests pin down.
 *
 * Editable real segments are the only rows a view edit may touch; block (header/gap/blank)
 * and phantom (diff-removed) rows carry a non-editable TextTag so the user can't type there
 * (the same trick the fold placeholder + mb:header tags already use). Multi-source *editable*
 * write-through (row-count-changing edits re-segmenting the projection) is Phase 3a; here a
 * multi-source projection is read-only, so the only live write-through is the identity path.
 */
import { Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { Point } from '../../text/Point.ts';
import { ViewProjection, type Item, type Fold } from './ViewProjection.ts';

// node-gtk returns out-param iters directly or as [ok, iter]; normalize to an iter.
const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const iterAtOffset = (buf: any, off: number): any => asIter(buf.getIterAtOffset(off));

/** Codepoint length of `s` (GtkTextIter offsets count characters, not UTF-16 units). */
function cpLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Text of `buf` row `row` (no trailing newline). */
function lineText(buf: any, row: number): string {
  const start = asIter(buf.getIterAtLine(row));
  if (!start) return '';
  const end = start.copy();
  if (!end.endsLine()) end.forwardToLineEnd();
  return buf.getText(start, end, true);
}

const READONLY_TAG = 'vp:readonly';

interface Connection {
  target: any;
  event: string;
  cb: (...args: any[]) => any;
}

export class ProjectionView {
  /** The materialized view buffer (what a GtkSource.View shows). */
  readonly buffer: SourceBuffer;

  private readonly sources: Map<string, SourceBuffer>;
  private items: Item[];
  private projection: ViewProjection;

  // Reentrancy guards: a view edit writes through to a source, whose own change signal
  // must NOT echo back into the view (and vice-versa). `viewSuppress` silences the view's
  // handler while we mirror INTO it; `sourceSuppress` holds the keys we're writing through
  // to, so their change signals are ignored.
  private viewSuppress = false;
  private readonly sourceSuppress = new Set<string>();
  private readonly connections: Connection[] = [];
  private disposed = false;

  // Cross-source undo (multibuffer, G7): each user action is a transaction recording which
  // source keys it touched; undo/redo replay those sources' OWN native undo, in reverse, as
  // one step — so a multi-file edit (e.g. replace-all) is one undo. A single-source editor
  // uses its Document's undo instead, so this stays dormant there.
  private readonly undoStack: string[][] = [];
  private readonly redoStack: string[][] = [];
  private currentTxn: Set<string> | null = null;
  private readonly openActions = new Set<string>();

  /**
   * Build the view buffer from `items` over `sources` (keyed by `Segment.sourceKey`). The
   * normal-editor case is `new ProjectionView([fullFileSegment], new Map([[path, model]]))`.
   */
  constructor(items: Item[], sources: Map<string, SourceBuffer>) {
    this.sources = sources;
    this.items = items;
    this.buffer = new GtkSource.Buffer();
    this.buffer.setEnableUndo(false); // the source models own undo (as Document's views do)
    const table = (this.buffer as any).getTagTable();
    table.add(new Gtk.TextTag({ name: READONLY_TAG, editable: false } as any));
    this.projection = ViewProjection.build(items, (seg) => this.sourceLines(seg));
    this.materialize();
    this.wireView();
    for (const [key, buf] of this.sources) this.wireSource(key, buf);
  }

  /** The current coordinate map (for the painter / gutter / editability queries). */
  get view(): ViewProjection {
    return this.projection;
  }

  private sourceLines(seg: { sourceKey: string; startRow: number; endRow: number }): string[] {
    const buf = this.sources.get(seg.sourceKey);
    if (!buf) return [];
    const out: string[] = [];
    for (let r = seg.startRow; r <= seg.endRow; r++) out.push(lineText(buf, r));
    return out;
  }

  // --- materialization (build the view text + lock down non-editable rows) ----

  private materialize(): void {
    this.viewSuppress = true;
    try {
      (this.buffer as any).setText(this.projection.viewText, -1);
      this.applyReadonlyTags();
      (this.buffer as any).setModified(false);
    } finally {
      this.viewSuppress = false;
    }
  }

  /** Tag every non-editable row (block / phantom) so the user can't type there. Identity
   *  (single editable full-file source) needs none — skip the per-row sweep entirely. */
  private applyReadonlyTags(): void {
    if (this.projection.isIdentity) return;
    const buffer = this.buffer as any;
    const tag = buffer.getTagTable().lookup(READONLY_TAG);
    const rowCount = this.projection.viewRowCount;
    for (let row = 0; row < rowCount; row++) {
      if (this.projection.isViewPositionEditable(row, 0)) continue;
      const start = asIter(buffer.getIterAtLine(row));
      const end = asIter(buffer.getIterAtLine(row + 1)); // includes the trailing '\n' → spans the row
      const endIter = end.getLine() === row ? this.endOfLine(row) : end;
      buffer.applyTag(tag, start, endIter);
    }
  }

  private endOfLine(row: number): any {
    const iter = asIter((this.buffer as any).getIterAtLine(row));
    if (!iter.endsLine()) iter.forwardToLineEnd();
    return iter;
  }

  // --- write-through (view → source) -----------------------------------------
  //
  // The view edit has NOT been applied to the view buffer yet (we're a "before" handler, as
  // Document is); GTK applies it after we return. We mirror it into the source so the source
  // stays authoritative; reverse-sync from that source is suppressed so it doesn't
  // double-apply (and GTK gives the originating view the text). SINGLE-SOURCE is offset-based:
  // projection offset == source offset, so a view offset → source offset is just the fold
  // transform (`viewOffsetToProj`). Multi-source *editable* write-through is Phase 3a — a
  // read-only multi-source projection fires no view edits here (the readonly tag blocks them).

  private wireView(): void {
    this.connect(this.buffer, 'insert-text', (iter: any, text: string) => {
      if (this.viewSuppress) return;
      this.writeThroughInsert(iter, text);
    });
    this.connect(this.buffer, 'delete-range', (start: any, end: any) => {
      if (this.viewSuppress) return;
      this.writeThroughDelete(start, end);
    });
  }

  private writeThroughInsert(iter: any, text: string): void {
    // SINGLE-SOURCE: offset-based (proj == source), fold-aware via the offset transform.
    if (this.projection.isSingleSource) {
      const src = this.soleSource();
      if (!src) return;
      const srcOffset = this.projection.viewOffsetToProj(iter.getOffset());
      this.suppressing(this.projection.soleKey!, () => (src as any).insert(iterAtOffset(src, srcOffset), text, -1));
      return;
    }
    // MULTI-SOURCE: route the edit to the segment's source. The readonly tag blocks edits on
    // block / phantom rows, so a view edit only reaches here on an editable real segment;
    // we still gate, since a headless caller can edit any row. In-place edits need no remap
    // (the row-direct map is stable); row-count-changing multi-source edits need
    // re-segmentation (Phase 3b) and aren't routed yet.
    const row = iter.getLine();
    const col = iter.getLineOffset();
    const target = this.projection.viewToSource(row, col);
    if (target.kind !== 'source' || !this.projection.isViewPositionEditable(row, col)) return;
    const src = this.sources.get(target.sourceKey);
    if (!src) return;
    this.noteSourceEdit(target.sourceKey);
    this.suppressing(target.sourceKey, () =>
      (src as any).insert(asIter((src as any).getIterAtLineOffset(target.row, target.column)), text, -1),
    );
  }

  private writeThroughDelete(startIter: any, endIter: any): void {
    if (this.projection.isSingleSource) {
      const src = this.soleSource();
      if (!src) return;
      const s = this.projection.viewOffsetToProj(startIter.getOffset());
      const e = this.projection.viewOffsetToProj(endIter.getOffset());
      if (e <= s) return; // a delete wholly inside a fold placeholder maps to a zero range
      this.suppressing(this.projection.soleKey!, () => (src as any).delete(iterAtOffset(src, s), iterAtOffset(src, e)));
      return;
    }
    // MULTI-SOURCE: only a delete within ONE editable segment routes; one spanning segments /
    // blocks is rejected (boundary clamp — hard problem #1).
    const a = this.projection.viewToSource(startIter.getLine(), startIter.getLineOffset());
    const b = this.projection.viewToSource(endIter.getLine(), endIter.getLineOffset());
    if (a.kind !== 'source' || b.kind !== 'source') return;
    if (a.sourceKey !== b.sourceKey || a.segmentIndex !== b.segmentIndex) return;
    if (!this.projection.isViewPositionEditable(startIter.getLine(), startIter.getLineOffset())) return;
    const src = this.sources.get(a.sourceKey);
    if (!src) return;
    this.noteSourceEdit(a.sourceKey);
    this.suppressing(a.sourceKey, () =>
      (src as any).delete(
        asIter((src as any).getIterAtLineOffset(a.row, a.column)),
        asIter((src as any).getIterAtLineOffset(b.row, b.column)),
      ),
    );
  }

  // --- reverse-sync (source → view) ------------------------------------------
  //
  // A source change (another view, undo/redo, reload — or our own write-through, suppressed).
  // The signal fires BEFORE the source mutates, so the projection still reflects the pre-edit
  // source: translate + mirror with the CURRENT map/fold spans. SINGLE-SOURCE is offset-based
  // (proj == source) and fold-aware: an edit a fold absorbs doesn't touch the view (the
  // placeholder stays; the fold just grows). MULTI-SOURCE mirrors an in-place edit at the
  // translated row (cursor preserved — what undo + external edits need); a row-count-changing
  // edit re-segments (Phase 3b), so it coarse-rebuilds once the source settles.

  private wireSource(key: string, buf: SourceBuffer): void {
    this.connect(buf, 'insert-text', (iter: any, text: string) => this.onSourceInsert(key, iter, text));
    this.connect(buf, 'delete-range', (start: any, end: any) => this.onSourceDelete(key, start, end));
  }

  private onSourceInsert(key: string, iter: any, text: string): void {
    if (!this.projection.isSingleSource) {
      if (this.sourceSuppress.has(key)) return;
      if (text.includes('\n')) return this.scheduleRebuild(); // row-count change → re-segment (3b)
      const pos = this.projection.sourceToView(key, iter.getLine(), iter.getLineOffset());
      if (pos) this.applyToView((b) => b.insert(asIter((b as any).getIterAtLineOffset(pos.row, pos.column)), text, -1));
      return;
    }
    const off = iter.getOffset();
    if (!this.sourceSuppress.has(key) && !this.projection.foldContaining(off)) {
      const viewOff = this.projection.projOffsetToView(off);
      this.applyToView((buffer) => buffer.insert(iterAtOffset(buffer, viewOff), text, -1));
    }
    this.projection.shiftFoldsForInsert(off, cpLength(text));
  }

  private onSourceDelete(key: string, startIter: any, endIter: any): void {
    if (!this.projection.isSingleSource) {
      if (this.sourceSuppress.has(key)) return;
      if (startIter.getLine() !== endIter.getLine()) return this.scheduleRebuild(); // row-count change → 3b
      const a = this.projection.sourceToView(key, startIter.getLine(), startIter.getLineOffset());
      const b = this.projection.sourceToView(key, endIter.getLine(), endIter.getLineOffset());
      if (a && b) this.applyToView((buf) => buf.delete(asIter((buf as any).getIterAtLineOffset(a.row, a.column)), asIter((buf as any).getIterAtLineOffset(b.row, b.column))));
      return;
    }
    const startOff = startIter.getOffset();
    const endOff = endIter.getOffset();
    if (!this.sourceSuppress.has(key)) {
      const fold = this.projection.foldContaining(startOff);
      const absorbed = !!fold && startOff >= fold.start && endOff <= fold.end; // fully inside a fold
      if (!absorbed) {
        const vs = this.projection.projOffsetToView(startOff);
        const ve = this.projection.projOffsetToView(endOff);
        if (ve > vs) this.applyToView((buffer) => buffer.delete(iterAtOffset(buffer, vs), iterAtOffset(buffer, ve)));
      }
    }
    this.projection.shiftFoldsForDelete(startOff, endOff);
  }

  // --- folds (view-side collapse; the analytic transform, hard problem #3) ----

  /** Collapse view codepoint range `[viewStart, viewEnd)` to `placeholder` and return its
   *  handle. The source is untouched (it's the full text); the view renders the fold on one
   *  line, the placeholder tagged read-only. Single-source only (the editor's fold use case);
   *  a fold makes the view non-identity but stays incrementally synced via the offset
   *  transform. Subsumes any inner folds in the range (their bodies join this collapse). */
  fold(viewStart: number, viewEnd: number, placeholder: string): Fold | null {
    if (!this.projection.isSingleSource || viewEnd <= viewStart) return null;
    const projStart = this.projection.viewOffsetToProj(viewStart);
    const projEnd = this.projection.viewOffsetToProj(viewEnd);
    if (projEnd <= projStart) return null;
    this.projection.removeFoldsWithin(projStart, projEnd); // an outer fold subsumes inner ones
    const handle = this.projection.addFold(projStart, projEnd, placeholder);
    if (!handle) return null;
    this.applyToView((buffer) => {
      buffer.delete(iterAtOffset(buffer, viewStart), iterAtOffset(buffer, viewEnd));
      buffer.insert(iterAtOffset(buffer, viewStart), placeholder, -1);
      const tag = buffer.getTagTable().lookup(READONLY_TAG);
      buffer.applyTag(tag, iterAtOffset(buffer, viewStart), iterAtOffset(buffer, viewStart + cpLength(placeholder)));
    });
    return handle;
  }

  /** Expand a fold: replace its placeholder with the current source text of its range. */
  unfold(handle: Fold): void {
    const src = this.soleSource();
    if (!src) return;
    const viewStart = this.projection.projOffsetToView(handle.start);
    const placeholderLen = cpLength(handle.placeholder);
    const body = (src as any).getText(iterAtOffset(src, handle.start), iterAtOffset(src, handle.end), true); // proj == source
    this.projection.removeFold(handle);
    this.applyToView((buffer) => {
      buffer.delete(iterAtOffset(buffer, viewStart), iterAtOffset(buffer, viewStart + placeholderLen));
      buffer.insert(iterAtOffset(buffer, viewStart), body, -1);
    });
  }

  // --- view ↔ source translation (the FoldHost surface SyntaxController consumes) --------
  // Single-source only (the editor's fold host is per-file): the offset transform composes
  // the fold collapse and proj offset == source offset. A non-single-source projection
  // returns identity (its painter uses the SyntaxProjection path, not this).

  /** The source (file) line shown at view line `viewLine` — for the line-number gutter. */
  modelLineForViewLine(viewLine: number): number {
    const src = this.soleSource();
    if (!src) return viewLine;
    const viewOff = asIter((this.buffer as any).getIterAtLine(viewLine)).getOffset();
    return iterAtOffset(src, this.projection.viewOffsetToProj(viewOff)).getLine();
  }

  /** The view line showing source line `modelLine` (its start) — for diagnostics/decorations. */
  viewLineForModelLine(modelLine: number): number {
    const src = this.soleSource();
    if (!src) return modelLine;
    const srcOff = asIter((src as any).getIterAtLine(modelLine)).getOffset();
    return iterAtOffset(this.buffer as any, this.projection.projOffsetToView(srcOff)).getLine();
  }

  /** Translate a VIEW caret to SOURCE coordinates (folds shift lines + columns) — for LSP. */
  modelPointFromView(point: Point): Point {
    const src = this.soleSource();
    if (!src) return point;
    const viewOff = asIter((this.buffer as any).getIterAtLineOffset(point.row, point.column)).getOffset();
    const iter = iterAtOffset(src, this.projection.viewOffsetToProj(viewOff));
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Translate a SOURCE caret to VIEW coordinates (a position inside a fold → placeholder). */
  viewPointFromModel(point: Point): Point {
    const src = this.soleSource();
    if (!src) return point;
    const srcOff = asIter((src as any).getIterAtLineOffset(point.row, point.column)).getOffset();
    const iter = iterAtOffset(this.buffer as any, this.projection.projOffsetToView(srcOff));
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Text of source line `row` (no newline) — for LSP column encoding of source ranges. */
  modelLineText(row: number): string {
    const src = this.soleSource();
    return src ? lineText(src, row) : '';
  }

  /** The live `[start, end)` placeholder offsets of `fold` in the view buffer. A removed
   *  (unfolded / subsumed) handle has no placeholder in the buffer anymore → a zero-width
   *  range (matching the old impl's collapsed marks), so a caller snapping the cursor out of
   *  a placeholder doesn't loop on a stale range while `unfold`'s splice is still in flight. */
  foldPlaceholderRange(fold: Fold): [number, number] {
    const viewStart = this.projection.projOffsetToView(fold.start);
    if (!this.isFoldAlive(fold)) return [viewStart, viewStart];
    return [viewStart, viewStart + cpLength(fold.placeholder)];
  }

  /** The source text a fold currently collapses (for search-reveal matching). */
  foldModelText(fold: Fold): string {
    const src = this.soleSource();
    return src ? (src as any).getText(iterAtOffset(src, fold.start), iterAtOffset(src, fold.end), true) : '';
  }

  /** Whether a fold handle is still live (not subsumed by an enclosing fold / deleted). */
  isFoldAlive(fold: Fold): boolean {
    return this.projection.foldSpans().includes(fold);
  }

  private soleSource(): SourceBuffer | null {
    const key = this.projection.soleKey;
    return key ? this.sources.get(key) ?? null : null;
  }

  /** Run `fn` (which mutates source `key`) with that source's reverse-sync suppressed, so the
   *  write-through doesn't echo back into the view (which GTK already updates). */
  private suppressing(key: string, fn: () => void): void {
    this.sourceSuppress.add(key);
    try {
      fn();
    } finally {
      this.sourceSuppress.delete(key);
    }
  }

  // --- cross-source undo (the UndoTarget the multibuffer's EditorModel drives) ------------

  /** Open a transaction: writes-through during it coalesce into one undo step per source. */
  beginUserAction(): void {
    this.currentTxn = new Set();
  }

  /** Close the transaction: end each touched source's native undo group + push the step. */
  endUserAction(): void {
    if (!this.currentTxn) return;
    for (const key of this.openActions) (this.sources.get(key) as any)?.endUserAction();
    this.openActions.clear();
    if (this.currentTxn.size) {
      this.undoStack.push([...this.currentTxn]);
      this.redoStack.length = 0; // a fresh edit invalidates the redo timeline
    }
    this.currentTxn = null;
  }

  /** Record that the open user action edited source `key` (opening its native undo group on
   *  first touch). Outside a user action, the edit is its own one-source transaction. */
  private noteSourceEdit(key: string): void {
    if (this.currentTxn) {
      if (!this.openActions.has(key)) {
        (this.sources.get(key) as any)?.beginUserAction();
        this.openActions.add(key);
      }
      this.currentTxn.add(key);
    } else {
      this.undoStack.push([key]);
      this.redoStack.length = 0;
    }
  }

  /** Undo the last transaction: replay each touched source's native undo (reverse order). The
   *  sources' change signals reverse-sync the result into the view (and the files' own views). */
  undo(): void {
    const txn = this.undoStack.pop();
    if (!txn) return;
    for (let i = txn.length - 1; i >= 0; i--) (this.sources.get(txn[i]) as any)?.undo();
    this.redoStack.push(txn);
  }

  redo(): void {
    const txn = this.redoStack.pop();
    if (!txn) return;
    for (const key of txn) (this.sources.get(key) as any)?.redo();
    this.undoStack.push(txn);
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private applyToView(mutate: (buffer: any) => void): void {
    this.viewSuppress = true;
    try {
      mutate(this.buffer as any);
    } finally {
      this.viewSuppress = false;
    }
  }

  // A non-identity source change settled: the source buffers have mutated, so rebuild the
  // projection from their current rows and re-materialize. Deferred to a microtask so the
  // source's own signal handlers all run first (the source mutates AFTER its 'insert-text').
  private rebuildScheduled = false;
  private scheduleRebuild(): void {
    if (this.rebuildScheduled || this.disposed) return;
    this.rebuildScheduled = true;
    queueMicrotask(() => {
      this.rebuildScheduled = false;
      if (!this.disposed) this.rebuild();
    });
  }

  /** Rebuild the projection from the current source state + re-materialize. Used when the
   *  segment structure changes (excerpts open/close, or a non-identity source edit). */
  rebuild(items: Item[] = this.items): void {
    this.items = items;
    this.projection = ViewProjection.build(items, (seg) => this.sourceLines(seg));
    this.materialize();
  }

  /** Ignore source-buffer change signals until `resume()` — for a bulk replace the owner
   *  drives explicitly (Document.setText emits whole-buffer delete+insert it doesn't want
   *  mirrored edit-by-edit; it `suspend()`s, replaces, then `rebuild()`s + `resume()`s). */
  suspend(): void {
    for (const key of this.sources.keys()) this.sourceSuppress.add(key);
  }
  resume(): void {
    for (const key of this.sources.keys()) this.sourceSuppress.delete(key);
  }

  // --- lifecycle -------------------------------------------------------------

  private connect(target: any, event: string, cb: (...args: any[]) => any): void {
    target.on(event, cb);
    this.connections.push({ target, event, cb });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { target, event, cb } of this.connections) {
      try {
        target.off(event, cb);
      } catch {
        /* target already finalized */
      }
    }
    this.connections.length = 0;
  }
}
