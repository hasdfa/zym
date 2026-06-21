# Git

The git subsystem covers three deliverables, plus extras that grew out of
them:

1. **Status viewer** — a Source Control panel (`GitPanel`), a sibling tab
   of the file tree in the left dock. File-level staging.
2. **Commit interface** — message edited in a normal editor tab, commit on
   save+close.
3. **Forge links** — GitHub repo/actions/issues/PR open-on-web, PR + CI
   status in the header, PR/issue/CI pickers, create/checkout PR. GitHub
   only (via `gh`).

Plus: **branch** switch/create/delete/merge/rename, **stash**
push/pop/apply/drop, a per-line **diff gutter** with **hunk-level
staging**, and a continuous multi-file editable diff view.

## Module boundary (public API)

The rest of the codebase imports git/GitHub functionality from exactly
**two** modules — **`src/git.ts`** and **`src/github.ts`**. Everything
under **`src/git/`** (`cli.ts`, `status.ts`) is internal:

- `src/git.ts` is the git facade — the reactive `GitRepo` (below) plus
  `export * from './git/cli.ts'`, which re-exports the CLI surface
  (status/staging/branch/stash/commit/worktree helpers + types). Callers
  do `import { … } from '../git.ts'`.
- `src/github.ts` is the GitHub facade: the reactive `GithubService` plus
  the `gh`-backed read functions. It is the one other module allowed to
  use `git/cli.ts` directly (it imports the async `git`/`repoRoot`) —
  deliberately, so it stays GTK-free and unit-testable. Its `gh` spawns
  also route through the process runner.

Invariant (grep-checkable): nothing outside `git.ts`/`github.ts` imports
`git/cli.ts` or `git/status.ts`.

## I/O model

Use `node:child_process` + the `git`/`gh` CLI directly. **Every** git/gh
invocation is **asynchronous** (callback form) — there is no synchronous
git path. Node async IO resolves normally under the live GLib loop;
promises/microtasks are starved, so the whole surface is callbacks (no
promise wrappers). Simpler than `Gio.Subprocess`, and hands us stdout
directly.

All spawning goes through the **process runner** (`src/process/runner.ts`
+ `runner-main.ts` — see [../process-runner.md](../process-runner.md)): the
long-lived ~1.5 GB node-gtk process must never `fork()` (this Node's
libuv has no `posix_spawn` fast path, so fork cost scales with RSS — tens
of ms/spawn). The parent forks once to launch a tiny child; every command
then forks *that* (~1 ms). `cli.ts`'s `git()` and github.ts's `gh()` both
call `runProcess`, with a direct-spawn fallback if the runner is down. IPC
is **binary** (`src/process/codec.ts`): a length-prefixed frame whose
stdout/stderr (up to 64 MiB) cross the pipe as raw bytes, never
JSON-escaped.

Repo topology is derived straight from the on-disk git layout — pure `fs`
reads, no subprocess: `repoRoot` (walk up for `.git`, memoized),
`worktreeInfo`, and `listWorktrees` (read `<common>/worktrees/*` + HEAD
via `commondir`/`gitdir`). The cold callers (branch/stash pickers, github
remote resolution, the commit message path) take a callback.

**Remaining perf work:** coalesce the `onChange` fan-out (one `git status`
per root feeding all gutters instead of per-editor `git show` pairs, plus
a per-file gate so a gutter only re-fetches when its own file moved).

## Backend: the git CLI helper — `src/git/cli.ts` (internal)

The CLI gives us exactly what `git status`/`git diff` print (no
re-deriving with libgit2 diffs) and respects the user's hooks and config
(name/email, GPG, pre-commit/commit-msg) for free.

Core primitives (note: `cwd`/`root` is the first arg of every call):

```ts
git(cwd, args, onDone): void;                // async (process runner); onDone(ok, stdout, stderr)
repoRoot(cwd): string | null;                // nearest ancestor with `.git` — pure fs, memoized
commitMsgPath(root, onDone): void;           // async; .git/COMMIT_EDITMSG (via rev-parse --git-path)
```

It also exposes the pure-fs `worktreeInfo` / `listWorktrees`,
`invalidateRepoRoot`, and the async `currentBranch(root, cb)` /
`listBranches(root, cb)` / `listStashes(root, cb)`. There is no `gitSync`.

