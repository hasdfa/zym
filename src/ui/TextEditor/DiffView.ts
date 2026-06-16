/*
 * DiffView — a unified (inline) diff pane. Given a `DiffModel`, it synthesizes a
 * read-only buffer whose lines ARE the diff (context + removed + added, in file
 * order — see tasks/code-editing/diff.md), then paints `added`/`removed` line
 * backgrounds via the editor's decoration surface and a `+`/`−` `DiffGutter`.
 *
 * It reuses the buffer-only `TextEditor` (read-only), so it gets vim navigation,
 * search, and the decoration/gutter plumbing for free. Construct at runtime (the
 * gutter renderer is a node-gtk vfunc subclass); the assembled widget is `root`.
 */
import type { Gtk } from '../../gi.ts';
import { TextEditor, type FoldProvider } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { DiffFold } from './DiffFold.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { revealRow, changeStartRows } from './diffNav.ts';
import { foldUnchanged, type DiffModel } from '../../util/DiffModel.ts';

export class DiffView implements FoldProvider {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly editor: TextEditor;
  private readonly gutter: DiffGutter;
  private readonly fold: DiffFold;
  // Hunk navigation: the (post-fold) buffer row each hunk starts on; `hunkIndex`
  // is the last-revealed hunk (-1 before any navigation).
  private readonly hunkRows: number[];
  private hunkIndex = -1;

  constructor(model: DiffModel, options: { languagePath?: string } = {}) {
    // The buffer is the diff lines verbatim; folds collapse unchanged runs (the
    // placeholder is an inline overlay widget, not a buffer line — see DiffFold).
    const folds = foldUnchanged(model.lines);
    // Trailing newline so the last content line is terminated — otherwise an empty
    // last changed line has no character/newline to carry its line background.
    const text = model.lines.map((line) => line.text).join('\n') + '\n';
    this.editor = new TextEditor({
      buffer: { readOnly: true, initialText: text, languagePath: options.languagePath, folding: false },
    });
    this.root = this.editor.root;

    applyDiffDecorations(this.editor.decorations.layer('diff'), model.lines);
    this.gutter = new DiffGutter(this.editor.sourceView, model.lines);
    this.fold = new DiffFold(this.editor.sourceView, folds, this.editor.inlineBlocks, (index) => this.fold.toggle(index));
    // Route the vim z-fold commands (zo/zc/za/zR/zM) to the unchanged-region folds.
    this.editor.setFoldProvider(this);
    this.hunkRows = changeStartRows(model.lines.map((line) => line.kind));
  }

  // FoldProvider — the editor's `fold:*` commands drive the DiffFold.
  toggleFoldAtCursor(): void {
    const i = this.fold.regionIndexAtCursor();
    if (i !== -1) this.fold.toggle(i);
  }
  setFoldAtCursor(folded: boolean): void {
    const i = this.fold.regionIndexAtCursor();
    if (i !== -1) this.fold.setFolded(i, folded);
  }
  foldAll(): void {
    this.fold.setAll(true);
  }
  unfoldAll(): void {
    this.fold.setAll(false);
  }
  revealLine(row: number): void {
    this.fold.revealRow(row);
  }

  get hunkCount(): number {
    return this.hunkRows.length;
  }

  nextHunk(): void {
    this.gotoHunk(this.hunkIndex + 1);
  }

  prevHunk(): void {
    this.gotoHunk(this.hunkIndex - 1);
  }

  private gotoHunk(index: number): void {
    if (this.hunkRows.length === 0) return;
    const n = this.hunkRows.length;
    this.hunkIndex = ((index % n) + n) % n;
    revealRow(this.editor.sourceView, this.hunkRows[this.hunkIndex]);
  }

  dispose(): void {
    this.gutter.dispose();
    this.fold.dispose();
  }
}
