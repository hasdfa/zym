/*
 * github.ts — GitHub remote parsing and PR/issue lookup.
 *
 * Pure node (no GTK), so it's testable in isolation. Remote URLs are parsed into
 * `{ host, owner, repo }` (GitHub only); the repository is resolved by trying a
 * list of remote names in order (upstream → origin). Pull-request and linked-
 * issue lookup shells out to the `gh` CLI, degrading to "none" when gh is absent,
 * unauthenticated, or the branch has no PR.
 */
// github.ts is a public facade alongside git.ts; it may use the internal git CLI
// helpers directly. It deliberately imports from `git/cli.ts` (pure node) rather
// than the public `git.ts` so it stays GTK-free and testable in isolation — the
// rest of the codebase still imports git helpers only via git.ts / github.ts.
import { git as gitCli, repoRoot } from './git/cli.ts';
import { runProcess } from './process/runner.ts';

// Run `gh` through the shared process runner (so the big node-gtk parent never
// forks), decoding output to text. `err` is non-null on a non-zero exit,
// mirroring the `execFile` callback shape the call sites were written against.
function gh(
  cwd: string,
  args: string[],
  onDone: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  runProcess({ file: 'gh', args, cwd }, (r) => {
    const stderr = r.stderr.toString('utf8');
    onDone(r.ok ? null : new Error(stderr.trim() || 'gh command failed'), r.stdout.toString('utf8'), stderr);
  });
}

export interface GithubRepo {
  host: string; // always 'github.com' (GitHub.com only, for now)
  owner: string;
  repo: string;
}

export type PrState = 'open' | 'closed' | 'merged';
/** Aggregate CI outcome: green (all passed) / amber (pending) / red (failed). */
export type CiStatus = 'success' | 'warning' | 'error';

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  state: PrState;
  /** Rolled-up CI status of the head commit's checks, or null when there are none. */
  ci: CiStatus | null;
  /** The first issue the PR closes ("Closes #N"), if any. */
  issueUrl: string | null;
}

// Reduce gh's `statusCheckRollup` (a mix of CheckRun and StatusContext entries)
// to one outcome: any failure → error; else any pending → warning; else success.
// Returns null when there are no checks.
function rollupCi(rollup: unknown): CiStatus | null {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let pending = false;
  for (const check of rollup) {
    const c = check as { status?: string; conclusion?: string; state?: string };
    if (typeof c.state === 'string') {
      // StatusContext: SUCCESS / PENDING / FAILURE / ERROR / EXPECTED
      if (c.state === 'FAILURE' || c.state === 'ERROR') return 'error';
      if (c.state === 'PENDING' || c.state === 'EXPECTED') pending = true;
    } else {
      // CheckRun: status QUEUED/IN_PROGRESS/COMPLETED, then a conclusion.
      if (c.status !== 'COMPLETED') {
        pending = true;
      } else if (c.conclusion && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)) {
        return 'error';
      }
    }
  }
  return pending ? 'warning' : 'success';
}

/** Parse a git remote URL into a GitHub repo, or null if it isn't GitHub.com. */
export function parseGithubRemote(url: string): GithubRepo | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  let host: string | undefined;
  let path: string | undefined;

  // scp-like SSH: git@github.com:owner/repo
  const scp = /^[^@\s]+@([^:]+):(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    // URL form: https://github.com/owner/repo, ssh://git@github.com/owner/repo
    const proto = /^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i.exec(trimmed);
    if (proto) {
      host = proto[1];
      path = proto[2];
    }
  }

  if (!host || !path || host !== 'github.com') return null;
  const [owner, repo] = path.split('/');
  if (!owner || !repo) return null;
  return { host, owner, repo };
}

/** The repo's web page URL. */
export function repoWebUrl(r: GithubRepo): string {
  return `https://${r.host}/${r.owner}/${r.repo}`;
}