### Status model

`getChangesAsync(root, cb)` parses `git status --porcelain=v2 -z` into a
flat list the panel groups itself; a file edited in both index and
worktree is pushed as **two** rows (staged + unstaged):

```ts
type GitFileState = 'new' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
interface GitChange {
  path: string;     // absolute
  state: GitFileState;
  staged: boolean;  // index vs HEAD
  unstaged: boolean;// workdir vs index
}
```

It runs the runner's async `git()`, so the Source Control panel (and the
staging view) refresh without blocking the UI thread. Porcelain v2 reports
staged (X) and unstaged (Y) state per file in one call. Per-row line counts
(±) are not surfaced in the panel.

### Mutations

Each is an `execFile`-callback function:

- stage / unstage: `stage` (`git add`), `unstage` (`git restore
  --staged`); `stageAll`, `unstageAll`
- hunk staging: `applyPatch` (`git apply --cached` of a synthesized hunk
  patch — see the diff gutter)
- discard: `discard` (`git restore`, tracked) / `clean` (`git clean`,
  untracked) — destructive, confirmed first
- commit: `commit(root, messageFile)` → `git commit -F <msgfile>` (no
  `--amend`/`--signoff` yet)
- branch: `currentBranch`, `listBranches`, `switchBranch`, `createBranch`,
  `deleteBranch`, `mergeBranch`, `renameBranch`
- stash: `listStashes` (→ `Stash[]`), `stashPush`, `stashPop`,
  `stashApply`, `stashDrop`

Pure parsers live in `src/git/status.ts` (`parseStatus`, `parseNumstat`,
`parseLsFiles`), unit-tested in `status.test.ts`.

## The reactive `GitRepo` — `src/git.ts`

`CliGitRepo implements GitRepo` (created via `openGitRepo`, pooled via
`acquireGitRepo`/`releaseGitRepo`). It exists because several call sites
read git state **synchronously** and cannot await:

- command predicates — `when: () => this.git.getBranch() !== null`.
- `GitBranchButton.refresh()` / `FileTree.refreshStatuses()` — render
  synchronously inside an `onChange` callback.

So the architecture is **async background poll → cached state →
synchronous getters**:

```
                 ┌─ git status --porcelain=v2 --branch -z --untracked-files=all ─┐
 1.5s poll  ──►  ├─ git diff --numstat -z HEAD ─────────────────────────────────┤
 (+ HEAD watch)  └─ git ls-files -z  (only when the index/HEAD moved) ───────────┘
                                   │  git(cwd, args, cb) — async, never blocks
                                   ▼  parse (pure fns, unit-tested)
                         this.state = { branch, commit, status, ahead,
                                        conflicts, fileStatuses, tracked }
                                   │ fire onChange iff signature() changed
   getBranch()/getHead()/getStatus()/… ◄────┘  cached field reads, no I/O
```

- Warmed up **asynchronously** at construction (`warmUp()`): an async
  `rev-parse --absolute-git-dir` + an immediate async `pollOnce()`, so
  acquiring a repo never blocks the UI thread. The getters return the
  empty state until that first poll lands (~tens of ms) — first paint
  shows a blank branch indicator for a frame, then the poll's `notify()`
  fills it in (subscribers register on the same tick as the acquire,
  before status returns).
- **Change detection**: a **chokidar** watch on `<git-dir>/HEAD`
  (`startHeadWatch`, attached once the async warm-up resolves the git dir;
  chokidar handles the atomic rename git does to `HEAD`) for instant
  branch-switch/commit reaction, plus the 1.5 s poll for working-tree
  edits and staging. On a HEAD event the signature is reset and
  `pollOnce()` runs. `signature()` is computed from the porcelain output —
  branch, HEAD commit, ahead/behind, conflicts, **per-file
  staged/unstaged/untracked state**, and ± totals — so it moves on edits,
  staging (including external `git add`), branch/upstream changes, and any
  HEAD move (commit/reset/external push).
