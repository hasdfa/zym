/*
 * DiffViewer — the user-facing diff widget: a header (title + `+N −M` stats +
 * prev/next-change + a unified↔side-by-side toggle) over a stack holding the two
 * renderers (`DiffView`, `SideBySideDiffView`). This is the piece a tab/command
 * embeds; the renderers stay focused on rendering.
 */
import { Gtk } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { iconLabel } from '../icons.ts';
import { DiffView } from './DiffView.ts';
import { SideBySideDiffView } from './SideBySideDiffView.ts';
import type { DiffModel } from '../../util/DiffModel.ts';
import { theme } from '../../theme/theme.ts';

const ADDED_COLOR = theme.ui.success;
const REMOVED_COLOR = theme.ui.error;
// Nerd Font glyphs for the header controls.
const ICON_PREV = String.fromCodePoint(0xf077); // chevron-up
const ICON_NEXT = String.fromCodePoint(0xf078); // chevron-down
const ICON_UNIFIED = String.fromCodePoint(0xf039); // align-justify (stacked lines)
const ICON_SIDE_BY_SIDE = String.fromCodePoint(0xf0db); // columns

addStyles(`
  .diff-header {
    padding: 3px 8px;
    border-bottom: 1px solid var(--border-color);
  }
  .diff-header .diff-title { font-weight: bold; }
  /* Compact, flat icon buttons. */
  .diff-header button {
    min-height: 0;
    min-width: 0;
    padding: 2px 6px;
  }
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

    header.append(this.iconButton(ICON_PREV, 'Previous change', () => this.active().prevHunk()));
    header.append(this.iconButton(ICON_NEXT, 'Next change', () => this.active().nextHunk()));

    header.append(this.buildModeToggle());
    return header;
  }

  /** A compact, flat icon button. */
  private iconButton(glyph: string, tooltip: string, onClick: () => void): InstanceType<typeof Gtk.Button> {
    const button = new Gtk.Button();
    button.setChild(iconLabel(glyph));
    button.addCssClass('flat');
    button.setTooltipText(tooltip);
    button.on('clicked', onClick);
    return button;
  }

  /** A linked, icon-only unified↔side-by-side toggle (kept in sync with the stack). */
  private buildModeToggle(): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    box.addCssClass('linked');

    const unified = new Gtk.ToggleButton();
    unified.setChild(iconLabel(ICON_UNIFIED));
    unified.setTooltipText('Unified');
    unified.setActive(true);

    const sideBySide = new Gtk.ToggleButton();
    sideBySide.setChild(iconLabel(ICON_SIDE_BY_SIDE));
    sideBySide.setTooltipText('Side by side');
    sideBySide.setGroup(unified); // mutually exclusive

    unified.on('toggled', () => {
      if (unified.getActive()) this.stack.setVisibleChildName('unified');
    });
    sideBySide.on('toggled', () => {
      if (sideBySide.getActive()) this.stack.setVisibleChildName('sbs');
    });

    box.append(unified);
    box.append(sideBySide);
    return box;
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
