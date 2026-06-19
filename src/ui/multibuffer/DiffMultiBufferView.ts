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
import { DiffLineNumberGutter } from '../TextEditor/DiffLineNumberGutter.ts';
import { buildDiffMultiBuffer, type DiffFile, type DiffMultiBuffer } from './diffMultiBuffer.ts';
import { buildHeaderWidget } from './MultiBufferHeader.ts';
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
  private readonly lineNumbers: DiffLineNumberGutter[] = [];
  private readonly headerHandles: BlockDecorationHandle[] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private readonly editable: boolean;
  private readonly registry?: DocumentRegistry;
  private reDiffTimer: NodeJS.Timeout | null = null;
  private suppressReDiff = false;
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

    if (this.editable) {
      this.editor.model.setEditableCheck((s, e) => this.projection.isViewRangeEditable(s, e));
      // A row-count reverse-sync (undo / external) can't be re-flowed by window arithmetic on a
      // diff (new-side + phantom segments interleave), so re-derive the diff from scratch instead.
      this.projectionView.setResyncHandler(() => this.reDiff());
    }

    this.applyDecorations(dmb);

    const view = this.editor.sourceView;
    this.lineNumbers = [
      new DiffLineNumberGutter(view, lineLabels(dmb.oldNums), undefined, 1, gutterBg(dmb, 'old')),
      new DiffLineNumberGutter(view, lineLabels(dmb.newNums), undefined, 2, gutterBg(dmb, 'new')),
    ];

    this.installHeaders(dmb);
    this.installNavigation();
    if (this.editable) {
      // Re-diff after the new side settles: the live Document already has the edit (write-through),
      // so recompute the windowed diff and re-flow the view with a minimal splice.
      this.editor.model.onDidChangeText(() => this.scheduleReDiff());
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
    return buildDiffMultiBuffer(files, this.cwd, { headers: 'widget' });
  }

  /** Anchor a filename-header widget above each file's first row (the search-view pattern). The
   *  anchor mark tracks the row across edits; clicking jumps to the file. */
  private installHeaders(dmb: DiffMultiBuffer): void {
    for (const h of dmb.headerAnchors) {
      const widget = buildHeaderWidget(h.label, h.path, () => this.onActivate?.({ path: h.path, row: 0 }));
      this.headerHandles.push(this.editor.inlineBlocks.add({ line: h.viewRow, widget, placement: 'above' }));
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
    this.lineNumbers[0]?.setData(lineLabels(dmb.oldNums), gutterBg(dmb, 'old'));
    this.lineNumbers[1]?.setData(lineLabels(dmb.newNums), gutterBg(dmb, 'new'));
    // retarget swapped rows but didn't repaint — re-highlight + re-style the gap rows, else
    // spliced sections lose their syntax colors and the `⋯ unchanged` styling.
    this.editor.repaintSyntax();
    // Restore the caret to where its source position now shows (it followed the reflow).
    if (anchor.kind === 'source') {
      const pos = this.projection.sourceToView(anchor.sourceKey, anchor.row, anchor.column);
      if (pos) this.editor.model.setCursorBufferPosition(pos);
    }
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
    for (const handle of this.headerHandles) handle.remove();
    this.headerHandles.length = 0;
    for (const gutter of this.lineNumbers) gutter.dispose();
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
