/*
 * DiffMultiBufferView — a CONTINUOUS, read-only multi-file diff in one scrollable editor
 * (tasks/code-editing/multibuffer.md, Phase 3b / G5). Each changed file is a filename header
 * then its diff windowed like a real diff (changed hunks + context, long unchanged runs elided
 * to a `⋯` gap; see `buildDiffMultiBuffer`): context + added rows over the NEW side, removed
 * rows over the OLD/HEAD blob, all stitched into one `ViewProjection`. Per-side syntax
 * highlighting (`ExcerptSyntaxProjection`), added/removed backgrounds (`applyDiffDecorations`),
 * old|new line gutters, and Enter/double-click → jump to the file.
 *
 * Read-only: the EDITABLE diff (write-through to live Documents + cross-source undo) is built
 * at the substrate level (ProjectionView write-through / undo, proven in diffEditable.test.ts)
 * but not wired into this surface yet — editing a continuous diff smoothly needs INCREMENTAL
 * re-segmentation (splice only the edited file's rows + preserve cursor/decorations); the
 * whole-buffer re-materialize shortcut flashes + disrupts the caret on every line add/remove,
 * and bulletproof per-row edit gating. That's a dedicated follow-up; this ships the solid
 * read-only surface.
 */
import { Gdk, Gtk, GtkSource, type SourceBuffer } from '../../gi.ts';
import { TextEditor } from '../TextEditor/TextEditor.ts';
import { DocumentSyntax } from '../../syntax/DocumentSyntax.ts';
import { ProjectionView } from '../TextEditor/ProjectionView.ts';
import { ViewProjection } from '../TextEditor/ViewProjection.ts';
import { ExcerptSyntaxProjection } from './ExcerptSyntaxProjection.ts';
import { applyDiffDecorations } from '../TextEditor/applyDiffDecorations.ts';
import { DiffLineNumberGutter } from '../TextEditor/DiffLineNumberGutter.ts';
import { buildDiffMultiBuffer, type DiffFile } from './diffMultiBuffer.ts';

export interface DiffMultiBufferOptions {
  /** Changed files: base (old/HEAD) + current (new/working) content. */
  files: DiffFile[];
  cwd?: string;
  onActivate?: (location: { path: string; row: number }) => void;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

/** Right-align line numbers (blank for null) into an equal-width gutter column. */
function lineLabels(nums: readonly (number | null)[]): string[] {
  let width = 1;
  for (const n of nums) if (n !== null) width = Math.max(width, String(n).length);
  return nums.map((n) => (n === null ? '' : String(n).padStart(width)));
}

interface SourceEntry {
  buffer: SourceBuffer;
  syntax: DocumentSyntax;
}

export class DiffMultiBufferView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly projectionView: ProjectionView;
  private readonly lineNumbers: DiffLineNumberGutter[] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private disposed = false;

  private get projection(): ViewProjection {
    return this.projectionView.view;
  }

  constructor(options: DiffMultiBufferOptions) {
    this.onActivate = options.onActivate;
    const dmb = buildDiffMultiBuffer(options.files, options.cwd);

    // One bare buffer + parse per source side (new:/old: per file), each highlighted by its
    // path's grammar — so old and new each get correct, independent highlighting.
    const sourceBuffers = new Map<string, SourceBuffer>();
    const syntaxMap = new Map<string, DocumentSyntax>();
    for (const [key, lines] of dmb.sources) {
      const buffer = new GtkSource.Buffer();
      buffer.setText(lines.join('\n'), -1);
      const syntax = new DocumentSyntax(buffer);
      syntax.setLanguageForPath(dmb.language.get(key)!);
      this.sources.set(key, { buffer, syntax });
      sourceBuffers.set(key, buffer);
      syntaxMap.set(key, syntax);
    }

    this.projectionView = new ProjectionView(dmb.items, sourceBuffers);
    this.editor = new TextEditor({
      buffer: {
        readOnly: true,
        folding: false,
        syntaxProjection: new ExcerptSyntaxProjection(() => this.projection, syntaxMap),
        externalBuffer: this.projectionView.buffer,
      },
    });
    this.root = this.editor.root;

    // Added/removed line backgrounds from the per-row diff kinds (header/blank/gap/context get
    // none). The view buffer's last line is unterminated, so decorations span its content.
    const buffer = this.projectionView.buffer as any;
    const lines = dmb.rowKinds.map((kind, row) => ({
      kind: kind === 'added' || kind === 'removed' ? kind : 'context',
      text: this.lineText(buffer, row),
    }));
    applyDiffDecorations(this.editor.decorations.layer('diff'), lines, /* terminated */ false);

    // Two file-line-number gutters (old | new); no folds, so view == model.
    const view = this.editor.sourceView;
    this.lineNumbers = [
      new DiffLineNumberGutter(view, lineLabels(dmb.oldNums), undefined, 1),
      new DiffLineNumberGutter(view, lineLabels(dmb.newNums), undefined, 2),
    ];

    this.installNavigation();
    // Materializing the buffer (setText) leaves the caret at the END; start at the top.
    this.editor.model.setCursorBufferPosition({ row: 0, column: 0 });
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
      if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
        this.activateRow(this.cursorRow());
        return true;
      }
      return false;
    });
    view.addController(keys);

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

  focus(): void {
    this.editor.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const gutter of this.lineNumbers) gutter.dispose();
    this.projectionView.dispose();
    for (const entry of this.sources.values()) entry.syntax.dispose();
    this.sources.clear();
    this.editor.dispose();
  }
}