- `getStatus()` totals count tracked `--numstat` adds/dels **plus**
  untracked files as insertions (the branch indicator's `+` relies on
  this). `countNewLines` caps each untracked file at 10 MiB and treats
  binaries as 0; the whole subprocess output is bounded by the 64 MiB
  `maxBuffer`.

### Coordinated mutations

Every repo mutation goes through a **named method on `GitRepo`** that
marks the repo busy (the branch indicator spins), runs the git/gh command,
then refreshes and reports `(ok, stderr)` via `GitOpDone`:

- git: `fetch`, `pull`, `push`, `commit(messageFile)`, `stash`,
  `stashPop/Apply/Drop(ref)`,
  `switchBranch/createBranch/deleteBranch/mergeBranch/renameBranch(name)`
- gh: `checkoutPullRequest(number)` — wraps github.ts's `gh pr checkout`.

The UI calls these (e.g. `git.switchBranch(name, report)`) and never
manages busy state itself. The coordination primitives are **private**:
`mutate(op, onDone)` brackets the op with `begin()`/end (reference-counted
busy + a forced `pollOnce()` refresh on completion). There is no public
`run`/`beginOperation`, so callers can't bypass the coordination
(type-enforced). This matters for a multi-second `gh pr checkout`
(switches branch, fetches forks): it spins the indicator and refreshes on
completion instead of waiting on the file watch.

## UI

### Left-dock layout

Source Control is a **sibling tab of the file tree** in the left-dock top
panel. `buildWorkbench` (`AppWindow`) adds only the `  Files` tab
(`fileIconGlyph`) up front; the ` Git` tab (`Icons.git`, embedded in the
Adw tab title) is **created lazily** the first time it's revealed
(`AppWindow.ensureGitPanel`, driven by `git-panel:focus`), so a workbench
opens no git-subscribing `GitPanel` until the user asks for it
(`workbench.gitPanel`/`gitTab` are null until then). The panel collapses
out of the workbench when its last tab closes; the reveal/focus path
re-attaches it (per-workbench, so each agent workbench has its own).
`#GitPanel` is the CSS/selector identity.

### Status viewer — `src/ui/GitPanel.ts`

Component **`GitPanel`** (`#GitPanel`), exposing `root` (a scrollable
column). Constructed with `{ cwd, git, onOpenFile, onCommit }`; rebuilds
on `git.onChange` via an async `getChangesAsync` fetch (a generation guard
drops a result superseded by a newer refresh — no `git status` on the UI
thread). `setRoot(cwd, git)` re-roots it when an agent moves into a
worktree.

- **Staged** group — `RowKind: 'staged'`, per-row unstage, drawn in
  `theme.ui.success`.
- **Changes / Untracked** — `RowKind: 'unstaged'`, stage + discard, drawn
  in `theme.ui.error`.

Each group is a small header (label + count) over a `Gtk.ListBox` of file
rows (file icon + path + a single-letter state badge, `STATE_LETTER`).
Rows are cursor-navigable (header rows non-selectable). Actions go through
the command system so they're keybindable while the panel is focused: `s`
stage, `u` unstage, `A` stage-all/unstage-all toggle, `X` discard, `c c`
commit — mirroring FileTree's bare-key bindings. Clicking/`o` opens the
file. In-panel diffs are not shown here; the diff surfaces are the editor
tab and the gutter.

The same staging is reachable **from anywhere** (no need to focus the panel)
via the `space g` leader, registered on `#AppWindow`. The `a`dd / `u`nstage
sub-leaders take `a` (all) or `.` (current file): `space g a a`
(`git:stage-all`, `git add -A`) and `space g a .` (`git:stage-current`, `git
add <file>`); `space g u a` (`git:unstage-all`, `git reset`) and `space g u .`
(`git:unstage-current`). They shell out via `git/cli.ts` and then call
`workbench.git.refresh()` so the gutter and branch indicator update at once.

### Commit interface — edit-in-tab

`c c` (`git:commit`) calls `onCommit` → `AppWindow.startCommit()`, which
opens `.git/COMMIT_EDITMSG` in a **normal editor tab**; **saving + closing
the tab commits** (`git commit -F .git/COMMIT_EDITMSG`). This reuses the
full editor (vim, chrome) with zero `TextEditor` changes and keeps the
message git-native. Result/failures surface through `zym.notifications`;
on success the lists refresh.

