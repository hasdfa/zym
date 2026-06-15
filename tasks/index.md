# Tasks

Each task can have it own page with research, design, and implementation details.
File name name the header structure, e.g. `git.md` for the git section, `code-editing/lsp-integration.md` for the LSP integration section, etc. When a header has more than one subheader, it should be a directory with an `index.md` file for the main section.

The task documents should be updated as the implementation progresses, with notes on research findings, design decisions, and implementation details. This will help keep track of the progress and provide context for future reference.

## Architecure

### Commands & keymaps

See [commands-keymaps.md](commands-keymaps.md). Done: commands with
args/descriptions/`when`, keymaps with sequences/priority/`unset!`, `#id`
selectors, user `keymap.json` (live-reloaded), command palette (shortcuts,
name+description search, dim-when-unavailable), which-key hints (currently
disabled — `WhichKey` constructor skips the `onPendingChanged` subscription;
re-enable in `src/ui/WhichKey.ts`), conflict detection, keymap reference panel
(all bindings + source, `space ?`). Remaining: `when` keymap fall-through;
keybinding editing UI.

### Panels & layout

See [panels.md](panels.md) for the `Panel` / `PanelGroup` / dock model: single
active panel = focus container (overlay exception), root-focusable panels,
focus-driven `.active-empty` outline, `.is-panel-child` invariant, the tab-bar
rules (`requireTabBar`, non-expanding tabs), and the zombie-safe dock-close rule
(bottom docks veto-hide; side docks per-tab close + re-root-before-re-add).

### Plugin system

- [ ] Plugin system for commands, UI components, and more.

## System integration

See [system-integration.md](system-integration.md) for how quilx should track the
desktop's appearance and fonts, with the rule that **OS font/theme changes are
followed through at runtime** (no restart).

- [x] Editor scheme follows the OS light/dark preference (`notify::dark`), when the theme defines no background; terminal inherits libadwaita colors.
- [ ] Follow OS **monospace** font changes live (editor, terminal, pickers — currently read once at startup).
- [ ] Follow OS **UI** font changes live (proportional text — currently read once).
- [ ] Follow OS **light/dark** through the quilx theme palette (swap the theme variant; chrome/syntax/picker colors re-apply), and wire the dead `core.followSystemColorScheme` config.
- [ ] Central `Gio.Settings`/`Adw.StyleManager` watcher that emits font/appearance-changed signals instead of per-widget one-shot reads.

## Git

See [git/index.md](git/index.md) for the architecture plan.

- [ ] Git status viewer
- [ ] Git commit interface
- [ ] Github PR/issue link when applicable, then gitlab etc

## Code editing

### LSP integration

See [code-editing/lsp-integration.md](code-editing/lsp-integration.md) for the design and decisions.

- [x] **Restructure:** grammar + LSP unified under a `LanguageRegistry` (the plugin seam); curated hand-authored built-in pack (`src/lang/builtin.ts`); runtime Helix fetch dropped; **per-project server selection** (flow vs tsserver vs deno, + additive linters) via root-marker activation + exclusion groups + priority; user overrides (`lsp.servers`/`lsp.disabledLanguages`). See [code-editing/language-config.md](code-editing/language-config.md).
- [x] LSP client + per-(server,root) lifecycle with crash recovery (exponential-backoff restart) and trace logging. **Incremental** document sync (full-text fallback). Correct LSP `languageId` (`.tsx`→typescriptreact, `.js`→javascript, …). See `src/lsp/`.
- [x] Server→client requests answered: `workspace/configuration` (from `ServerDef.settings`), `client/(un)registerCapability`, `workDoneProgress/create`; `window/showMessage` surfaced, error `logMessage` to the trace log. File watching: dynamically-registered `workspace/didChangeWatchedFiles` via a per-dir `WorkspaceWatcher` (excludes node_modules/.git).
- [x] Diagnostics integration (gutter, inline, panel) — custom-drawn Cairo squiggles (`UnderlineOverlay`), Nerd-Font gutter glyphs, a "Diagnostics" panel (shared `LocationList`). Namespaced by `(server, path)` and merged.
- [x] Go to shortcuts — definition/declaration/type-definition/implementation + find-references (`space l d`/`D`/`t`/`i`/`r`); jumps reveal an already-open tab.
- [x] Hover tooltips — `space l k` / vim `K`; markdown card above the cursor, code blocks syntax-highlighted by reusing tree-sitter, in the editor monospace.
- [x] Server install — `ServerDef.install` (npm / raw command) → `lsp/installer.ts` installs into a managed dir (`$XDG_DATA_HOME/quilx/lsp/<server>`), searched + on the spawn PATH. Triggers: "Install" button on the missing-server warning, `lsp:install-server` picker, and `lsp.autoInstall` (default off). Missing servers are skipped (not crash-looped); the warning names the exact missing binary.
- [x] Code actions — `textDocument/codeAction` (+ resolve) → pick (`space l a`) and apply via the shared `WorkspaceEdit` applier (`lsp/workspaceEdit.ts`: `applyTextEdits`/`normalizeWorkspaceEdit`; open editors edited in-buffer, others on disk).
- [x] Rename — `textDocument/rename` (+ `prepareRename`); `space l R` prompts (prefilled with the symbol) → applies the multi-file `WorkspaceEdit`.
- [x] Formatting — `textDocument/formatting` (+ range); `space l f` applies the edits to the buffer. Options from `editor.tabLength`/`insertSpaces`.
- [x] Completion — `textDocument/completion` (+ resolve, auto-import `additionalTextEdits`, `textEdit` ranges). See the Autocompletion section.
- [x] Signature help — `textDocument/signatureHelp`; floating card while typing call args, anchored at the callee name, active parameter bold, syntax-highlighted. Backend in `src/lsp/`; card in `TextEditor`.
- [ ] Later: document symbols (outline), workspace symbols, inlay hints, semantic tokens, document highlight, format-on-save, command-only code actions (`workspace/executeCommand`) + `WorkspaceEdit` resource ops (create/rename/delete file).

