/*
 * InlayHintController — LSP inlay hints (parameter names / inferred types) rendered as
 * native end-of-line annotations, per view.
 *
 * The native annotation API is line-anchored (end-of-line), so a line's hints are joined
 * and trailed after the line rather than placed at their exact column — "simple
 * end-of-line inlay hints" per tasks/code-editing/virtual-lines.md. (Mid-line placement
 * would need the gap-tag + overlay recipe.) Like everything annotation-based, this is
 * per-view thanks to the A2 document-model: each view has its own buffer.
 *
 * Refetches the whole document (debounced) on edits + on demand; cheap timeout-bounded
 * LSP request. Gated by `editor.inlayHints`.
 */
import type { SourceView } from '../../gi.ts';
import { quilx } from '../../quilx.ts';
import { VirtualText } from './VirtualText.ts';
import type { LspDocument } from '../../lsp/LspManager.ts';

const DEBOUNCE_MS = 400;

export class InlayHintController {
  private readonly annotations: VirtualText;
  private readonly getDoc: () => LspDocument | null;
  private timer: NodeJS.Timeout | null = null;
  private seq = 0; // drops stale async responses
  private disposed = false;
  // Last-fetched hints (MODEL lines), kept so a fold toggle can re-place them at the
  // shifted view lines without a new LSP round-trip.
  private lastHints: Array<{ line: number; label: string }> = [];

  // Maps a MODEL (file) line to the VIEW line it renders on — folds collapse text so
  // the two diverge; identity when not provided.
  private readonly toViewLine: (line: number) => number;

  constructor(view: SourceView, getDoc: () => LspDocument | null, toViewLine?: (line: number) => number) {
    this.annotations = new VirtualText(view);
    this.getDoc = getDoc;
    this.toViewLine = toViewLine ?? ((line) => line);
  }

  /** Recompute after a short idle (coalesces a burst of edits into one request). */
  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  /** Fetch inlay hints for the whole document and render them end-of-line per line. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (quilx.config.get('editor.inlayHints') === false) {
      this.annotations.clear();
      return;
    }
    const doc = this.getDoc();
    if (!doc) {
      this.annotations.clear();
      return;
    }
    const token = ++this.seq;
    const hints = await quilx.lsp.inlayHints(doc);
    if (this.disposed || token !== this.seq) return; // superseded by a newer request
    this.lastHints = hints;
    this.apply();
  }

  /** Re-place the last-fetched hints at the current view lines — no LSP round-trip.
   *  Called when folds open/close (which shifts the view lines under the model hints). */
  rerender(): void {
    if (!this.disposed) this.apply();
  }

  /** Group cached hints per (model) line, translate to view lines, render end-of-line. */
  private apply(): void {
    if (quilx.config.get('editor.inlayHints') === false) {
      this.annotations.clear();
      return;
    }
    // One annotation per line: join that line's hint labels (e.g. `a: b: number`).
    const byLine = new Map<number, string[]>();
    for (const hint of this.lastHints) {
      const labels = byLine.get(hint.line);
      if (labels) labels.push(hint.label);
      else byLine.set(hint.line, [hint.label]);
    }
    this.annotations.setAnnotations(
      [...byLine.entries()].map(([line, labels]) => ({ line: this.toViewLine(line), text: labels.join(' '), style: 'none' as const })),
    );
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.annotations.dispose();
  }
}
