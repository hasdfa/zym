/*
 * GitGutter — a VS Code-style change bar in the editor's left gutter.
 *
 * Draws a colored bar on each line that differs from the index/HEAD: unstaged
 * changes (added=green, modified=amber, deletion marker=red) and staged changes
 * (blue). Two diffs feed it, both computed in-process (Myers, see util/lineDiff):
 * the live buffer against the file's *index* blob (unstaged hunks — the
 * stage/revert targets) and the index against the *HEAD* blob (staged hunks — the
 * unstage targets). Both base blobs are (re)fetched on load and on any
 * `GitRepo.onChange` (commits, staging, branch switches), so the bars stay
 * correct as all three sides move.
 *
 * It also drives hunk-level git actions: `stageHunk` / `unstageHunk` synthesize a
 * unified diff for the hunk under the cursor and `git apply` it to the index;
 * reverting is done in the buffer by the editor (it owns the edit).
 *
 * Mirrors DiagnosticsView: a `GtkSource.GutterRendererText` subclass driven by a
 * line→kind map, repainted with `queueDraw()`.
 */
import * as Path from 'node:path';
import { Gtk, GtkSource, registerClass, type SourceView } from '../../gi.ts';
import { theme } from '../../theme/theme.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { buildRowMap, computeHunks, formatHunkPatch, hunkContainsBufferRow, type Hunk } from '../../util/hunkPatch.ts';
import { applyPatch, git, repoRoot } from '../../git.ts';
import type { GitRepo } from '../../git.ts';

type ChangeKind = 'added' | 'modified' | 'removed';

// Bar colors match the rest of the git UI (GitBranchButton / GitPanel): theme
// semantic colors. Staged changes use the `info` blue so they read as a distinct
// (already-staged, unstageable) state next to the unstaged add/modify/remove.
const COLORS: Record<ChangeKind, string> = {
  added: theme.ui.status.success,
  modified: theme.ui.status.warning,
  removed: theme.ui.status.error,
};
const STAGED_COLOR = theme.ui.status.info;
// U+258F LEFT ONE EIGHTH BLOCK — the thinnest full-height block glyph (~1px), so
// stacked lines read as one continuous hairline bar.
const BAR = '▏';

// Coalesce keystrokes before re-diffing the buffer.
const DEBOUNCE_MS = 150;

// Split text into lines, tolerating CRLF and ignoring a single trailing newline
// (so a file's final newline isn't reported as a phantom change).
function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

class GitGutterRenderer extends GtkSource.GutterRendererText {
  // Assigned after construction; read on every draw. (line is 0-based.)
  kindByLine!: Map<number, ChangeKind>;
  stagedLines!: Set<number>;
  viewToModel!: (line: number) => number;
  buffer!: any;

  queryData(_lines: any, line: number) {
    // The diff is keyed by MODEL/file lines; translate this view line (folds collapse
    // text, so view lines diverge). A folded body's changed lines have no view line of
    // their own → their bars simply don't show (no pile-up at the collapsed position).
    const modelLine = this.viewToModel(line);
    const kind = this.kindByLine?.get(modelLine);
    if (kind) {
      this.setMarkup(`<span foreground="${COLORS[kind]}">${BAR}</span>`, -1);
      return;
    }
    // Staged-only lines (no overlapping unstaged change) read blue.
    if (this.stagedLines?.has(modelLine)) {
      this.setMarkup(`<span foreground="${STAGED_COLOR}">${BAR}</span>`, -1);
      return;
    }
    this.setMarkup(' ', -1);
  }
}
registerClass(GitGutterRenderer);

export class GitGutter {
  private readonly view: SourceView;
  private readonly getPath: () => string | null;
  private readonly getText: () => string;
  // The repo whose HEAD/index changes re-trigger a diff (and that staging pokes for
  // the Source Control panel). Swapped via `setGit` when the editor's workbench
  // re-roots into a worktree. The diff *bases* are fetched from the file's own repo
  // root (`rootFor`), so they're correct regardless of this.
  private git: GitRepo;
  private gitUnsub?: () => void;
  private readonly renderer: GitGutterRenderer;
  // Unstaged changes (index → buffer): the stage / revert targets.
  private readonly kindByLine = new Map<number, ChangeKind>();
  // Staged changes (HEAD → index), mapped onto buffer rows: the unstage targets.
  private readonly stagedLines = new Set<number>();
  private readonly subs = new CompositeDisposable();

