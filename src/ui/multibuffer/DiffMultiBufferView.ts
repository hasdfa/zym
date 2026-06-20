/*
 * DiffMultiBufferView — a CONTINUOUS multi-file diff in one scrollable editor
 * (tasks/code-editing/multibuffer.md, Phase 3b / G5). Each changed file is a filename header
 * then its diff windowed like a real diff (changed hunks + context, long unchanged runs elided
 * to a `⋯` gap; see `buildDiffMultiBuffer`): context + added rows over the NEW side, removed
 * rows over the OLD/HEAD blob, all stitched into one `ViewProjection`. Per-side syntax
 * highlighting (`ExcerptSyntaxProjection`), added/removed backgrounds (`applyDiffDecorations`),
 * old|new line gutters, and Enter/double-click → jump to the file.
 *
 * Two modes:
 *   - READ-ONLY (default): each side is a bare disk-snapshot buffer.
 *   - EDITABLE (G5): the NEW side is a LIVE `Document` from the registry, so editing a
 *     context/added row writes through to the file's model (open tab + save); removed (phantom,
 *     old-side) rows reject edits. After an edit settles, the diff is RE-COMPUTED and the view
 *     re-flowed via `ProjectionView.retarget` — a minimal-churn splice (no whole-buffer
 *     re-materialize), so phantom rows appear/disappear without a flash or a caret jump.
 */
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { TextEditor } from '../TextEditor/TextEditor.ts';
import { Document } from '../TextEditor/Document.ts';
import { DocumentRegistry } from '../TextEditor/DocumentRegistry.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { ProjectionView } from '../TextEditor/ProjectionView.ts';
import { ViewProjection } from '../TextEditor/ViewProjection.ts';
import { ExcerptSyntaxProjection } from './ExcerptSyntaxProjection.ts';
import { applyDiffDecorations } from '../TextEditor/applyDiffDecorations.ts';
import { CombinedDiffLineNumberGutter } from '../TextEditor/DiffLineNumberGutter.ts';
import { buildDiffMultiBuffer, type DiffFile, type DiffMultiBuffer } from './diffMultiBuffer.ts';
import { buildHeaderWidget, buildGapWidget } from './MultiBufferHeader.ts';
import type { BlockDecorationHandle } from '../TextEditor/BlockDecorations.ts';

export interface DiffMultiBufferOptions {
  /** Changed files: base (old/HEAD) + current (new/working) content. */
  files: DiffFile[];
  cwd?: string;
  onActivate?: (location: { path: string; row: number }) => void;
  /** Edit-in-place: back the NEW side with live `Document`s (write-through + save + live
   *  re-diff) instead of disk snapshots. Requires `documents`. */
  editable?: boolean;
  /** The app's document registry — required when `editable`. */
  documents?: DocumentRegistry;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);
const newKey = (path: string): string => `new:${path}`;
const oldKey = (path: string): string => `old:${path}`;
const REDIFF_DEBOUNCE_MS = 120;

/** Right-align line numbers (blank for null) into an equal-width gutter column. */
function lineLabels(nums: readonly (number | null)[]): string[] {
  let width = 1;
  for (const n of nums) if (n !== null) width = Math.max(width, String(n).length);
  return nums.map((n) => (n === null ? '' : String(n).padStart(width)));
}

/** Per-row gutter cell tints: the old column reddens removed rows, the new column greens added
 *  rows (the stronger `*Word` tint, so the gutter reads a bit deeper than the line background).
 *  Context rows (both numbers present) stay untinted. */
function gutterBg(dmb: DiffMultiBuffer, side: 'old' | 'new'): (string | null)[] {
  const want = side === 'old' ? 'removed' : 'added';
  const color = side === 'old' ? theme.ui.diff.removedWord : theme.ui.diff.addedWord;
  return dmb.rowKinds.map((kind) => (kind === want ? color : null));
}

interface SourceEntry {
  buffer: SourceBuffer;
  syntax: DocumentSyntax;
  /** Editable mode, new side only: the live Document backing it (released on dispose). */
  document?: Document;
}