/** Web permalink to a 1-based `line` of `relPath` (a repo-root-relative POSIX path) at
 *  `ref` — a commit sha pins it so the link survives the line later moving. */
export function lineWebUrl(r: GithubRepo, ref: string, relPath: string, line: number): string {
  const encoded = relPath.split('/').map(encodeURIComponent).join('/');
  return `${repoWebUrl(r)}/blob/${ref}/${encoded}#L${line}`;
}

/**
 * Resolve the GitHub repo for `root` by trying `remoteNames` in order (e.g.
 * upstream then origin). Calls back with the first that parses as a GitHub
 * remote, or null. Async (the git lookups go through the process runner).
 */
export function resolveGithubRepo(
  root: string,
  remoteNames: string[],
  onDone: (repo: GithubRepo | null) => void,
): void {
  // List the remotes first so we never run `get-url` on a missing one (which
  // would leak git's "No such remote" to stderr).
  gitCli(root, ['remote'], (ok, stdout) => {
    if (!ok) {
      onDone(null);
      return;
    }
    const remotes = new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
    // Try the names in order, sequentially — the first GitHub remote wins.
    const tryNext = (i: number): void => {
      if (i >= remoteNames.length) {
        onDone(null);
        return;
      }
      const name = remoteNames[i];
      if (!remotes.has(name)) {
        tryNext(i + 1);
        return;
      }
      gitCli(root, ['remote', 'get-url', name], (urlOk, urlOut) => {
        const repo = urlOk ? parseGithubRemote(urlOut.trim()) : null;
        if (repo) onDone(repo);
        else tryNext(i + 1);
      });
    };
    tryNext(0);
  });
}

/**
 * Look up the pull request for the current branch via `gh`. Calls back with null
 * when gh is unavailable/unauthenticated or the branch has no PR.
 */
export function fetchPullRequest(cwd: string, onDone: (pr: PullRequest | null) => void): void {
  gh(
    cwd,
    ['pr', 'view', '--json', 'number,url,title,state,statusCheckRollup,closingIssuesReferences'],
    (err, stdout) => {
      if (err) {
        onDone(null);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const url = typeof data.url === 'string' ? data.url : null;
        const number = typeof data.number === 'number' ? data.number : null;
        if (!url || number === null) {
          onDone(null);
          return;
        }
        // gh reports MERGED / CLOSED / OPEN; CLOSED here means closed-unmerged.
        const raw = typeof data.state === 'string' ? data.state.toUpperCase() : '';
        const state: PrState = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : 'open';
        const issues = Array.isArray(data.closingIssuesReferences) ? data.closingIssuesReferences : [];
        const issueUrl =
          issues.length > 0 && typeof issues[0].url === 'string' ? (issues[0].url as string) : null;
        const title = typeof data.title === 'string' ? data.title : '';
        onDone({ number, url, title, state, ci: rollupCi(data.statusCheckRollup), issueUrl });
      } catch {
        onDone(null);
      }
    },
  );
}

/** Coarse outcome of a single CI check: failed / in progress / passed. */
export type CheckState = 'fail' | 'pending' | 'pass';

/** A single CI check on a PR: its display name, run/job page URL, and state. */
export interface CiCheck {
  name: string;
  url: string;
  state: CheckState;
}

/** A failed CI check on a PR: its display name and the run/job page URL. */
export interface FailedCheck {
  name: string;
  url: string;
}

// gh's `bucket` is pass / fail / pending / skipping / cancel; collapse to the
// three states we render (a cancelled run reads as a failure).
function bucketToState(bucket: unknown): CheckState {
  if (bucket === 'fail' || bucket === 'cancel') return 'fail';
  if (bucket === 'pending') return 'pending';
  return 'pass'; // pass / skipping / anything unexpected
}

