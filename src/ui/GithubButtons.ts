/*
 * GithubButtons — a header-bar control for the current branch's pull request.
 *
 * Shown only when the branch has a PR; a `.linked` pair of plain buttons: the PR
 * segment (a state-coloured glyph — open green / merged purple / closed red, the
 * same icons as the `github:pr-checkout` picker — followed by "#1234" in white)
 * opens the pull request, and the CI segment (a check / dot / times glyph in
 * success / warning / error) opens the PR's checks page.
 *
 * The repo is resolved from the git remotes (upstream → origin); the PR + CI come
 * from `gh`, re-queried on branch change and on a timer (CI changes over time).
 * The `github:*` commands cover the repo/actions/issues/pulls/issue pages too.
 * Assembled control exposed via `root`.
 */
import { GLib, Gtk } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import { openUrl } from './openUrl.ts';
import { repoRoot } from '../git/cli.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { stateGlyphMarkup } from './GithubPrPicker.ts';
import {
  resolveGithubRepo,
  repoWebUrl,
  fetchPullRequest,
  createPullRequestWeb,
  type PrState,
  type CiStatus,
} from '../git/github.ts';
import type { GitRepo } from '../git.ts';

// CI status glyph + colour (bundled icon font): check / dot / times, drawn in
// the theme's success / warning / error.
const CI_STYLE: Record<CiStatus, { glyph: string; color: string }> = {
  success: { glyph: String.fromCodePoint(0xf00c), color: theme.ui.success ?? '#3fb950' }, // check
  warning: { glyph: String.fromCodePoint(0xf111), color: theme.ui.warning ?? '#e5a50a' }, // dot
  error: { glyph: String.fromCodePoint(0xf00d), color: theme.ui.error ?? '#f85149' }, // times
};

// Markup for the PR segment: the state glyph (coloured) then "#1234" in white.
function prMarkup(state: PrState, number: number): string {
  return `${stateGlyphMarkup(state)}<span foreground="white">#${number}</span>`;
}

