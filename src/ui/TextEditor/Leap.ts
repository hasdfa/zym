/*
 * Leap — the host side of the vim `g s` / `g S` leap motion
 * (leap.nvim-style labeled jump).
 *
 * The vim layer's `Leap` motion is fully host-driven (see motion.js): it calls
 * `focusInput({purpose:'leap'})`, which `VimState.setLeapInput` routes to this
 * controller's `start`. The flow is progressive — labels show from the *first*
 * char and refine as you type:
 *   1. read a char → append it to the search pattern → find matches in the
 *      visible range (both directions when `leapBidirectional`),
 *   2. none → resolve null; one → jump to it; many → label them and render,
 *   3. the next key either jumps (it is a shown label), pages (Space), or extends
 *      the pattern (anything else) and loops back to step 1,
 *   4. resolve the chosen match's *start* Point (and the committed pattern, for
 *      `;` repeat) to the motion, which then moves the cursor / drives the operator.
 *
 * Label-vs-narrow is disambiguated leap-style: characters that *follow* a current
 * match are excluded from the label set, so typing a real continuation narrows
 * while typing a label jumps. Labels are assigned by identity and carried across
 * narrowing, so a target keeps its letter as the search refines.
 *
 * Rendering: a match's first character is *replaced* by a mark — its label letter
 * on the current page, or a middle-dot placeholder for paged-out targets. The
 * original glyph is concealed (painted the editor background color) and a pooled
 * `Gtk.Label` is floated over the cell on a `Gtk.Fixed` overlay. While a leap is
 * active the rest of the visible text is dimmed (when `leapDimEditor`) so the
 * marks stand out. The pure target/label logic lives in `./leapTargets.ts`.
 */
import Gdk from 'gi:Gdk-4.0';
import Gtk from 'gi:Gtk-4.0';
import { addStyles } from '../../styles.ts';
import { theme } from '../../theme/theme.ts';
import { zym } from '../../zym.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';
import {
  computeLeapTargets,
  leapNextChars,
  safeLeapLabels,
  assignLeapLabels,
  resolveLeapChoice,
  pageCount,
  type LeapTarget,
} from './leapTargets.ts';

const DOT = '·'; // placeholder mark for targets paged out of the current label set

addStyles(`
  /* A mark replaces (conceals) the match's first character: a glyph with no
     background, so it reads as the character having been swapped for a label.
     Monospace family (from the font store) with its own bold weight + the
     inherited editor size, so it overlays the concealed character cleanly. */
  .zym-leap-mark { font-family: var(--t-font-monospace-family); font-weight: bold; }
  .zym-leap-label { color: var(--t-ui-status-error); }
  /* Paged-out placeholders share the label color; the dot glyph (and lighter
     weight) is what marks them as not-yet-labeled. */
  .zym-leap-dot { color: var(--t-ui-status-error); font-weight: normal; }
`);

/** Request shape handed over by the vim layer's leap motion via `setLeapInput`. */
export interface LeapRequest {
  reverse?: boolean;
  onConfirm(target: Point | null): void;
  onCancel(): void;
}

export interface LeapOptions {
  editor: EditorModel;
  /** Overlay layer the mark widgets live on (positioned in widget coords). */
  labelLayer: InstanceType<typeof Gtk.Fixed>;
  /** Read one character; resolves null on Escape / cancel. */
  readChar(): Promise<string | null>;
}

export class Leap {
  private readonly editor: EditorModel;
  private readonly labelLayer: InstanceType<typeof Gtk.Fixed>;
  private readonly readChar: () => Promise<string | null>;
  private readonly markPool: InstanceType<typeof Gtk.Label>[] = [];
  private concealTag: InstanceType<typeof Gtk.TextTag> | null = null;
  private dimTag: InstanceType<typeof Gtk.TextTag> | null = null;
  private active = false;

  constructor(options: LeapOptions) {
    this.editor = options.editor;
    this.labelLayer = options.labelLayer;
    this.readChar = options.readChar;
  }

  /** Drive one leap, resolving the chosen target (or null) to the motion. */
  async start(request: LeapRequest): Promise<void> {
    if (this.active) {
      // A leap is already in flight — refuse re-entry rather than tangle inputs.
      request.onCancel();
      return;
    }
    this.active = true;
    const bidirectional = zym.config.get('vim-mode-plus.leapBidirectional') !== false;
    const range = this.visibleRange();
    if (zym.config.get('vim-mode-plus.leapDimEditor') !== false) this.dim(range);
    try {
      const reverse = bidirectional ? false : Boolean(request.reverse);
      const cursor = this.editor.getCursorBufferPosition();

      let pattern = '';
      let matches: Range[] = [];
      let labeled: LeapTarget[] = [];
      let assigned = new Map<string, string>(); // match key → label, carried for stability
      let freeLabels = '';
      let page = 0;

      for (;;) {
        const key = await this.readChar();
        if (key === null) return request.onCancel();

        // Once labels are on screen, a key is first tried as a label / page step.
        if (matches.length > 1) {
          const pages = pageCount(matches.length, freeLabels.length);
          const choice = resolveLeapChoice(labeled, page, pages, key);
          if (choice.kind === 'page') {
            page = choice.page;
            ({ labeled, assigned } = assignLeapLabels(matches, freeLabels, page, assigned));
            this.render(labeled);
            continue;
          }
          if (choice.kind === 'jump') {
            this.teardown();
            return request.onConfirm(choice.point);
          }
          // A 'miss' falls through: treat the key as the next search char.
        }

        // Extend the pattern and re-search (labels carry over for stability).
        pattern += key;
        page = 0;
        matches = computeLeapTargets(this.editor, pattern, { reverse, cursor, range, bidirectional });
        if (matches.length <= 1) {
          this.teardown();
          return request.onConfirm(matches[0]?.start ?? null);
        }
        freeLabels = safeLeapLabels(leapNextChars(this.editor, matches));
        ({ labeled, assigned } = assignLeapLabels(matches, freeLabels, page, assigned));
        this.render(labeled);
      }
    } finally {
      this.teardown();
      this.active = false;
    }
  }