// Parse `gh pr checks --json name,link,bucket`, deduped by run URL (matrix jobs
// repeat the name) and dropping entries with no link (nothing to open).
function parseChecks(stdout: string): CiCheck[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const checks: CiCheck[] = [];
  for (const c of data as Array<{ name?: unknown; link?: unknown; bucket?: unknown }>) {
    if (!c || typeof c.link !== 'string' || !c.link || seen.has(c.link)) continue;
    seen.add(c.link);
    checks.push({
      name: typeof c.name === 'string' && c.name ? c.name : c.link,
      url: c.link,
      state: bucketToState(c.bucket),
    });
  }
  return checks;
}

/**
 * The current branch PR's CI checks (name + run URL + state), via `gh pr checks`.
 * Empty when gh is unavailable or the branch has no PR. (gh exits non-zero when
 * checks fail/pending, but still prints the JSON.)
 */
export function fetchChecks(cwd: string, onDone: (checks: CiCheck[]) => void): void {
  gh(cwd, ['pr', 'checks', '--json', 'name,link,bucket'], (_err, stdout) => onDone(parseChecks(stdout)));
}

/** The current branch PR's failed CI checks (name + run URL) — the subset of
 *  `fetchChecks` that failed. Empty when gh is unavailable or nothing failed. */
export function fetchFailedChecks(cwd: string, onDone: (checks: FailedCheck[]) => void): void {
  fetchChecks(cwd, (checks) =>
    onDone(checks.filter((c) => c.state === 'fail').map(({ name, url }) => ({ name, url }))),
  );
}

/** A pull request or issue in a list (for the PR / issue pickers). */
export interface GithubListItem {
  number: number;
  title: string;
  url: string;
  author: string; // login, or '' if unknown
  state: PrState; // gh reports MERGED only for PRs; issues are open/closed
}

/**
 * Pull requests matching `query`, via `gh pr list --search`. Lists every state
 * (open, closed, merged) so the picker can show each PR's status. An empty query
 * omits `--search`, listing recent PRs; a non-empty query runs a GitHub search
 * (matching title/body/number server-side). Used by the PR picker to fetch fresh
 * matches as the user types; empty when gh is unavailable.
 */
export function searchPullRequests(
  cwd: string,
  query: string,
  onDone: (items: GithubListItem[]) => void,
  state: PrState | 'all' = 'all',
  onError?: (message: string) => void,
): void {
  const args = ['pr', 'list', '--state', state, '--json', 'number,title,url,author,state', '--limit', '50'];
  const q = query.trim();
  if (q) args.push('--search', q);
  fetchList(cwd, args, onDone, onError);
}

/** Open issues in the repo, via `gh issue list`. */
export function fetchIssues(cwd: string, onDone: (items: GithubListItem[]) => void): void {
  fetchList(cwd, ['issue', 'list', '--json', 'number,title,url,author,state', '--limit', '100'], onDone);
}

// Run a `gh … list --json number,title,url,author,state` and parse it. On failure
// (gh missing/unauthenticated, bad output) it reports via `onError` if given,
// otherwise falls back to an empty list.
function fetchList(
  cwd: string,
  args: string[],
  onDone: (items: GithubListItem[]) => void,
  onError?: (message: string) => void,
): void {
  // Surface a failure through `onError` when supplied, else degrade to empty.
  const fail = (message: string) => (onError ? onError(message) : onDone([]));
  gh(cwd, args, (err, stdout, stderr) => {
    if (err) {
      fail(stderr?.trim() || err.message || 'gh command failed');
      return;
    }
    try {
      const data = JSON.parse(stdout);
      if (!Array.isArray(data)) {
        fail('Unexpected response from gh');
        return;
      }
      const items: GithubListItem[] = [];
      for (const it of data) {
        if (!it || typeof it.url !== 'string' || typeof it.number !== 'number') continue;
        const raw = typeof it.state === 'string' ? it.state.toUpperCase() : '';
        const state: PrState = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : 'open';
        items.push({
          number: it.number,
          title: typeof it.title === 'string' ? it.title : '',
          url: it.url,
          author: typeof it.author?.login === 'string' ? it.author.login : '',
          state,
        });
      }
      onDone(items);
    } catch {
      fail('Could not parse gh output');
    }
  });
}

