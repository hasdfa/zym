/*
 * GitHub PR picker — pick a pull request, then either open it in the browser or
 * switch to its branch.
 *
 * Lists PRs in every state (open / closed / merged) via `gh` (see git/github.ts)
 * and opens the fuzzy picker over "#<n> <title>", each row prefixed with a
 * colour-coded state glyph and the author as a muted detail. Two entry points
 * share the picker; the host wires each to a command. Notifies when gh is
 * unavailable or there are no PRs.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { proseMarkup, escapeMarkup } from './proseMarkup.ts';
import { openUrl } from './openUrl.ts';
import { quilx } from '../quilx.ts';
import { repoRoot } from '../git/cli.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { fetchPullRequests, checkoutPullRequest, type GithubListItem, type PrState } from '../git/github.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Octicon glyph + GitHub-style colour for each PR state (open green, merged
// purple, closed red), rendered in the bundled icon font ahead of the title.
const STATE_STYLE: Record<PrState, { glyph: string; color: string }> = {
  open: { glyph: String.fromCodePoint(0xf407), color: '#3fb950' }, // git-pull-request
  merged: { glyph: String.fromCodePoint(0xf419), color: '#a371f7' }, // git-merge
  closed: { glyph: String.fromCodePoint(0xf407), color: '#f85149' }, // git-pull-request
};

export function stateGlyphMarkup(state: PrState): string {
  const { glyph, color } = STATE_STYLE[state];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span> `;
}

/** Pick a PR and open it in the browser. */
export function openGithubPrPicker(host: Overlay, cwd: string): void {
  pickPullRequest(host, cwd, 'Open pull request…', (pr) => openUrl(pr.url));
}

/** Pick a PR and switch to its branch (`gh pr checkout`). */
export function checkoutGithubPrPicker(host: Overlay, cwd: string): void {
  pickPullRequest(host, cwd, 'Switch to pull request…', (pr, root) => {
    checkoutPullRequest(root, pr.number, (ok, stderr) => {
      if (ok) quilx.notifications.addSuccess(`Switched to PR #${pr.number}`);
      else quilx.notifications.addError('Could not switch to pull request', { detail: stderr.trim() });
    });
  });
}

// Shared: fetch PRs (all states), show the picker, and run `onPick` for the chosen one.
function pickPullRequest(
  host: Overlay,
  cwd: string,
  placeholder: string,
  onPick: (pr: GithubListItem, root: string) => void,
): void {
  const root = repoRoot(cwd);
  if (!root) {
    quilx.notifications.addInfo('Not a git repository');
    return;
  }
  fetchPullRequests(root, (prs) => {
    if (prs.length === 0) {
      quilx.notifications.addInfo('No pull requests');
      return;
    }
    // value = PR number (unique); map it back to the PR for the action + author.
    const byKey = new Map<string, GithubListItem>();
    const items = prs.map((pr) => {
      const key = String(pr.number);
      byKey.set(key, pr);
      return { value: key, text: `#${pr.number} ${pr.title}` };
    });
    openPicker({
      host,
      placeholder,
      items,
      formatMain: (item, positions) => {
        const pr = byKey.get(item.value);
        const main = (pr ? stateGlyphMarkup(pr.state) : '') + proseMarkup(item.text, positions);
        return pr && pr.author ? { main, detail: `@${pr.author}` } : { main };
      },
      onSelect: (key) => {
        const pr = byKey.get(key);
        if (pr) onPick(pr, root);
      },
    });
  });
}
