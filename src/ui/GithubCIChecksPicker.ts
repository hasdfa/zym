/*
 * GitHub CI-checks picker — list the current branch PR's CI runs and open one in
 * the browser.
 *
 * The picker opens immediately (with a loading state) and fills in once `gh pr
 * checks` resolves (see github.ts). Each row is prefixed with a state glyph
 * (failed ✗ red / pending ● amber / passed ✓ green); failed runs are weighted to
 * the top (then pending, then passed). Choosing a run opens its page in the
 * browser. The GitHub mark is the prompt icon (and the loading spinner's home).
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { openUrl } from './openUrl.ts';
import { repoRoot } from '../git.ts';
import { Icons } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { fetchChecks, type CiCheck, type CheckState } from '../github.ts';
import { theme } from '../theme/theme.ts';
import { lookupCSSColor } from '../theme/cssColor.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Glyph + colour per check state — the same check / dot / cross icons (in
// success / warning / error) the header CI button uses.
const CHECK_STYLE: Record<CheckState, { glyph: string; color: string }> = {
  pass: { glyph: NERDFONT.STATUS.CHECK, color: lookupCSSColor(theme, '--success-color') },
  pending: { glyph: NERDFONT.STATUS.DOT, color: lookupCSSColor(theme, '--warning-color') },
  fail: { glyph: NERDFONT.STATUS.CROSS, color: lookupCSSColor(theme, '--error-color') },
};

// Sort/weight key: failed first, then pending, then passed.
const STATE_RANK: Record<CheckState, number> = { fail: 2, pending: 1, pass: 0 };

// A picker row carrying its check, so weight/renderRow read it off the item.
interface CiCheckItem extends PickerItem {
  check: CiCheck;
}

/** Pick one of the current branch PR's CI checks and open it in the browser. */
export function openGithubCIChecksPicker(host: Overlay, cwd: string): void {
  const root = repoRoot(cwd);
  if (!root) {
    openPicker({
      host,
      placeholder: 'Open CI check…',
      promptIcon: Icons.github,
      onSelect: () => {},
      error: 'Not a git repository',
    });
    return;
  }
  // Open immediately with a loading state; fill in once `gh pr checks` resolves.
  const picker = openPicker({
    host,
    placeholder: 'Open CI check…',
    promptIcon: Icons.github, // doubles as the home for the loading spinner
    loading: true,
    items: [],
    // Float failed runs to the top (then pending), and bias them up once a
    // query is typed too.
    weight: (item) => STATE_RANK[(item as CiCheckItem).check.state],
    // A colour-coded state glyph (failed ✗ / pending ● / passed ✓) leads each row.
    renderRow: (item, positions) => {
      const { glyph, color } = CHECK_STYLE[(item as CiCheckItem).check.state];
      return renderRowSingleLine({
        icon: glyph,
        iconColor: color,
        main: highlightMarkup(item.text, positions),
      });
    },
    onSelect: (url) => openUrl(url),
  });
  fetchChecks(root, (checks) => {
    picker.setItems(
      checks.map((check): CiCheckItem => ({
        value: check.url, // the run/job URL is unique (deduped in fetchChecks)
        text: check.name,
        check,
      })),
    );
  });
}
