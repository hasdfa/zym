# Diff display

A read-only diff viewer (git working-tree / commit / "compare two texts") in two
presentations:

- **Inline (unified)** — one column; context, added, and removed lines stacked.
- **Side-by-side** — two columns (old | new), line-aligned and scroll-synced.

A separate, harder feature — live gutter change-bars **while editing** a file with
uncommitted changes — is out of scope here (that's the git gutter; see
`src/util/lineDiff.ts`, which the live gutter also uses).

## The approach: synthesized read-only buffers

A diff needs to show content/space that isn't in the file: **deleted lines**
(inline) and **alignment fillers** (side-by-side, where one side gained/lost lines
the other must pad to stay aligned). GtkTextView **cannot** insert blank vertical
regions or phantom lines between real lines except by embedding a heavy
`GtkTextChildAnchor` widget per gap, or by making the content **real buffer lines**.

So each pane is a buffer whose lines ARE the diff: for unified, context + added +
removed lines all as real text; for side-by-side, each side padded with **blank
filler lines** so the two line up 1:1. Panes are styled with `editor.decorations`
+ a diff gutter. Both sides having equal line counts (via padding) and no wrapping
means row *N* sits at the same pixel *y* on both, so scroll-sync is a trivial
adjustment-value copy. (True virtual lines on a *live editable* buffer are only
needed for editing-with-inline-deleted-peeks, not a viewer — see
[virtual-lines.md](virtual-lines.md).)

Each pane reuses the buffer-only `TextEditor` (`TextEditor({ buffer: { readOnly: true, ... } })`),
so it gets vim navigation, search, decorations, the gutter plumbing, and per-pane
tree-sitter highlighting (via `SyntaxController`) for free.

## The pieces

**Model (pure, GTK-free, unit-tested) — `src/util/DiffModel.ts`:**

- `computeDiff(oldText, newText)` → `DiffModel { lines, hunks, stats }`. Lines are
  computed over `diffLines` (`src/util/lineDiff.ts`, a minimal Myers O(ND) diff
  that degrades to a whole-file replace past size bounds).
- `DiffLine.kind` is `context | added | removed` — there is **no** `modified`
  kind; a modification is a removed↔added pair. `annotateWordDiffs` /
  `computeIntraLineDiff` (char diff via the `diff` package, `^9`) attach
  `wordRanges` to such pairs for intra-line highlighting (skipped for wholesale
  replacements). `refineWordRanges` then tidies each line's spans for display:
  whitespace-separated spans merge into one, and a lone span covering all of a line's
  non-whitespace content is dropped (the full-line background carries it).
- `DiffHunk` points at a `lines` row range (`startRow`/`rowCount`) plus
  added/removed counts and old/new start rows — used for hunk navigation.
- `splitSides(model)` → `{ left, right }`: line-aligned `SideLine[]` panes, the
  shorter side padded with `filler` rows.
- `foldUnchanged(lines)` → `DiffFoldInfo[]`: runs of unchanged lines to collapse
  (keeping 3 context lines around each change), generic over `DiffLine`/`SideLine`
  so the two side-by-side panes fold in lockstep. `diffFoldLabel` computes each
  collapsed run's placeholder (the enclosing scope's header line, git-diff style).

**Renderers — `src/ui/TextEditor/`:**

- `DiffView.ts` — the unified pane. Synthesizes the read-only buffer from
  `model.lines`, applies decorations, attaches a `DiffGutter` and two
  `DiffLineNumberGutter`s (old | new file-line columns), and installs the
  unchanged-run folds via `editor.setDiffFolds(...)`. `nextHunk`/`prevHunk` jump
  through `changeStartRows` (`diffNav.ts`).
- `SideBySideDiffView.ts` — two read-only panes in a `Gtk.Paned` from
  `splitSides`, each with its own decorations + gutter; the two views' vertical
  scroll is hard-locked (value copy on `value-changed`). Both panes fold from the
  same `foldUnchanged` plan, so the alignment (and scroll-sync) stays valid.
- `DiffViewer.ts` — the user-facing widget a tab/command embeds: a header (title +
  `+N −M` stats + prev/next-change + an icon-only unified↔side-by-side toggle) over a
  content box holding the **active** renderer only. One renderer is built at a time;
  the toggle destroys the live one and builds the other (and the box sizes to the
  single live pane for free). Renderer `dispose()` tears its `TextEditor`(s) down
  fully — the switch detaches (not destroys) the old root, so the `destroy` fallback
  never fires (see [lifecycle-and-disposal.md](lifecycle-and-disposal.md)).
  `header: false` for embedders with their own chrome (the inline staging diff).
- `DiffGutter.ts` — a `GtkSource.GutterRendererText` subclass drawing `+`/`−` per
  line, keyed by **model** row (translated through folds).
- `applyDiffDecorations.ts` — shared helper applying full-line backgrounds
  (`added`/`removed`/`filler`, full-width via `paragraph-background`) and
  `word-add`/`word-del` char-span decorations onto a decoration layer. A
  `paragraph-background` needs a char/newline on the line to paint, so the buffer is
  built (`diffBufferText`) with a trailing newline **only** when the last line is
  empty-and-changed; otherwise the last line's decoration spans its content instead of
  `[row+1,0)` (which would collapse) — avoiding a spurious trailing blank row.

**Folding** uses the editor's *diff fold method* — the same fold projection +
chevron gutter as code folding (`SyntaxController.setDiffFolds`, driven by the vim
z-fold commands), collapsing each run to a `⋯ N unchanged lines` placeholder.
Enabling diff folds disables tree-sitter syntax-fold discovery on that view.

## Data sources

- **`git:diff-current`** (`space g d`, `AppWindow.diffActiveAgainstHead`) — diffs
  the active file's working tree against its HEAD blob (`git show HEAD:<rel>`,
  empty base for an untracked file) → `computeDiff` → `DiffViewer` in a new tab.
- The inline staging diff embeds `DiffViewer` with `header: false`
  (`GitStagingView.ts`).
- `scripts/diff-demo.ts` drives `DiffViewer` standalone (awaits `preloadGrammars()`
  for syntax highlighting first).

Remaining: more diff sources (staged / arbitrary commit / PR) and surfacing them —
sequences with the Git workstream.

The next-generation surface for these is a **continuous, multi-file, editable diff**
(replacing `GitStagingView`'s accordion) — see
[multibuffer.md](multibuffer.md), which also folds the per-pane syntax parse back
onto the model.

See [inline-widgets.md](inline-widgets.md) for the inline-block primitive (used by
the staging chrome / peek, not by the current fold placeholder).
