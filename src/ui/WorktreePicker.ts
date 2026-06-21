/*
 * Worktree picker — choose which git worktree to launch an agent in.
 *
 * Lists every worktree of the repo (the main checkout first, then linked ones
 * from `git worktree add`); selecting one calls `onChoose(path)`, and the host
 * launches a new agent rooted there — that path becomes the agent's workbench
 * cwd, file tree, and git (see docs/agents.md "git worktree integration"). The
 * agent itself still creates *new* worktrees; this only picks existing ones.
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup } from './Picker.ts';
import { Icons } from './icons.ts';
import { listWorktrees } from '../git.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Open a picker over the repo's worktrees; `onChoose` gets the chosen root. */
export function openWorktreePicker(host: Overlay, cwd: string, onChoose: (path: string) => void): void {
  const worktrees = listWorktrees(cwd);
  if (worktrees.length === 0) {
    openPicker({
      host,
      placeholder: 'Start agent in worktree…',
      promptIcon: Icons.git,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  const byPath = new Map(worktrees.map((w) => [w.path, w]));

  openPicker({
    host,
    placeholder: 'Start agent in worktree…',
    promptIcon: Icons.git,
    items: worktrees.map((w) => ({ value: w.path, text: w.name })),
    // Highlight the fuzzy match on the worktree name; tag the branch in the detail
    // column, and mark the main checkout so it's distinguishable from linked ones.
    formatMain: (item, positions) => {
      const w = byPath.get(item.value);
      const main = highlightMarkup(item.text, positions);
      if (!w) return main;
      const branch = w.branch ?? 'detached';
      return { main, detail: w.linked ? branch : `${branch} · main` };
    },
    onSelect: (path) => onChoose(path),
  });
}
