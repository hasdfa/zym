/*
 * Branch picker — a quick-switcher over the repository's local branches.
 *
 * Opens the fuzzy picker over local branch names (most-recent first, excluding
 * the current one); selecting one switches to it. When the typed name matches no
 * branch, an action row offers to create it (off HEAD) and switch. Switch/create
 * go through `git/cli.ts`; HEAD moving makes the branch button and gutters update
 * via the existing `GitRepo.onChange`. Results surface through `quilx.notifications`.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { proseMarkup } from './proseMarkup.ts';
import { quilx } from '../quilx.ts';
import {
  repoRoot,
  currentBranch,
  listBranches,
  switchBranch,
  createBranch,
  type GitDone,
} from '../git/cli.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openBranchPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    quilx.notifications.addInfo('Not a git repository');
    return;
  }
  const current = currentBranch(root);
  const branches = listBranches(root); // includes the current branch (marked below)

  openPicker({
    host,
    placeholder: 'Switch branch…',
    items: branches,
    // Highlight the fuzzy match; tag the current branch with a muted "current".
    formatMain: (item, positions) => {
      const main = proseMarkup(item.text, positions);
      return item.value === current ? { main, detail: 'current' } : main;
    },
    onSelect: (branch) => {
      if (branch === current) return; // already here — nothing to do
      switchBranch(root, branch, report(`Switched to ${branch}`));
    },
    // Only when no existing branch matches the query: create it off HEAD.
    actionWhenEmpty: true,
    action: {
      label: (query) => `Create branch: ${query.trim()}`,
      run: (query) => {
        const name = query.trim();
        if (name) createBranch(root, name, report(`Created branch ${name}`));
      },
    },
  });
}

// Report a git result: success message, or an error with git's stderr.
function report(success: string): GitDone {
  return (ok, _stdout, stderr) => {
    if (ok) quilx.notifications.addSuccess(success);
    else quilx.notifications.addError('Git operation failed', { detail: stderr.trim() });
  };
}
