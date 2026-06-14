/*
 * Git integration, isolated behind a small abstraction.
 *
 * The implementation uses Ggit (libgit2 via GObject introspection) — in-process,
 * synchronous, no subprocess. (We started with simple-git, but node's
 * child_process is starved while node-gtk's GLib main loop runs, so its promises
 * never settled; Gio-native / in-process APIs are required here.) Callers only
 * ever see the `GitRepo` interface, so the backend can still be swapped.
 *
 * `onChange` fires when the branch or working-tree line counts change. A branch
 * switch is caught instantly via a Gio file monitor on `HEAD`; working-tree edits
 * have no single file to watch, so they are picked up by a low-priority poll that
 * only notifies when the computed (branch + insertions/deletions) signature moves.
 */
import * as Path from 'node:path';
import { GLib, Gio, Ggit } from './gi.ts';

type FileMonitor = InstanceType<typeof Gio.FileMonitor>;
type GioFile = ReturnType<typeof Gio.File.newForPath>;
type Repository = InstanceType<typeof Ggit.Repository>;

// node-gtk quirk: Gio.File instance methods are undefined on the concrete
// wrapper (and on GFiles handed back from Ggit), so we reach them through the
// interface prototype. Same workaround as FileTree.
const FileProto = (Gio.File as any).prototype;

const POLL_INTERVAL_MS = 1500;

/** Working-tree line delta vs HEAD, untracked files included as insertions. */
export interface GitStatus {
  added: number;
  removed: number;
}

/** Commit counts of the current branch relative to its upstream. */
export interface AheadBehind {
  ahead: number;
  behind: number;
}

/** A single file's working-tree status: untracked, or tracked-and-modified
 *  with its inserted/deleted line counts. */
export type FileGitStatus =
  | { kind: 'untracked' }
  | { kind: 'modified'; added: number; removed: number };

export interface GitRepo {
  /**
   * Current branch name, a short SHA when detached, or null outside a repo.
   *
   * Synchronous by design: node's async primitives (promises, child_process)
   * are starved while node-gtk's GLib main loop is running, so a Promise-based
   * API would never settle on screen. A backend swapped in later must likewise
   * resolve synchronously (e.g. libgit2) or via GLib-native async, not node I/O.
   */
  getBranch(): string | null;
  /**
   * Inserted/deleted line counts of the working tree vs HEAD — matching
   * `git diff HEAD --numstat` plus untracked files (counted as insertions).
   * Null outside a repo.
   */
  getStatus(): GitStatus | null;
  /**
   * Commits the current branch is ahead/behind its upstream tracking branch.
   * Null outside a repo, on a detached HEAD, or when there is no upstream.
   */
  getAheadBehind(): AheadBehind | null;
  /**
   * Per-file working-tree status keyed by absolute path: untracked files, and
   * tracked files with their insert/delete line counts (matching `git diff
   * HEAD`). Empty map outside a repo or on error.
   */
  getFileStatuses(): Map<string, FileGitStatus>;
  /**
   * Absolute paths of every file tracked by git (present in the index — staged
   * or committed). Empty outside a repo or on error.
   */
  getTrackedPaths(): Set<string>;
  /** Whether a git operation (run via `run`) is currently in flight. */
  isBusy(): boolean;
  /**
   * Run a git subcommand (e.g. `['fetch']`) asynchronously and report whether it
   * exited cleanly. Mutating/network operations must go through here rather than
   * the synchronous libgit2 reads: it shells out via Gio.Subprocess, which is
   * GLib-native and so does not block the main loop. `isBusy()` is true for the
   * duration and `onChange` fires on both the busy transition and completion.
   */
  run(args: string[], onDone?: (ok: boolean) => void): void;
  /** Subscribe to branch / working-tree / busy changes. Returns an unsubscribe fn. */
  onChange(callback: () => void): () => void;
  /** Stop watching and release resources. */
  dispose(): void;
}

let initialized = false;
function ensureGgitInit(): void {
  if (initialized) return;
  Ggit.init(); // ref-counted libgit2 init; safe to pair with later shutdowns
  initialized = true;
}

