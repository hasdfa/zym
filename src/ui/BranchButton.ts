/*
 * BranchButton — a header-bar indicator showing the repository's current git
 * branch (e.g. " master"). It reads the branch from an injected `GitRepo` and
 * refreshes on checkout via `GitRepo.onChange`; outside a repo it hides itself.
 *
 * It is a flat button so it can later grow into a branch switcher (open a popover
 * on click). The assembled widget is exposed via `root`.
 */
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import type { GitRepo } from '../git.ts';

// nf-oct-git_branch from the bundled "Symbols Nerd Font Mono" (see fonts.ts).
const BRANCH_GLYPH = String.fromCodePoint(0xf418);

export class BranchButton {
  readonly root: InstanceType<typeof Gtk.Button>;

  private readonly repo: GitRepo;
  private readonly label: InstanceType<typeof Gtk.Label>;
  private readonly unsubscribe: () => void;

  constructor(repo: GitRepo) {
    this.repo = repo;

    // [icon label, name label]. The icon is a Nerd Font glyph rendered in the
    // bundled icon font; as plain label text it inherits the theme foreground,
    // matching FileTree's monochrome, theme-following icons.
    const iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
    const icon = new Gtk.Label({ label: BRANCH_GLYPH });
    icon.setAttributes(iconAttrs);

    this.label = new Gtk.Label();

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    box.append(icon);
    box.append(this.label);

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
    if (branch) {
      this.label.setText(branch);
      this.root.setVisible(true);
    } else {
      this.root.setVisible(false);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
