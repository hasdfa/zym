/*
 * DiffMultiBufferView — a CONTINUOUS multi-file diff in one scrollable, read-only editor
 * (tasks/code-editing/multibuffer.md, Phase 3b / G5). Each changed file is a filename header
 * followed by its diff (context + added rows over the new side, removed rows as read-only
 * phantoms over the old/HEAD blob), all stitched into one `ViewProjection` — the same
 * substrate the single-file editor and search multibuffer run on. Added/removed line
 * backgrounds come from `applyDiffDecorations`; per-file/per-side highlighting from each
 * source's own grammar via `ExcerptSyntaxProjection`.
 *
 * Read-only for now (the editable diff — new-side write-through to live Documents + cross-
 * source undo — is the next step; the substrate already supports it). It IS a `TextEditor`
 * (buffer mode, read-only) so it gets vim navigation + search + decorations for free.
 * fold-unchanged + the old|new line gutters are follow-ups.
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

/** Right-align line numbers (blank for null) into an equal-width gutter column. */
function lineLabels(nums: readonly (number | null)[]): string[] {
  let width = 1;
  for (const n of nums) if (n !== null) width = Math.max(width, String(n).length);
  return nums.map((n) => (n === null ? '' : String(n).padStart(width)));
}

export interface DiffMultiBufferOptions {
  /** Changed files with their resolved base (old/HEAD) + current (new/working) content. */
  files: DiffFile[];
  /** Root for relativizing header labels. */
  cwd?: string;
  /** Fired when the user activates a row (Enter / double-click) over real source. */
  onActivate?: (location: { path: string; row: number }) => void;
}

const asIter = (r: any): any => (Array.isArray(r) ? r[r.length - 1] : r);

interface SourceEntry {
  buffer: SourceBuffer;
  syntax: DocumentSyntax;
}

export class DiffMultiBufferView {
  readonly root: InstanceType<typeof Gtk.Widget>;
  readonly editor: TextEditor;
  private readonly sources = new Map<string, SourceEntry>();
  private readonly projectionView: ProjectionView;
  private readonly projection: ViewProjection;
  private readonly lineNumbers: DiffLineNumberGutter[] = [];
  private readonly onActivate?: (location: { path: string; row: number }) => void;
  private disposed = false;

  constructor(options: DiffMultiBufferOptions) {
    this.onActivate = options.onActivate;
    const dmb = buildDiffMultiBuffer(options.files, options.cwd);

    // One bare buffer + parse per source side (new:/old: per file), highlighted by its path's
    // grammar — so the old and new sides each get correct, independent highlighting.
    const sourceBuffers = new Map<string, SourceBuffer>();
    for (const [key, lines] of dmb.sources) {
      const buffer = new GtkSource.Buffer();
      buffer.setText(lines.join('\n'), -1);
      const syntax = new DocumentSyntax(buffer);
      syntax.setLanguageForPath(dmb.language.get(key)!);
      this.sources.set(key, { buffer, syntax });
      sourceBuffers.set(key, buffer);
    }

    this.projectionView = new ProjectionView(dmb.items, sourceBuffers);
    this.projection = this.projectionView.view;
    const syntaxMap = new Map([...this.sources].map(([key, entry]) => [key, entry.syntax] as const));
    this.editor = new TextEditor({
      buffer: {
        readOnly: true,
        folding: false,
        syntaxProjection: new ExcerptSyntaxProjection(this.projection, syntaxMap),
        externalBuffer: this.projectionView.buffer,
      },
    });
    this.root = this.editor.root;

    this.applyDecorations(dmb.rowKinds);
    // Two file-line-number gutters (old | new); no folds in the multibuffer, so view==model.
    const view = this.editor.sourceView;
    this.lineNumbers = [
      new DiffLineNumberGutter(view, lineLabels(dmb.oldNums), undefined, 1),
      new DiffLineNumberGutter(view, lineLabels(dmb.newNums), undefined, 2),
    ];
    this.installNavigation();
  }

  /** Paint added/removed line backgrounds from the per-row diff kinds. Header / blank / context
   *  rows get no background (treated as `context`). The view buffer's last line is unterminated
   *  (the projection joins rows without a trailing newline), so decorations span its content. */
  private applyDecorations(rowKinds: ReturnType<typeof buildDiffMultiBuffer>['rowKinds']): void {
    const buffer = this.projectionView.buffer as any;
    const lines = rowKinds.map((kind, row) => ({
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

  /** Enter / double-click jumps to the file + line under the cursor/pointer (new side when
   *  available; a removed row jumps to the same line in the file). */
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
    // Source keys are `new:<path>` / `old:<path>`; jump to the underlying file at that row.
    const sep = target.sourceKey.indexOf(':');
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
