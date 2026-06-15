/*
 * Picker — a generic "quick open" overlay: a search entry over a
 * fuzzy-filtered, rank-sorted list with the matched characters highlighted.
 * Type to narrow, Up/Down (or Tab) to move, Enter to choose, Escape to dismiss.
 *
 * It renders as a floating card inside a Gtk.Overlay (supplied by the caller as
 * `host`) rather than a separate window, so it sits over the editor unobtrusively
 * and dismisses when it loses focus. It knows nothing about files; callers supply
 * the candidate strings and an `onSelect` callback. Items may arrive
 * asynchronously via the returned handle's `setItems`.
 */
import { Gdk, Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { monospaceFontCss, uiFontFamily } from '../fonts.ts';
import { fuzzyMatch } from './fuzzyMatch.ts';
import { theme } from '../theme/theme.ts';
import { frecency } from '../util/Frecency.ts';

const MONOSPACE = monospaceFontCss();
// The proportional UI font, for the opt-in `.prose-entry` (CSS doesn't resolve
// the `sans-serif` generic reliably, so a concrete family is used).
const UI_FONT = uiFontFamily();

const PICKER_WIDTH = 640;
const PICKER_MAX_HEIGHT = 360;
const MAX_RESULTS = 200;
// Color of the matched characters. Sourced from the theme's accent foreground
// (Zed's `text.accent`), with a blue fallback when the theme omits it. Baked
// into Pango markup at row-build time, so it can't be a CSS variable (and Pango
// can't gradient-fill text, so it's a solid color).
export const HIGHLIGHT_COLOR = theme.ui.textAccent ?? '#05d6d9';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// libadwaita's `.card` fill (`@card_bg_color`) is semi-transparent — meant to
// sit on a window, not float over editor content. Override it with the opaque
// popover background so the editor doesn't show through.
addStyles(`
  #Picker {
    padding: 0;
    border: 1px solid var(--border-color);
    border-radius: var(--popover-radius);
    background-color: var(--window-bg-color);
    box-shadow: 0px 10px 33px 28px rgba(0,0,0,0.15);
    ${MONOSPACE.declarations}
  }
  #PickerEntry {
    padding: 0.5em 0.5em;
    border-radius: var(--popover-radius);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* Collapse the leading search icon (it has no .left class — it's just the
     first image child) so the entry text starts at the entry's 1em padding,
     matching the row text inset below. */
  #PickerEntry > image:first-child {
    -gtk-icon-size: 0;
    min-width: 0;
    min-height: 0;
    padding: 0;
    margin: 0;
  }
  /* Opt-in sans entry (e.g. the resume picker, whose query is prose, not a path
     or identifier). Overrides the card's inherited monospace family. */
  #PickerEntry.prose-entry,
  #PickerEntry.prose-entry > text {
    font-family: "${UI_FONT}";
  }
  #PickerEntry > text {
    margin: 0;
    padding: 0;
  }
  #PickerList {
    border-radius: var(--popover-radius);
  }
  /* Drop Adwaita's built-in row padding so only the label's inset applies. */
  #PickerList row {
    padding: 0;
  }
  #PickerRow {
    padding: 0.5em 1em;
  }
  /* Two-column rows (e.g. the file picker): filename on the left, its directory
     right-aligned and muted. Highlights still show through the dimming. */
  #PickerRow > .picker-detail {
    margin-left: 1em;
    opacity: 0.5;
  }
  #PickerEmpty {
    padding: 0.5em 1em;
    opacity: 0.55;
  }
  /* The action row uses the current prompt; set it apart from the matches with a
     separator and the accent color. */
  #PickerAction {
    padding: 0.5em 1em;
    color: var(--accent-color);
  }
  #PickerList row.action-row {
    border-top: 1px solid var(--border-color);
  }
`);

/**
 * An action driven by the current prompt rather than by a listed item. When
 * supplied, a distinct row is shown (whenever the entry is non-empty) labelled
 * by `label(query)`; choosing it invokes `run(query)` with the entry's text.
 * Used e.g. by the agent picker to start a new agent from the typed prompt.
 */
export interface PickerAction {
  /** The action row's text for the current query (e.g. `Start agent: …`). */
  label: (query: string) => string;
  /** Run the action with the current query; the picker closes first. */
  run: (query: string) => void;
}

/**
 * A candidate richer than a bare string. Plain strings are still accepted and
 * normalised to `{ value, text }`; objects let a caller separate the value
 * returned on selection from the text matched against, boost matches in a
 * sub-range (e.g. a filename), and split the display into two columns.
 */
export interface PickerItem {
  /** Passed to `onSelect` when this item is chosen. */
  value: string;
  /** Text matched against the query; highlight positions index into this. */
  text: string;
  /**
   * Char offset in `text` from which matches score higher. The file picker
   * points this at the filename so filename matches outrank directory matches.
   */
  boostFrom?: number;
  /** Optional two-column display (main left, detail right-aligned and muted). */
  display?: PickerItemDisplay;
}

export interface PickerItemDisplay {
  /** Substring range `[start, end)` of `text` shown on the left, highlighted. */
  main: [number, number];
  /** Substring range `[start, end)` shown right-aligned and muted, highlighted. */
  detail: [number, number];
}

export interface PickerOptions {
  host: Overlay;
  placeholder?: string;
  items?: Array<string | PickerItem>;
  /** Initial entry text (e.g. seed an action prompt with the editor selection). */
  query?: string;
  onSelect: (value: string) => void;
  action?: PickerAction;
  /**
   * Show the `action` row only when the query matches no items (rather than
   * always, alongside matches). Used by the resume picker, which offers "start a
   * new agent with this prompt" as a fallback when nothing matches.
   */
  actionWhenEmpty?: boolean;
  /** Render the search entry in a proportional (sans) font instead of the card's
   *  monospace — for pickers whose query is prose rather than a path/identifier. */
  proseEntry?: boolean;
  /**
   * Override the markup of a (non-`display`) row, given the item and its
   * matched-char positions (into `item.text`). Return either a single markup
   * string (the row's only label) or `{ main, detail }` to add a right-aligned,
   * muted detail column. Lets a caller restyle the row — e.g. the command picker
   * mutes a command's `prefix:`, inserts a space, and right-aligns its
   * description. Positions still drive the match highlight.
   */
  formatMain?: (item: PickerItem, positions: number[]) => string | FormattedRow;
  /**
   * Enable frecency ("frequency × recency") ordering under this namespace (e.g.
   * `"file"`). When set, chosen items are recorded on selection, and a modest
   * bonus floats frequently/recently chosen ones up — both in the no-query list
   * and once a query is typed. Off by default; not every picker wants it (the
   * command palette, for one, prefers stable alphabetical ordering).
   */
  frecency?: string;
  /**
   * Lower-level escape hatch: a ranking bonus added to an item's fuzzy score and
   * used to order the no-query list. `frecency` is the usual way to get this;
   * supply `weight` directly only for a custom signal. Takes precedence over
   * `frecency`'s ordering bonus when both are set. Keep it modest (~0–1.5).
   */
  weight?: (item: PickerItem) => number;
}

/** Markup for a row's main label plus an optional right-aligned detail. */
export interface FormattedRow {
  main: string;
  detail?: string;
  /**
   * Whether the detail is dimmed (the muted `.picker-detail` look). Default true;
   * set false when the caller controls emphasis in the markup itself (e.g. the
   * command palette's bold keybinding column).
   */
  detailMuted?: boolean;
  /**
   * Dim the whole row (e.g. a command the palette shows but that isn't currently
   * applicable). Visual only — the row stays selectable; the caller's `onSelect`
   * decides what choosing it does.
   */
  dim?: boolean;
}

export interface PickerHandle {
  /** Replace the candidate list (e.g. once an async scan completes). */
  setItems(items: Array<string | PickerItem>): void;
  close(): void;
}

function normalizeItem(item: string | PickerItem): PickerItem {
  return typeof item === 'string' ? { value: item, text: item } : item;
}

export function openPicker(options: PickerOptions): PickerHandle {
  const { host, frecency: frecencyNs } = options;

  // Effective ranking bonus: an explicit `weight` wins; otherwise derive one
  // from the frecency store when a namespace is configured.
  const weight =
    options.weight ??
    (frecencyNs ? (item: PickerItem) => frecency.boost(frecencyNs, item.value) : undefined);

  const entry = new Gtk.SearchEntry({
    placeholderText: options.placeholder ?? 'Search…',
  });
  entry.setHexpand(true);
  entry.setName('PickerEntry');
  entry.addCssClass('has-text-input'); // release the `space` leader so it types
  if (options.proseEntry) entry.addCssClass('prose-entry');

  const listBox = new Gtk.ListBox();
  listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(listBox);
  scrolled.setPropagateNaturalHeight(true);
  scrolled.setMaxContentHeight(PICKER_MAX_HEIGHT);
  // Never scroll horizontally: rows ellipsize to the card's fixed width instead
  // of widening it / exposing a horizontal scrollbar for long labels.
  scrolled.setPolicy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
  scrolled.setName('PickerList');

  // A floating, opaque "card" placed at the top-centre of the overlay.
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  panel.setName('Picker');
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(48);
  panel.setSizeRequest(PICKER_WIDTH, -1);
  panel.append(entry);
  panel.append(scrolled);
  panel.overflow = Gtk.Overflow.HIDDEN;

  let items = (options.items ?? []).map(normalizeItem);
  // The currently displayed matches, parallel to the leading rows in the list
  // box, so a row can be mapped back to its item by index.
  let results: PickerItem[] = [];
  // The trailing action row, when an action is configured and the entry is
  // non-empty; checked in `choose` to run the action instead of selecting.
  let actionRow: InstanceType<typeof Gtk.ListBoxRow> | null = null;
  let closed = false;

  // Remember whatever held focus before the picker grabbed it, so that
  // dismissing without a selection returns focus there (e.g. back to the editor)
  // instead of leaving it stranded on the now-removed overlay.
  const previousFocus = host.getRoot()?.getFocus() ?? null;

  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    host.removeOverlay(panel);
    if (restoreFocus) previousFocus?.grabFocus();
  };

  const rebuild = () => {
    let child = listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      listBox.remove(child);
      child = next;
    }
    const query = entry.getText();
    const ranked = rank(query, items, weight).slice(0, MAX_RESULTS);
    results = ranked.map((match) => match.item);
    for (const match of ranked) {
      const row = new Gtk.ListBoxRow();
      row.setChild(renderRow(match.item, match.positions, options.formatMain));
      listBox.append(row);
    }

    // The prompt-driven action sits after the matches; it appears only when the
    // user has typed something for it to act on — and, when `actionWhenEmpty`,
    // only if nothing matched (so it reads as a "nothing found, do this instead").
    actionRow = null;
    if (options.action && query.length > 0 && (!options.actionWhenEmpty || results.length === 0)) {
      const label = new Gtk.Label({ xalign: 0 });
      label.setText(options.action.label(query));
      label.setName('PickerAction');
      actionRow = new Gtk.ListBoxRow();
      actionRow.setChild(label);
      actionRow.addCssClass('action-row');
      listBox.append(actionRow);
    }

    if (results.length === 0 && !actionRow) {
      // No rows to select — show a non-interactive message row instead so the
      // card doesn't collapse to just the entry.
      const label = new Gtk.Label({ xalign: 0 });
      label.setText(items.length === 0 ? 'No entries' : 'No matches');
      label.setName('PickerEmpty');
      const row = new Gtk.ListBoxRow();
      row.setChild(label);
      row.setActivatable(false);
      row.setSelectable(false);
      listBox.append(row);
      return;
    }
    const first = listBox.getRowAtIndex(0);
    if (first) listBox.selectRow(first);
  };

  const choose = (row: InstanceType<typeof Gtk.ListBoxRow> | null) => {
    const target = row ?? listBox.getSelectedRow();
    if (!target) return;
    if (target === actionRow) {
      const query = entry.getText();
      close(false);
      options.action?.run(query);
      return;
    }
    const item = results[target.getIndex()];
    if (item === undefined) return;
    if (frecencyNs) frecency.record(frecencyNs, item.value);
    close(false);
    options.onSelect(item.value);
  };

  const move = (delta: number) => {
    // Navigable rows are the matches followed by the optional action row.
    const count = results.length + (actionRow ? 1 : 0);
    if (count === 0) return;
    const selected = listBox.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + count) % count;
    const row = listBox.getRowAtIndex(next);
    if (row) listBox.selectRow(row);
  };

  entry.on('search-changed', rebuild);
  entry.on('activate', () => choose(null));
  listBox.on('row-activated', (row) => choose(row));

  // Drive list navigation from a capture-phase controller so Up/Down/Tab move
  // the selection instead of the entry's cursor or the focus chain.
  const keys = new Gtk.EventControllerKey();
  keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
  keys.on('key-pressed', (keyval: number) => {
    switch (keyval) {
      case Gdk.KEY_Escape:
        close();
        return true;
      case Gdk.KEY_Down:
      case Gdk.KEY_KP_Down:
      case Gdk.KEY_Tab:
        move(1);
        return true;
      case Gdk.KEY_Up:
      case Gdk.KEY_KP_Up:
      case Gdk.KEY_ISO_Left_Tab:
        move(-1);
        return true;
      default:
        return false;
    }
  });
  panel.addController(keys);

  // Dismiss when focus leaves the card (e.g. clicking back into the editor).
  const focus = new Gtk.EventControllerFocus();
  // focus.on('leave', () => close());
  panel.addController(focus);

  host.addOverlay(panel);
  if (options.query) entry.setText(options.query); // prefill (e.g. a seeded prompt)
  rebuild();
  entry.grabFocus();

  return {
    setItems(next: Array<string | PickerItem>) {
      items = next.map(normalizeItem);
      if (!closed) rebuild();
    },
    close,
  };
}

