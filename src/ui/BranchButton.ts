/*
 * BranchButton — a header-bar indicator showing the repository's current git
 * branch (e.g. " master") plus a working-tree overview: "+N" inserted lines in
 * green and "-M" deleted lines in red (untracked files counted as insertions),
 * and the upstream delta "↑N"/"↓M" (commits ahead/behind). Each count is hidden
 * when zero. It reads from an injected `GitRepo` and refreshes on
 * `GitRepo.onChange`; outside a repo it hides itself.
 *
 * It is a flat button so it can later grow into a branch switcher (open a popover
 * on click). The assembled widget is exposed via `root`.
 */
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import type { GitRepo } from '../git.ts';

// nf-oct-git_branch from the bundled "Symbols Nerd Font Mono" (see fonts.ts).
const BRANCH_GLYPH = String.fromCodePoint(0xf418);

// Counts in theme colors (fallbacks are Adwaita's): working-tree insertions/
// deletions in success/error; upstream ahead in info, behind in warning, and
// both (a diverged branch) in danger/error.
addStyles(`
  .quilx-diff-added   { color: ${theme.ui.success ?? '#2ec27e'}; }
  .quilx-diff-removed { color: ${theme.ui.error ?? '#e01b24'}; }
  .quilx-sync-info    { color: ${theme.ui.info ?? '#3584e4'}; }
  .quilx-sync-warning { color: ${theme.ui.warning ?? '#e5a50a'}; }
  .quilx-sync-danger  { color: ${theme.ui.error ?? '#e01b24'}; }
`);

const SYNC_CLASSES = ['quilx-sync-info', 'quilx-sync-warning', 'quilx-sync-danger'];

export class BranchButton {
  readonly root: InstanceType<typeof Gtk.Button>;

  private readonly repo: GitRepo;
  private readonly label: InstanceType<typeof Gtk.Label>;
  private readonly added: InstanceType<typeof Gtk.Label>;
  private readonly removed: InstanceType<typeof Gtk.Label>;
  private readonly ahead: InstanceType<typeof Gtk.Label>;
  private readonly behind: InstanceType<typeof Gtk.Label>;
  private readonly unsubscribe: () => void;

  constructor(repo: GitRepo) {
    this.repo = repo;

    // [icon, branch name, +added, -removed, ↑ahead, ↓behind]. The icon is a Nerd
    // Font glyph in the bundled icon font; as plain label text it inherits the
    // theme foreground, matching FileTree's monochrome, theme-following icons.
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
    const icon = new Gtk.Label({ label: BRANCH_GLYPH });
    icon.setAttributes(iconAttrs);

    this.label = new Gtk.Label();
    this.added = new Gtk.Label();
    this.added.addCssClass('quilx-diff-added');
    this.removed = new Gtk.Label();
    this.removed.addCssClass('quilx-diff-removed');
    this.ahead = new Gtk.Label();
    this.behind = new Gtk.Label();

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    box.append(icon);
    box.append(this.label);
    box.append(this.added);
    box.append(this.removed);
    box.append(this.ahead);
    box.append(this.behind);

    this.root = new Gtk.Button();
    this.root.setName('BranchButton'); // selector identity for command/keymap rules
    this.root.addCssClass('flat');
    this.root.addCssClass('quilx-branch');
    this.root.setChild(box);
    this.root.setVisible(false); // shown once a branch is resolved

    this.unsubscribe = repo.onChange(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const branch = this.repo.getBranch();
    if (!branch) {
      this.root.setVisible(false);
      return;
    }
    this.label.setText(branch);
    this.root.setVisible(true);

    const status = this.repo.getStatus();
    this.setCount(this.added, '+', status?.added ?? 0);
    this.setCount(this.removed, '-', status?.removed ?? 0);

    const sync = this.repo.getAheadBehind();
    const ahead = sync?.ahead ?? 0;
    const behind = sync?.behind ?? 0;
    // A diverged branch (both ahead and behind) is the dangerous case.
    const diverged = ahead > 0 && behind > 0;
    this.setCount(this.ahead, '↑', ahead);
    this.setCount(this.behind, '↓', behind);
    this.setColor(this.ahead, diverged ? 'quilx-sync-danger' : 'quilx-sync-info');
    this.setColor(this.behind, diverged ? 'quilx-sync-danger' : 'quilx-sync-warning');
  }

  private setCount(label: InstanceType<typeof Gtk.Label>, sign: string, count: number): void {
    label.setText(count > 0 ? `${sign}${count}` : '');
    label.setVisible(count > 0);
  }

  private setColor(label: InstanceType<typeof Gtk.Label>, cls: string): void {
    for (const c of SYNC_CLASSES) label.removeCssClass(c);
    label.addCssClass(cls);
  }

  dispose(): void {
    this.unsubscribe();
  }
}
