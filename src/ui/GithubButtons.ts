/*
 * GithubButtons — a header-bar control for the current branch's pull request.
 *
 * A `.linked` pair of plain buttons: the PR segment (a state-coloured glyph —
 * open green / merged purple / closed red, the same icons as the
 * `github:pull-request-checkout` picker — followed by "#1234" in white) opens the pull
 * request, and the CI segment (a check / dot / times glyph in success / warning
 * / error) opens a picker of the PR's CI checks (`GithubCIChecksPicker`). When the
 * branch has no PR but isn't the default branch, the PR segment instead shows a
 * white PR glyph and opens the create-PR web page; the control is hidden only when
 * there's nothing actionable.
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
import { repoRoot } from '../git.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { stateGlyphMarkup } from './GithubPrPicker.ts';
import {
  resolveGithubRepo,
  repoWebUrl,
  fetchPullRequest,
  fetchDefaultBranch,
  createPullRequestWeb,
  type GithubRepo,
  type PrState,
  type CiStatus,
} from '../github.ts';
import type { GitRepo } from '../git.ts';

// CI status glyph + colour (bundled icon font): check / dot / times, drawn in
// the theme's success / warning / error.
const CI_STYLE: Record<CiStatus, { glyph: string; color: string }> = {
  success: { glyph: String.fromCodePoint(0xf00c), color: theme.ui.success }, // check
  warning: { glyph: String.fromCodePoint(0xf111), color: theme.ui.warning }, // dot
  error: { glyph: String.fromCodePoint(0xf00d), color: theme.ui.error }, // times
};

// Markup for the PR segment: the state glyph (coloured) then "#1234" in the
// theme foreground.
function prMarkup(state: PrState, number: number): string {
  return `${stateGlyphMarkup(state)}<span foreground="${theme.ui.fg}">#${number}</span>`;
}

// Markup for the PR segment when there's no PR yet on a non-default branch: the
// PR glyph in the theme foreground — clicking opens the create-PR web page.
const CREATE_PR_GLYPH = String.fromCodePoint(0xf407); // git-pull-request
function createPrMarkup(): string {
  return `<span face="${ICON_FONT_FAMILY}" foreground="${theme.ui.fg}">${escapeMarkup(CREATE_PR_GLYPH)}</span>`;
}

// Markup for the CI segment: a single status glyph in the icon font.
function ciMarkup(ci: CiStatus): string {
  const { glyph, color } = CI_STYLE[ci];
  return `<span face="${ICON_FONT_FAMILY}" foreground="${color}">${escapeMarkup(glyph)}</span>`;
}

// The control is two linked buttons; each one carries its own side padding, so
// without this it sits ~2× wider than the single-button GitBranchButton. Trim the
// horizontal padding (leaving the vertical default) to match that compactness.
addStyles(`
  #GithubButtons button { padding-left: 8px; padding-right: 8px; }
`);

const CI_REFRESH_MS = 30000; // re-poll the PR's CI status every 30s while shown

export interface GithubButtonsOptions {
  git: GitRepo;
  /** A directory inside the repo (the repo root is resolved from it). */
  cwd: string;
  /**
   * Open the CI-checks picker for the current branch's PR. Provided by the host
   * because the picker needs its overlay, which doesn't exist yet when this
   * header control is constructed (so it's read lazily, at click time).
   */
  onShowChecks?: () => void;
}

export class GithubButtons {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly git: GitRepo;
  private readonly repoDir: string | null;
  private readonly onShowChecks?: () => void;

  private readonly prLabel: InstanceType<typeof Gtk.Label>; // state glyph + "#1234"
  private readonly prButton: InstanceType<typeof Gtk.Button>;
  private readonly ciButton: InstanceType<typeof Gtk.Button>;
  private readonly ciIcon: InstanceType<typeof Gtk.Label>;

  private repoUrl: string | null = null;
  private actionsUrl: string | null = null; // the repo's CI Actions page
  private issuesUrl: string | null = null; // the repo's issues list
  private pullsUrl: string | null = null; // the repo's pull-requests list
  private prUrl: string | null = null; // this branch's PR
  private issueUrl: string | null = null; // the PR's linked issue
  private lastBranch: string | null = null;
  private defaultBranch: string | null = null; // the repo's default branch
  private defaultBranchFetched = false;
  // When there's no PR, the PR segment becomes a "create PR" affordance on a
  // non-default branch; the click handler branches on this.
  private prMode: 'view' | 'create' = 'view';
  // The GitHub remote is stable for the session; resolving it shells out to git
  // twice (`remote`, `remote get-url`), so do it once rather than on every
  // git.onChange (which fires on every working-tree edit).
  private githubRepo: GithubRepo | null = null;
  private repoResolved = false;
  private prGeneration = 0;
  private ciTimer = 0;
  private readonly unsubscribe: () => void;