**Amend** (`space g C`, `git:commit-amend`) uses the same edit-in-tab flow
but prefills the message with the last commit's (`lastCommitMessage` →
`git log -1 --format=%B`) and finalizes with `git commit --amend`. The
`amend` flag rides through `commitEditors` → `finishCommit` →
`GitRepo.commit(messageFile, amend)`.

Not done: sign-off, commit-message length ruler, branch-name placeholder.

### Branch / stash pickers

- **`src/ui/BranchPicker.ts`** — switch/create (`openBranchPicker`, `space
  g b b`), delete (`space g b d`), merge into current (`space g b m`),
  rename (`space g b r`). `GitBranchButton` opens the branch picker on
  click (no popover; the picker is the switcher).
- **`src/ui/StashPicker.ts`** — push (`space g s s`), and pop/apply/drop
  via a picker over `listStashes` (`space g s p`/`a`/`d`).
- **`GitBranchButton`** — header indicator (branch, ±lines, ↑↓, busy
  spinner).

### Diff gutter + hunk staging — `src/ui/TextEditor/GitGutter.ts`

A `GtkSource.GutterRendererText` subclass drawing a VS Code-style change
bar per line. Two in-process Myers diffs feed it (`util/lineDiff`): the
live buffer vs the file's **index** blob (unstaged changes — green added /
amber modified / red deletion marker) and the index vs the **HEAD** blob
(staged changes — blue). Both base blobs are refetched (two `git show`
spawns) on load and on any `GitRepo.onChange`, debounced and
generation-guarded against stale async results. The refetch is **skipped
while the editor is unmapped** (off-screen tabs/docks) and runs on the
next `map`, so only visible editors refetch on a repo change.

It also drives **hunk-level staging**: `stageHunk`/`unstageHunk` (`space h
s` / `space h u`) synthesize a unified diff for the hunk under the cursor
and `git apply --cached` it (via `applyPatch`); `revert-hunk` (`space h
r`) is done in the buffer by the editor. Hunk helpers live in
`util/hunkPatch.ts`.

### Inline blame — `src/ui/TextEditor/GitBlameController.ts`

Current-line blame (GitLens-style), gated by the **`editor.lineBlame`**
config flag (off by default). While on, the line under the cursor trails the
blame for the commit that last touched it (or `You • Uncommitted changes` for
the zero-sha working-tree line). The fields and their order come from
**`editor.lineBlameFormat`** (default `[message, time, author]`; tokens
`message`/`time`/`author`/`date`/`sha`, joined by ` • `, parsed by
`formatBlame`).

Built on `VirtualText` (the native `GtkSourceAnnotations` API, `NONE` style —
plain trailing text, no background), like `InlayHintController`. Blame is
fetched per file with `git blame --line-porcelain --contents -`, feeding the
**live buffer** on stdin so line numbers and uncommitted lines match what the
user sees (not the on-disk file); the result is parsed by `parseBlame` and
cached. Cursor moves and fold toggles re-place the single annotation from the
cache with no new git call (mapping VIEW→MODEL lines through the document, for
folds); an edit invalidates the cache so the next render re-blames (debounced).

Independent of the inline annotation, **`git:show-commit`** (`space g m`) pops
the **full message** of the commit that last touched the cursor line above the
cursor, reusing the LSP hover card. It blames just that line
(`blameCommitForLine` → `git blame -L n,n --contents -`) for the sha, then
`git show -s` for the message; `blameCommitAtCursor` is the shared entry point
(also used by `github:open-pr-for-line`).

### Continuous editable diff

Multi-file staging is done through a **continuous multi-file editable diff
view** (opened with `space g o` / `space g D`): each changed file's hunks
are editable inline, hunk staging via the gutter marker + `space h s` /
`space h u`, commit via `space g c`. It is built on the editor's
multibuffer substrate — see
[../text-editor/multibuffer.md](../text-editor/multibuffer.md). This
replaced the earlier tab-hosted `GitStagingView`; its original design is
recorded in [staging-interface.md](staging-interface.md).

## Forge: GitHub — `src/github.ts` + `src/ui/Github*.ts`

