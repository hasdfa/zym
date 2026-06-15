# Autocompletion

A source-pluggable autocompletion framework: a coordinator drives a popup from one
or more **sources** (buffer words, LSP, Copilot, …). The widget + events + source
contract are built; a placeholder source validates the pipeline.

## Built

- **`CompletionSource.ts`** — the contract. `CompletionItem`
  (`label`/`insertText`/`filterText`/`kind`/`detail`/`sortText`), `CompletionContext`
  (the typed `prefix`, `cursor`, the `replaceRange` an accept overwrites, the
  `line`, and the `trigger`), and `CompletionSource` (`name`, optional
  `triggerCharacters`, `complete(ctx)` → items, **sync or async**).
- **`CompletionController.ts`** — the coordinator. Triggers in **insert mode**:
  word typing re-queries on the editor's `onDidChangeText` (debounced 60ms), and
  Ctrl+Space forces it. Queries all sources, swallows per-source errors, and ranks
  (prefix match first, then `sortText`/label), capped to the popup size. **Sync
  sources present immediately**; only async sources take the awaited path (awaiting
  even a resolved promise is sluggish under node-gtk's GLib loop). Prefix detection
  is codepoint-aware. A capture-phase key controller drives the popup: Down/Up (or
  Ctrl+N/P) navigate, Enter/Tab accept (Tab still indents when closed), Ctrl+E
  dismiss. **Esc is left to vim** (it exits insert mode); the host dismisses on any
  leave-insert via `vimState.onDidActivateMode`. Accept replaces `replaceRange`
  with the item and moves the cursor after it.
- **`CompletionPopup.ts`** — a keyboard-driven dropdown floated just below the
  cursor in the editor overlay (the project's floating-card pattern, **not** a
  GtkPopover — that froze the UI). Non-focusable so the editor keeps focus and
  typing flows; renders label (monospace) + right-aligned muted detail; selection
  tracked via the `Gtk.ListBox`. List is capped to a no-scroll count.
- **`placeholderCompletionSource.ts`** — a fixed keyword vocabulary, filtered by
  the controller. Validates the widget/events; real sources replace/augment it.
- **Wiring** — `TextEditor` builds the controller in its overlay, registers the
  placeholder source, and dismisses on leave-insert. (File editors only for now;
  buffer-only editors skip it.)

Verified end-to-end in a real GTK harness: typing opens the popup with filtered
items, navigation/accept insert the chosen item (replacing the prefix), and
leaving insert mode dismisses.

## Next

- **Real sources** (each a `CompletionSource`, `addSource`-ed):
  - **Buffer words** — collect `\w+` from the buffer (and open buffers), rank by
    proximity/frequency. The natural first real source (sync, no deps).
  - **LSP** — `textDocument/completion` via `quilx.lsp`; map LSP items
    (kinds, `insertText`/`textEdit`, `detail`, trigger characters) to
    `CompletionItem`. Async; resolve docs lazily.
  - **Copilot** — inline/ghost suggestions (a different UX than the dropdown;
    may warrant a separate ghost-text path rather than list items).
- **Widget polish** — kind icons (Nerd Font glyphs), scroll-into-view for long
  lists (currently capped to fit), `detail`/documentation side panel, mouse
  click-to-select + hover, fuzzy (not just substring) filtering, flip-above when
  near the editor's bottom edge.
- **Behavior** — trigger-character handling (`.`/`::` open even with no prefix),
  per-source debounce / cancellation, accept-on-trigger-char, snippet
  (`$1`-placeholder) insertion, and a config to tune eagerness (`MIN_PREFIX`,
  debounce, auto vs manual).