### Grammar

- [ ] More default grammars

### Autocompletion

See [code-editing/autocompletion.md](code-editing/autocompletion.md).

- [x] Framework: source contract (`CompletionSource`), coordinator (`CompletionController` — insert-mode triggers, debounce, rank, sync-immediate/async-awaited, accept/navigate/dismiss keys), and keyboard-driven popup (`CompletionPopup`).
- [x] Fuzzy matching: reuse the picker's fzy scorer (`fuzzyMatch`, subsequence + 1 typo) for ranking, with matched-character highlighting in the popup.
- [x] Popup: theme background, word-start alignment, square selection, compact (no min-height), and a split documentation pane (`CompletionItem.documentation`).
- [x] Buffer-words source (`createBufferWordsSource`) — the first real source.
- [x] LSP source (`createLspCompletionSource`): `textDocument/completion` via the primary server → framework items (kind, detail, `documentation` feeds the doc pane). `LanguageServer.completion`/`hasCompletion`/`completionTriggerCharacters`; `LspManager.completion`. Trigger-character support added to the controller (`.`/`::` etc., sourced from the server) so member completion fires on an empty prefix.
- [x] Source ranking: `CompletionSource.priority` (default 0); a higher-priority source ranks entirely above lower ones (score/`sortText` order within a source). LSP is `priority: 100`, so it sits above buffer-words — which also keeps the buffer-words fallback out of the way on empty-prefix member completion.
- [x] Per-item source tag (`CompletionItem.source`, stamped by the controller) shown dimmed in the popup — debug aid for which source produced each candidate.
- [x] Auto-imports: an accepted item's `additionalEdits` (LSP `additionalTextEdits`, fetched via resolve) apply on accept — e.g. the `import` line for a cross-module symbol (tsserver `includeCompletionsForModuleExports`). Honors `textEdit` ranges via `replaceRange`.
- [ ] More sources: Copilot (ghost text).
- [ ] Widget polish: kind icons, scroll-into-view, mouse, flip-above.
- [ ] Behavior: snippet insertion, eagerness config; de-dupe identical labels across sources.

### Text editor

See [code-editing/text-editor.md](code-editing/text-editor.md) for the widget evaluation (GtkSourceView vs. custom/Rust), the shared editor-layer primitives, and the prioritized "What's next".

