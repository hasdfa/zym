/*
 * status.ts — pure parsers for the git CLI's machine-readable output, used by
 * the CLI-backed `GitRepo` (../git.ts). No I/O and no node-gtk: everything here
 * is string → data, so it is exhaustively unit-testable (see status.test.ts).
 *
 * `git status --porcelain=v2 --branch -z` is git's own stable machine format and
 * gives, in ONE call: the branch, ahead/behind vs upstream, conflict state, and
 * every changed path with its staged (X) / unstaged (Y) state. Per-line ± counts
 * come from `git diff --numstat -z HEAD`; the tracked set from `git ls-files -z`.
 */

/** One changed path from porcelain v2, with where the change lives. */
export interface StatusEntry {
  /** Repo-relative path (for renames, the new path). */
  relPath: string;
  /** Index differs from HEAD (the X column). */
  staged: boolean;
  /** Worktree differs from the index (the Y column). */
  unstaged: boolean;
  /** Untracked (`?`) — not in the index at all. */
  untracked: boolean;
  /** Unmerged (`u`) — a conflict. */
  conflicted: boolean;
}

export interface ParsedStatus {
  /** Branch name, a short SHA when detached, or null when there's no branch info. */
  branch: string | null;
  /** HEAD commit OID, or null on an unborn branch (no commits yet). */
  commit: string | null;
  /** Commits ahead of upstream, or null when there is no upstream. */
  ahead: number | null;
  /** Commits behind upstream, or null when there is no upstream. */
  behind: number | null;
  /** Any unmerged (conflicted) entries present. */
  conflicts: boolean;
  entries: StatusEntry[];
}

const H_HEAD = '# branch.head ';
const H_OID = '# branch.oid ';
const H_AB = '# branch.ab ';

/** Parse `git status --porcelain=v2 --branch -z` (NUL-separated records). */
export function parseStatus(out: string): ParsedStatus {
  let head: string | null = null;
  let oid: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let conflicts = false;
  const entries: StatusEntry[] = [];

  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;

    if (tok[0] === '#') {
      if (tok.startsWith(H_HEAD)) head = tok.slice(H_HEAD.length);
      else if (tok.startsWith(H_OID)) oid = tok.slice(H_OID.length);
      else if (tok.startsWith(H_AB)) {
        const m = tok.slice(H_AB.length).match(/^\+(-?\d+)\s+-(-?\d+)$/);
        if (m) {
          ahead = parseInt(m[1], 10);
          behind = parseInt(m[2], 10);
        }
      }
      continue;
    }

    const kind = tok[0];
    if (kind === '?') {
      // "? <path>"
      entries.push(entry(tok.slice(2), false, true, true, false));
    } else if (kind === '1') {
      // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>"
      const f = tok.split(' ');
      const xy = f[1] ?? '..';
      entries.push(entry(f.slice(8).join(' '), xy[0] !== '.', xy[1] !== '.', false, false));
    } else if (kind === '2') {
      // "2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>"
      const f = tok.split(' ');
      const xy = f[1] ?? '..';
      entries.push(entry(f.slice(9).join(' '), xy[0] !== '.', xy[1] !== '.', false, false));
      i++; // the next token is the rename's original path — consume it
    } else if (kind === 'u') {
      // "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>"
      conflicts = true;
      const f = tok.split(' ');
      entries.push(entry(f.slice(10).join(' '), true, true, false, true));
    }
    // '!' (ignored) and anything else: skip.
  }

  // branch.head is the literal "(detached)" when detached; branch.oid is
  // "(initial)" on an unborn branch (no commits yet). Match libgit2's shorthand:
  // the branch name normally, a short SHA when detached.
  const branch =
    head == null
      ? null
      : head === '(detached)'
        ? oid && oid !== '(initial)'
          ? oid.slice(0, 7)
          : null
        : head;

  const commit = oid && oid !== '(initial)' ? oid : null;
  return { branch, commit, ahead, behind, conflicts, entries };
}

function entry(
  relPath: string,
  staged: boolean,
  unstaged: boolean,
  untracked: boolean,
  conflicted: boolean,
): StatusEntry {
  return { relPath, staged, unstaged, untracked, conflicted };
}

/** Per-path inserted/deleted line counts. */
export interface LineDelta {
  added: number;
  removed: number;
}

/** Parse `git diff --numstat -z HEAD` → relPath → {added, removed}.
 *  Binary files (`-\t-`) count as zero; renames carry old\0new path tokens. */
export function parseNumstat(out: string): Map<string, LineDelta> {
  const map = new Map<string, LineDelta>();
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const t1 = tok.indexOf('\t');
    if (t1 < 0) continue;
    const t2 = tok.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const addedS = tok.slice(0, t1);
    const removedS = tok.slice(t1 + 1, t2);
    let path = tok.slice(t2 + 1);
    if (path === '') {
      // rename under -z: "<a>\t<r>\t" then the old and new paths as two tokens.
      i++; // old path
      path = tokens[++i] ?? '';
    }
    if (!path) continue;
    const added = addedS === '-' ? 0 : parseInt(addedS, 10) || 0;
    const removed = removedS === '-' ? 0 : parseInt(removedS, 10) || 0;
    map.set(path, { added, removed });
  }
  return map;
}

/** Parse `git ls-files -z` → repo-relative tracked paths. */
export function parseLsFiles(out: string): string[] {
  return out.split('\0').filter(Boolean);
}
