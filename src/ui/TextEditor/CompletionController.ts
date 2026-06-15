/*
 * CompletionController — the autocompletion framework's coordinator: it owns the
 * sources, decides when to open completion, queries the sources, ranks/merges the
 * results, and drives the `CompletionPopup` plus the accept/navigate/dismiss
 * keys. Sources (placeholder for now; buffer-words/LSP/Copilot later) plug in via
 * `addSource`.
 *
 * Triggering (insert mode only): typing a word re-queries on the buffer-change
 * event (debounced); a trigger character opens immediately; Ctrl+Space forces it.
 * The popup is keyboard-driven through a capture key controller on the view — in
 * insert mode vim passes Down/Up/Enter/Tab through, so this consumes them only
 * while the popup is open (Tab still indents otherwise). Esc is left to vim (it
 * exits insert mode); the host dismisses on any leave-insert via `onModeChange`.
 */
import { Gdk, GLib, Gtk } from '../../gi.ts';
import { Point } from '../../text/Point.ts';
import { Range } from '../../text/Range.ts';
import type { EditorModel } from './EditorModel.ts';
import { fuzzyMatch } from '../fuzzyMatch.ts';
import { CompletionPopup } from './CompletionPopup.ts';
import type { CompletionContext, CompletionItem, CompletionSource, CompletionTrigger, RankedCompletion } from './CompletionSource.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

const DEBOUNCE_MS = 60;
const MIN_PREFIX = 1; // word chars typed before auto-opening
const MAX_ITEMS = 10; // also the popup's no-scroll capacity

/** Whether a source's result is a promise (async source) vs a plain array. */
function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown })?.then === 'function';
}

export class CompletionController {
  private readonly editor: EditorModel;
  private readonly isInsertMode: () => boolean;
  private readonly popup: CompletionPopup;
  private readonly sources: CompletionSource[] = [];

  private replaceRange: Range | null = null;
  private requestSeq = 0; // drops stale async source responses
  private debounceId = 0;

  constructor(editor: EditorModel, host: Overlay, isInsertMode: () => boolean) {
    this.editor = editor;
    this.isInsertMode = isInsertMode;
    this.popup = new CompletionPopup(host);
    editor.onDidChangeText(() => this.onBufferChanged());
    this.installKeys();
  }

  /** Register a candidate source (placeholder, buffer words, LSP, Copilot, …). */
  addSource(source: CompletionSource): void {
    this.sources.push(source);
  }

  /** Close the popup and cancel any pending query. */
  dismiss(): void {
    if (this.debounceId) {
      GLib.sourceRemove(this.debounceId);
      this.debounceId = 0;
    }
    this.requestSeq++; // invalidate in-flight queries
    this.popup.hide();
  }

  /** Explicitly open completion at the cursor (Ctrl+Space). */
  trigger(): void {
    if (this.isInsertMode()) this.scheduleQuery('manual');
  }

  private onBufferChanged(): void {
    if (!this.isInsertMode()) {
      this.dismiss();
      return;
    }
    this.scheduleQuery('auto');
  }