Implemented as a concrete **GitHub** integration driven by the `gh` CLI
(not an abstract `Forge` interface — a second provider can be factored out
if/when GitLab lands).

- **Remote resolution** — `resolveGithubRepo(root, remoteNames)` lists
  remotes, resolves the first present in order, parsing SSH/HTTPS via
  `parseGithubRemote` → `{ host, owner, repo }`. Order is **`upstream`
  then `origin`**, both from config. `repoWebUrl` builds the base URL.
- **`gh`-backed reads** — `fetchPullRequest` (number, url, title, state,
  CI rollup, linked issue), `fetchChecks` / `fetchFailedChecks`,
  `searchPullRequests`, `fetchIssues`, `fetchDefaultBranch`,
  `createPullRequestWeb`, `checkoutPullRequest`.
- **`GithubService`** (`openGithubService(git, options)`) — the reactive
  model: caches PR/CI/default-branch state plus busy, exposes synchronous
  getters and `onChange`, and refreshes off the underlying `git` changes.
  The header view is a pure view over it.
- **`GithubButtons`** (header) — a `.linked` pair of buttons over
  `GithubService`: the PR segment shows the current branch's PR
  (state-colored glyph + `#1234`) and opens it, or becomes a **create-PR**
  affordance on a non-default branch; the CI segment shows the PR's check
  rollup and opens the checks picker. Hidden when there's nothing
  actionable.
- **Pickers** — `GithubPrPicker` (checkout), `GithubIssuePicker`,
  `GithubCIChecksPicker`, `GithubFailedCIPicker`.
- **Commands / keymaps** (`space g h …`) — `r` repo, `a` actions, `i`
  issues, `p`/`c` PR checkout, `n` new PR, `o` open this branch's PR, `l`
  open the current line (`github:open-line`), `L` open the PR that introduced
  the current line (`github:open-pr-for-line`), `f` failed CI.

Not done: `#123`-in-text / branch-name / selection detection (offer *Open
#123*); `compareUrl`; GitLab and other providers.

## Config: default git workflow

Config keys registered in `src/zym.ts` (same mechanism as `editor.*`),
read via `zym.config.get`:

| Key                    | Type   | Default      | Description                                              |
| ---------------------- | ------ | ------------ | -------------------------------------------------------- |
| `git.remotes.upstream` | string | `"upstream"` | Remote name for the canonical repo (PRs/issues, fetch). |
| `git.remotes.origin`   | string | `"origin"`   | Remote name for your fork (push).                        |

Used by forge resolution (upstream → origin order) and as the natural
defaults for push/pull targets. More knobs (default push remote,
auto-fetch interval) can be added as we iterate.

## Shared concerns

- **Errors & feedback**: every mutation reports through
  `zym.notifications` (success info / failure error). `AppWindow` also
  offers `git:pull` when the branch falls behind upstream.
- **Commands first, bindings central**: each component registers its
  handlers; key bindings live in `src/keymaps/default.ts` (vim bare keys
  while the relevant list/panel is focused).
- **Theming**: reuse the semantic colors wired for diffs/sync
  (`.zym-diff-added/-removed`, the `theme.ui.success/error/warning`
  keys).
- **Destructive ops** (discard, force) confirm first and never run
  implicitly.

## Correctness edge cases (parsers + `status.test.ts`)

Not-a-repo → all null/empty; detached HEAD → branch = short SHA,
ahead/behind null; unborn branch (`diff HEAD` fails) → everything
untracked/added; renames consume the trailing original-path token;
worktrees/submodules resolve via `cwd`. Porcelain v2 includes the staged X
state, so an external `git add` fires `onChange`.

## Remaining / planned

- [ ] Commit extras: amend, sign-off, amend prefill, length ruler
- [ ] Forge: `#123` reference detection → open issue/PR; open file/line on
  web (`blameUrl`/`compareUrl`)
- [ ] Forge: GitLab provider (factor out a `Forge` interface when it
  lands)
- [ ] In-panel diffs in `GitPanel` itself
- [ ] More git diff sources (commit / PR) — see text-editor/diff.md
- [~] Perf: coalesce the `onChange` fan-out (one `git status` per root +
  per-file refetch gate)
