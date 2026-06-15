# Autocompletion

A source-pluggable autocompletion framework: a coordinator drives a popup from one
or more **sources** (buffer words, LSP, Copilot, …). The widget, events, source
contract, and a first real source (buffer words) are built.

## Built

- **`CompletionSource.ts`** — the contract. `CompletionItem`
  (`label`/`insertText`/`filterText`/`kind`/`detail`/`documentation`/`sortText`),
  `CompletionContext` (the typed `prefix`, `cursor`, the `replaceRange` an accept
  overwrites, the `line`, and the `trigger`), `CompletionSource` (`name`, optional
  `triggerCharacters`, `complete(ctx)` → items, **sync or async**), and
  `RankedCompletion` (an item plus the matched-character `positions` the popup
  highlights).
- **`CompletionController.ts`** — the coordinator. Triggers in **insert mode**:
  word typing re-queries on the editor's `onDidChangeText` (debounced 60ms), and
  Ctrl+Space forces it. Queries all sources, swallows per-source errors, and ranks
  with the picker's fzy scorer (`fuzzyMatch`, `maxTypos: 1`): a **subsequence — and
  a single typo — still matches**, ordered by fuzzy score with `sortText` as the
  tie-break, capped to the popup size. **Sync sources present immediately**; only
  async sources take the awaited path (awaiting even a resolved promise is sluggish
  under node-gtk's GLib loop). Prefix detection is codepoint-aware. A capture-phase
  key controller drives the popup: Down/Up (or Ctrl+N/P) navigate, Enter/Tab accept
  (Tab still indents when closed), Ctrl+E dismiss. **Esc is left to vim** (it exits
  insert mode); the host dismisses on any leave-insert via `onDidActivateMode`.
  Accept replaces `replaceRange` with the item and moves the cursor after it.
- **`CompletionPopup.ts`** — a keyboard-driven dropdown floated at the **start of
  the word** being completed in the editor overlay (the project's floating-card
  pattern, **not** a GtkPopover — that froze the UI). Non-focusable so the editor
  keeps focus and typing flows. Painted with the theme background; selection is a
  square highlight in the theme's selected color; rows have no min-height (a single
  match is one row tall); the fuzzy-matched characters are bolded in the picker's
  accent (`highlightMarkup`). A horizontally-split **documentation pane** (driven by
  `CompletionItem.documentation`) appears to the right when the selected item has
  docs, and stays hidden otherwise. Uses `--popover-radius-small`.
- **`createBufferWordsSource.ts`** — the first real source. A factory over a
  `getText` accessor (decoupled from the widget, unit-tested) that tokenizes the
  buffer for identifier-like words (Unicode-aware, min length 2), dedupes, drops
  the partial word under the cursor, and emits a frequency hint via `sortText` so
  more-frequent words rank first within a prefix group.
- **Wiring** — `TextEditor` builds the controller in its overlay, registers the
  buffer-words source, and dismisses on leave-insert. (File editors only for now;
  buffer-only editors skip it.)

Verified end-to-end in a real GTK harness: typing opens the popup with fuzzy-filtered
items, navigation/accept insert the chosen item (replacing the prefix), and leaving
insert mode dismisses.

## Next

- **More sources** (each a `CompletionSource`, `addSource`-ed):
  - **LSP** — `textDocument/completion` via `quilx.lsp`; map LSP items (kinds,
    `insertText`/`textEdit`, `detail`, `documentation`, trigger characters) to
    `CompletionItem`. Async; resolve docs lazily (the doc pane is ready for them).
  - **Copilot** — inline/ghost suggestions (a different UX than the dropdown;
    may warrant a separate ghost-text path rather than list items).
  - Buffer words could widen to **open buffers** and rank by proximity.
- **Widget polish** — kind icons (Nerd Font glyphs), scroll-into-view for long
  lists (currently capped to fit), mouse click-to-select + hover, flip-above when
  near the editor's bottom edge.
- **Behavior** — trigger-character handling (`.`/`::` open even with no prefix),
  per-source debounce / cancellation, accept-on-trigger-char, snippet
  (`$1`-placeholder) insertion, and a config to tune eagerness (`MIN_PREFIX`,
  debounce, auto vs manual).