**Recommended next:** buffer-only editor mode and multi-cursor are **done** (see below). Remaining editor-side work is mostly diff/Git integration and small vim polish (`=` auto-indent needs a real indent source). (The vim `:` ex-command line is **won't-do** — see text-editor.md.)

Shared primitives now in place (in `EditorModel` / `DecorationController`):

- [x] Buffer change events (`EditorModel.onDidChangeText`, Atom shape) — drives LSP didChange, vim undo/redo, and multi-cursor live edit-replication.
- [x] Viewport + pixel geometry (`getFirst/LastVisibleScreenRow`, `pixelRectForBufferPosition`) — for hover/code-action popovers, vim H/M/L, scroll commands. (Realized-view paths need interactive verification.)
- [x] Inline decoration surface (`editor.decorations` — clearable tag layers) — for search highlights and inline diff. (Diagnostic squiggles are custom-drawn via `UnderlineOverlay`; gutter icons + virtual text land with their consumers.)

Features:

- [~] Consider a custom widget or a fork of GtkSourceView for better control and features. Research how to implement features like multiple cursors, rectangular selection, and better performance with large files. Consider a JS widget, or a Rust widget with a JS wrapper. — **Decided: stay on GtkSourceView and emulate (Option A).** Multi-cursor + blockwise are now built on top (virtual selection/cursor mark pairs via `MarkerLayer`, surfaced through the array-shaped `getCursors()`/`getSelections()`); see Vim mode below. A custom/Rust widget remains a gated escape hatch only if long single lines become intolerable (see text-editor.md).
- [~] Diff display (inline/unified + side-by-side) — **mostly done**. See [code-editing/diff.md](code-editing/diff.md). Synthesized read-only buffers + decorations + diff gutter + scroll-sync (sidesteps GtkTextView's lack of virtual lines). Built: `DiffModel`/`splitSides` (computeDiff + word-level intra-line diff, unit-tested); `DiffView` (unified) + `SideBySideDiffView` (scroll-synced, Tab switches panes); `DiffViewer` wrapper (stats header, icon toggle, hunk nav); per-pane syntax highlighting; full-line backgrounds; `git:diff-current` command (`space g d`) → working-tree vs HEAD in a tab. Remaining: fold-unchanged, more git diff sources (staged/commit/PR), and the bigger Git-workstream integration. (Try it: `node scripts/diff-demo.ts`.)
- [x] Search interface — `SearchBar` (top-right) + `SearchController` over `EditorModel.scan`: case/regex toggles, replace + replace-all, highlights via `editor.decorations`. Bound to vim `/` `?` `n` `N`.

#### Vim mode

Custom modal editing ported from Atom's vim-mode-plus, driven by quilx's
CommandManager/KeymapManager over an `EditorModel` shim (see `src/ui/TextEditor/vim/`).
It replaced `GtkSource.VimIMContext` and is now the default (no flag).

- [x] Initial implementation derived from Atom's vim-mode-plus
- [x] Motions, operators, text-objects, visual mode, registers, marks, counts, dot-repeat
- [x] find-char (f/F/t/T/;/,), case ops (gU/gu/g~), surround (ys/ds/cs), indent/outdent/join
- [x] System clipboard integration; register prefix (`"`)
- [x] Make custom vim the default; remove GtkSource.VimIMContext
- [~] `:` ex-command line — **won't do** (save/close/open/search reachable via `space w` / `tab:close` / `space o` / SearchBar; see text-editor.md)
- [x] `/` `?` `n` `N` search via the `SearchBar` (incremental highlight, case/regex, replace)
- [x] Occurrence — operator-modifier `o`/`O` (`c o p`, `d o p`, `g U o w`; subword via `O`) and preset occurrence `g o`/`g O`/`g .` (persistent highlighted markers any later operator restricts itself to). Real `OccurrenceManager` over `MarkerLayer` + a `DecorationController` highlight layer. (`occurrence.test.ts`.)
- [x] visual-blockwise (`ctrl-v`) and multiple cursors — emulated on `MarkerLayer` mark pairs surfaced through the array-shaped `getCursors()`/`getSelections()`. Entry points: blockwise `ctrl-v` (I/A/c/d/yank/paste), occurrence `c o p`, and persistent `ctrl-alt-↑/↓` (add cursor above/below; `escape` collapses). Extra-caret rendering (reverse-video block tags in normal/visual; host-drawn beam carets in insert); multi-cursor operations undo as one step; insert is incrementally replicated to every cursor live. (`blockwise.test.ts`, `multicursor.test.ts`.) Caret visuals + `ctrl-alt-arrow` keys need in-app verification (headless can't realize the view).
- [ ] Polish: `=` auto-indent (needs a real indent source), scroll/fold/flash niceties. (H/M/L screen motions + ctrl-f/b/d/u/e/y scrolling are done.)

## Session management

See [session-management.md](session-management.md) for the architecture plan.

- [ ] Define session structure and storage format (e.g. JSON file with open files, unsaved changes, terminal sessions, agent sessions, etc).
- [ ] Define session main path(s?) (the CWD for the session)
- [ ] Implement session saving and loading, including handling of edge cases (e.g. missing files, conflicts with unsaved changes, etc).
- [ ] Integrate session management with the rest of the application (e.g. prompt to save session on exit, option to restore previous session on startup, etc). Hooks for each widget to prompt and save/restore their own state as part of the session.

## Agents

See [agents.md](agents.md) for the architecture plan.

- [x] Basic agent runner (claude in terminal tab)
- [x] Basic AgentManager, sidebar list, and picker/starter
- [x] Live agent status (idle/working/waiting/exited) via Claude Code hooks
- [x] Management UX: attention notifications + waiting badge, kill / focus-next/prev, vim list nav
- [x] Send editor context to an agent (selection / file → current / picked / new agent)
- [x] Resume / continue past conversations (transcript enumeration + `--resume`/`--continue`); capture session id for restore
- [x] More management UX: restart (resume conversation), rename, close — keyboard/command driven (`r`/`R`/`X`); status glyph in the tab title
- [x] File-change awareness: a PostToolUse hook records edited files; agent-list "✎ N" badge (tooltip), click/`o` opens them (newest first), and edits trigger an immediate git refresh
- [x] **Per-person layouts** — `Workbench` is now `Layout` (`src/ui/Layout.ts`, with an `owner` field naming its person), and **each person owns a fully self-contained `Layout`**: its own splittable center, its own Files/Source-Control (right), and its own bottom docks. **Nothing is shared or reparented on switch.** `buildLayout(owner)` constructs the whole bundle (`LayoutBundle`); `activateLayout(layout)` shows it (`overlay.setChild(layout.root)`) and re-points the `this.*` fields to that layout's widgets (`applyBundle`), writing the active layout's mutable state back first (`saveActiveBundle`). Detached layouts stay alive (tabs/terminal/editors persist — verified). An agent's layout opens terminal-only (no Files/Source-Control shown — the panel is still built, so `file-tree:focus`/git commands reveal it on demand); any layout can open/edit files. **Now worktree-ready** (each agent's Files/Git is its own — just needs a per-worktree root/`GitRepo`). Defer: per-worktree roots; session restore of agent layouts (only the user layout is serialized); per-layout NotificationLog/KeymapPanel subscribe to global signals and aren't disposed on close (minor leak, few agents)
- [x] **LayoutSidebar / LayoutList** (renamed from agent sidebar / AgentList): its own full-height column at the very left of the window (left of the header bar) — a top-level horizontal `Gtk.Paned` (sidebar | header-bar+workbench), no longer a workbench dock. Top is a themed `Adw.HeaderBar` whose only content is a flat **logo button** (square placeholder for now; styled like the git branch button) that toggles collapse (icons-only / icons+text). The first row is the **user** (default-selected pseudo-agent), the rest are agents; never empty; each row is one header-bar tall. Each entry will be associated with a workbench layout (planned). Files/Source-Control moved to the **right** dock (fixed 220px); the left dock is empty/hidden at startup
- [x] Modal terminal input (Terminal & AgentTerminal): normal/insert modes — `Escape`↔`i`; normal frees the `space` leader / `ctrl-w` window-nav, `ctrl-[` sends a literal Escape to the child. Implemented by wrapping the Vte in a focusable container that *steals* focus in normal mode (Vte un-focused → cursor idles, no keys reach it — no key-swallowing guard needed); clicking the Vte re-enters insert
- [ ] **Review an agent's work** (next; design in agents.md): per-agent baselines (PreToolUse snapshot → `.baseline/`) make one agent's diff well-defined even in a tree shared by several agents; an "Agent Changes" diff panel (baseline→current), live while it works + after exit; overlap warning when two live agents edit the same file. Needs the editor Diff renderer first
- [ ] Live activity timeline: tail the agent's transcript JSONL (already parsed for resume) into a structured feed (tools used, files touched, messages)
- [ ] OS notifications (`Gio.Notification`) when an agent needs attention while the window is unfocused (today: in-app toasts only)
- [ ] Agent interrupt (`agent:interrupt` → send ESC/ctrl-c to the child) — softer than kill
- [ ] Jump to an agent's latest edit *location* (file + exact line), not just the file
- [ ] Agent configuration and customization (name, description, model, tools, etc), integration with other tools than claude.
- [ ] Worktree integration: run agents in worktrees (**N agents per worktree**, not 1:1), group the list by worktree, re-root the editor when viewing one; review at worktree (`git diff`) vs per-agent (baseline) granularity; per-worktree keep/merge/discard when the last agent leaves
- [ ] Cost/context meter (per-row `$cost · context%` via a `statusLine` hook); multi-agent orchestration (speculative)