  // The current file's index / HEAD blobs, split into lines; null until fetched.
  private indexLines: string[] | null = null;
  private headLines: string[] | null = null;
  // The latest hunk lists, rebuilt on every recompute() and read by the actions.
  private unstagedHunks: Hunk[] = [];
  private stagedHunks: Hunk[] = [];
  // Repo root + repo-relative path for the current file (set per refresh).
  private root: string | null = null;
  private relPath: string | null = null;
  // Bumped per base fetch so a late async result for a superseded file is dropped.
  private baseGeneration = 0;
  // Pending debounced recompute (a GLib timeout id; 0 when none).
  private updateTimer: NodeJS.Timeout | null = null;
  // Cache the repo root per path so the sync `rev-parse` isn't run on every fetch.
  private cachedRoot: string | null = null;
  private cachedRootPath: string | null = null;

  // Maps a VIEW line to its MODEL (file) line — folds collapse text so they diverge.
  // Identity when not provided (no folds). The diff is keyed by model/file lines, so
  // the gutter (queried per view line) translates back through this.
  private readonly viewToModelLine: (line: number) => number;

  constructor(
    view: SourceView,
    getPath: () => string | null,
    getText: () => string,
    gitRepo: GitRepo,
    viewToModelLine?: (line: number) => number,
  ) {
    this.view = view;
    this.getPath = getPath;
    this.getText = getText;
    this.git = gitRepo;
    this.viewToModelLine = viewToModelLine ?? ((line) => line);

    this.renderer = new GitGutterRenderer();
    (this.renderer as any).kindByLine = this.kindByLine;
    (this.renderer as any).stagedLines = this.stagedLines;
    (this.renderer as any).viewToModel = this.viewToModelLine;
    (this.renderer as any).buffer = (view as any).getBuffer();
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).insert(this.renderer, 0);

