/*
 * github.ts — GitHub remote parsing and PR/issue lookup.
 *
 * Pure node (no GTK), so it's testable in isolation. Remote URLs are parsed into
 * `{ host, owner, repo }` (GitHub only); the repository is resolved by trying a
 * list of remote names in order (upstream → origin). Pull-request and linked-
 * issue lookup shells out to the `gh` CLI, degrading to "none" when gh is absent,
 * unauthenticated, or the branch has no PR.
 */
import { execFile } from 'node:child_process';
import { gitSync } from './cli.ts';

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

/**
 * Resolve the GitHub repo for `root` by trying `remoteNames` in order (e.g.
 * upstream then origin). Returns the first that parses as a GitHub remote.
 */
export function resolveGithubRepo(root: string, remoteNames: string[]): GithubRepo | null {
  // List the remotes first so we never run `get-url` on a missing one (which
  // would leak git's "No such remote" to stderr).
  let remotes: Set<string>;
  try {
    remotes = new Set(
      gitSync(root, ['remote'])
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
  for (const name of remoteNames) {
    if (!remotes.has(name)) continue;
    try {
      const repo = parseGithubRemote(gitSync(root, ['remote', 'get-url', name]).trim());
      if (repo) return repo;
    } catch {
      // unreadable remote — try the next
    }
  }
  return null;
}

/**
 * Look up the pull request for the current branch via `gh`. Calls back with null
 * when gh is unavailable/unauthenticated or the branch has no PR.
 */
export function fetchPullRequest(cwd: string, onDone: (pr: PullRequest | null) => void): void {
  execFile(
    'gh',
    ['pr', 'view', '--json', 'number,url,state,statusCheckRollup,closingIssuesReferences'],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 },
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
        onDone({ number, url, state, ci: rollupCi(data.statusCheckRollup), issueUrl });
      } catch {
        onDone(null);
      }
    },
  );
}

/** A failed CI check on a PR: its display name and the run/job page URL. */
export interface FailedCheck {
  name: string;
  url: string;
}

/**
 * The current branch PR's failed CI checks (name + run URL), via `gh pr checks`.
 * Empty when gh is unavailable, the branch has no PR, or nothing failed. (gh
 * exits non-zero when checks fail/pending, but still prints the JSON.)
 */
export function fetchFailedChecks(cwd: string, onDone: (checks: FailedCheck[]) => void): void {
  execFile(
    'gh',
    ['pr', 'checks', '--json', 'name,link,bucket'],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (_err, stdout) => {
      try {
        const data = JSON.parse(stdout);
        if (!Array.isArray(data)) {
          onDone([]);
          return;
        }
        const seen = new Set<string>();
        const checks: FailedCheck[] = [];
        for (const c of data) {
          if (!c || c.bucket !== 'fail' || typeof c.link !== 'string' || !c.link) continue;
          if (seen.has(c.link)) continue; // dedupe by URL
          seen.add(c.link);
          checks.push({ name: typeof c.name === 'string' && c.name ? c.name : c.link, url: c.link });
        }
        onDone(checks);
      } catch {
        onDone([]); // no PR / not authed / gh missing
      }
    },
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
 * Pull requests in the repo, via `gh pr list`. Lists every state (open, closed,
 * and merged) so the picker can show each PR's status; defaults to open-only
 * unless `state` is given.
 */
export function fetchPullRequests(
  cwd: string,
  onDone: (items: GithubListItem[]) => void,
  state: PrState | 'all' = 'all',
): void {
  fetchList(
    cwd,
    ['pr', 'list', '--state', state, '--json', 'number,title,url,author,state', '--limit', '100'],
    onDone,
  );
}

/** Open issues in the repo, via `gh issue list`. */
export function fetchIssues(cwd: string, onDone: (items: GithubListItem[]) => void): void {
  fetchList(cwd, ['issue', 'list', '--json', 'number,title,url,author,state', '--limit', '100'], onDone);
}

// Run a `gh … list --json number,title,url,author,state` and parse it. Empty when
// gh is unavailable or there are none.
function fetchList(cwd: string, args: string[], onDone: (items: GithubListItem[]) => void): void {
  execFile('gh', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err) {
      onDone([]);
      return;
    }
    try {
      const data = JSON.parse(stdout);
      if (!Array.isArray(data)) {
        onDone([]);
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
      onDone([]);
    }
  });
}

/** Open the "create pull request" page in the browser for the current branch. */
export function createPullRequestWeb(cwd: string, onDone: (ok: boolean, stderr: string) => void): void {
  execFile(
    'gh',
    ['pr', 'create', '--web'],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (err, _stdout, stderr) => onDone(!err, stderr ?? ''),
  );
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
  execFile(
    'gh',
    ['pr', 'checkout', String(number)],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    (err, _stdout, stderr) => onDone(!err, stderr ?? ''),
  );
}
