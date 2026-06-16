/*
 * Document — the model layer behind one or more TextEditor views (the A2
 * "document-model" architecture; see tasks/code-editing/text-editor.md →
 * "Document-model direction (A2)").
 *
 * GtkTextBuffer conflates model and view: a buffer shared by N GtkSourceViews renders
 * the same cursor / selection / decorations / folds in all of them. So instead we own
 * the text here: a **headless model buffer** (never shown) is the single source of
 * truth for text + undo, and each view gets its **own** GtkSource.Buffer kept in sync.
 * Every view is then native and independent — its own cursor, selection, current line,
 * folds, decorations — for free, and we can use GtkSourceView's APIs per view.
 *
 * Sync: a native edit in a view's buffer is forwarded to the model, which mirrors it to
 * the other views (reentrancy-guarded). Undo/redo run on the model (view buffers have
 * native undo off) and propagate out. The mechanics are validated in
 * src/poc/document-model.ts and Document.test.ts.
 *
 * The Document also owns the document-level concerns — file I/O, disk-watching,
 * modified-state, and the LSP document — so views are pure presentation. The LSP
 * lifecycle is genuinely document-level here (one didOpen/didChange/didClose for the
 * file, driven off the model), unlike a shared-buffer design where every view's model
 * observed the edits.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Adw, Gio, GLib, GtkSource, type SourceBuffer } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { Point } from '../../text/Point.ts';
import type { LspDocument, DocumentEdit } from '../../lsp/LspManager.ts';

type EditKind = 'insert' | 'delete';

// node-gtk quirk: Gio.File instance methods are undefined on the concrete instance,
// so reach them through the prototype (see config/load.ts).
const GioFileProto = (Gio.File as any).prototype;
// node-gtk returns out-param iters directly or as [ok, iter]; normalize.
const asIter = (res: any): any => (Array.isArray(res) ? res[res.length - 1] : res);
const iterAtOffset = (buf: any, off: number): any => asIter(buf.getIterAtOffset(off));

/** A view's buffer + the guard that keeps a model-applied edit from forwarding back. */
interface ViewEntry {
  buffer: SourceBuffer;
  suppress: boolean;
}

/** The view-side reactions a Document routes to the active (focused) view: cursor
 *  restore + focus on load, modal dialogs, toasts, and the cursor for LSP requests. */
export interface DocumentHost {
  /** About to replace the document content (capture the caret when `reload` so a
   *  silent external-change reload keeps it). */
  willReplaceContent(reload: boolean): void;
  /** Content was loaded: restore/place the cursor, refresh diagnostics + git gutter,
   *  apply detected indentation, and grab focus (unless `reload`). Syntax follows the
   *  view buffer's own change automatically. */
  didLoad(content: string, path: string, reload: boolean): void;
  /** Content was written to `path`: refresh the git gutter. */
  didSave(path: string): void;
  /** Present a modal dialog parented to the view (overwrite-confirm). */
  presentDialog(dialog: InstanceType<typeof Adw.AlertDialog>): void;
  /** Whether the view currently holds focus (drives prompt timing). */
  hasFocus(): boolean;
  /** Surface an error message (load/save failures). */
  toast(message: string): void;
  /** The view's cursor, for LSP requests (completion/hover anchor at the active view). */
  lspCursor(): Point;
}

export class Document {
  // The headless authority: text + the single undo stack. Never attached to a view.
  private readonly model: SourceBuffer;
  private readonly views = new Set<ViewEntry>();
  private origin: ViewEntry | null = null;
  private syncing = false;

  /** The LSP document identity for this file — one per Document. Text/line read the
   *  model directly; the cursor comes from the active view. */
  readonly lspDocument: LspDocument = {
    getPath: () => this._currentFile,
    getText: () => this.getText(),
    lineTextForRow: (row) => this.lineText(row),
    getCursorBufferPosition: () => this.host?.lspCursor() ?? new Point(0, 0),
  };

  private readonly hosts: DocumentHost[] = [];
  private activeHost: DocumentHost | null = null;
  private get host(): DocumentHost | null {
    return this.activeHost ?? this.hosts[0] ?? null;
  }
  private readonly modifiedHandlers: Array<() => void> = [];
  private readonly titleHandlers: Array<() => void> = [];

