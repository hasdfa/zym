/*
 * MultiBufferView — Phase 1a of the multibuffer (tasks/code-editing/multibuffer.md): ONE
 * read-only GtkSourceView stitching excerpts from many files, each with a filename header,
 * each highlighted by its own grammar. The validation vehicle for the excerpt coordinate
 * map + the multi-source syntax projection before the diff/editable phases build on it.
 *
 * Read-only snapshot: each unique source is a bare GtkSource.Buffer + its own
 * `DocumentSyntax` (the Phase-0 per-Document parse), so the file's grammar paints its
 * excerpt. Reusing a *live* open Document (so an edited file re-projects) is the seam
 * Phase 1b/2 fill — here a source is read from disk once.
 *
 * Navigation: the cursor row resolves through the coordinate map to a `(path, row)`; Enter
 * or double-click fires `onActivate` so the caller opens the file at that line.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { MultiBufferProjection, type Excerpt, type Segment } from './MultiBufferModel.ts';
import { MultiBufferSyntax } from './MultiBufferSyntax.ts';

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
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;
  readonly view: InstanceType<typeof GtkSource.View>;
  private readonly buffer: SourceBuffer;
  private readonly projector: MultiBufferSyntax;
  private readonly sources = new Map<string, SourceEntry>();
  private projection: MultiBufferProjection;
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private disposed = false;

  constructor(options: MultiBufferOptions) {
    this.onActivate = options.onActivate;

    this.buffer = new GtkSource.Buffer();
    this.buffer.setHighlightSyntax(false); // the projector owns highlighting
    this.view = new GtkSource.View({ buffer: this.buffer });
    this.view.setEditable(false);
    this.view.setMonospace(true);
    this.view.setName('MultiBufferView');
    (this.view as any).setShowLineNumbers?.(false);

    this.projector = new MultiBufferSyntax(this.view, this.buffer);

    // Resolve each unique source once (read from disk, parse with its grammar), then build
    // the projection text + coordinate map and paint it.
    const excerpts = this.buildExcerpts(options.excerpts, options.cwd);
    this.projection = MultiBufferProjection.build(excerpts, (seg) => this.resolveLines(seg));
    this.buffer.setText(this.projection.text, -1);
    this.repaint();

    this.installNavigation();

    this.root = new Gtk.ScrolledWindow();
    this.root.setHexpand(true);
    this.root.setVexpand(true);
    this.root.setChild(this.view);
  }

  /** Resolve sources from disk + parse them, and turn region inputs into Excerpts. Files
   *  that can't be read are skipped (logged); regions are clamped to the file's line count. */
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

  private resolveLines(segment: Segment): string[] {
    const entry = this.sources.get(segment.sourceKey);
    if (!entry) return [];
    return entry.lines.slice(segment.startRow, segment.endRow + 1);
  }

  private repaint(): void {
    const sources = new Map<string, DocumentSyntax>();
    for (const [key, entry] of this.sources) sources.set(key, entry.syntax);
    this.projector.paint(this.projection, sources);
  }

  /** Enter (on the focused view) + double-click activate the row under the cursor/pointer. */
  private installNavigation(): void {
    const keys = new Gtk.EventControllerKey();
    keys.on('key-pressed', (keyval: number) => {
      if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
        this.activateRow(this.cursorRow());
        return true;
      }
      return false;
    });
    this.view.addController(keys);

    const click = new Gtk.GestureClick();
    click.on('pressed', (nPress: number, x: number, y: number) => {
      if (nPress < 2) return; // double-click only
      const by = (this.view as any).windowToBufferCoords(Gtk.TextWindowType.TEXT, x, y);
      const yBuf = Array.isArray(by) ? by[by.length - 1] : y;
      const r = (this.view as any).getLineAtY(yBuf);
      this.activateRow(asIter(Array.isArray(r) ? r[0] : r).getLine());
    });
    this.view.addController(click);
  }

  private cursorRow(): number {
    const buffer = this.buffer as any;
    return asIter(buffer.getIterAtMark(buffer.getInsert())).getLine();
  }

  private activateRow(viewRow: number): void {
    const loc = this.projection.sourceAt(viewRow);
    if (loc) this.onActivate?.({ path: loc.sourceKey, row: loc.sourceRow });
  }

  /** Re-apply token colors on a system light/dark change. */
  restyle(): void {
    this.projector.restyle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.sources.values()) entry.syntax.dispose();
    this.sources.clear();
  }
}
