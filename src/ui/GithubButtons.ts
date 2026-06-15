/*
 * GithubButtons — header-bar links to the repository on GitHub.
 *
 * A linked group of up to three flat icon buttons:
 *   - the repository (always shown inside a GitHub repo),
 *   - its pull request for the current branch (when one exists), and
 *   - the issue that PR closes (when it links one).
 *
 * The repo is resolved from the git remotes, trying `git.remotes.upstream` then
 * `git.remotes.origin` (config), so a fork setup points at the canonical repo.
 * The PR/issue come from the `gh` CLI and are re-queried when the branch changes;
 * without gh (or a PR) only the repository button shows. Clicking opens the URL
 * in the default browser. Assembled widget exposed via `root`.
 */
import { Gio, Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { repoRoot } from '../git/cli.ts';
import {
  resolveGithubRepo,
  repoWebUrl,
  fetchPullRequest,
  type PrState,
  type CiStatus,
} from '../git/github.ts';
import type { GitRepo } from '../git.ts';

// Nerd Font glyphs (bundled icon font): GitHub mark, pull request, issue.
const GITHUB_GLYPH = String.fromCodePoint(0xf09b); // nf-fa-github
const PR_GLYPH = String.fromCodePoint(0xf407); // nf-oct-git_pull_request
const ISSUE_GLYPH = String.fromCodePoint(0xf41b); // nf-oct-issue_opened
// CI status glyphs (icon font): check / circle (pending) / times.
const CI_GLYPH: Record<CiStatus, string> = {
  success: String.fromCodePoint(0xf00c), // nf-fa-check
  warning: String.fromCodePoint(0xf111), // nf-fa-circle (pending/in-progress)
  error: String.fromCodePoint(0xf00d), // nf-fa-times
};

const SUCCESS = theme.ui.success ?? '#2ec27e';
const WARNING = theme.ui.warning ?? '#e5a50a';
const ERROR = theme.ui.error ?? '#e01b24';
const MERGED = '#a371f7'; // GitHub's merged-purple (no theme equivalent)

// A little gap from the branch button; compact PR/issue buttons (trimmed
// horizontal padding), but the repository button keeps a roomier hit area. The
// PR glyph is tinted by PR state, and a small dot reflects CI status.
addStyles(`
  #GithubButtons { margin-left: 16px; }
  #GithubButtons button { min-width: 0; padding-left: 6px; padding-right: 6px; }
  #GithubButtons .gh-repo { padding-left: 12px; padding-right: 12px; }
  #GithubButtons .pr-open   { color: ${SUCCESS}; }
  #GithubButtons .pr-closed { color: ${ERROR}; }
  #GithubButtons .pr-merged { color: ${MERGED}; }
  #GithubButtons .ci-success { color: ${SUCCESS}; }
  #GithubButtons .ci-warning { color: ${WARNING}; }
  #GithubButtons .ci-error   { color: ${ERROR}; }
`);

const PR_STATE_CLASSES = ['pr-open', 'pr-closed', 'pr-merged'];
const CI_CLASSES = ['ci-success', 'ci-warning', 'ci-error'];

export interface GithubButtonsOptions {
  git: GitRepo;
  /** A directory inside the repo (the repo root is resolved from it). */
  cwd: string;
}

export class GithubButtons {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly git: GitRepo;
  private readonly repoDir: string | null;
  private readonly iconAttrs: InstanceType<typeof Pango.AttrList>;

  private readonly repoButton: InstanceType<typeof Gtk.Button>;
  private readonly prButton: InstanceType<typeof Gtk.Button>;
  private readonly prCi: InstanceType<typeof Gtk.Label>; // CI status glyph (open/merged only)
  private readonly prNumber: InstanceType<typeof Gtk.Label>; // "1234" before the PR glyph
  private readonly prIcon: InstanceType<typeof Gtk.Label>; // tinted by PR state
  private readonly issueButton: InstanceType<typeof Gtk.Button>;

  private repoUrl: string | null = null;
  private actionsUrl: string | null = null; // the repo's CI Actions page
  private issuesUrl: string | null = null; // the repo's issues list
  private pullsUrl: string | null = null; // the repo's pull-requests list
  private prUrl: string | null = null; // this branch's PR
  private issueUrl: string | null = null; // the PR's linked issue
  // The branch the PR/issue were last looked up for (a PR is per-branch, so we
  // only re-query gh when this changes — onChange also fires for other reasons).
  private lastBranch: string | null = null;
  // Bumped per gh lookup so a late result for a stale branch is dropped.
  private prGeneration = 0;
  private readonly unsubscribe: () => void;

  constructor(options: GithubButtonsOptions) {
    this.git = options.git;
    this.repoDir = repoRoot(options.cwd);

    this.iconAttrs = Pango.AttrList.new();
    this.iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));

    this.repoButton = this.makeButton(GITHUB_GLYPH, 'Open repository on GitHub', () =>
      this.open(this.repoUrl),
    );
    this.repoButton.addCssClass('gh-repo'); // roomier than the compact PR/issue buttons

    // The PR button: an optional CI glyph, the number, then a state-tinted glyph.
    this.prCi = this.iconLabel('');
    this.prCi.setVisible(false);
    this.prNumber = new Gtk.Label();
    this.prIcon = this.iconLabel(PR_GLYPH);
    const prBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    prBox.append(this.prCi);
    prBox.append(this.prNumber);
    prBox.append(this.prIcon);
    this.prButton = new Gtk.Button();
    this.prButton.addCssClass('flat');
    this.prButton.setChild(prBox);
    this.prButton.setTooltipText('Open pull request');
    this.prButton.setVisible(false);
    this.prButton.on('clicked', () => this.open(this.prUrl));

    this.issueButton = this.makeButton(ISSUE_GLYPH, 'Open linked issue', () => this.open(this.issueUrl));

    // `.linked` joins the buttons into one connected control (Adwaita).
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('GithubButtons'); // selector identity for command/keymap rules
    this.root.addCssClass('linked');
    this.root.append(this.repoButton);
    this.root.append(this.prButton);
    this.root.append(this.issueButton);

    this.registerCommands();
    this.unsubscribe = this.git.onChange(() => this.refresh());
    this.refresh();
  }

  // Command-palette / keybindable entries for the same opens as the buttons, plus
  // the repo's CI Actions page. Registered on `#AppWindow` so they're available
  // regardless of focus (handlers only; no default key bindings).
  private registerCommands(): void {
    quilx.commands.add('#AppWindow', {
      'github:open-repository': () => this.openOrNotify(this.repoUrl, 'GitHub repository'),
      'github:open-actions': () => this.openOrNotify(this.actionsUrl, 'GitHub repository'),
      'github:open-issues': () => this.openOrNotify(this.issuesUrl, 'GitHub repository'),
      'github:open-pull-requests': () => this.openOrNotify(this.pullsUrl, 'GitHub repository'),
      'github:open-pull-request': () => this.openOrNotify(this.prUrl, 'pull request for this branch'),
      'github:open-issue': () => this.openOrNotify(this.issueUrl, 'linked issue'),
    });
  }

  dispose(): void {
    this.unsubscribe();
  }

  // --- internals -------------------------------------------------------------

  private refresh(): void {
    const repo = this.repoDir
      ? resolveGithubRepo(this.repoDir, this.remoteNames())
      : null;
    if (!repo) {
      this.root.setVisible(false);
      this.lastBranch = null;
      return;
    }
    this.repoUrl = repoWebUrl(repo);
    this.actionsUrl = `${this.repoUrl}/actions`;
    this.issuesUrl = `${this.repoUrl}/issues`;
    this.pullsUrl = `${this.repoUrl}/pulls`;
    this.root.setVisible(true);
    this.repoButton.setVisible(true);

    // The PR is per-branch; only re-query gh when the branch actually changes.
    const branch = this.git.getBranch();
    if (branch === this.lastBranch) return;
    this.lastBranch = branch;

    // Hide PR/issue until the lookup resolves (and ignore any in-flight result).
    this.prUrl = null;
    this.issueUrl = null;
    this.prCi.setVisible(false);
    this.prButton.setVisible(false);
    this.issueButton.setVisible(false);

    const generation = ++this.prGeneration;
    fetchPullRequest(this.repoDir!, (pr) => {
      if (generation !== this.prGeneration) return; // branch changed meanwhile
      if (!pr) return;
      this.prUrl = pr.url;
      this.prNumber.setText(String(pr.number));
      this.setPrState(pr.state);
      // CI glyph only for open/merged PRs that actually have checks.
      const showCi = (pr.state === 'open' || pr.state === 'merged') && pr.ci !== null;
      if (showCi) this.setCi(pr.ci!);
      this.prCi.setVisible(showCi);
      this.prButton.setVisible(true);
      if (pr.issueUrl) {
        this.issueUrl = pr.issueUrl;
        this.issueButton.setVisible(true);
      }
    });
  }

  private remoteNames(): string[] {
    const upstream = (quilx.config.get('git.remotes.upstream') as string) || 'upstream';
    const origin = (quilx.config.get('git.remotes.origin') as string) || 'origin';
    return [upstream, origin];
  }

  private open(url: string | null): void {
    if (!url) return;
    try {
      Gio.AppInfo.launchDefaultForUri(url, null);
    } catch (error) {
      quilx.notifications.addError('Could not open link', { detail: (error as Error).message });
    }
  }

  // Open `url`, or tell the user why there's nothing to open (for command-palette
  // invocations, where there's no button-visibility hint).
  private openOrNotify(url: string | null, label: string): void {
    if (url) this.open(url);
    else quilx.notifications.addInfo(`No ${label} available`);
  }

  // Tint the PR glyph by state: open green, closed red, merged purple.
  private setPrState(state: PrState): void {
    for (const cls of PR_STATE_CLASSES) this.prIcon.removeCssClass(cls);
    this.prIcon.addCssClass(`pr-${state}`);
  }

  // Set the CI glyph (check / circle / times) and color it (green / amber / red).
  private setCi(ci: CiStatus): void {
    this.prCi.setText(CI_GLYPH[ci]);
    for (const cls of CI_CLASSES) this.prCi.removeCssClass(cls);
    this.prCi.addCssClass(`ci-${ci}`);
  }

  /** A label rendering `glyph` in the bundled icon font. */
  private iconLabel(glyph: string): InstanceType<typeof Gtk.Label> {
    const label = new Gtk.Label({ label: glyph });
    label.setAttributes(this.iconAttrs);
    return label;
  }

  private makeButton(glyph: string, tooltip: string, onClick: () => void): InstanceType<typeof Gtk.Button> {
    const button = new Gtk.Button();
    button.addCssClass('flat');
    button.setChild(this.iconLabel(glyph));
    button.setTooltipText(tooltip);
    button.setVisible(false); // shown by refresh()
    button.on('clicked', onClick);
    return button;
  }
}