  private _currentFile: string | null = null;
  private diskMtimeMs: number | null = null;
  private diskState: 'synced' | 'changed' | 'deleted' = 'synced';
  private diskChangePrompted = false;
  private fileMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private deletionCheckTimer = 0;

  constructor() {
    this.model = new GtkSource.Buffer();
    this.model.setEnableUndo(true);
    (this.model as any).on('modified-changed', () => {
      for (const callback of this.modifiedHandlers) callback();
    });
    // A model change (a forwarded view edit, or undo/redo) → mirror to every view
    // except its origin, and tell the LSP (document-level: one didChange off the
    // model, vs a shared-buffer design where every view's model would fire it).
    // Signals fire pre-mutation, so the offset / deleted text describe the pre-edit
    // state (what the delta needs).
    (this.model as any).on('insert-text', (iter: any, text: string) => {
      this.propagate('insert', iter.getOffset(), text, 0);
      this.lspDidChange([{ start: this.pointAt(iter.getOffset()), oldText: '', newText: text }]);
    });
    (this.model as any).on('delete-range', (start: any, end: any) => {
      const so = start.getOffset();
      const eo = end.getOffset();
      const oldText = (this.model as any).getText(start, end, true);
      this.propagate('delete', so, '', eo);
      this.lspDidChange([{ start: this.pointAt(so), oldText, newText: '' }]);
    });
  }

  // --- Text ------------------------------------------------------------------

  /** The canonical document text. */
  getText(): string {
    return (this.model as any).getText(this.model.getStartIter(), this.model.getEndIter(), true);
  }

  /** Text of model row `row` (no trailing newline). For the LSP line cache. */
  private lineText(row: number): string {
    const start = asIter((this.model as any).getIterAtLine(row));
    if (!start) return '';
    const end = start.copy();
    if (!end.endsLine()) end.forwardToLineEnd();
    return (this.model as any).getText(start, end, true);
  }

  private pointAt(offset: number): Point {
    const iter = iterAtOffset(this.model, offset);
    return new Point(iter.getLine(), iter.getLineOffset());
  }

  /** Replace the whole document (a file load/reload). Re-syncs every view directly
   *  and clears the modified flag. */
  setText(text: string): void {
    this.syncing = true;
    try {
      this.model.setText(text, -1);
      for (const view of this.views) {
        view.suppress = true;
        view.buffer.setText(text, -1);
        view.suppress = false;
      }
    } finally {
      this.syncing = false;
    }
    this.model.setModified(false);
  }

  isModified(): boolean {
    return this.model.getModified();
  }

  onModifiedChange(callback: () => void): void {
    this.modifiedHandlers.push(callback);
  }

  /** Sync a model edit to the language server (a bulk setText / load is covered by
   *  didOpen instead, so it's skipped). No-op for a buffer-only document (no file). */
  private lspDidChange(changes: DocumentEdit[]): void {
    if (this.syncing || !this._currentFile) return;
    quilx.lsp.didChange(this.lspDocument, changes);
  }

  // --- Views -----------------------------------------------------------------

  /** Open a new view onto this document: a per-view buffer seeded with the current
   *  text and kept in sync. Detach with `removeView` on the view's teardown. */
  createView(): SourceBuffer {
    const buffer = new GtkSource.Buffer();
    buffer.setEnableUndo(false); // the model owns undo
    buffer.setHighlightSyntax(true);
    const entry: ViewEntry = { buffer, suppress: false };

    (buffer as any).on('insert-text', (iter: any, text: string) => {
      if (!entry.suppress) this.forward(entry, 'insert', iter.getOffset(), text);
    });
    (buffer as any).on('delete-range', (start: any, end: any) => {
      if (!entry.suppress) this.forward(entry, 'delete', start.getOffset(), end.getOffset());
    });

    entry.suppress = true;
    buffer.setText(this.getText(), -1);
    buffer.setModified(false);
    entry.suppress = false;

    this.views.add(entry);
    return buffer;
  }

  removeView(buffer: SourceBuffer): void {
    for (const entry of this.views) {
      if (entry.buffer === buffer) {
        this.views.delete(entry);
        return;
      }
    }
  }

  get viewCount(): number {
    return this.views.size;
  }

  // --- Hosts (the active view's reactions) -----------------------------------

