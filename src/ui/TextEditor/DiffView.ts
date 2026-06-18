/*
 * DiffView — a unified (inline) diff pane. Given a `DiffModel`, it synthesizes a
 * read-only buffer whose lines ARE the diff (context + removed + added, in file
 * order — see tasks/code-editing/diff.md), then paints `added`/`removed` line
 * backgrounds via the editor's decoration surface and a `+`/`−` `DiffGutter`.
 *
 * Unchanged runs collapse via the editor's *diff fold method* — the same fold
 * projection + chevron gutter as code folding, with a `⋯ N unchanged lines`
 * placeholder (see SyntaxController.setDiffFolds). The vim z-fold commands
 * (zo/zc/za/zR/zM) drive them through the editor's default fold controller.
 *
 * It reuses the buffer-only `TextEditor` (read-only), so it gets vim navigation,
 * search, and the decoration/gutter plumbing for free. Construct at runtime (the
 * gutter renderer is a node-gtk vfunc subclass); the assembled widget is `root`.
 */
import type { Gtk } from '../../gi.ts';
import { TextEditor } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { DiffLineNumberGutter, oldLineLabels, newLineLabels } from './DiffLineNumberGutter.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { revealRow, changeStartRows } from './diffNav.ts';
import { foldUnchanged, diffFoldLabel, type DiffModel } from '../../util/DiffModel.ts';

export class DiffView {
  readonly root: InstanceType<typeof Gtk.Box>;
  readonly editor: TextEditor;
  private readonly gutter: DiffGutter;
  private readonly lineNumbers: DiffLineNumberGutter[];
  // Hunk navigation: the (model) row each hunk starts on; `hunkIndex` is the
  // last-revealed hunk (-1 before any navigation).
  private readonly hunkRows: number[];
  private hunkIndex = -1;

  constructor(model: DiffModel, options: { languagePath?: string } = {}) {
    // The buffer is the diff lines verbatim; unchanged runs fold (diff fold method).
    // Trailing newline so the last content line is terminated — otherwise an empty
    // last changed line has no character/newline to carry its line background.
    const text = model.lines.map((line) => line.text).join('\n') + '\n';
    this.editor = new TextEditor({
      buffer: { readOnly: true, initialText: text, languagePath: options.languagePath },
    });
    this.root = this.editor.root;

    applyDiffDecorations(this.editor.decorations.layer('diff'), model.lines);
    const viewToModel = (line: number) => this.editor.modelLineForViewLine(line);
    const view = this.editor.sourceView;
    // File line numbers as two columns (old | new), left of the +/− mark; each keys
    // by MODEL row, so a queried view line is translated through the folds.
    this.lineNumbers = [
      new DiffLineNumberGutter(view, oldLineLabels(model.lines), viewToModel, 1),
      new DiffLineNumberGutter(view, newLineLabels(model.lines), viewToModel, 2),
    ];
    this.gutter = new DiffGutter(view, model.lines, viewToModel, 3);
    // Collapse the unchanged runs through the fold projection; each marker shows its
    // git-diff-style context line (the enclosing scope), computed from the line texts.
    this.editor.setDiffFolds(
      foldUnchanged(model.lines).map((f) => ({ ...f, label: diffFoldLabel(model.lines, f.bodyStart, f.count) })),
    );
    this.hunkRows = changeStartRows(model.lines.map((line) => line.kind));
  }

  /** Focus the diff buffer (so vim nav + the fold keys act on it). */
  focus(): void {
    this.editor.focus();
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
    // hunkRows are model rows; map to the (folded) view row before scrolling.
    revealRow(this.editor.sourceView, this.editor.viewLineForModelLine(this.hunkRows[this.hunkIndex]));
  }

  dispose(): void {
    this.gutter.dispose();
    for (const gutter of this.lineNumbers) gutter.dispose();
  }
}