    // HEAD / index moved (commit / checkout / staging): re-fetch the bases and re-diff.
    this.gitUnsub = this.git.onChange(() => this.refresh());
  }

  /** Re-point at a different repo (the editor's workbench re-rooted into a worktree):
   *  swap the change subscription and re-diff against the new repo's HEAD/index. */
  setGit(git: GitRepo): void {
    if (git === this.git) return;
    this.gitUnsub?.();
    this.git = git;
    this.gitUnsub = git.onChange(() => this.refresh());
    this.cachedRootPath = null; // force rootFor to re-resolve for the new repo
    this.refresh();
  }

  /** (Re)fetch the file's index + HEAD blobs, then re-diff. Call on load / save /
   *  HEAD change. */
  refresh(): void {
    const path = this.getPath();
    const root = path ? this.rootFor(path) : null;
    this.root = root;
    this.relPath = path && root ? Path.relative(root, path) : null;
    if (!path || !root || !this.relPath) {
      this.indexLines = [];
      this.headLines = [];
      this.recompute();
      return;
    }
    const rel = this.relPath;
    const generation = ++this.baseGeneration;
    // No index/HEAD blob (untracked / new / unborn HEAD) → empty base, so that side
    // reads as fully added. Recompute once both fetches for this generation land.
    let pending = 2;
    const settle = () => {
      if (generation !== this.baseGeneration) return; // superseded by a newer fetch
      if (--pending === 0) this.recompute();
    };
    git(root, ['show', `:${rel}`], (ok, stdout) => {
      if (generation === this.baseGeneration) this.indexLines = ok ? splitLines(stdout) : [];
      settle();
    });
    git(root, ['show', `HEAD:${rel}`], (ok, stdout) => {
      if (generation === this.baseGeneration) this.headLines = ok ? splitLines(stdout) : [];
      settle();
    });
  }

  /** Debounced re-diff of the live buffer against the cached bases (on edits). */
  scheduleUpdate(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.recompute();
    }, DEBOUNCE_MS);
  }

  /** Sorted buffer rows where each git hunk begins — a hunk is a maximal run of
   *  consecutive changed (unstaged or staged) lines. Drives vim `]h`/`[h`. */
  hunkStartRows(): number[] {
    const rows = [...new Set([...this.kindByLine.keys(), ...this.stagedLines])].sort((a, b) => a - b);
    const starts: number[] = [];
    let prev = -2;
    for (const row of rows) {
      if (row !== prev + 1) starts.push(row);
      prev = row;
    }
    return starts;
  }

  // --- Hunk-level git actions ------------------------------------------------

  /** The unstaged hunk under buffer `row` (stage / revert target), or null. */
  unstagedHunkAtRow(row: number): Hunk | null {
    this.recompute(); // operate on the live buffer, not a debounced snapshot
    return this.unstagedHunks.find((hunk) => hunkContainsBufferRow(hunk, row)) ?? null;
  }

  /** The staged hunk under buffer `row` (unstage target), or null. */
  stagedHunkAtRow(row: number): Hunk | null {
    this.recompute();
    return this.stagedHunks.find((hunk) => hunkContainsBufferRow(hunk, row)) ?? null;
  }

  /** Stage one unstaged hunk: synthesize its (index→buffer) patch and apply it to
   *  the index. On success the repo + gutter refresh so the bar turns blue. */
  stageHunk(hunk: Hunk, onDone?: (ok: boolean, error: string) => void): void {
    this.applyHunk(hunk, { cached: true }, onDone);
  }

  /** Unstage one staged hunk: apply its (HEAD→index) patch in reverse to the index. */
  unstageHunk(hunk: Hunk, onDone?: (ok: boolean, error: string) => void): void {
    this.applyHunk(hunk, { cached: true, reverse: true }, onDone);
  }

  private applyHunk(hunk: Hunk, opts: { cached?: boolean; reverse?: boolean }, onDone?: (ok: boolean, error: string) => void): void {
    if (!this.root || !this.relPath) return onDone?.(false, 'not in a git repository');
    const patch = formatHunkPatch(this.relPath, hunk);
    applyPatch(this.root, patch, opts, (ok, _stdout, stderr) => {
      if (ok) {
        this.git.refresh(); // let the Source Control panel pick up the new index state
        this.refresh(); // re-fetch the index blob so the bars reflect the staged hunk
      }
      onDone?.(ok, stderr);
    });
  }

  dispose(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    (this.view as any).getGutter(Gtk.TextWindowType.LEFT).remove(this.renderer);
    this.gitUnsub?.();
    this.subs.dispose();
  }

  // --- internals -------------------------------------------------------------

  private rootFor(path: string): string | null {
    if (this.cachedRootPath !== path) {
      this.cachedRootPath = path;
      this.cachedRoot = repoRoot(Path.dirname(path));
    }
    return this.cachedRoot;
  }

  // Re-diff the live buffer against the bases and rebuild the line→kind map and
  // the cached hunk lists.
  private recompute(): void {
    if (this.indexLines === null || this.headLines === null) return; // bases not fetched yet
    this.kindByLine.clear();
    this.stagedLines.clear();

    const bufferLines = splitLines(this.getText());

    // Unstaged: index → buffer. These bars sit directly on buffer rows.
    this.unstagedHunks = computeHunks(this.indexLines, bufferLines);
    for (const hunk of this.unstagedHunks) this.markUnstaged(hunk);

    // Staged: HEAD → index. Computed in index coordinates, then mapped onto buffer
    // rows through the index→buffer alignment so they land on the right line even
    // when there are also unstaged edits above them.
    this.stagedHunks = computeHunks(this.headLines, this.indexLines);
    const indexToBuffer = buildRowMap(this.indexLines, bufferLines);
    const mapRow = (indexRow: number) =>
      indexToBuffer[Math.min(indexRow, indexToBuffer.length - 1)] ?? bufferLines.length - 1;
    for (const hunk of this.stagedHunks) {
      if (hunk.newLines.length === 0) {
        this.stagedLines.add(Math.max(0, mapRow(hunk.newStart) - 1));
      } else {
        for (let i = 0; i < hunk.newLines.length; i++) this.stagedLines.add(mapRow(hunk.newStart + i));
      }
    }

    this.renderer.queueDraw();
  }

  private markUnstaged(hunk: Hunk): void {
    if (hunk.newLines.length === 0) {
      // Pure deletion: mark the surviving line above the gap (always exists).
      this.mark(Math.max(0, hunk.newStart - 1), 'removed');
    } else {
      const kind: ChangeKind = hunk.oldLines.length === 0 ? 'added' : 'modified';
      for (let i = 0; i < hunk.newLines.length; i++) this.mark(hunk.newStart + i, kind);
    }
  }

  private mark(row: number, kind: ChangeKind): void {
    // A deletion marker never overrides an added/modified bar on the same line.
    if (kind === 'removed' && this.kindByLine.has(row)) return;
    this.kindByLine.set(row, kind);
  }
}
