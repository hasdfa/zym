/*
 * WorkspaceWatcher — watches a project tree for file changes, to feed an LSP
 * server's `workspace/didChangeWatchedFiles`.
 *
 * It places a non-recursive `fs.watch` on each directory (adding/dropping them as
 * dirs appear/vanish) rather than one recursive watch, so heavy/irrelevant trees
 * (`node_modules`, `.git`, build output) can be excluded — `fs.watch({recursive})`
 * offers no ignore and would blow past inotify limits. Raw events are coalesced
 * over a short window; each changed path's type (created/changed/deleted) is
 * resolved by stat + a set of known files. Glob filtering happens in the caller.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';

// LSP FileChangeType: Created = 1, Changed = 2, Deleted = 3.
export interface FileChange {
  path: string;
  type: 1 | 2 | 3;
}

// Directories never worth watching (huge, noisy, or VCS internals).
const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.cache', 'coverage', 'target', '.venv', '__pycache__',
]);

const DEBOUNCE_MS = 60;

export class WorkspaceWatcher {
  private readonly root: string;
  private readonly onBatch: (changes: FileChange[]) => void;
  private readonly ignore: Set<string>;
  private readonly watchers = new Map<string, Fs.FSWatcher>(); // dir → watcher
  private readonly seen = new Set<string>(); // known files (created vs changed)
  private pending = new Set<string>(); // paths touched since the last flush
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(root: string, onBatch: (changes: FileChange[]) => void, ignore: Set<string> = DEFAULT_IGNORE) {
    this.root = Path.resolve(root);
    this.onBatch = onBatch;
    this.ignore = ignore;
  }

  /** Begin watching (walks the tree once to place watches + seed known files). */
  start(): void {
    this.watchDir(this.root);
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  private watchDir(dir: string): void {
    if (this.disposed || this.watchers.has(dir)) return;
    let watcher: Fs.FSWatcher;
    try {
      watcher = Fs.watch(dir, (_event, filename) => {
        if (filename) this.enqueue(Path.join(dir, filename.toString()));
      });
    } catch {
      return; // permission / limit — skip this dir, keep the rest
    }
    watcher.on('error', () => {
      watcher.close();
      this.watchers.delete(dir);
    });
    this.watchers.set(dir, watcher);

    let entries: Fs.Dirent[];
    try {
      entries = Fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!this.ignore.has(entry.name)) this.watchDir(Path.join(dir, entry.name));
      } else if (entry.isFile()) {
        this.seen.add(Path.join(dir, entry.name));
      }
    }
  }

  private enqueue(path: string): void {
    if (this.ignore.has(Path.basename(path))) return;
    this.pending.add(path);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, DEBOUNCE_MS);
    }
  }

  private flush(): void {
    if (this.disposed) return;
    const pending = this.pending;
    this.pending = new Set();
    const changes: FileChange[] = [];
    for (const path of pending) {
      let exists = false;
      let isDir = false;
      try {
        const stat = Fs.statSync(path);
        exists = true;
        isDir = stat.isDirectory();
      } catch {
        // gone
      }
      if (isDir) {
        // A new directory appeared — start watching it (its files come next).
        if (!this.ignore.has(Path.basename(path))) this.watchDir(path);
        continue; // directories aren't reported as file changes
      }
      if (exists) {
        const type: 1 | 2 = this.seen.has(path) ? 2 : 1; // Changed vs Created
        this.seen.add(path);
        changes.push({ path, type });
      } else if (this.seen.delete(path)) {
        changes.push({ path, type: 3 }); // Deleted
      } else {
        // An unknown path vanished — likely a directory; drop its subtree's watches.
        this.dropWatchersUnder(path);
      }
    }
    if (changes.length > 0) this.onBatch(changes);
  }

  private dropWatchersUnder(prefix: string): void {
    const root = prefix + Path.sep;
    for (const [dir, watcher] of this.watchers) {
      if (dir === prefix || dir.startsWith(root)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    }
  }
}
