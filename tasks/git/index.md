# Git

Architecture plan for the Git section. Three deliverables, in priority order:

1. **Status viewer** — a Source Control panel in the left dock (changed files,
   staging, diffs).
2. **Commit interface** — inline in that panel, using a `TextEditor` widget for
   the message.
3. **Forge links** — GitHub PR/issue links when applicable, then GitLab etc.

This page covers the architecture; per-feature implementation pages can be split
out later (`status-viewer.md`, `commit.md`, `forge-links.md`) if they grow.

## Current state

What already exists and is reused, not rebuilt:

- **`src/git.ts` — `GitRepo`** (libgit2 via Ggit). Synchronous reads
  (`getBranch`, `getStatus` ±lines, `getAheadBehind`, `getFileStatuses`,
  `getTrackedPaths`), an async mutation path (`run(args, onDone)` via
  `Gio.Subprocess`, non-blocking, GLib-native), `isBusy`, and `onChange`
  (HEAD file-monitor + 1.5s working-tree poll keyed on a `signature()`).
- **`BranchButton`** — header indicator (branch, ±lines, ↑↓, busy spinner). Its
  own comment notes it is meant to grow into a branch switcher popover.
- **`FileTree`** — per-file status (untracked / ±lines) and a hide-untracked
  filter, refreshed on `git.onChange`.
- **AppWindow** — `git:fetch` / `git:pull` / `git:push` commands and the
  upstream-behind notification (offers `git:pull` when the branch falls behind).
- **Notifications** — `quilx.notifications` for surfacing operation results and
  failures (replaces ad-hoc toasts).

Constraints carried from the codebase:

- **I/O model (measured, not assumed).** A probe under the live GLib main loop
  (`startLoop()` + `loop.run()`) showed:
  - `child_process.execFileSync` / `node:fs` sync — **work** (already used by
    FileTree / FilePicker).
  - `child_process.execFile` **callbacks** — **fire promptly** with full stdout.
  - **Promise / microtask** resolution — fires only when the loop yields, so it
    is effectively starved (this, not "child_process is broken", is why the
    earlier promise-based `simple-git` attempt appeared to hang — see `git.ts`).

  Conclusion: **node I/O is fine** for git. Use `node:child_process` directly —
  `execFileSync` for fast local reads, `execFile` (callback form) for anything
  slow or networked. Avoid promise-based wrappers until the loop integration
  drains microtasks. This is simpler than the `Gio.Subprocess` path and hands us
  stdout directly.
- **Strip-only TS** (see project memory): no enums, no parameter properties, no
  namespaces.
- **One main component per file** under `src/ui`, camel-cased after the
  component.

## Backend: a small git CLI helper

Keep it simple: the new git operations use **`node:child_process` + the `git`
CLI** rather than extending the libgit2 `GitRepo`. The CLI gives us exactly what
`git status`/`git diff` print (no re-deriving with three libgit2 diffs), and
respects the user's hooks and config (name/email, GPG, pre-commit/commit-msg)
for free. The existing libgit2 reads (BranchButton, FileTree) stay as-is for now;
consolidate later if it's worth it.

A thin module — `src/git/cli.ts` (working name) — wrapping the CLI:

```ts
gitSync(args: string[]): string;                              // execFileSync, fast local reads
git(args: string[], onDone: (ok: boolean, stdout: string) => void): void;  // execFile callback
```

(No promise wrappers — microtasks are starved under the loop; see Current state.)

### Status model

Parse `git status --porcelain=v2 -z` into a flat list the panel groups itself:

```ts
type GitFileState = 'new' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
interface GitChange {
  path: string;     // absolute
  state: GitFileState;
  staged: boolean;  // index vs HEAD
  unstaged: boolean;// workdir vs index
}
```

Porcelain v2 already reports staged (XY index) and unstaged (XY worktree) state
per file in one call, so no separate diffs. Line counts (±) for a row, when
wanted, come from `git diff --numstat`/the diff itself — defer if not needed for
the first cut.

### Mutations

- stage: `git add -- <path>`
- unstage: `git restore --staged -- <path>`
- discard: `git restore -- <path>` (destructive — confirm first)
- commit: `git commit -F <msgfile>` (+ `--amend`, `--signoff`)
- diff text: `git diff [--staged] -- <path>`

### Refresh

After an in-app mutation completes, refresh directly (the callback fires
promptly). To also catch changes made from a terminal, reuse the existing
`git.onChange` (HEAD monitor + poll); note its `signature()` is HEAD→workdir
totals and does **not** move on staging alone, so external `git add` won't auto-
refresh until `signature()` learns about the index — a known gap, fine to defer.

## UI: left-dock layout

Today the left dock is a vertical `Gtk.Paned`: FileTree (top) / AgentList
(bottom). Add Source Control **above** the file tree → a three-section vertical
stack (nested Paneds), top to bottom:

```
left dock
├── SourceControl   (new — top)
├── FileTree
└── AgentList
```

`AppWindow` builds this; the Source Control section gets a `setName` for
command/keymap/CSS identity, like the other docks. Placement is provisional
("might be moved later"), so SourceControl stays a self-contained component with
a single `root`, droppable into any slot.

## Feature: status viewer

New component **`src/ui/SourceControl.ts`** (`#SourceControl`), exposing `root`
(a scrollable column). Driven by `quilx`'s injected `GitRepo`; rebuilds on
`git.onChange`.

Layout, top to bottom:

- **Commit area** (see next section).
- **Staged** group — files with a per-row unstage action.
- **Changes** group — unstaged tracked edits, with stage / discard actions.
- **Untracked** group — with stage / discard.