export class DiffMultiBufferView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly files: DiffFile[];
  private readonly cwd?: string;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly projectionView: ProjectionView;
  private lineNumbers: CombinedDiffLineNumberGutter | null = null;
  // Header + `⋯` gap widgets (BlockDecoration bands). Re-placed on each re-diff: their text
  // (gap counts, leading-gap subtitle) and positions change as the diff re-flows.
  private overlayHandles: BlockDecorationHandle[] = [];
  // Expand-context state: NEW-side rows the user forced visible, and a reveal-everything flag.
  // The current diff's anchors, kept for the keyboard `expandContextAtCursor`.
  private revealAll = false;
  private readonly revealedNewRows = new Set<number>();
  private gapAnchors: DiffMultiBuffer['gapAnchors'] = [];
  private headerAnchors: DiffMultiBuffer['headerAnchors'] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private readonly editable: boolean;
  private readonly registry?: DocumentRegistry;
  private reDiffTimer: NodeJS.Timeout | null = null;
  private suppressReDiff = false;
  private lastLineCount = 0; // view buffer line count, to detect line-count-changing edits
  private readonly modifiedHandlers: Array<() => void> = [];
  private readonly modifiedUnsubs: Array<() => void> = [];
  private disposed = false;

  private get projection(): ViewProjection {
    return this.projectionView.view;
  }

  constructor(options: DiffMultiBufferOptions) {
    this.onActivate = options.onActivate;
    this.files = options.files;
    this.cwd = options.cwd;
    this.editable = !!options.editable;
    this.registry = options.documents;
    if (this.editable && !this.registry) {
      throw new Error('DiffMultiBufferView: editable mode requires a DocumentRegistry');
    }

    // Resolve each side's source ONCE (live Document for the new side when editable, else a
    // disk snapshot; the old/base side is always a read-only blob), then diff + project.
    for (const file of this.files) this.ensureSources(file);
    const dmb = this.buildDiff();

    const sourceBuffers = new Map([...this.sources].map(([key, e]) => [key, e.buffer] as const));
    const syntaxMap = new Map([...this.sources].map(([key, e]) => [key, e.syntax] as const));
    this.projectionView = new ProjectionView(dmb.items, sourceBuffers);

    this.editor = new TextEditor({
      buffer: {
        readOnly: !this.editable,
        folding: false,
        syntaxProjection: new ExcerptSyntaxProjection(() => this.projection, syntaxMap),
        externalBuffer: this.projectionView.buffer,
        undoTarget: this.editable ? this.projectionView : undefined,
      },
    });
    this.root = this.editor.root;
    // Scope the expand-context keymap to this surface: `#TextEditor.diff-multibuffer` is more
    // specific than vim's `#TextEditor`, so `z o`/`z R`/`z m` bind here while `z z` (scroll) etc.
    // still fall through to vim.
    (this.editor.sourceView as any).addCssClass('diff-multibuffer');

    if (this.editable) {
      this.editor.model.setEditableCheck((s, e) => this.projection.isViewRangeEditable(s, e));
      // A row-count reverse-sync (undo / external) can't be re-flowed by window arithmetic on a
      // diff (new-side + phantom segments interleave), so re-derive the diff from scratch instead.
      this.projectionView.setResyncHandler(() => this.reDiff());
    }

    this.applyDecorations(dmb);

    // ONE gutter renderer drawing both old + new columns (one PangoLayout/line, for perf).
    this.lineNumbers = new CombinedDiffLineNumberGutter(
      this.editor.sourceView,
      lineLabels(dmb.oldNums),
      lineLabels(dmb.newNums),
      gutterBg(dmb, 'old'),
      gutterBg(dmb, 'new'),
    );

    this.installOverlays(dmb);
    this.installNavigation();
    if (this.editable) {
      // Re-diff after an edit. A LINE-COUNT change (Enter / `o` / dd) reflows the diff and moves
      // the caret relative to the gaps, so re-diff IMMEDIATELY — debouncing it leaves the caret
      // briefly stranded next to a gap widget before the deferred reflow corrects it. A within-line
      // edit doesn't move gaps, so it stays debounced (the common per-keystroke case).
      this.lastLineCount = (this.projectionView.buffer as any).getLineCount();
      this.editor.model.onDidChangeText(() => {
        if (this.suppressReDiff) return; // our own retarget edits
        const n = (this.projectionView.buffer as any).getLineCount();
        const lineCountChanged = n !== this.lastLineCount;
        this.lastLineCount = n;
        // A line-count change reflows the diff; re-diff on a MICROTASK (after the full edit
        // command finishes placing the caret, but before the next paint) so the caret follows
        // with no visible flash — yet not synchronously, which would race vim's own cursor move.
        if (lineCountChanged) this.scheduleMicroReDiff();
        else this.scheduleReDiff();
      });
      // Surface each new-side file's modified state as one event (for the tab's unsaved marker).
      for (const entry of this.sources.values()) {
        if (entry.document) this.modifiedUnsubs.push(entry.document.onModifiedChange(() => this.emitModified()));
      }
    }
    // Materializing the buffer (setText) leaves the caret at the END; start at the top.
    this.editor.model.setCursorBufferPosition({ row: 0, column: 0 });
  }

  /** Build the windowed diff from each file's base blob + its CURRENT new-side text (the live
   *  Document's text when editable, else the snapshot passed in). */
  private buildDiff(): DiffMultiBuffer {
    const files = this.files.map((f) => ({ ...f, newText: this.currentNewText(f) }));
    // Filename headers are widgets (not navigable buffer text), anchored above each file's rows.
    // `reveal` forces user-expanded (otherwise-elided) new-side rows visible (expand-context).
    const reveal = this.revealAll ? () => true : (r: number) => this.revealedNewRows.has(r);
    return buildDiffMultiBuffer(files, this.cwd, { headers: 'widget', reveal });
  }

  // --- expand context (reveal elided unchanged lines) ------------------------
  private static readonly CHUNK = 10; // lines revealed per click / `zo`

  /** Reveal a chunk of a gap's elided rows. `fromTop` extends the window above the gap (the
   *  common case); else extends the window below (a leading gap). Re-diffs to re-flow. */
  private revealChunk(rows: number[], fromTop: boolean): void {
    if (!rows.length) return;
    const chunk = fromTop ? rows.slice(0, DiffMultiBufferView.CHUNK) : rows.slice(-DiffMultiBufferView.CHUNK);
    for (const r of chunk) this.revealedNewRows.add(r);
    this.reDiff();
  }

  /** Expand the gap nearest the caret, revealing TOWARD the caret: a gap below the caret reveals
   *  from its top (extends the caret's window down), a gap above reveals from its bottom (extends
   *  it up). Leading gaps (above a file's first row) join the same candidate set. So `zo` works
   *  whether the caret sits above or below the fold. */
  expandContextAtCursor(): void {
    const row = this.cursorRow();
    // Each gap sits just below `viewRow` (the last shown row before it); a leading gap sits above
    // the file's first content row (`header.viewRow`), i.e. just below `header.viewRow - 1`.
    const gaps: Array<{ rows: number[]; viewRow: number }> = [
      ...this.gapAnchors.map((g) => ({ rows: g.revealRows, viewRow: g.viewRow })),
      ...this.headerAnchors.flatMap((h) => (h.leadingRevealRows?.length ? [{ rows: h.leadingRevealRows, viewRow: h.viewRow - 1 }] : [])),
    ];
    let best: { rows: number[]; fromTop: boolean; dist: number } | null = null;
    for (const g of gaps) {
      const above = row <= g.viewRow; // is the caret above this gap?
      const dist = above ? g.viewRow - row : row - (g.viewRow + 1);
      if (!best || dist < best.dist) best = { rows: g.rows, fromTop: above, dist };
    }
    if (best) this.revealChunk(best.rows, best.fromTop);
  }

  /** Reveal every elided line (show the full files). */
  expandAll(): void {
    this.revealAll = true;
    this.reDiff();
  }

  /** Re-collapse all expanded context back to the windowed diff. */
  collapseContext(): void {
    this.revealAll = false;
    this.revealedNewRows.clear();
    this.reDiff();
  }

  /** (Re)place the header widgets (above each file's first row) + the `⋯` gap bands (below the
   *  last shown row before each elision). Both are real widgets, not navigable buffer rows.
   *
   *  Re-placing tears down + recreates the overlay widgets, which flickers — so SKIP it when the
   *  anchors are byte-identical to last time. Typing within a line doesn't change the gap/header
   *  structure (same labels, same rows), so the common edit re-diffs without touching overlays;
   *  only a line add/remove (which shifts rows or gap counts) actually re-places. */
  private lastOverlayKey = '';
  private installOverlays(dmb: DiffMultiBuffer): void {
    this.gapAnchors = dmb.gapAnchors; // kept for the keyboard expand (`expandContextAtCursor`)
    this.headerAnchors = dmb.headerAnchors;
    const key = JSON.stringify([dmb.headerAnchors, dmb.gapAnchors]);
    if (key === this.lastOverlayKey && this.overlayHandles.length) return;
    this.lastOverlayKey = key;
    for (const h of this.overlayHandles) h.remove();
    this.overlayHandles = [];
    for (const h of dmb.headerAnchors) {
      const widget = buildHeaderWidget(h.label, h.path, () => this.onActivate?.({ path: h.path, row: 0 }), h.subtitle);
      this.overlayHandles.push(this.editor.inlineBlocks.add({ line: h.viewRow, widget, placement: 'above' }));
    }
    for (const g of dmb.gapAnchors) {
      // Clicking the gap reveals a chunk of its elided lines (extends the window above it).
      const widget = buildGapWidget(g.label, () => this.revealChunk(g.revealRows, true));
      this.overlayHandles.push(this.editor.inlineBlocks.add({ line: g.viewRow, widget, placement: 'below' }));
    }
  }

  private currentNewText(file: DiffFile): string {
    return this.sources.get(newKey(file.path))?.document?.getText() ?? file.newText;
  }

  /** Resolve the old (base, read-only blob) + new (live Document or snapshot) sides of `file`. */
  private ensureSources(file: DiffFile): void {
    if (!this.sources.has(oldKey(file.path))) {
      this.sources.set(oldKey(file.path), this.snapshotSource(file.oldText, file.path));
    }
    if (this.sources.has(newKey(file.path))) return;
    const entry = this.editable ? this.acquireNewSide(file) : this.snapshotSource(file.newText, file.path);
    if (entry) this.sources.set(newKey(file.path), entry);
  }

  /** A read-only blob buffer + its own parse (the base side, and both sides when read-only). */
  private snapshotSource(text: string, path: string): SourceEntry {
    const buffer = new GtkSource.Buffer();
    buffer.setText(text, -1);
    const syntax = new DocumentSyntax(buffer);
    syntax.setLanguageForPath(path);
    return { buffer, syntax };
  }

  /** Editable new side: the shared live Document's model buffer + its own parse (no double
   *  parse). Loads from disk only if not already open (preserving an open tab's unsaved edits). */
  private acquireNewSide(file: DiffFile): SourceEntry {
    const { document } = this.registry!.acquire(file.path);
    if (!document.isLoaded) document.loadFile(file.path);
    document.syntax.setLanguageForPath(file.path);
    return { buffer: document.modelBuffer, syntax: document.syntax, document };
  }

  private scheduleReDiff(): void {
    if (this.suppressReDiff || this.disposed) return;
    if (this.reDiffTimer) clearTimeout(this.reDiffTimer);
    this.reDiffTimer = setTimeout(() => {
      this.reDiffTimer = null;
      this.reDiff();
    }, REDIFF_DEBOUNCE_MS);
  }

  // Re-diff on a microtask (a line-count-changing edit): runs after the edit command settles but
  // before the next paint, so the reflow + caret-follow happen with no visible flash. Supersedes
  // a pending debounce.
  private microReDiffScheduled = false;
  private scheduleMicroReDiff(): void {
    if (this.microReDiffScheduled || this.disposed) return;
    this.microReDiffScheduled = true;
    if (this.reDiffTimer) { clearTimeout(this.reDiffTimer); this.reDiffTimer = null; }
    queueMicrotask(() => {
      this.microReDiffScheduled = false;
      if (!this.disposed && !this.suppressReDiff) this.reDiff();
    });
  }

  /** Recompute the windowed diff from the (edited) live new side and re-flow the view with a
   *  minimal splice — phantom/removed rows appear/disappear without a whole-buffer flash. */
  private reDiff(): void {
    if (this.disposed) return;
    // Anchor the caret to its SOURCE position: the reflow re-aligns rows (e.g. a just-typed line
    // is re-classified as added and moves past the removed block), so a view-row caret would be
    // left pointing at a different (often phantom) row — and edits would then land there.
    const caret = this.editor.model.getCursorBufferPosition();
    const anchor = this.projection.viewToSource(caret.row, caret.column);
    const dmb = this.buildDiff();
    this.suppressReDiff = true; // retarget's view edits must not re-trigger a re-diff
    try {
      this.projectionView.retarget(dmb.items);
    } finally {
      this.suppressReDiff = false;
    }
    this.applyDecorations(dmb);
    this.lineNumbers?.setData(lineLabels(dmb.oldNums), lineLabels(dmb.newNums), gutterBg(dmb, 'old'), gutterBg(dmb, 'new'));
    this.installOverlays(dmb); // re-place header + gap widgets (counts/positions re-flowed)
    // retarget swapped rows but didn't repaint — re-highlight the spliced sections.
    this.editor.repaintSyntax();
    // Restore the caret to where its source position now shows (it followed the reflow).
    if (anchor.kind === 'source') {
      const pos = this.projection.sourceToView(anchor.sourceKey, anchor.row, anchor.column);
      if (pos) this.editor.model.setCursorBufferPosition(pos);
    }
    this.lastLineCount = (this.projectionView.buffer as any).getLineCount(); // reflow changed it
  }

  /** Added/removed line backgrounds from the per-row diff kinds (header/blank/gap/context get
   *  none). The view buffer's last line is unterminated, so decorations span its content. */
  private applyDecorations(dmb: DiffMultiBuffer): void {
    const buffer = this.projectionView.buffer as any;
    const lines = dmb.rowKinds.map((kind, row) => ({
      kind: kind === 'added' || kind === 'removed' ? kind : 'context',
      text: this.lineText(buffer, row),
    }));
    applyDiffDecorations(this.editor.decorations.layer('diff'), lines, /* terminated */ false);
  }

  private lineText(buffer: any, row: number): string {
    const start = asIter(buffer.getIterAtLine(row));
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return buffer.getText(start, end, true);
  }

  private installNavigation(): void {
    const view = this.editor.sourceView as any;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval !== Gdk.KEY_Return && keyval !== Gdk.KEY_KP_Enter) return false;
      if (this.editable && view.getEditable()) return false; // insert mode: Enter is a newline
      this.activateRow(this.cursorRow());
      return true;
    });
    view.addController(keys);

    if (this.editable) return; // double-click word-select stays while editing
    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return;
      const by = view.windowToBufferCoords(Gtk.TextWindowType.TEXT, x, y);
      const yBuf = Array.isArray(by) ? by[by.length - 1] : y;
      const r = view.getLineAtY(yBuf);
      this.activateRow(asIter(Array.isArray(r) ? r[0] : r).getLine());
    });
    view.addController(click);
  }

  private cursorRow(): number {
    const buffer = (this.editor.sourceView as any).getBuffer();
    return asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  }

  private activateRow(viewRow: number): void {
    const target = this.projection.viewToSource(viewRow, 0);
    if (target.kind !== 'source') return;
    const sep = target.sourceKey.indexOf(':'); // keys are `new:<path>` / `old:<path>`
    const path = sep >= 0 ? target.sourceKey.slice(sep + 1) : target.sourceKey;
    this.onActivate?.({ path, row: target.row });
  }

  /** Whether any edited new-side file has unsaved changes (editable mode). */
  isModified(): boolean {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) return true;
    return false;
  }

  /** Save every edited new-side file back to disk (editable mode; no-op read-only). */
  save(): void {
    for (const entry of this.sources.values()) if (entry.document?.isModified()) entry.document.save();
  }

  /** Subscribe to changes in this diff's unsaved state (any edited new-side file). For the tab's
   *  modified marker. */
  onModifiedChange(callback: () => void): void {
    this.modifiedHandlers.push(callback);
  }
  private emitModified(): void {
    for (const cb of this.modifiedHandlers) cb();
  }

  focus(): void {
    this.editor.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reDiffTimer) clearTimeout(this.reDiffTimer);
    this.reDiffTimer = null;
    for (const unsub of this.modifiedUnsubs) unsub(); // detach from the (possibly shared) Documents
    this.modifiedUnsubs.length = 0;
    for (const handle of this.overlayHandles) handle.remove();
    this.overlayHandles = [];
    this.lineNumbers?.dispose();
    this.projectionView.dispose();
    for (const entry of this.sources.values()) {
      // Editable new side: drop the shared ref (a file also open in a tab survives + keeps its
      // unsaved edit). Read-only / base blobs: this view owns the parse.
      if (entry.document) this.registry!.release(entry.document);
      else entry.syntax.dispose();
    }
    this.sources.clear();
    this.editor.dispose();
  }
}
