/*
 * Completion source contract — the seam the autocompletion framework is built
 * around. The `CompletionController` coordinates one or more sources (a buffer-
 * words source, an LSP source, a Copilot source, …); each implements
 * `CompletionSource` and is fed a `CompletionContext` (the prefix being typed,
 * the cursor, and the range an accepted item replaces). Sources are sync or
 * async — LSP/Copilot return promises.
 */
import type { Point } from '../../text/Point.ts';
import type { Range } from '../../text/Range.ts';

/** A single completion candidate. Mirrors the useful subset of an LSP item. */
export interface CompletionItem {
  /** Shown in the list and, by default, matched against the prefix + inserted. */
  label: string;
  /** Text inserted on accept (defaults to `label`). */
  insertText?: string;
  /**
   * Exact buffer range this item replaces (LSP `textEdit` range, in buffer
   * codepoint coordinates). When set, the controller replaces this range instead
   * of the heuristic typed-prefix range — needed for trigger-character
   * completions (e.g. after `.`) whose `insertText` re-includes the trigger.
   */
  replaceRange?: Range;
  /** Text matched against the typed prefix (defaults to `label`). */
  filterText?: string;
  /** A short kind tag — `function`, `variable`, `keyword`, … — drives the icon. */
  kind?: string;
  /** Right-aligned detail (a concise type signature, …). */
  detail?: string;
  /**
   * Secondary, dimmed text shown after the detail — the source module / import
   * path (LSP `labelDetails.description`). Optional.
   */
  description?: string;
  /**
   * Longer documentation for the item (LSP `documentation`, a signature + doc
   * comment, …). Shown in the popup's side panel when the item is selected.
   */
  documentation?: string;
  /** Ordering hint within a source (compared as a string; falls back to `label`). */
  sortText?: string;
  /**
   * Name of the source that produced this item, stamped by the controller (the
   * source itself need not set it). Shown dimmed in the popup as a debug tag.
   */
  source?: string;
  /**
   * Lazily fetch fields the list response omitted — chiefly `documentation`
   * (LSP `completionItem/resolve`; many servers send docs only here). Called by
   * the controller when the item is selected; the resolved fields are merged in
   * and the doc pane refreshed. Optional; resolved at most once per item.
   */
  resolve?: () => Promise<CompletionItem>;
}

/** A candidate after ranking: the item plus the matched-character positions
 *  (indices into `item.label`) the popup highlights. */
export interface RankedCompletion {
  item: CompletionItem;
  positions: number[];
}

export type CompletionTrigger = 'auto' | 'manual' | 'character';

/** Everything a source needs to produce candidates for the current position. */
export interface CompletionContext {
  /** The word being typed immediately before the cursor (may be empty). */
  prefix: string;
  /** The cursor position. */
  cursor: Point;
  /** The buffer range an accepted item replaces (covers `prefix`). */
  replaceRange: Range;
  /** The full text of the cursor's line. */
  line: string;
  /** What caused the request. */
  trigger: CompletionTrigger;
  /** The trigger character, when `trigger === 'character'`. */
  triggerCharacter?: string;
}

/** A provider of completion candidates (buffer words, LSP, Copilot, …). */
export interface CompletionSource {
  readonly name: string;
  /**
   * Ranking weight relative to other sources (default 0). Higher-priority
   * sources rank above lower ones regardless of fuzzy score, so e.g. LSP results
   * sit above buffer words. Score + `sortText` order items within one source.
   */
  readonly priority?: number;
  /**
   * Characters that auto-open completion for this source beyond plain word typing
   * (e.g. `.` / `::` for LSP). Optional.
   */
  readonly triggerCharacters?: readonly string[];
  /**
   * Produce candidates for `context`. May be sync or async; thrown errors and
   * rejections are swallowed by the controller (one bad source won't break the rest).
   */
  complete(context: CompletionContext): CompletionItem[] | Promise<CompletionItem[]>;
}
