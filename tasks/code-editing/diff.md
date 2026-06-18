# Diff display

Investigation of what the **text-editor side** needs to support a diff viewer in
two presentations:

- **Inline (unified)** — one column; context, added, and removed lines stacked.
- **Side-by-side** — two columns (old | new), line-aligned and scroll-synced.

Both are *read-only viewers* (git diff / commit / PR review / "compare two
texts"). A separate, harder feature — live gutter change-bars **while editing** a
file with uncommitted changes — is noted at the end but out of scope here.

## The crux: GtkTextView has no virtual lines

A diff needs to show content/space that isn't in the file: **deleted lines**
(inline) and **alignment fillers** (side-by-side, where one side gained/lost lines
the other must pad to stay aligned — index.md's "insert blank regions"). GtkTextView
**cannot** insert blank vertical regions or phantom lines between real lines, except
by embedding a `GtkTextChildAnchor` widget (heavy, one per gap) or by making the
content **real buffer lines**.

**Recommendation — synthesized read-only diff buffers.** Build a buffer *per pane*
whose lines ARE the diff: for unified, context + added + removed lines all as real
text; for side-by-side, each side padded with **blank filler lines** so the two
line up 1:1. Then style with `editor.decorations` + a diff gutter. This sidesteps
the virtual-line problem entirely and reuses the just-built buffer-only mode. Both
sides having equal line counts (via padding) + no wrapping means row *N* sits at
the same pixel *y* on both → scroll-sync is a trivial adjustment copy.

The alternative — true virtual lines on the *live editable* buffer — is only
needed for editing-with-inline-deleted-peeks, not for a viewer. Defer it; the
general virtual-line capability (which several other features also want) is
investigated separately in [virtual-lines.md](virtual-lines.md).

## Already in place (reuse)

- **Buffer-only editor mode** (`TextEditor({ buffer })`) — no file/LSP/minimap,
  `getText`/`setText`. The base for a diff pane.
- **`editor.decorations`** — clearable tag layers with `added`/`removed` line
  backgrounds already defined (`TextDecorations`).
- **Scroll/viewport API on `EditorModel`** — `getScrollTop`/`setScrollTop`,
  `getVadjustment`, `getFirst/LastVisibleScreenRow`, `scrollToBufferPosition`:
  the basis for side-by-side scroll-sync and hunk navigation.
- **Gutter-renderer pattern** — `GtkSource.GutterRendererText` subclass reading a
  per-line map (the fold chevron + diagnostic glyph already do this).
- **`SyntaxController`** runs per view/buffer, so a synthesized pane can still get
  tree-sitter highlighting (set the language from the compared file's type).
- **`diff` v9** dependency (already used for `diffChars` in the vim layer) computes
  line/word/char diffs client-side; git (`GitRepo`) can also supply hunks.

## Gaps / needs on the text-editor side

1. **Read-only mode** — extend buffer-only mode with `readOnly`
   (`view.setEditable(false)`, vim nav-only / no insert). Diff panes don't edit.
2. **Diff-pane construction** — decide: reuse the buffer-only `TextEditor`
   (gets syntax + familiar nav for free; vim/search are harmless) vs a slimmer
   dedicated `DiffView`. Leaning reuse.
3. **Decoration styles** — have `added`/`removed` (line bg). Add: `modified`
   (line bg), intra-line **word-level** styles (`word-add`/`word-del`, stronger
   char-range bg), and a dimmed/hatched **filler** look. Small `TextDecorations`
   additions; char-range decoration already works.
4. **Diff gutter renderer** — `+ / − / ~` (or a colored change bar) per line, from
   a per-line change map. New `GtkSource.GutterRendererText` (pattern exists).
5. **Scroll-sync (side-by-side)** — lock the two views' vertical adjustments. With
   equal-height padded buffers it's a value copy on `value-changed` (or
   `GObject.bind_property` on the two `vadjustment`s). Needs **wrapping off** (the
   GtkSourceView default) so one buffer line == one display row on both sides.
6. **Filler / blank regions (side-by-side)** — solved by the synthesized buffer's
   padded blank lines, styled as filler; **no virtual-line API needed**.
7. **Hunk navigation** — `next-change` / `prev-change` commands over the diff
   model's hunk line-ranges (move cursor + scroll), plus an optional header count.
8. **Fold unchanged regions** (optional) — collapse large context blocks. The
   `invisible`-tag fold mechanism works, but `SyntaxController`'s is tree-sitter
   tied; a small line-range fold for diffs is cleaner.
9. **A `DiffModel`** — the structured input the renderer consumes: hunks of
   `{ kind: context|added|removed|modified, oldRange, newRange, lines, wordDiff? }`.
   Computed from `diff`/git; lives outside the editor but the panes render it.

## Open decisions (for you)

- **Reuse `TextEditor` (buffer-only, read-only) for panes, or a slimmer `DiffView`?**
  Recommend reuse — free syntax highlighting + decorations + scroll API; vim/search
  are harmless and handy for navigating a diff.
- **Syntax highlighting inside diffs?** Cheap to keep (run `SyntaxController` per
  pane with the file's language). Recommend yes.
- **Diff data source** — git (`GitRepo`) for working-tree/commit/staged diffs, the
  `diff` package for arbitrary two-text compares. The panes take a `DiffModel`
  either way; sequence with the **Git** workstream for real data.
- **Scroll-sync style** — hard-lock (always together) vs independent-with-catchup.
  Recommend hard-lock for v1.

## Recommended sequence

1. **Read-only buffer mode** + a `DiffModel` (hunks) abstraction. — *done*
   - [x] `DiffModel` (`src/util/DiffModel.ts`) — `computeDiff(old, new)` over the
     existing `lineDiff`: `lines` (unified context/added/removed, each with its
     old/new row), `hunks` (contiguous changed regions by `lines` row range), and
     `stats`. Pure, unit-tested (`DiffModel.test.ts`).
   - [x] Read-only buffer mode — `TextEditor({ buffer: { readOnly: true } })` sets
     `view.setEditable(false)` (vim nav still works; insert keystrokes no-op).
2. **Unified (inline) renderer** — *done*
   - [x] `DiffView` (`src/ui/TextEditor/DiffView.ts`) — synthesizes a read-only
     buffer from `model.lines` (the buffer-only `TextEditor`, so vim/search/
     decorations come free), paints `added`/`removed` line backgrounds via
     `editor.decorations`, and attaches a `DiffGutter`.
   - [x] `DiffGutter` (`src/ui/TextEditor/DiffGutter.ts`) — a
     `GtkSource.GutterRendererText` subclass (the `GitGutter` pattern) drawing
     `+`/`−` per line from `DiffModel.lines`. Added `TextEditor.sourceView` to
     attach it.
   - Verified it constructs in a real GTK context (decoration tags + vfunc gutter
     attach without error; synthesized buffer correct). Visual colors/glyphs need
     an interactive check. Remaining: full-line (paragraph) backgrounds, a
     language for syntax highlighting, and a header/stat line.
3. **Side-by-side** — *done*
   - [x] `splitSides` (`DiffModel.ts`) — pure transform of a `DiffModel` into two
     line-aligned, equally-tall panes (changed rows paired; shorter side padded
     with blank `filler` rows). Unit-tested.
   - [x] `SideBySideDiffView` (`src/ui/TextEditor/SideBySideDiffView.ts`) — two
     read-only panes in a `Gtk.Paned`, each with `removed`/`added`/`filler` line
     backgrounds + a `DiffGutter`; the two views' vertical scroll hard-locked
     (value copy on `value-changed`). Added a `filler` decoration style.
   - Verified it constructs in a real GTK context (panes/gutters/scroll-adjustments
     wire up; padded buffers correct). Live scroll-lock + colors need an
     interactive check.
4. **Polish** — *in progress*
   - [x] Word-level intra-line diff — `computeIntraLineDiff` (char diff via the
     `diff` package) annotates modified line pairs with `wordRanges` (skipping
     wholesale replacements); `word-add`/`word-del` char-span decorations render
     them over the line background. Pure part unit-tested; carried into
     side-by-side. Shared `applyDiffDecorations` helper.
   - [x] Full-line (paragraph) backgrounds — `added`/`removed`/`filler` now paint
     full-width via `paragraph-background` (a `TextDecorations` `LINE_STYLES`
     split).
   - [x] Hunk navigation — `next/prevHunk()` on both views (jump cursor + scroll
     to each changed region via `diffNav.revealRow`; side-by-side scrolls the left,
     the sync carries the right). `changeStartRows` unit-tested.
   - [x] `DiffViewer` (`src/ui/TextEditor/DiffViewer.ts`) — the embeddable widget:
     header with title + `+N −M` stats + prev/next-change + a unified↔side-by-side
     toggle, over a stack of the two renderers. `scripts/diff-demo.ts` uses it.
   - [x] Per-pane syntax highlighting — buffer-only mode gained a `languagePath`
     option (`SyntaxController.setLanguageForPath` after the text is set);
     `DiffView`/`SideBySide`/`DiffViewer` take it and the demo passes the new
     file's path. Needs `preloadGrammars()` first (the demo awaits it).
   - [x] `DiffViewer` polish — icon-only unified/side-by-side toggle + compact flat
     prev/next-change buttons (Nerd Font glyphs).
   - [x] Side-by-side pane focus — `Tab` switches between the two panes
     (`diff:focus-other-pane` command + keymap, selector-scoped to the diff views;
     `ctrl-w` stays app-pane nav). Read-only panes start unfocused (no caret until
     focused — fixes both panes showing a caret at creation).
   - [x] Empty-line backgrounds — synthesized buffers append a trailing newline so
     an empty last changed line is still terminated/taggable. (If empty *interior*
     lines ever lack a background, that's a GtkTextView tag limitation needing a
     custom line-background draw — not yet hit.)
   - [x] Fold unchanged regions — `foldUnchanged` (`DiffModel.ts`, pure +
     unit-tested) returns the collapsible context runs (over real buffer rows),
     keeping 3 lines of context around each change; `DiffFold` (`DiffFold.ts`)
     hides each fold's body with an `invisible` tag, draws a ▸/▾ chevron in the
     gutter (click to toggle), and — while collapsed — renders the
     `⋯ N unchanged lines` placeholder as an **inline block** (an overlay widget
     via `BlockDecorations`, zero buffer footprint — not editable/selectable;
     replaced the old synthesized placeholder line). Regions open collapsed. The
     two side-by-side panes fold from matching plans in lockstep (context rows
     align), so the scroll-sync stays valid. Diff panes turn SyntaxController's
     tree-sitter code folding off (`folding: false`). See
     [inline-widgets.md](inline-widgets.md) for the inline-block primitive.
   - [x] **Wire real data (working tree)** — `git:diff-current` (`space g d`)
     diffs the active file's working tree against its HEAD blob (`git show
     HEAD:<rel>`) → `DiffModel` → `DiffViewer` in a new tab.
   - [ ] More diff sources — staged / arbitrary commit / PR, and surfacing them
     (sequences with the Git workstream).

Net: no new widget primitive is strictly required — the synthesized-buffer
approach turns "diff" into "read-only buffer + decorations + a gutter + scroll
sync", all of which are small additions over what the search/decoration/buffer-only
work already landed. The real dependency is the **Git** data source.
