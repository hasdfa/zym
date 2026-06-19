/*
 * DiffViewer — the user-facing diff widget: a header (title + `+N −M` stats +
 * prev/next-change + a unified↔side-by-side toggle) over a content box holding the
 * *active* renderer (`DiffView` or `SideBySideDiffView`). This is the piece a
 * tab/command embeds; the renderers stay focused on rendering.
 *
 * Only the active renderer is built — each one synthesizes read-only buffers and
 * installs gutter vfuncs, so building both up front (and keeping the hidden one
 * alive) is wasted work. The toggle destroys the current renderer and builds the
 * other; the embedder's height tracks the single live pane for free.
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
  /** Show the top bar (title + stats + change-nav + mode toggle). Default true;
   *  embedders that supply their own chrome (e.g. the inline staging diff) pass false. */
  header?: boolean;
}

type DiffMode = 'unified' | 'sbs';

/** Both renderers expose the same surface to the viewer chrome. */
interface DiffRenderer {
  readonly root: InstanceType<typeof Gtk.Widget>;
  focus(): void;
  nextHunk(): void;
  prevHunk(): void;
  dispose(): void;
}

export class DiffViewer {
  readonly root: InstanceType<typeof Gtk.Box>;
  private readonly model: DiffModel;
  private readonly options: DiffViewerOptions;
  // The content box holds exactly one (the active) renderer; switching mode swaps it.
  private readonly content: InstanceType<typeof Gtk.Box>;
  private mode: DiffMode = 'unified';
  private current: DiffRenderer;

  constructor(model: DiffModel, options: DiffViewerOptions = {}) {
    this.model = model;
    this.options = options;

    this.content = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.content.setVexpand(true);
    this.content.setHexpand(true);
    // Build only the active renderer; the box sizes to it, so an inline (height-
    // bounded) embedder never pays for the taller side-by-side pane while unified shows.
    this.current = this.buildRenderer(this.mode);
    this.content.append(this.current.root);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    if (options.header !== false) this.root.append(this.buildHeader(model, options));
    this.root.append(this.content);
  }

  /** Construct the renderer for `mode` (each is built lazily, on first show). */
  private buildRenderer(mode: DiffMode): DiffRenderer {
    return mode === 'sbs'
      ? new SideBySideDiffView(this.model, { languagePath: this.options.languagePath })
      : new DiffView(this.model, { languagePath: this.options.languagePath });
  }

  /** Switch presentation: destroy the live renderer and build the other. */
  private setMode(mode: DiffMode): void {
    if (mode === this.mode) return;
    this.content.remove(this.current.root);
    this.current.dispose();
    this.mode = mode;
    this.current = this.buildRenderer(mode);
    this.content.append(this.current.root);
    this.current.focus(); // the old pane (which may have held focus) is gone
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

    header.append(this.iconButton(ICON_PREV, 'Previous change', () => this.current.prevHunk()));
    header.append(this.iconButton(ICON_NEXT, 'Next change', () => this.current.nextHunk()));

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
      if (unified.getActive()) this.setMode('unified');
    });
    sideBySide.on('toggled', () => {
      if (sideBySide.getActive()) this.setMode('sbs');
    });

    box.append(unified);
    box.append(sideBySide);
    return box;
  }

  /** Focus the visible diff pane (so vim nav + fold keys act on it). */
  focus(): void {
    this.current.focus();
  }

  dispose(): void {
    this.current.dispose();
  }
}