/**
 * The repository's default branch (e.g. "main"), via `gh`. Calls back with null
 * when gh is unavailable/unauthenticated or the lookup fails.
 */
export function fetchDefaultBranch(cwd: string, onDone: (branch: string | null) => void): void {
  gh(
    cwd,
    ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    (err, stdout) => onDone(err ? null : stdout.trim() || null),
  );
}

/** Web URL of the first pull request associated with `sha` — i.e. the PR that
 *  introduced it — or null when none (a commit pushed straight to a branch).
 *  `gh api` substitutes `{owner}`/`{repo}` from `cwd`'s repo. Async. */
export function fetchCommitPullRequestUrl(cwd: string, sha: string, onDone: (url: string | null) => void): void {
  gh(
    cwd,
    ['api', `repos/{owner}/{repo}/commits/${sha}/pulls`, '--jq', '.[0].html_url // empty'],
    (err, stdout) => onDone(err ? null : stdout.trim() || null),
  );
}

/** Whether the current branch has an upstream tracking branch on a remote. Async. */
function hasUpstream(cwd: string, onDone: (has: boolean) => void): void {
  gitCli(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], (ok) => onDone(ok));
}

/**
 * Open the "create pull request" page in the browser for the current branch.
 *
 * `gh pr create --web` needs the branch to exist on the remote. When the branch
 * has no upstream yet, push it (`git push -u origin <branch>`) first, then open
 * the create-PR page.
 */
export function createPullRequestWeb(cwd: string, onDone: (ok: boolean, stderr: string) => void): void {
  const openWeb = () => gh(cwd, ['pr', 'create', '--web'], (err, _stdout, stderr) => onDone(!err, stderr ?? ''));

  hasUpstream(cwd, (has) => {
    if (has) {
      openWeb();
      return;
    }
    gitCli(cwd, ['branch', '--show-current'], (branchOk, branchOut) => {
      const branch = branchOk ? branchOut.trim() : '';
      if (!branch) {
        onDone(false, 'Cannot create a pull request from a detached HEAD.');
        return;
      }
      gitCli(cwd, ['push', '--set-upstream', 'origin', branch], (pushOk, _stdout, stderr) => {
        if (!pushOk) {
          onDone(false, stderr.trim() || `Could not push '${branch}' to origin.`);
          return;
        }
        openWeb();
      });
    });
  });
}

/**
 * Check out a PR's branch via `gh pr checkout` (fetches it, handling forks).
 * Reports (ok, stderr).
 */
export function checkoutPullRequest(
  cwd: string,
  number: number,
  onDone: (ok: boolean, stderr: string) => void,
): void {
  gh(cwd, ['pr', 'checkout', String(number)], (err, _stdout, stderr) => onDone(!err, stderr ?? ''));
}

// --- reactive GitHub model -------------------------------------------------

/**
 * The slice of the git model the GitHub service needs: the current branch (to
 * re-query the PR when it changes) and a reactive busy/onChange pair (so the
 * service can mirror git's busy state). `GitRepo` satisfies this — passing the
 * interface rather than `GitRepo` itself keeps github.ts free of git.ts/GTK.
 */
export interface GithubServiceGit {
  getBranch(): string | null;
  /** HEAD commit OID, or null on an unborn branch. */
  getHead(): string | null;
  /** Commits ahead/behind upstream, or null when there's no upstream. */
  getAheadBehind(): { ahead: number; behind: number } | null;
  isBusy(): boolean;
  onChange(callback: () => void): () => void;
}

export interface GithubServiceOptions {
  /** A directory inside the repo (its root is resolved from this). */
  cwd: string;
  /** Remote names to try, in order (e.g. upstream → origin). Read each lookup so
   *  config changes are picked up. */
  remoteNames: () => string[];
  /** How often to silently re-poll the PR's CI while alive (ms). */
  pollMs?: number;
}

