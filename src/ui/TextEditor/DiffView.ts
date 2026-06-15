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
import { TextEditor } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { revealRow } from './diffNav.ts';
import type { DiffModel } from '../../util/DiffModel.ts';

export class DiffView {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly editor: TextEditor;
  private readonly gutter: DiffGutter;
  // Hunk navigation: the unified buffer row each hunk starts on; `hunkIndex` is
  // the last-revealed hunk (-1 before any navigation).
  private readonly hunkRows: number[];
  private hunkIndex = -1;

  constructor(model: DiffModel, options: { languagePath?: string } = {}) {
    const text = model.lines.map((line) => line.text).join('\n');
    this.editor = new TextEditor({
      buffer: { readOnly: true, initialText: text, languagePath: options.languagePath },
    });
    this.root = this.editor.root;

    applyDiffDecorations(this.editor.decorations.layer('diff'), model.lines);
    this.gutter = new DiffGutter(this.editor.sourceView, model.lines);
    this.hunkRows = model.hunks.map((hunk) => hunk.startRow);
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
  }
}