interface RankedItem {
  item: PickerItem;
  positions: number[];
}

function rank(
  query: string,
  items: PickerItem[],
  weight?: (item: PickerItem) => number,
): RankedItem[] {
  // No query: keep insertion order, but float weighted (frecent) items up.
  if (query.length === 0) {
    const ranked = items.map((item) => ({ item, positions: [] as number[] }));
    if (weight) ranked.sort((a, b) => weight(b.item) - weight(a.item));
    return ranked;
  }
  const scored: Array<RankedItem & { score: number }> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item.text, { boostFrom: item.boostFrom, maxTypos: 1 });
    if (match) {
      const score = match.score + (weight ? weight(item) : 0);
      scored.push({ item, positions: match.positions, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Build a row's widget for `item`, highlighting the matched `positions`. A plain
 * item renders as a single highlighted label; a two-column item (e.g. a file)
 * renders its `main` segment on the left and its `detail` segment right-aligned
 * and muted, with highlights mapped into each segment.
 */
function renderRow(
  item: PickerItem,
  positions: number[],
  formatMain?: (item: PickerItem, positions: number[]) => string | FormattedRow,
): InstanceType<typeof Gtk.Widget> {
  if (!item.display) {
    const formatted = formatMain?.(item, positions);
    const mainMarkup =
      (typeof formatted === 'string' ? formatted : formatted?.main) ??
      highlightMarkup(item.text, positions);
    const detailMarkup = typeof formatted === 'object' ? formatted.detail : undefined;

    const dim = typeof formatted === 'object' && formatted.dim === true;

    if (!detailMarkup) {
      const label = new Gtk.Label({ xalign: 0, useMarkup: true });
      label.setMarkup(mainMarkup);
      label.setName('PickerRow');
      // Crop a long label to the card width rather than widening the row.
      label.setHexpand(true);
      label.setEllipsize(Pango.EllipsizeMode.END);
      if (dim) label.setOpacity(0.4);
      return label;
    }

    // Main label on the left, a right-aligned muted detail on the right (reusing
    // the two-column `.picker-detail` styling). The main label expands and
    // ellipsizes so a long label crops to the picker width rather than pushing
    // the detail (e.g. a "5m ago" timestamp) off the edge; the detail keeps its
    // natural width so it always shows in full.
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
    box.setName('PickerRow');
    const main = new Gtk.Label({ xalign: 0, useMarkup: true });
    main.setMarkup(mainMarkup);
    main.setHexpand(true);
    main.setEllipsize(Pango.EllipsizeMode.END);
    box.append(main);
    const detail = new Gtk.Label({ xalign: 1, useMarkup: true });
    detail.setMarkup(detailMarkup);
    // Dimmed by default; an un-muted detail keeps the spacing but not the opacity
    // (the caller's markup sets its own emphasis).
    if (typeof formatted === 'object' && formatted.detailMuted === false) detail.setMarginStart(16);
    else detail.addCssClass('picker-detail');
    box.append(detail);
    if (dim) box.setOpacity(0.4);
    return box;
  }

  const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 0 });
  box.setName('PickerRow');

  // Main segment (e.g. filename) expands and ellipsizes so a long value crops to
  // the card width rather than pushing the detail off the edge; the detail keeps
  // its natural width and so always shows in full.
  const [ms, me] = item.display.main;
  const main = new Gtk.Label({ xalign: 0, useMarkup: true });
  main.setMarkup(highlightSegment(item.text, ms, me, positions));
  main.setHexpand(true);
  main.setEllipsize(Pango.EllipsizeMode.END);
  box.append(main);

  const [ds, de] = item.display.detail;
  if (de > ds) {
    const detail = new Gtk.Label({ xalign: 1, useMarkup: true });
    detail.setMarkup(highlightSegment(item.text, ds, de, positions));
    detail.setEllipsize(Pango.EllipsizeMode.END);
    detail.addCssClass('picker-detail');
    box.append(detail);
  }
  return box;
}

/** Highlight the `[start, end)` slice of `text`, with positions in `text` coords. */
function highlightSegment(text: string, start: number, end: number, positions: number[]): string {
  const local = positions.filter((p) => p >= start && p < end).map((p) => p - start);
  return highlightMarkup(text.slice(start, end), local);
}

/** Render `text` as Pango markup with the matched characters highlighted red. */
export function highlightMarkup(text: string, positions: number[]): string {
  const matched = new Set(positions);
  let out = '';
  let highlit = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i);
    if (isMatch && !highlit) {
      out += `<span foreground="${HIGHLIGHT_COLOR}" weight="bold">`;
      highlit = true;
    } else if (!isMatch && highlit) {
      out += '</span>';
      highlit = false;
    }
    out += escapeMarkup(text[i]);
  }
  if (highlit) out += '</span>';
  return out;
}

export function escapeMarkup(ch: string): string {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}
