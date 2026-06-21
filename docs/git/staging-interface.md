# Staging interface (tab-based) — superseded

> **Superseded by the continuous editable diff multibuffer**
> ([../text-editor/multibuffer.md](../text-editor/multibuffer.md)).
> The `GitStagingView` described here was retired; this doc is kept for the
> design ideas that informed the replacement (per-row diff base, no-prompt
> discard semantics, untracked = all-added).

The original idea was a second Source-Control surface opening **as an editor
tab** (distinct from the left-dock `GitPanel`, which stays). It mirrored
`git status` — staged files green, unstaged/untracked red — and expanded an
inline read-only diff beneath any file row (an accordion), in the same widget.

## Design ideas worth keeping

- **File list = file-level staging only** (stage / unstage / discard whole
  files), grouped Staged / Unstaged / Untracked. The full relPath (no file-type
  icon) shown in the app monospace font, colored like `git status`. Porcelain
  letters dropped except a `D` badge on deletions. Discard takes **no prompt**
  (`discard` a tracked file / `clean` an untracked file *or folder*).

- **Per-row diff base** drives the inline diff: staged → index↔HEAD
  (`git show HEAD:p` / `:p`), unstaged → worktree↔index, **untracked →
  all-added**. The viewer is self-contained given a `DiffModel` (no
  `DocumentRegistry` plumbing). Diff height is bounded (snug to displayed rows
  after `foldUnchanged`, capped) with the viewer's own scroll past the cap.

- **Commit** opens `.git/COMMIT_EDITMSG` as a normal editor tab; save+close
  commits via `git commit -F` (hooks/GPG honored).

- **Read-only inline diff** meant hunk-level staging lived elsewhere (the editor
  diff gutter, `git apply --cached`). The follow-up direction — an editable diff
  with hunk staging on the gutter and vim on the new-side lines — is what the
  multibuffer ultimately delivered.

## Refresh/key behavior worth keeping

- Rebuild the list on `git.onChange`, preserving cursor + scroll and **re-opening
  any inline diffs** whose file still has a row (so staging a file, which moves
  it between groups, keeps its diff open and refreshes its content).
- Open diffs keyed by `${kind}:${relPath}` (untracked renders in the `unstaged`
  group) so a file present in both staged and unstaged groups shows each diff
  independently. Async `git show` results dropped if the list was rebuilt
  meanwhile (stale-row guard).