/** Open the repository containing `cwd` (resolved lazily; non-repos are fine). */
export function openGitRepo(cwd: string): GitRepo {
  return new GgitRepo(cwd);
}

class GgitRepo implements GitRepo {
  // The repo's `.git` location, used both to (re)open for fresh reads and to
  // monitor HEAD. Null when `cwd` is not inside a git repository.
  private readonly gitDir: GioFile | null;
  private readonly cwd: string;
  private readonly listeners = new Set<() => void>();
  private monitor: FileMonitor | null = null;
  private pollId = 0;
  private watching = false;
  private lastSignature = '';
  private busyCount = 0;

  constructor(cwd: string) {
    ensureGgitInit();
    this.cwd = cwd;
    this.gitDir = discoverGitDir(cwd);
  }

  getBranch(): string | null {
    // Open fresh each read: libgit2 caches the ref db, so reusing a Repository
    // could miss an external checkout that just rewrote HEAD.
    const repo = this.openRepo();
    if (!repo) return null;
    try {
      return repo.getHead()?.getShorthand() ?? null;
    } catch {
      return null; // unborn branch (empty repo), unreadable HEAD, etc.
    }
  }

  isBusy(): boolean {
    return this.busyCount > 0;
  }

  run(args: string[], onDone?: (ok: boolean) => void): void {
    if (!this.gitDir) {
      onDone?.(false);
      return;
    }
    let proc;
    try {
      const launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE);
      launcher.setCwd(this.cwd);
      proc = launcher.spawnv(['git', ...args]);
    } catch {
      onDone?.(false); // spawn failed (e.g. git not on PATH); never entered busy
      return;
    }
    this.enterBusy();
    proc.waitAsync(null, () => {
      const ok = proc.getSuccessful();
      // The operation may have moved HEAD / refs (fetch, pull, …); force the next
      // signature to differ so the refresh on leaveBusy reflects the new state.
      this.lastSignature = '';
      this.leaveBusy();
      onDone?.(ok);
    });
  }

  getStatus(): GitStatus | null {
    const repo = this.openRepo();
    if (!repo) return null;
    try {
      const options = Ggit.DiffOptions.new();
      const flags = Ggit.DiffOption.SHOW_UNTRACKED_CONTENT | Ggit.DiffOption.RECURSE_UNTRACKED_DIRS;
      options.setFlags(flags as any);
      // Tree → workdir compares HEAD directly to file contents (staged +
      // unstaged combined), matching `git diff HEAD`. SHOW_UNTRACKED_CONTENT
      // makes untracked files contribute their lines as insertions.
      const diff = Ggit.Diff.newTreeToWorkdir(repo, headTree(repo), options);
      let added = 0;
      let removed = 0;
      const count = Number(diff.getNumDeltas());
      for (let i = 0; i < count; i++) {
        // getLineStats(): [ok, context, insertions, deletions]
        const stats = Ggit.Patch.newFromDiff(diff, i).getLineStats();
        added += Number(stats[2]);
        removed += Number(stats[3]);
      }
      return { added, removed };
    } catch {
      return null;
    }
  }

  getAheadBehind(): AheadBehind | null {
    const repo = this.openRepo();
    if (!repo) return null;
    try {
      const head = repo.getHead();
      const name = head?.getShorthand();
      if (!name) return null;
      const upstream = repo.lookupBranch(name, Ggit.BranchType.LOCAL)?.getUpstream();
      const local = head?.getTarget();
      const remote = upstream?.getTarget();
      if (!local || !remote) return null; // detached, or no upstream configured
      const [ahead, behind] = repo.getAheadBehind(local, remote);
      return { ahead: Number(ahead), behind: Number(behind) };
    } catch {
      return null;
    }
  }

  getFileStatuses(): Map<string, FileGitStatus> {
    const statuses = new Map<string, FileGitStatus>();
    const repo = this.openRepo();
    if (!repo) return statuses;
    try {
      const workdir = repo.getWorkdir();
      const workdirPath = workdir ? (FileProto.getPath.call(workdir) as string | null) : null;
      if (!workdirPath) return statuses;

      const options = Ggit.DiffOptions.new();
      const flags = Ggit.DiffOption.SHOW_UNTRACKED_CONTENT | Ggit.DiffOption.RECURSE_UNTRACKED_DIRS;
      options.setFlags(flags as any);
      const diff = Ggit.Diff.newTreeToWorkdir(repo, headTree(repo), options);

      const count = Number(diff.getNumDeltas());
      for (let i = 0; i < count; i++) {
        const patch = Ggit.Patch.newFromDiff(diff, i);
        const delta = patch.getDelta();
        if (!delta) continue;
        const file = delta.getNewFile() ?? delta.getOldFile();
        const rel = file?.getPath();
        if (!rel) continue;
        const abs = Path.join(workdirPath, rel);

        if (delta.getStatus() === Ggit.DeltaType.UNTRACKED) {
          statuses.set(abs, { kind: 'untracked' });
        } else {
          // getLineStats(): [ok, context, insertions, deletions]
          const stats = patch.getLineStats();
          statuses.set(abs, { kind: 'modified', added: Number(stats[2]), removed: Number(stats[3]) });
        }
      }
    } catch {
      // return whatever was collected before the error
    }
    return statuses;
  }

  getTrackedPaths(): Set<string> {
    const paths = new Set<string>();
    const repo = this.openRepo();
    if (!repo) return paths;
    try {
      const workdir = repo.getWorkdir();
      const workdirPath = workdir ? (FileProto.getPath.call(workdir) as string | null) : null;
      if (!workdirPath) return paths;
      const entries = repo.getIndex()?.getEntries();
      if (!entries) return paths;
      const count = Number(entries.size());
      for (let i = 0; i < count; i++) {
        const rel = entries.getByIndex(i)?.getPath();
        if (rel) paths.add(Path.join(workdirPath, rel));
      }
    } catch {
      // return whatever was collected before the error
    }
    return paths;
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    this.ensureWatching();
    return () => this.listeners.delete(callback);
  }

  dispose(): void {
    this.listeners.clear();
    this.monitor?.cancel();
    this.monitor = null;
    if (this.pollId) {
      GLib.sourceRemove(this.pollId);
      this.pollId = 0;
    }
  }

  private openRepo(): Repository | null {
    if (!this.gitDir) return null;
    try {
      return Ggit.Repository.open(this.gitDir);
    } catch {
      return null;
    }
  }

  private ensureWatching(): void {
    const gitDir = this.gitDir;
    if (this.watching || !gitDir) return;
    this.watching = true;
    this.lastSignature = this.signature();

    // Branch switches rewrite HEAD — watch it for instant updates.
    const head = FileProto.getChild.call(gitDir, 'HEAD');
    this.monitor = FileProto.monitorFile.call(head, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.monitor!.on('changed', () => this.maybeEmit());

    // Working-tree edits have no single file to watch; poll and diff the
    // signature so listeners only fire when the visible numbers actually move.
    this.pollId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT_IDLE, POLL_INTERVAL_MS, () => {
      this.maybeEmit();
      return true; // keep polling
    });
  }

  private signature(): string {
    const status = this.getStatus();
    const sync = this.getAheadBehind();
    return [
      this.getBranch(),
      status?.added ?? 0,
      status?.removed ?? 0,
      sync?.ahead ?? 0,
      sync?.behind ?? 0,
    ].join('|');
  }

  private maybeEmit(): void {
    const signature = this.signature();
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.notify();
  }

  // Busy is reference-counted so overlapping operations stay busy until the last
  // one finishes; listeners fire on the 0↔1 transitions (spinner on/off).
  private enterBusy(): void {
    if (this.busyCount++ === 0) this.notify();
  }

  private leaveBusy(): void {
    if (--this.busyCount === 0) this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The HEAD commit's tree, or null on an unborn branch (empty repo). */
function headTree(repo: Repository): InstanceType<typeof Ggit.Tree> | null {
  try {
    return repo.revparse('HEAD^{tree}') as InstanceType<typeof Ggit.Tree>;
  } catch {
    return null;
  }
}

/** The `.git` location for `cwd`, or null when it is not inside a repository. */
function discoverGitDir(cwd: string): GioFile | null {
  try {
    return Ggit.Repository.discover(Gio.File.newForPath(cwd));
  } catch {
    return null;
  }
}