  addHost(host: DocumentHost): void {
    if (!this.hosts.includes(host)) this.hosts.push(host);
    if (!this.activeHost) this.activeHost = host;
  }
  removeHost(host: DocumentHost): void {
    const index = this.hosts.indexOf(host);
    if (index >= 0) this.hosts.splice(index, 1);
    if (this.activeHost === host) this.activeHost = this.hosts[0] ?? null;
  }
  setActiveHost(host: DocumentHost): void {
    if (this.hosts.includes(host)) this.activeHost = host;
  }

  // --- Undo (model-owned) ----------------------------------------------------

  undo(): void {
    if (this.model.canUndo) this.model.undo();
  }
  redo(): void {
    if (this.model.canRedo) this.model.redo();
  }
  canUndo(): boolean {
    return this.model.canUndo;
  }
  canRedo(): boolean {
    return this.model.canRedo;
  }
  transact(fn: () => void): void {
    this.model.beginUserAction();
    try {
      fn();
    } finally {
      this.model.endUserAction();
    }
  }

  /** Open/close a model undo group. The editor wraps an insert session (and its
   *  `transact`) in these so the forwarded view edits coalesce into one undo step on
   *  the model (the view buffers have native undo off). Matches the `UndoTarget` shape. */
  beginUserAction(): void {
    this.model.beginUserAction();
  }
  endUserAction(): void {
    this.model.endUserAction();
  }

  // --- Sync internals --------------------------------------------------------

  private forward(view: ViewEntry, kind: EditKind, offset: number, textOrEnd: string | number): void {
    this.origin = view;
    try {
      if (kind === 'insert') {
        this.model.insert(iterAtOffset(this.model, offset), textOrEnd as string, -1);
      } else {
        this.model.delete(iterAtOffset(this.model, offset), iterAtOffset(this.model, textOrEnd as number));
      }
    } finally {
      this.origin = null;
    }
  }

  private propagate(kind: EditKind, offset: number, text: string, end: number): void {
    if (this.syncing) return;
    for (const view of this.views) {
      if (view === this.origin) continue;
      view.suppress = true;
      try {
        if (kind === 'insert') {
          view.buffer.insert(iterAtOffset(view.buffer, offset), text, -1);
        } else {
          view.buffer.delete(iterAtOffset(view.buffer, offset), iterAtOffset(view.buffer, end));
        }
      } finally {
        view.suppress = false;
      }
    }
  }

  // --- Identity --------------------------------------------------------------

  get currentFile(): string | null {
    return this._currentFile;
  }
  get title(): string {
    return this._currentFile ? Path.basename(this._currentFile) : 'Untitled';
  }
  onTitleChange(callback: () => void): void {
    this.titleHandlers.push(callback);
  }
  private emitTitleChange(): void {
    for (const callback of this.titleHandlers) callback();
  }
  hasDiskChange(): boolean {
    return this.diskState !== 'synced';
  }

  /** Release shared resources (last view gone): cancel the monitor + close the LSP doc. */
  dispose(): void {
    this.fileMonitor?.cancel();
    this.fileMonitor = null;
    if (this.deletionCheckTimer) GLib.sourceRemove(this.deletionCheckTimer);
    this.deletionCheckTimer = 0;
    if (this._currentFile) quilx.lsp.didClose(this.lspDocument);
  }

  // --- File operations -------------------------------------------------------

  loadFile(path: string, opts: { silent?: boolean } = {}): void {
    try {
      // Close the old LSP doc before replacing content (a reload re-opens with the
      // new text; a first load no-ops since there's no path yet).
      if (this._currentFile) quilx.lsp.didClose(this.lspDocument);
      this.host?.willReplaceContent(!!opts.silent);
      const content = Fs.readFileSync(path, 'utf8');
      this.setText(content); // re-syncs every view + clears modified
      this._currentFile = path;
      this.diskMtimeMs = this.statMtimeMs(path);
      this.setDiskState('synced');
      this.watchFile(path);
      quilx.lsp.didOpen(this.lspDocument);
      this.host?.didLoad(content, path, !!opts.silent);
      this.emitTitleChange();
    } catch (error) {
      this.host?.toast(`Could not open ${Path.basename(path)}: ${(error as Error).message}`);
    }
  }

  save(): void {
    if (this._currentFile) this.saveAs(this._currentFile);
  }

  saveAs(path: string): void {
    const content = this.getText();
    if (path === this._currentFile && this.hasExternalChange()) {
      this.confirmOverwriteThenSave(path, content);
      return;
    }
    this.writeFile(path, content);
  }

