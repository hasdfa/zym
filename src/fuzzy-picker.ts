/*
 * FuzzyPicker — a generic, chromeless modal "quick open" overlay: a search
 * entry over a fuzzy-filtered, rank-sorted list with the matched characters
 * highlighted. Type to narrow, Up/Down (or Tab) to move, Enter to choose,
 * Escape to dismiss.
 *
 * It knows nothing about files; callers supply the candidate strings and an
 * `onSelect` callback. Items may arrive asynchronously via the returned
 * handle's `setItems` (the file picker collects its list in the background).
 */
import { Gdk, Gtk, type ApplicationWindow } from './gi.ts';

const PICKER_WIDTH = 640;
const PICKER_HEIGHT = 420;
const MAX_RESULTS = 200;

export interface FuzzyPickerOptions {
  parent: ApplicationWindow;
  title?: string;
  placeholder?: string;
  items?: string[];
  onSelect: (item: string) => void;
}

export interface FuzzyPickerHandle {
  /** Replace the candidate list (e.g. once an async scan completes). */
  setItems(items: string[]): void;
  close(): void;
}

export function openFuzzyPicker(options: FuzzyPickerOptions): FuzzyPickerHandle {
  // Chromeless: no header bar, no close button — Escape dismisses it.
  const window = new Gtk.Window();
  window.setTitle(options.title ?? 'Pick');
  window.setDecorated(false);
  window.setModal(true);
  window.setTransientFor(options.parent);
  window.setDefaultSize(PICKER_WIDTH, PICKER_HEIGHT);

  const entry = new Gtk.SearchEntry({ placeholderText: options.placeholder ?? 'Search…' });
  entry.setHexpand(true);

  const listBox = new Gtk.ListBox();
  listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);

  const scrolled = new Gtk.ScrolledWindow();
  scrolled.setChild(listBox);
  scrolled.setVexpand(true);

  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  box.setMarginTop(6);
  box.setMarginBottom(6);
  box.setMarginStart(6);
  box.setMarginEnd(6);
  box.append(entry);
  box.append(scrolled);
  window.setChild(box);

  let items = options.items ?? [];
  // The currently displayed matches, parallel to the rows in the list box, so a
  // row can be mapped back to its item by index.
  let results: string[] = [];

  const rebuild = () => {
    let child = listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      listBox.remove(child);
      child = next;
    }
    const ranked = rank(entry.getText(), items).slice(0, MAX_RESULTS);
    results = ranked.map((match) => match.item);
    for (const match of ranked) {
      const label = new Gtk.Label({ xalign: 0, useMarkup: true });
      label.setMarkup(highlightMarkup(match.item, match.positions));
      label.setMarginTop(2);
      label.setMarginBottom(2);
      label.setMarginStart(6);
      label.setMarginEnd(6);
      const row = new Gtk.ListBoxRow();
      row.setChild(label);
      listBox.append(row);
    }
    const first = listBox.getRowAtIndex(0);
    if (first) listBox.selectRow(first);
  };

  const choose = (row: InstanceType<typeof Gtk.ListBoxRow> | null) => {
    const target = row ?? listBox.getSelectedRow();
    if (!target) return;
    const item = results[target.getIndex()];
    if (item === undefined) return;
    window.close();
    options.onSelect(item);
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    const selected = listBox.getSelectedRow();
    const current = selected ? selected.getIndex() : -1;
    const next = (current + delta + results.length) % results.length;
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
        window.close();
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
  window.addController(keys);

  rebuild();
  window.present();
  entry.grabFocus();

  return {
    setItems(next: string[]) {
      items = next;
      rebuild();
    },
    close() {
      window.close();
    },
  };
}

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices in the text that the query matched, in order. */
  positions: number[];
}

/**
 * Score `text` against `query` as a fuzzy (subsequence) match, recording which
 * characters matched. Returns `null` when `query` is not a subsequence of
 * `text`. An empty query matches everything with a neutral score.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (query.length === 0) return { score: 0, positions: [] };
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of needle) {
    let pos = -1;
    for (let j = from; j < haystack.length; j++) {
      if (haystack[j] === ch) { pos = j; break; }
    }
    if (pos === -1) return null;

    if (pos === previous + 1) score += 8;                  // consecutive run
    if (pos === 0 || isBoundary(text, pos)) score += 12;   // word / path boundary
    score -= pos - from;                                   // penalise skipped chars
    positions.push(pos);
    previous = pos;
    from = pos + 1;
  }
  return { score: score - text.length * 0.05, positions }; // prefer shorter, denser hits
}

function isBoundary(text: string, pos: number): boolean {
  const before = text[pos - 1];
  if (before === '/' || before === '\\' || before === '_' ||
      before === '-' || before === '.' || before === ' ') {
    return true;
  }
  // camelCase boundary: a lowercase/digit followed by an uppercase letter.
  return /[a-z0-9]/.test(before) && /[A-Z]/.test(text[pos]);
}

interface RankedItem {
  item: string;
  positions: number[];
}

function rank(query: string, items: string[]): RankedItem[] {
  if (query.length === 0) return items.map((item) => ({ item, positions: [] }));
  const scored: Array<RankedItem & { score: number }> = [];
  for (const item of items) {
    const match = fuzzyMatch(query, item);
    if (match) scored.push({ item, positions: match.positions, score: match.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Render `text` as Pango markup with the matched characters bolded. */
function highlightMarkup(text: string, positions: number[]): string {
  const matched = new Set(positions);
  let out = '';
  let bold = false;
  for (let i = 0; i < text.length; i++) {
    const isMatch = matched.has(i);
    if (isMatch && !bold) { out += '<b>'; bold = true; }
    else if (!isMatch && bold) { out += '</b>'; bold = false; }
    out += escapeMarkup(text[i]);
  }
  if (bold) out += '</b>';
  return out;
}

function escapeMarkup(ch: string): string {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  return ch;
}
