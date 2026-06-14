/*
 * BranchButton — a header-bar indicator showing the repository's current git
 * branch (e.g. " master") plus a working-tree overview: "+N" inserted lines in
 * green and "-M" deleted lines in red (untracked files counted as insertions).
 * It reads from an injected `GitRepo` and refreshes on `GitRepo.onChange`;
 * outside a repo it hides itself.
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

// Diff counts in the theme's success/error colors (fallbacks are Adwaita's).
addStyles(`
  .quilx-diff-added   { color: ${theme.ui.success ?? '#2ec27e'}; }
  .quilx-diff-removed { color: ${theme.ui.error ?? '#e01b24'}; }
`);

export class BranchButton {
  readonly root: InstanceType<typeof Gtk.Button>;

  private readonly repo: GitRepo;
  private readonly label: InstanceType<typeof Gtk.Label>;
  private readonly added: InstanceType<typeof Gtk.Label>;
  private readonly removed: InstanceType<typeof Gtk.Label>;
  private readonly unsubscribe: () => void;

  constructor(repo: GitRepo) {
    this.repo = repo;

    // [icon, branch name, +added, -removed]. The icon is a Nerd Font glyph in
    // the bundled icon font; as plain label text it inherits the theme
    // foreground, matching FileTree's monochrome, theme-following icons.
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
    const icon = new Gtk.Label({ label: BRANCH_GLYPH });
    icon.setAttributes(iconAttrs);

    this.label = new Gtk.Label();
    this.added = new Gtk.Label();
    this.added.addCssClass('quilx-diff-added');
    this.removed = new Gtk.Label();
    this.removed.addCssClass('quilx-diff-removed');

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    box.append(icon);
    box.append(this.label);
    box.append(this.added);
    box.append(this.removed);

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
  }

  private setCount(label: InstanceType<typeof Gtk.Label>, sign: string, count: number): void {
    label.setText(count > 0 ? `${sign}${count}` : '');
    label.setVisible(count > 0);
  }

  dispose(): void {
    this.unsubscribe();
  }
}
