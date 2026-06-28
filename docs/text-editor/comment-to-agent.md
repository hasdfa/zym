# Comment to agent

An inline box that turns the cursor row (or a visual selection) into a message
for a coding agent: a `path:line` reference, the targeted lines as a fenced
block, then `On <locator>:` + your text. It exists on **two surfaces** that share
the box and the message format:

- the **diff** (`DiffView`) — the original home; comments a diff row/hunk and
  also supports **review mode** (accumulate inline cards, batch-send). See
  [diff.md](diff.md).
- ordinary **file editors** (`TextEditor`) — `enter` in vim **normal** mode, or
  on a **visual** selection, comments the line/selection. **Single comment only**
  (no review-mode accumulation).

## Shared pieces

- **`src/ui/DiffCommentBox.ts`** — the focusable box, hosted in the editor's
  `Peek` (a sibling overlay card; see [inline-widgets.md](inline-widgets.md)).
  Body is a buffer-only `TextEditor` (`enter` submits, `alt-enter` newline,
  `escape`/`q` cancels). `reviewable: false` (the file-editor case) hides the
  review hint and makes `ctrl-enter` a plain submit.
- **`src/ui/agentComment.ts`** — `formatAgentComment({ rel, line, fence, body,
  locator, comment })`, the one definition of the message shape. The diff passes
  `fence: 'diff'` + a unified-diff hunk; a file editor passes the file's language
  id + plain code.

## File-editor wiring

- A file editor opts in via the **`onComment`** option (`TextEditorOptions`),
  passed by `AppWindow.createEditorTab` as `(message) => this.reviewToAgent(message)`
  — the **same agent seam every diff review uses** (`AppWindow.reviewToAgent`:
  sends to the running agent and reveals it, or opens the picker / launches one,
  so a comment always reaches an agent). Inputs, peeks, and multibuffers never
  pass it, so the feature is file-editor-only.
- `TextEditor.installComment` (called only when `onComment` is set) registers the
  **`editor:comment`** command on the view. `startComment` builds the target
  (`buildEditorCommentTarget`), opens a `DiffCommentBox` in `showPeek`, and on
  submit formats via `formatAgentComment` → `onComment`.
- **Trigger:** `src/keymaps/default.ts` binds `enter` →`editor:comment` under
  `.TextEditor.normal-mode:not(.zym-input)` and `.visual-mode:not(.zym-input)`.
  `:not(.zym-input)` excludes inputs/pickers; the command is registered only on
  commenting-enabled editors, so the binding is inert elsewhere (an unmatched
  command falls through — `EVENT_CONTINUE`, `src/KeymapManager.ts`).
- **Targeting** (`buildEditorCommentTarget`): a bare cursor comments its line; a
  selection comments exactly its rows. View rows map to **document** lines via
  `screen.documentPointFromScreen` (fold-correct); the locator is `L<a>`/`L<a-b>`
  plus `col`/`cols` for a sub-line selection.

The box is the editor's single open peek; it's torn down via the peek's
`onClose` (deferred off the key dispatch) and again in `TextEditor.dispose`
(idempotent) — see [lifecycle-and-disposal.md](../lifecycle-and-disposal.md).