/**
 * A reactive model of the current branch's GitHub PR + CI status.
 *
 * Owns the `gh` lookups and caches the result; consumers read the cached getters
 * and subscribe via `onChange` (which also fires on busy transitions). `isBusy()`
 * is true while a user-initiated `scheduleRefresh` is pending/in flight, OR
 * whenever the underlying git model is busy — so a push (git-busy) and the
 * follow-up scheduled refresh both read as "loading". Background polling and
 * branch-change re-queries are silent (they don't set busy).
 */
export interface GithubService {
  isBusy(): boolean;
  getRepo(): GithubRepo | null;
  getPullRequest(): PullRequest | null;
  getDefaultBranch(): string | null;
  onChange(callback: () => void): () => void;
  /** Re-query the PR/CI now, silently (no busy). */
  refresh(): void;
  /** Re-query after `delayMs`, holding busy=true from now until it resolves. */
  scheduleRefresh(delayMs: number): void;
  /** Re-point at a different git model + repo dir (active-workbench switch): drops
   *  the old git subscription, resets the cached repo/PR, and re-queries. */
  rebind(git: GithubServiceGit, cwd: string): void;
  dispose(): void;
}

const DEFAULT_POLL_MS = 30000;

class CliGithubService implements GithubService {
  // `git`/`repoDir` are swapped by `rebind` when the active workbench changes.
  private git: GithubServiceGit;
  private repoDir: string | null;
  private readonly remoteNames: () => string[];

  private repo: GithubRepo | null = null;
  private repoResolved = false;
  private pr: PullRequest | null = null;
  private defaultBranch: string | null = null;
  private defaultBranchFetched = false;

  private lastBranch: string | null = null;
  // HEAD commit + ahead/behind, joined — re-poll GitHub whenever this moves on the
  // same branch (a local commit, or a push made outside the editor flips ahead→0).
  private lastHeadSig = '';
  private gitBusy = false;
  // Count of outstanding scheduled refreshes (a pending timer or an in-flight
  // query started by one). Non-zero ⇒ the service is "busy" on its own.
  private scheduledBusy = 0;
  // Bumps on every query so a slow in-flight response that's been superseded
  // (newer query, branch change, or dispose) is discarded.
  private generation = 0;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubscribeGit: () => void;

  constructor(git: GithubServiceGit, options: GithubServiceOptions) {
    this.git = git;
    this.repoDir = repoRoot(options.cwd);
    this.remoteNames = options.remoteNames;
    this.lastBranch = git.getBranch();
    this.lastHeadSig = this.headSig();
    this.gitBusy = git.isBusy();

    this.unsubscribeGit = git.onChange(() => this.onGitChange());
    this.pollTimer = setInterval(() => this.refresh(), options.pollMs ?? DEFAULT_POLL_MS);
    this.refresh();
  }