Each group is a small header (label + count) over a `Gtk.ListBox` of file rows
(icon via `fileIcons`, path, ±badge reusing FileTree's status markup). A group
header carries a bulk action (stage-all / unstage-all). Rows expose actions as
hover buttons and via the command system so they are keybindable (vim-style
`s`/`u`/`x` while the panel is focused, mirroring FileTree's bare-key bindings).

**Diffs.** Not in this pass — rows show status and support staging only. Diff
display (`git diff …` rendered in a tab or panel) is deferred; revisit once the
basics land and the diff-display / grammar tasks are picked up.

## Feature: commit interface

Inline at the top of the Source Control panel, **using a `TextEditor` widget**
for the message (so vim editing + the editor's chrome come for free):

- Embed a `TextEditor` instance (`editor.root`) sized to a few lines, with a
  Commit button (and an overflow for `--amend` / `--signoff`).
- Commit writes the buffer to a temp file and runs
  `git(['commit', '-F', file], …)`; result + failures surface through
  `quilx.notifications`. On success, clear the buffer and refresh the lists.

**Buffer backing — a commit-message file (decided).** `TextEditor` is
file-oriented today (`loadFile`, `currentFile`, `save`), so the message buffer is
backed by a real file (`.git/COMMIT_EDITMSG`): load it into the embedded editor,
and commit with `git commit -F .git/COMMIT_EDITMSG`. Git-native and fits the
existing model with no editor changes. (Non-file / scratch buffers come later as
a general `TextEditor` capability; the inline editor switches to that then.)

Niceties (later): commit-message ruler/length hint, amend prefill from
`git log -1 --format=%B`, branch name in the placeholder.

## Feature: forge links (GitHub / GitLab / …)

Turn git refs into web URLs and open them in the browser.

- **Remote model (configurable workflow)**: a fork-friendly setup has two
  remotes — `upstream` (the canonical repo, where PRs/issues live) and `origin`
  (your fork). PR/issue detection resolves **`upstream` first, then `origin`**,
  so it points at the canonical repo when there is one. Both remote names are
  config (see below) and default to `upstream` / `origin`; when `upstream` is
  unset or absent, `origin` is used alone.
- **Remote parsing**: `gitSync(['remote', 'get-url', <name>])` → normalize
  SSH/HTTPS to `{ host, owner, repo }`. Detect provider by host
  (github.com / gitlab.com / self-hosted patterns).
- **`Forge` abstraction**: an interface mapping entities to URLs
  (`issueUrl(n)`, `prUrl(n)`, `commitUrl(sha)`, `branchUrl`, `compareUrl`,
  `blameUrl(file, line)`), with `GitHubForge` first, then `GitLabForge`.
  Self-hosted instances differ only by base URL + path templates.
- **"When applicable"**: detect `#123` references in commit messages, the
  current branch name, and selected text; offer *Open #123* against the resolved
  forge. Plus always-available commands: *Open repo on web*, *Open current
  branch*, *Open file/line on web*.
- Surfaced as commands (palette + keybindings) and as actions on relevant rows.

MVP: resolve `upstream`→`origin`, GitHub remote parsing, *open
repo/branch/file-line*, and `#123` resolution. GitLab and richer PR/issue
metadata (titles, state — needs an authenticated API) come later.

## Config: default git workflow

New config keys (registered in the app schema, same mechanism as `editor.*`):

| Key                     | Type   | Default      | Description                                              |
| ----------------------- | ------ | ------------ | -------------------------------------------------------- |
| `git.remotes.upstream`  | string | `"upstream"` | Remote name for the canonical repo (PRs/issues, fetch). |
| `git.remotes.origin`    | string | `"origin"`   | Remote name for your fork (push).                        |

Used by forge resolution (upstream → origin order) and as the natural defaults
for push/pull targets later. Kept minimal now; more workflow knobs (default
push remote, auto-fetch interval, …) can be added as we iterate.

## Shared concerns

- **I/O**: the new git ops use `node:child_process` + the `git` CLI —
  `execFileSync` for fast local reads, `execFile` (callback) for slow/networked
  ops. No promise wrappers (microtasks are starved under the loop).
- **Refresh**: in-app mutations refresh on their callback; `git.onChange`
  (existing) covers external changes (with the staging-signature gap noted above).
- **Errors & feedback**: every mutation reports through `quilx.notifications`
  (success info / failure error), consistent with fetch/pull/push.
- **Commands first, bindings central**: each component registers its handlers;
  key bindings live in `src/keymaps/default.ts` (vim bare keys while the panel is
  focused, like FileTree).
- **Theming**: reuse the semantic colors already wired for diffs/sync
  (`.quilx-diff-added/-removed`, the `theme.ui.success/error/...` keys).
- **Destructive ops** (discard, force) confirm first and never run implicitly.

## Phasing

- [ ] Backend: `src/git/cli.ts` helper (`gitSync` / `git`) + `git status --porcelain=v2` parsing
- [ ] Left-dock: add the SourceControl section above the file tree
- [ ] Status viewer: staged/changes/untracked lists with stage/unstage/discard
- [ ] Commit: inline TextEditor over `.git/COMMIT_EDITMSG` + `git commit -F`
- [ ] Commit extras: amend, sign-off, amend prefill
- [ ] Config: `git.remotes.upstream` / `git.remotes.origin`
- [ ] Forge: remote parsing (upstream→origin) + `Forge` interface + GitHub open-on-web
- [ ] Forge: `#123` reference detection → open issue/PR
- [ ] Forge: GitLab provider

## Decisions (first pass)

- **Diffs**: none yet — status + staging only; diff display deferred.
- **Commit buffer**: backed by `.git/COMMIT_EDITMSG` (non-file buffers later).
- **Staging**: file-level only (hunk/line staging later).
- **BranchButton**: no popover yet — stays a plain indicator.
