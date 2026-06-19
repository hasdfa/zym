/*
 * MultiBufferView — Phase 1a of the multibuffer (tasks/code-editing/multibuffer.md): ONE
 * read-only editor stitching excerpts from many files, each with a filename header, each
 * highlighted by its own grammar. It IS a `TextEditor` (buffer mode, read-only) so it gets
 * vim navigation, search, selection, and decorations for free; the per-file highlighting
 * comes from an `ExcerptSyntaxProjection` the editor's painter renders through (one painter
 * on the buffer — no second highlighter, no parsing the concatenation as one language).
 *
 * Read-only snapshot: each unique source is a bare GtkSource.Buffer + its own
 * `DocumentSyntax` (the Phase-0 per-Document parse), read from disk once. Reusing a *live*
 * open Document (so an edited file re-projects) is the seam Phase 1b/2 fill.
 *
 * Navigation: the cursor row resolves through the coordinate map to `(path, row)`; Enter or
 * double-click fires `onActivate` so the caller opens the file at that line.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { TextEditor } from '../TextEditor/TextEditor.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { ViewProjection } from '../TextEditor/ViewProjection.ts';
import { ProjectionView } from '../TextEditor/ProjectionView.ts';
import { excerptsToItems, type Excerpt, type Segment } from './MultiBufferModel.ts';
import { ExcerptSyntaxProjection } from './ExcerptSyntaxProjection.ts';

/** One file's contribution: the regions (source model row spans) to show. */
export interface ExcerptInput {
  path: string;
  /** Header label; defaults to a path relative to `cwd` (or the basename). */
  label?: string;
  regions: Array<{ startRow: number; endRow: number }>;
}

export interface MultiBufferOptions {
  excerpts: ExcerptInput[];
  /** Root for relativizing header labels. */
  cwd?: string;
  /** Fired when the user activates a row (Enter / double-click) over real source. */
  onActivate?: (location: { path: string; row: number }) => void;
}

interface SourceEntry {
  buffer: SourceBuffer;
  syntax: DocumentSyntax;
  lines: string[];
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

export class MultiBufferView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly projectionView: ProjectionView;
  private readonly projection: ViewProjection;
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private disposed = false;

  constructor(options: MultiBufferOptions) {
    this.onActivate = options.onActivate;

    // Resolve each unique source once (read from disk, parse with its grammar), then back the
    // editor with a ProjectionView over those source buffers — the SAME substrate the
    // single-file editor uses. The PV materializes + would reverse-sync the view buffer; the
    // editor renders it (read-only) and the painter highlights each excerpt from its source's
    // own parse via the ExcerptSyntaxProjection over the PV's coordinate map.
    const excerpts = this.buildExcerpts(options.excerpts, options.cwd);
    const sourceBuffers = new Map([...this.sources].map(([key, entry]) => [key, entry.buffer] as const));
    this.projectionView = new ProjectionView(excerptsToItems(excerpts), sourceBuffers);
    this.projection = this.projectionView.view;
    const syntaxMap = new Map([...this.sources].map(([key, entry]) => [key, entry.syntax] as const));
    const syntaxProjection = new ExcerptSyntaxProjection(this.projection, syntaxMap);

    this.editor = new TextEditor({
      buffer: { readOnly: true, folding: false, syntaxProjection, externalBuffer: this.projectionView.buffer },
    });
    this.root = this.editor.root;
    this.installNavigation();
  }

  /** Resolve sources from disk + parse them, and turn region inputs into Excerpts. Files
   *  that can't be read are skipped; regions are clamped to the file's line count. */
  private buildExcerpts(inputs: ExcerptInput[], cwd?: string): Excerpt[] {
    const excerpts: Excerpt[] = [];
    for (const input of inputs) {
      const entry = this.ensureSource(input.path);
      if (!entry) continue;
      const lastRow = Math.max(0, entry.lines.length - 1);
      const segments: Segment[] = input.regions
        .map((r): Segment => ({
          sourceKey: input.path,
          startRow: Math.max(0, Math.min(r.startRow, lastRow)),
          endRow: Math.max(0, Math.min(r.endRow, lastRow)),
          editable: false,
          kind: 'real',
        }))
        .filter((s) => s.endRow >= s.startRow);
      if (segments.length === 0) continue;
      const label = input.label ?? (cwd ? Path.relative(cwd, input.path) : Path.basename(input.path));
      excerpts.push({ header: label, segments });
    }
    return excerpts;
  }

  /** Read + parse a source once; returns null if unreadable. */
  private ensureSource(path: string): SourceEntry | null {
    const existing = this.sources.get(path);
    if (existing) return existing;
    let text: string;
    try {
      text = Fs.readFileSync(path, 'utf8');
    } catch (error) {
      console.warn(`[multibuffer] could not read ${path}: ${(error as Error).message}`);
      return null;
    }
    const buffer = new GtkSource.Buffer();
    buffer.setText(text, -1);
    const syntax = new DocumentSyntax(buffer);
    syntax.setLanguageForPath(path); // synchronous parse (grammars are preloaded)
    const entry: SourceEntry = { buffer, syntax, lines: text.split('\n') };
    this.sources.set(path, entry);
    return entry;
  }

  /** Enter (on the focused view) + double-click activate the row under the cursor/pointer.
   *  Capture phase so Enter jumps before the vim layer treats it as a motion (this is a
   *  read-only results surface — Enter-opens is the expected quickfix UX). */
  private installNavigation(): void {
    const view = this.editor.sourceView as any;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
        this.activateRow(this.cursorRow());
        return true;
      }
      return false;
    });
    view.addController(keys);

    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return; // double-click only
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
    if (target.kind === 'source') this.onActivate?.({ path: target.sourceKey, row: target.row });
  }

  focus(): void {
    this.editor.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.projectionView.dispose(); // detach the PV's source-buffer signal handlers
    for (const entry of this.sources.values()) entry.syntax.dispose();
    this.sources.clear();
    this.editor.dispose();
  }
}