  isBusy(): boolean {
    return this.scheduledBusy > 0 || this.git.isBusy();
  }
  getRepo(): GithubRepo | null {
    return this.repo;
  }
  getPullRequest(): PullRequest | null {
    return this.pr;
  }
  getDefaultBranch(): string | null {
    return this.defaultBranch;
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  refresh(): void {
    this.lookup();
  }

  scheduleRefresh(delayMs: number): void {
    // Coalesce: a new schedule resets the timer but keeps busy continuous.
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
      this.scheduledBusy--; // the superseded schedule's busy is replaced below
    }
    this.scheduledBusy++;
    this.notify(); // busy may have just turned on
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      // Hand this schedule's busy hold to the query; cleared when it resolves.
      this.lookup(() => {
        this.scheduledBusy--;
        this.notify();
      });
    }, delayMs);
  }

  rebind(git: GithubServiceGit, cwd: string): void {
    if (git === this.git) return;
    this.unsubscribeGit();
    this.generation++; // discard any in-flight response bound to the old repo
    this.git = git;
    this.repoDir = repoRoot(cwd);
    // Forget the old repo's resolution so the new root is looked up fresh.
    this.repo = null;
    this.repoResolved = false;
    this.pr = null;
    this.defaultBranch = null;
    this.defaultBranchFetched = false;
    this.lastBranch = git.getBranch();
    this.lastHeadSig = this.headSig();
    this.gitBusy = git.isBusy();
    this.unsubscribeGit = git.onChange(() => this.onGitChange());
    this.notify(); // clear the old branch's PR/CI from the view immediately
    this.refresh();
  }

  dispose(): void {
    this.generation++; // discard any in-flight response
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    this.pollTimer = this.scheduleTimer = null;
    this.unsubscribeGit();
    this.listeners.clear();
  }

  // --- internals -------------------------------------------------------------

  // Git moved: a branch switch re-queries the PR; a HEAD/ahead-behind move on the
  // same branch re-polls (catching a commit or a push made outside the editor); a
  // busy transition just needs re-broadcasting so consumers re-read composed busy.
  private onGitChange(): void {
    const branch = this.git.getBranch();
    const busy = this.git.isBusy();
    if (branch !== this.lastBranch) {
      this.lastBranch = branch;
      this.lastHeadSig = this.headSig(); // baseline for the new branch
      this.pr = null; // stale until the new branch's lookup resolves
      this.notify(); // clear the old branch's PR from the view now
      this.lookup();
      return;
    }
    // Same branch: re-poll GitHub when HEAD or ahead/behind moved. Plain working-
    // tree edits don't change this, so we don't re-query gh on every keystroke.
    const headSig = this.headSig();
    if (headSig !== this.lastHeadSig) {
      this.lastHeadSig = headSig;
      this.refresh();
    }
    if (busy !== this.gitBusy) {
      this.gitBusy = busy;
      this.notify();
    }
  }

  // HEAD commit + ahead/behind, joined into a comparison key.
  private headSig(): string {
    const ab = this.git.getAheadBehind();
    return `${this.git.getHead() ?? ''}|${ab ? `${ab.ahead}/${ab.behind}` : ''}`;
  }

  // Re-query the repo (once), default branch (once), and the PR/CI. `onSettled`
  // runs after the PR query finishes (success or failure), used to release a
  // scheduled-refresh busy hold.
  private lookup(onSettled?: () => void): void {
    if (!this.repoResolved) {
      this.repoResolved = true; // resolve once (matches the prior synchronous semantics)
      if (!this.repoDir) {
        onSettled?.();
        return;
      }
      const gen = this.generation;
      resolveGithubRepo(this.repoDir, this.remoteNames(), (repo) => {
        if (gen !== this.generation) {
          onSettled?.();
          return; // superseded by a rebind/dispose
        }
        this.repo = repo;
        this.lookupResolved(onSettled);
      });
      return;
    }
    this.lookupResolved(onSettled);
  }

  // The repo is resolved; query its default branch (once) and the PR/CI.
  private lookupResolved(onSettled?: () => void): void {
    if (!this.repo || !this.repoDir) {
      onSettled?.();
      return;
    }
    if (!this.defaultBranchFetched) {
      this.defaultBranchFetched = true;
      const gen = this.generation;
      fetchDefaultBranch(this.repoDir, (branch) => {
        if (gen !== this.generation) return;
        this.defaultBranch = branch;
        this.notify();
      });
    }
    const gen = ++this.generation;
    fetchPullRequest(this.repoDir, (pr) => {
      if (gen !== this.generation) {
        onSettled?.();
        return;
      }
      this.pr = pr;
      onSettled?.();
      this.notify();
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Open a reactive GitHub PR/CI model bound to a git model. */
export function openGithubService(git: GithubServiceGit, options: GithubServiceOptions): GithubService {
  return new CliGithubService(git, options);
}