  constructor(options: GithubButtonsOptions) {
    this.git = options.git;
    this.repoDir = repoRoot(options.cwd);
    this.onShowChecks = options.onShowChecks;

    // PR segment: state glyph + "#1234"; opens the pull request (or, with no PR
    // on a non-default branch, opens the create-PR web page — see `prMode`).
    this.prLabel = new Gtk.Label();
    this.prButton = new Gtk.Button();
    this.prButton.addCssClass('flat');
    this.prButton.setChild(this.prLabel);
    this.prButton.setTooltipText('Open pull request');
    this.prButton.on('clicked', () => (this.prMode === 'create' ? this.createPr() : this.open(this.prUrl)));

    // "CI status" segment: a status glyph that opens the CI-checks picker.
    this.ciIcon = new Gtk.Label();
    this.ciButton = new Gtk.Button();
    this.ciButton.addCssClass('flat');
    this.ciButton.setChild(this.ciIcon);
    this.ciButton.setTooltipText('CI status — open checks');
    this.ciButton.on('clicked', () => this.onShowChecks?.());

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    this.root.setName('GithubButtons'); // selector identity for command/keymap rules
    this.root.addCssClass('linked');
    this.root.setValign(Gtk.Align.CENTER);
    this.root.append(this.prButton);
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
      'github:repository-open': () => this.openOrNotify(this.repoUrl, 'GitHub repository'),
      'github:actions-open': () => this.openOrNotify(this.actionsUrl, 'GitHub repository'),
      'github:issues-open': () => this.openOrNotify(this.issuesUrl, 'GitHub repository'),
      'github:pull-requests-open': () => this.openOrNotify(this.pullsUrl, 'GitHub repository'),
      'github:pull-request-open': () => this.openOrNotify(this.prUrl, 'pull request for this branch'),
      'github:issue-open': () => this.openOrNotify(this.issueUrl, 'linked issue'),
      'github:pull-request-create': () => this.createPr(),
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
    // Resolve the GitHub remote once (it doesn't change during a session); avoids
    // two synchronous git spawns on every onChange.
    if (!this.repoResolved) {
      this.githubRepo = this.repoDir ? resolveGithubRepo(this.repoDir, this.remoteNames()) : null;
      this.repoResolved = true;
    }
    const repo = this.githubRepo;
    if (!repo) {
      this.repoUrl = this.actionsUrl = this.issuesUrl = this.pullsUrl = null;
      this.prUrl = this.issueUrl = null;
      this.root.setVisible(false);
      this.lastBranch = null;
      return;
    }
    this.repoUrl = repoWebUrl(repo);
    this.actionsUrl = `${this.repoUrl}/actions`;
    this.issuesUrl = `${this.repoUrl}/issues`;
    this.pullsUrl = `${this.repoUrl}/pulls`;
    if (!this.defaultBranchFetched) this.lookupDefaultBranch(); // stable per repo

    // The PR is per-branch; only re-query gh when the branch changes (the timer
    // re-queries the same branch's PR for fresh CI).
    const branch = this.git.getBranch();
    if (branch === this.lastBranch) return;
    this.lastBranch = branch;
    this.root.setVisible(false); // until the lookup resolves
    this.lookupPullRequest();
  }

  // Query the current branch's PR and update the pill (hidden when there's none,
  // unless the branch can open a new PR — see `showCreatePr`).
  private lookupPullRequest(): void {
    if (!this.repoDir) return;
    const generation = ++this.prGeneration;
    fetchPullRequest(this.repoDir, (pr) => {
      if (generation !== this.prGeneration) return; // superseded
      if (!pr) {
        this.prUrl = this.issueUrl = null;
        this.showCreatePr();
        return;
      }
      this.prMode = 'view';
      this.prButton.setTooltipText(`Open ${pr.title || `#${pr.number}`}`);
      this.prUrl = pr.url;
      this.issueUrl = pr.issueUrl;
      this.prLabel.setMarkup(prMarkup(pr.state, pr.number));
      // CI glyph only for open/merged PRs that actually have checks.
      const showCi = (pr.state === 'open' || pr.state === 'merged') && pr.ci !== null;
      if (showCi) this.ciIcon.setMarkup(ciMarkup(pr.ci!));
      this.ciButton.setVisible(showCi);
      this.root.setVisible(true);
    });
  }

  // Fetch the repo's default branch once (it's stable for `repoDir`). A no-PR
  // lookup may have already resolved before we knew it, so re-evaluate then.
  private lookupDefaultBranch(): void {
    if (!this.repoDir) return;
    this.defaultBranchFetched = true;
    fetchDefaultBranch(this.repoDir, (branch) => {
      this.defaultBranch = branch;
      if (!this.prUrl) this.showCreatePr();
    });
  }

  // With no PR for the current branch, offer "create PR" — but only on a real,
  // non-default branch. Otherwise hide the control entirely.
  private showCreatePr(): void {
    const branch = this.git.getBranch();
    if (!branch || this.defaultBranch === null || branch === this.defaultBranch) {
      this.prMode = 'view';
      this.root.setVisible(false);
      return;
    }
    this.prMode = 'create';
    this.prButton.setTooltipText('Create PR');
    this.prLabel.setMarkup(createPrMarkup());
    this.ciButton.setVisible(false); // no checks until the PR exists
    this.root.setVisible(true);
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
