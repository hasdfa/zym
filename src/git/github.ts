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