  /** The on-screen buffer range leap searches (clamped to the buffer). */
  private visibleRange(): Range {
    const lastRow = this.editor.getLastBufferRow();
    const first = Math.max(0, Math.min(this.editor.getFirstVisibleScreenRow(), lastRow));
    const last = Math.max(first, Math.min(this.editor.getLastVisibleScreenRow(), lastRow));
    // End at the start of the row after the last visible one (or the buffer end).
    const end = last >= lastRow ? this.editor.getEofBufferPosition() : new Point(last + 1, 0);
    return new Range(new Point(first, 0), end);
  }

  /** Replace each match's first character with its mark (label letter, or a
   *  middle-dot for paged-out targets). The rest of the match is left untouched. */
  private render(labeled: LeapTarget[]): void {
    this.clearMarks();
    for (let i = 0; i < labeled.length; i++) {
      const target = labeled[i];
      const isDot = target.label === '';
      this.placeMark(target.range.start, isDot ? DOT : target.label, isDot, i);
    }
  }

  /** Conceal the first character at `at` and float a mark glyph over that cell. */
  private placeMark(at: Point, glyph: string, isDot: boolean, poolIndex: number): void {
    const after = new Point(at.row, at.column + 1);
    this.buffer.applyTag(this.conceal(), this.editor.iterAtPoint(at), this.editor.iterAtPoint(after));

    const widget = this.markWidget(poolIndex);
    widget.setLabel(glyph);
    widget.removeCssClass(isDot ? 'zym-leap-label' : 'zym-leap-dot');
    widget.addCssClass(isDot ? 'zym-leap-dot' : 'zym-leap-label');
    const rect = this.editor.pixelRectForBufferPosition(at);
    if (!rect) {
      widget.setVisible(false);
      return;
    }
    widget.setSizeRequest(rect.width, rect.height);
    this.labelLayer.move(widget, rect.x, rect.y);
    widget.setVisible(true);
  }

  /** Hide every mark and un-conceal (per-render reset; leaves dimming in place). */
  private clearMarks(): void {
    if (this.concealTag) {
      const [start, end] = this.buffer.getBounds();
      this.buffer.removeTag(this.concealTag, start, end);
    }
    for (const widget of this.markPool) widget.setVisible(false);
  }

  /** Full teardown: drop marks, conceal, and the editor dimming. */
  private teardown(): void {
    this.clearMarks();
    if (this.dimTag) {
      const [start, end] = this.buffer.getBounds();
      this.buffer.removeTag(this.dimTag, start, end);
    }
  }

  /** Mute the visible text so the marks stand out (foreground only). */
  private dim(range: Range): void {
    this.buffer.applyTag(this.dimTagFor(), this.editor.iterAtPoint(range.start), this.editor.iterAtPoint(range.end));
  }

  private get buffer() {
    return this.editor.buffer;
  }

  /** A tag that mutes text by painting its foreground a dim color. Created lazily
   *  *before* the conceal tag so conceal keeps the higher priority on first chars. */
  private dimTagFor(): InstanceType<typeof Gtk.TextTag> {
    if (this.dimTag) return this.dimTag;
    const tag = new Gtk.TextTag({ name: 'leap:dim' });
    const fg = new Gdk.RGBA();
    fg.parse(theme.ui.text.muted);
    tag.foregroundRgba = fg;
    this.buffer.getTagTable().add(tag);
    this.dimTag = tag;
    return tag;
  }

  /** A tag that hides a glyph by painting it the editor background color, so the
   *  floated mark is all that shows in the cell. Created lazily, once. */
  private conceal(): InstanceType<typeof Gtk.TextTag> {
    if (this.concealTag) return this.concealTag;
    const tag = new Gtk.TextTag({ name: 'leap:conceal' });
    const bg = new Gdk.RGBA();
    bg.parse(theme.ui.editor.background);
    tag.foregroundRgba = bg;
    this.buffer.getTagTable().add(tag);
    this.concealTag = tag;
    return tag;
  }

  private markWidget(i: number): InstanceType<typeof Gtk.Label> {
    let widget = this.markPool[i];
    if (!widget) {
      widget = new Gtk.Label({ label: '' });
      widget.addCssClass('zym-leap-mark');
      widget.setCanTarget(false);
      widget.setHalign(Gtk.Align.START);
      widget.setValign(Gtk.Align.START);
      widget.setXalign(0);
      this.labelLayer.put(widget, 0, 0);
      this.markPool[i] = widget;
    }
    return widget;
  }
}
