/*
 * DiffViewer — the user-facing diff widget: a header (title + `+N −M` stats +
 * prev/next-change + a unified↔side-by-side toggle) over a stack holding the two
 * renderers (`DiffView`, `SideBySideDiffView`). This is the piece a tab/command
 * embeds; the renderers stay focused on rendering.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { DiffView } from './DiffView.ts';
import { SideBySideDiffView } from './SideBySideDiffView.ts';
import type { DiffModel } from '../../util/DiffModel.ts';

const ADDED_COLOR = '#2ec27e';
const REMOVED_COLOR = '#e01b24';

addStyles(`
  .diff-header {
    padding: 4px 8px;
    border-bottom: 1px solid var(--border-color);
  }
  .diff-header .diff-title { font-weight: bold; }
`);

interface DiffViewerOptions {
  /** Shown at the left of the header (e.g. the file path). */
  title?: string;
  /** A file path/name selecting the grammar for syntax highlighting in the panes. */
  languagePath?: string;
}

export class DiffViewer {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly unified: DiffView;
  private readonly sideBySide: SideBySideDiffView;
  private readonly stack: InstanceType<typeof Gtk.Stack>;

  constructor(model: DiffModel, options: DiffViewerOptions = {}) {
    this.unified = new DiffView(model, { languagePath: options.languagePath });
    this.sideBySide = new SideBySideDiffView(model, { languagePath: options.languagePath });

    this.stack = new Gtk.Stack();
    this.stack.setVexpand(true);
    this.stack.setHexpand(true);
    this.stack.addTitled(this.unified.root, 'unified', 'Unified');
    this.stack.addTitled(this.sideBySide.root, 'sbs', 'Side by side');

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.append(this.buildHeader(model, options));
    this.root.append(this.stack);
  }

  private buildHeader(model: DiffModel, options: DiffViewerOptions): InstanceType<typeof Gtk.Box> {
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    header.addCssClass('diff-header');

    const title = new Gtk.Label({ label: options.title ?? 'Diff', xalign: 0 });
    title.addCssClass('diff-title');
    header.append(title);

    const stats = new Gtk.Label({ useMarkup: true });
    stats.setMarkup(
      `<span foreground="${ADDED_COLOR}">+${model.stats.added}</span>  ` +
        `<span foreground="${REMOVED_COLOR}">−${model.stats.removed}</span>`,
    );
    header.append(stats);

    const spacer = new Gtk.Box();
    spacer.setHexpand(true);
    header.append(spacer);

    const prev = new Gtk.Button({ label: '↑' });
    prev.setTooltipText('Previous change');
    prev.on('clicked', () => this.active().prevHunk());
    const next = new Gtk.Button({ label: '↓' });
    next.setTooltipText('Next change');
    next.on('clicked', () => this.active().nextHunk());
    header.append(prev);
    header.append(next);

    const switcher = new Gtk.StackSwitcher();
    switcher.setStack(this.stack);
    header.append(switcher);

    return header;
  }

  /** The renderer currently shown (drives prev/next-change). */
  private active(): { nextHunk(): void; prevHunk(): void } {
    return this.stack.getVisibleChildName() === 'sbs' ? this.sideBySide : this.unified;
  }

  dispose(): void {
    this.unified.dispose();
    this.sideBySide.dispose();
  }
}
