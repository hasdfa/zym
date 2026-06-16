/*
 * SideBySideDiffView — a two-column (old | new) diff pane. From a `DiffModel`,
 * `splitSides` produces two line-aligned, equally-tall line arrays (each changed
 * row paired, the shorter side padded with blank fillers). Each side is a
 * read-only buffer pane with its own line backgrounds (`removed`/`added`/`filler`)
 * and a `+`/`−` gutter; the two views' vertical scroll is hard-locked.
 *
 * Equal line counts + no wrapping mean row N sits at the same pixel y on both
 * sides, so scroll-sync is a value copy. Built at runtime (vfunc gutter); the
 * assembled widget is `root`. See tasks/code-editing/diff.md.
 */
import { Gtk, type SourceView } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { TextEditor, type FoldProvider } from './TextEditor.ts';
import { DiffGutter } from './DiffGutter.ts';
import { DiffFold } from './DiffFold.ts';
import { applyDiffDecorations } from './applyDiffDecorations.ts';
import { revealRow, changeStartRows } from './diffNav.ts';
import { splitSides, foldUnchanged, type DiffModel, type SideLine } from '../../util/DiffModel.ts';

// `Tab` switches focus between the two panes — registered once (selector-scoped to
// this widget's descendant views); each instance registers the command handler.
// With two panes, Tab alone toggles, so no Shift-Tab is needed.
let diffKeymapsRegistered = false;
function registerDiffKeymapsOnce(): void {
  if (diffKeymapsRegistered) return;
  diffKeymapsRegistered = true;
  quilx.keymaps.add('diff-view', {
    '#SideBySideDiff #TextEditor': { tab: 'diff:focus-other-pane' },
  });
}

export class SideBySideDiffView implements FoldProvider {
  readonly root: InstanceType<typeof Gtk.Paned>;
  private readonly left: TextEditor;
  private readonly right: TextEditor;
  private readonly gutters: DiffGutter[];
  private readonly folds: DiffFold[];
  // Hunk navigation: padded-buffer rows where each changed region starts (left and
  // right are aligned, so the same row applies to both). `hunkIndex` last revealed.
  private readonly hunkRows: number[];
  private hunkIndex = -1;

  constructor(model: DiffModel, options: { languagePath?: string } = {}) {
    const { left, right } = splitSides(model);
    // The two sides have context (and therefore fold) rows at identical indices,
    // so the plans match index-for-index — fold them in lockstep to stay aligned.
    const leftFolds = foldUnchanged(left);
    const rightFolds = foldUnchanged(right);
    this.left = makePane(left, options.languagePath);
    this.right = makePane(right, options.languagePath);
    this.gutters = [
      new DiffGutter(this.left.sourceView, left),
      new DiffGutter(this.right.sourceView, right),
    ];
    const toggleBoth = (index: number) => {
      this.folds[0].toggle(index);
      this.folds[1].toggle(index);
    };
    this.folds = [
      new DiffFold(this.left.sourceView, leftFolds, this.left.inlineBlocks, toggleBoth),
      new DiffFold(this.right.sourceView, rightFolds, this.right.inlineBlocks, toggleBoth),
    ];
    // Vim z-fold commands route here from whichever pane is focused and apply to
    // both panes (their folds share indices), keeping the two sides aligned.
    this.left.setFoldProvider(this);
    this.right.setFoldProvider(this);
    this.hunkRows = changeStartRows(left.map((line) => line.kind));

    syncScroll(this.left.sourceView, this.right.sourceView);

    this.root = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('SideBySideDiff'); // the keymap selector targets its views
    this.root.setStartChild(this.left.root);
    this.root.setEndChild(this.right.root);
    this.root.setResizeStartChild(true);
    this.root.setResizeEndChild(true);
    this.root.setWideHandle(true);

    // `Tab` switches focus between the panes — via the command/keymap system, not a
    // raw controller, so it stays consistent with the rest of the app's bindings.
    quilx.commands.add(this.root, { 'diff:focus-other-pane': () => this.toggleFocus() });
    registerDiffKeymapsOnce();
  }

  /** Move focus to the other pane (defaults to the left when neither has it). */
  private toggleFocus(): void {
    const target = (this.right.sourceView as any).hasFocus?.() ? this.left : this.right;
    target.focus();
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
    // Reveal on the left; the scroll-sync carries the right pane along.
    revealRow(this.left.sourceView, this.hunkRows[this.hunkIndex]);
  }

  // FoldProvider — fold commands from either pane apply to both (indices match).
  private cursorIndex(): number {
    // Use the focused pane's cursor; rows are aligned, so the index applies to both.
    const fold = this.folds[1].viewHasFocus() ? this.folds[1] : this.folds[0];
    return fold.regionIndexAtCursor();
  }
  toggleFoldAtCursor(): void {
    const i = this.cursorIndex();
    if (i !== -1) for (const fold of this.folds) fold.toggle(i);
  }
  setFoldAtCursor(folded: boolean): void {
    const i = this.cursorIndex();
    if (i !== -1) for (const fold of this.folds) fold.setFolded(i, folded);
  }
  foldAll(): void {
    for (const fold of this.folds) fold.setAll(true);
  }
  unfoldAll(): void {
    for (const fold of this.folds) fold.setAll(false);
  }
  revealLine(row: number): void {
    for (const fold of this.folds) fold.revealRow(row);
  }

  dispose(): void {
    for (const gutter of this.gutters) gutter.dispose();
    for (const fold of this.folds) fold.dispose();
  }
}

/** A read-only pane for one side, with per-line diff backgrounds applied. */
function makePane(lines: SideLine[], languagePath?: string): TextEditor {
  // Trailing newline terminates the last line so an empty last row can still carry
  // its line background (and both panes stay equal-height for scroll-sync).
  const editor = new TextEditor({
    buffer: { readOnly: true, initialText: lines.map((l) => l.text).join('\n') + '\n', languagePath, folding: false },
  });
  applyDiffDecorations(editor.decorations.layer('diff'), lines);
  return editor;
}

/** Hard-lock the two views' vertical scroll (value copy, reentrancy-guarded). */
function syncScroll(a: SourceView, b: SourceView): void {
  const adjA = (a as any).getVadjustment?.();
  const adjB = (b as any).getVadjustment?.();
  if (!adjA || !adjB) return;
  let syncing = false;
  const link = (from: any, to: any) =>
    from.on('value-changed', () => {
      if (syncing) return;
      syncing = true;
      to.setValue(from.getValue());
      syncing = false;
    });
  link(adjA, adjB);
  link(adjB, adjA);
}