// Markup for the CI segment: a single status glyph in the icon font.
function ciMarkup(ci: CiStatus): string {
  const { glyph, color } = CI_STYLE[ci];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span>`;
}

// The control is two linked buttons; each one carries its own side padding, so
// without this it sits ~2× wider than the single-button BranchButton. Trim the
// horizontal padding (leaving the vertical default) to match that compactness.
addStyles(`
  #GithubButtons button { padding-left: 8px; padding-right: 8px; }
`);

const CI_REFRESH_MS = 30000; // re-poll the PR's CI status every 30s while shown

export interface GithubButtonsOptions {
  git: GitRepo;
  /** A directory inside the repo (the repo root is resolved from it). */
  cwd: string;
}

export class GithubButtons {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly git: GitRepo;
  private readonly repoDir: string | null;

  private readonly prLabel: InstanceType<typeof Gtk.Label>; // state glyph + "#1234"
  private readonly ciButton: InstanceType<typeof Gtk.Button>;
  private readonly ciIcon: InstanceType<typeof Gtk.Label>;

  private repoUrl: string | null = null;
  private actionsUrl: string | null = null; // the repo's CI Actions page
  private issuesUrl: string | null = null; // the repo's issues list
  private pullsUrl: string | null = null; // the repo's pull-requests list
  private prUrl: string | null = null; // this branch's PR
  private prChecksUrl: string | null = null; // the PR's checks page
  private issueUrl: string | null = null; // the PR's linked issue
  private lastBranch: string | null = null;
  private prGeneration = 0;
  private ciTimer = 0;
  private readonly unsubscribe: () => void;

  constructor(options: GithubButtonsOptions) {
    this.git = options.git;
    this.repoDir = repoRoot(options.cwd);

    // PR segment: state glyph + "#1234"; opens the pull request.
    this.prLabel = new Gtk.Label();
    const prButton = new Gtk.Button();
    prButton.addCssClass('flat');
    prButton.setChild(this.prLabel);
    prButton.setTooltipText('Open pull request');
    prButton.on('clicked', () => this.open(this.prUrl));

    // "CI status" segment: a status glyph that opens the PR's checks page.
    this.ciIcon = new Gtk.Label();
    this.ciButton = new Gtk.Button();
    this.ciButton.addCssClass('flat');
    this.ciButton.setChild(this.ciIcon);
    this.ciButton.setTooltipText('CI status — open checks');
    this.ciButton.on('clicked', () => this.open(this.prChecksUrl));

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('GithubButtons'); // selector identity for command/keymap rules
    this.root.addCssClass('linked');
    this.root.setValign(Gtk.Align.CENTER);
    this.root.append(prButton);
    this.root.append(this.ciButton);
    this.root.setVisible(false); // shown only when a PR exists

    this.registerCommands();
    this.unsubscribe = this.git.onChange(() => this.refresh());
    this.refresh();

    // Re-poll the PR's CI status while the pill is shown (checks change over time).
    this.ciTimer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, CI_REFRESH_MS, () => {
      if (this.prUrl) this.lookupPullRequest();
      return true;
    });
  }

  dispose(): void {
    if (this.ciTimer) GLib.sourceRemove(this.ciTimer);
    this.unsubscribe();
  }

  // --- commands --------------------------------------------------------------

  private registerCommands(): void {
    quilx.commands.add('#AppWindow', {
      'github:open-repository': () => this.openOrNotify(this.repoUrl, 'GitHub repository'),
      'github:open-actions': () => this.openOrNotify(this.actionsUrl, 'GitHub repository'),
      'github:open-issues': () => this.openOrNotify(this.issuesUrl, 'GitHub repository'),
      'github:open-pull-requests': () => this.openOrNotify(this.pullsUrl, 'GitHub repository'),
      'github:open-pull-request': () => this.openOrNotify(this.prUrl, 'pull request for this branch'),
      'github:open-issue': () => this.openOrNotify(this.issueUrl, 'linked issue'),
      'github:create-pr': () => this.createPr(),
    });
  }

  private createPr(): void {
    if (!this.repoDir) {
      quilx.notifications.addInfo('No GitHub repository available');
      return;
    }
    createPullRequestWeb(this.repoDir, (ok, stderr) => {
      if (!ok) quilx.notifications.addError('Could not create pull request', { detail: stderr.trim() });
    });
  }

  // --- refresh ---------------------------------------------------------------

  private refresh(): void {
    const repo = this.repoDir ? resolveGithubRepo(this.repoDir, this.remoteNames()) : null;
    if (!repo) {
      this.repoUrl = this.actionsUrl = this.issuesUrl = this.pullsUrl = null;
      this.prUrl = this.issueUrl = this.prChecksUrl = null;
      this.root.setVisible(false);
      this.lastBranch = null;
      return;
    }
    this.repoUrl = repoWebUrl(repo);
    this.actionsUrl = `${this.repoUrl}/actions`;
    this.issuesUrl = `${this.repoUrl}/issues`;
    this.pullsUrl = `${this.repoUrl}/pulls`;

    // The PR is per-branch; only re-query gh when the branch changes (the timer
    // re-queries the same branch's PR for fresh CI).
    const branch = this.git.getBranch();
    if (branch === this.lastBranch) return;
    this.lastBranch = branch;
    this.root.setVisible(false); // until the lookup resolves
    this.lookupPullRequest();
  }

  // Query the current branch's PR and update the pill (hidden when there's none).
  private lookupPullRequest(): void {
    if (!this.repoDir) return;
    const generation = ++this.prGeneration;
    fetchPullRequest(this.repoDir, (pr) => {
      if (generation !== this.prGeneration) return; // superseded
      if (!pr) {
        this.prUrl = this.issueUrl = this.prChecksUrl = null;
        this.root.setVisible(false);
        return;
      }
      this.prUrl = pr.url;
      this.prChecksUrl = `${pr.url}/checks`;
      this.issueUrl = pr.issueUrl;
      this.prLabel.setMarkup(prMarkup(pr.state, pr.number));
      // CI glyph only for open/merged PRs that actually have checks.
      const showCi = (pr.state === 'open' || pr.state === 'merged') && pr.ci !== null;
      if (showCi) this.ciIcon.setMarkup(ciMarkup(pr.ci!));
      this.ciButton.setVisible(showCi);
      this.root.setVisible(true);
    });
  }

  // --- helpers ---------------------------------------------------------------

  private remoteNames(): string[] {
    const upstream = (quilx.config.get('git.remotes.upstream') as string) || 'upstream';
    const origin = (quilx.config.get('git.remotes.origin') as string) || 'origin';
    return [upstream, origin];
  }

  private open(url: string | null): void {
    if (url) openUrl(url);
  }

  private openOrNotify(url: string | null, label: string): void {
    if (url) this.open(url);
    else quilx.notifications.addInfo(`No ${label} available`);
  }
}