  private statMtimeMs(path: string): number | null {
    try {
      return Fs.statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }

  private hasExternalChange(): boolean {
    if (this.diskMtimeMs === null || !this._currentFile) return false;
    const onDisk = this.statMtimeMs(this._currentFile);
    return onDisk !== null && onDisk !== this.diskMtimeMs;
  }

  private confirmOverwriteThenSave(path: string, content: string): void {
    const dialog = new Adw.AlertDialog({
      heading: 'File changed on disk',
      body:
        `${Path.basename(path)} has changed on disk since it was opened. ` +
        `Saving will overwrite those changes.`,
    });
    dialog.addResponse('cancel', 'Cancel');
    dialog.addResponse('reload', 'Reload from Disk');
    dialog.addResponse('overwrite', 'Overwrite');
    dialog.setResponseAppearance('overwrite', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.setDefaultResponse('cancel');
    dialog.setCloseResponse('cancel');
    dialog.on('response', (response: string) => {
      if (response === 'overwrite') this.writeFile(path, content);
      else if (response === 'reload') this.loadFile(path);
    });
    this.host?.presentDialog(dialog);
  }

  private writeFile(path: string, content: string): void {
    try {
      const wasDeleted = this.diskState === 'deleted';
      Fs.writeFileSync(path, content);
      this.diskMtimeMs = this.statMtimeMs(path);
      this.setDiskState('synced');
      this.model.setModified(false);
      const pathChanged = path !== this._currentFile;
      this._currentFile = path;
      if (pathChanged || wasDeleted) this.watchFile(path);
      quilx.lsp.didSave(this.lspDocument);
      this.host?.didSave(path);
      this.emitTitleChange();
      quilx.notifications.addTrace(`Saved ${Path.basename(path)}`);
    } catch (error) {
      this.host?.toast(`Could not save: ${(error as Error).message}`);
    }
  }

  // --- On-disk change detection ----------------------------------------------

  private watchFile(path: string): void {
    this.fileMonitor?.cancel();
    this.fileMonitor = null;
    try {
      const file = Gio.File.newForPath(path);
      const monitor = GioFileProto.monitorFile.call(
        file,
        Gio.FileMonitorFlags.WATCH_MOVES,
        null,
      ) as InstanceType<typeof Gio.FileMonitor>;
      monitor.on('changed', () => this.onDiskChanged());
      this.fileMonitor = monitor;
    } catch (error) {
      console.warn(`[editor] could not watch ${path}: ${(error as Error).message}`);
    }
  }

  private onDiskChanged(): void {
    if (!this._currentFile) return;
    const onDisk = this.statMtimeMs(this._currentFile);
    if (onDisk === null) {
      this.scheduleDeletionCheck();
      return;
    }
    if (this.diskMtimeMs === null || onDisk === this.diskMtimeMs) return;
    if (!this.isModified()) {
      this.loadFile(this._currentFile, { silent: true });
      return;
    }
    this.setDiskState('changed');
  }

  private scheduleDeletionCheck(): void {
    if (this.deletionCheckTimer) return;
    this.deletionCheckTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 200, () => {
      this.deletionCheckTimer = 0;
      if (this._currentFile && this.statMtimeMs(this._currentFile) === null) {
        this.setDiskState('deleted');
      } else if (this._currentFile) {
        this.onDiskChanged();
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  private setDiskState(state: 'synced' | 'changed' | 'deleted'): void {
    if (state === this.diskState) return;
    this.diskState = state;
    this.diskChangePrompted = false;
    this.emitTitleChange();
    if (state === 'synced') return;
    if (this.host?.hasFocus()) this.promptDiskChange();
  }

  promptDiskChange(): void {
    const path = this._currentFile;
    if (!path || this.diskState === 'synced' || this.diskChangePrompted) return;
    this.diskChangePrompted = true;
    const name = Path.basename(path);
    if (this.diskState === 'deleted') {
      quilx.notifications.addWarning(`${name} was deleted on disk`, {
        detail: path,
        dismissable: true,
        onDidClick: () => this.save(),
        buttons: [{ text: 'Save', onDidClick: () => this.save() }],
      });
    } else {
      quilx.notifications.addWarning(`${name} changed on disk`, {
        detail: path,
        dismissable: true,
        onDidClick: () => this.loadFile(path),
        buttons: [{ text: 'Reload', onDidClick: () => this.loadFile(path) }],
      });
    }
  }
}