  private scheduleQuery(trigger: CompletionTrigger): void {
    if (this.debounceId) GLib.sourceRemove(this.debounceId);
    this.debounceId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
      this.debounceId = 0;
      this.query(trigger);
      return false;
    });
  }

  private query(trigger: CompletionTrigger): void {
    const context = this.buildContext(trigger);
    if (trigger === 'auto' && context.prefix.length < MIN_PREFIX) {
      this.popup.hide();
      return;
    }
    const results = this.sources.map((source) => {
      try {
        return source.complete(context);
      } catch {
        return [];
      }
    });
    // Sync sources (buffer words, placeholder) present immediately — awaiting even
    // an already-resolved promise costs a microtask, which under node-gtk's GLib
    // loop is sluggish. Only async sources (LSP, Copilot) take the awaited path.
    if (!results.some(isThenable)) {
      this.present((results as CompletionItem[][]).flat(), context);
      return;
    }
    const seq = ++this.requestSeq;
    void Promise.all(results.map((r) => Promise.resolve(r).catch(() => [] as CompletionItem[]))).then((lists) => {
      if (seq === this.requestSeq) this.present(lists.flat(), context);
    });
  }

  private present(raw: CompletionItem[], context: CompletionContext): void {
    const ranked = this.rank(raw, context.prefix);
    // Anchor at the start of the word being completed, not the cursor, so the
    // candidate labels line up under the text they're replacing.
    const rect = ranked.length > 0 ? this.editor.pixelRectForBufferPosition(context.replaceRange.start) : null;
    if (!rect) {
      this.popup.hide();
      return;
    }
    this.replaceRange = context.replaceRange;
    this.popup.showAt(ranked, rect.x, rect.y + rect.height);
  }

  /** The word being typed before the cursor and the range it occupies. */
  private buildContext(trigger: CompletionTrigger): CompletionContext {
    const cursor = this.editor.getCursorBufferPosition();
    const line = this.editor.lineTextForBufferRow(cursor.row);
    // Codepoint-aware: columns are codepoints, JS string indices are UTF-16.
    const codepoints = [...line];
    let start = cursor.column;
    while (start > 0 && /\w/.test(codepoints[start - 1])) start--;
    const prefix = codepoints.slice(start, cursor.column).join('');
    const replaceRange = new Range(new Point(cursor.row, start), cursor);
    return { prefix, cursor, replaceRange, line, trigger };
  }

  /**
   * Fuzzy-filter against the prefix (reusing the picker's fzy scorer, so a
   * subsequence — and a single typo — still matches), rank by score, and cap to
   * the popup. fzy's word-start/consecutive bonuses keep prefix matches on top;
   * `sortText` (e.g. buffer-word frequency) breaks ties. An empty prefix keeps
   * everything, ordered by `sortText`/label.
   */
  private rank(items: CompletionItem[], prefix: string): RankedCompletion[] {
    return items
      .map((item) => {
        if (item.label === prefix) return null; // already fully typed
        const text = item.filterText ?? item.label;
        const match = prefix === '' ? { score: 0, positions: [] } : fuzzyMatch(prefix, text, { maxTypos: 1 });
        if (!match) return null;
        // Highlight positions must index into the displayed `label`. They already
        // do when matching `label` directly; if a source matched a distinct
        // `filterText`, re-derive positions against the label (best effort).
        const positions =
          text === item.label
            ? match.positions
            : (prefix === '' ? [] : (fuzzyMatch(prefix, item.label)?.positions ?? []));
        return { item, score: match.score, positions };
      })
      .filter((entry): entry is { item: CompletionItem; score: number; positions: number[] } => entry !== null)
      .sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score; // higher score first
        const ak = a.item.sortText ?? a.item.label;
        const bk = b.item.sortText ?? b.item.label;
        return ak < bk ? -1 : ak > bk ? 1 : 0;
      })
      .slice(0, MAX_ITEMS)
      .map(({ item, positions }) => ({ item, positions }));
  }

  private accept(): void {
    const item = this.popup.getSelected();
    const range = this.replaceRange;
    this.dismiss();
    if (item && range) {
      const inserted = this.editor.setTextInBufferRange(range, item.insertText ?? item.label);
      this.editor.setCursorBufferPosition(inserted.end);
    }
  }

  private installKeys(): void {
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
      const ctrl = (state & Gdk.ModifierType.CONTROL_MASK) !== 0;
      if (!this.popup.isOpen) {
        if (ctrl && keyval === Gdk.KEY_space) {
          this.trigger();
          return true;
        }
        return false;
      }
      switch (keyval) {
        case Gdk.KEY_Down:
          this.popup.move(1);
          return true;
        case Gdk.KEY_Up:
          this.popup.move(-1);
          return true;
        case Gdk.KEY_Return:
        case Gdk.KEY_KP_Enter:
        case Gdk.KEY_Tab:
          this.accept();
          return true;
        default:
          if (ctrl && keyval === Gdk.KEY_n) {
            this.popup.move(1);
            return true;
          }
          if (ctrl && keyval === Gdk.KEY_p) {
            this.popup.move(-1);
            return true;
          }
          if (ctrl && keyval === Gdk.KEY_e) {
            this.dismiss();
            return true;
          }
          return false; // typing flows through → onBufferChanged re-queries
      }
    });
    this.editor.view.addController(keys);
  }
}
