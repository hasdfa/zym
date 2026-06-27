/*
 * File picker — the first user of the fuzzy picker. Lists the files under the
 * current working directory and opens the fuzzy picker over their paths
 * (relative for display), invoking `onSelect` with the absolute path of the
 * chosen file.
 *
 * Two enumeration strategies:
 *   - In a git repo, `listProjectFiles` lists tracked + untracked-non-ignored
 *     files in one `git ls-files` call — near-instant and honouring `.gitignore`
 *     (so build output / vendored trees don't pollute results).
 *   - Otherwise, a manual walk falls back. It runs incrementally from a GLib idle
 *     source rather than `await fs.promises` (Node's promise microtasks don't run
 *     while the GLib main loop is blocked, node-gtk#430), scanning a bounded
 *     number of directories per tick and streaming coalesced batches into the
 *     picker as they're found.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openPicker, highlightSegment, type PickerItem } from './Picker.ts';
import { renderRowStacked } from './PickerRow.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { Icons } from './icons.ts';
import { listProjectFiles } from '../git.ts';
import Gtk from 'gi:Gtk-4.0';

type Overlay = InstanceType<typeof Gtk.Overlay>;

// Directories that are rarely what you want to open and expensive to walk. Only
// consulted on the non-git walk fallback; in a repo `.gitignore` handles this.
const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', '.cache',
]);
const MAX_FILES = 20_000;
const DIRS_PER_TICK = 24; // directories scanned per idle iteration
const FLUSH_INTERVAL_MS = 80; // coalesce streamed walk batches to ~once per this

export function openFilePicker(host: Overlay, cwd: string, onSelect: (path: string) => void): void {
  // Open immediately in the loading state; fill it once enumeration resolves
  // (one-shot in a git repo, or streamed by the walk), so a large tree never
  // blocks the UI.
  const picker = openPicker({
    host,
    placeholder: 'Search files…',
    promptIcon: Icons.search,
    loading: true,
    // Rows carry their own (file-type) icon column, aligned under the prompt icon —
    // so skip the prompt-driven row indent.
    disableIconPadding: true,
    // Surface recently/frequently opened files first, and nudge them up the
    // ranking once a query is typed.
    frecency: 'file',
    // Two-line rows: a file-type icon, the filename on top, its directory muted
    // below. Both lines index into the relative path (`item.text`) so the match
    // highlight spans them.
    renderRow: (item, positions) => {
      const rel = item.text;
      const base = Path.basename(rel);
      const dirEnd = rel.length - base.length; // where the filename starts
      // Directory (trailing slash dropped); a root-level file has no directory, so
      // show `.` rather than a blank second line.
      const dir = highlightSegment(rel, 0, Math.max(0, dirEnd - 1), positions);
      return renderRowStacked({
        icon: fileIconGlyph(base, false),
        iconMuted: true, // a quiet visual cue; the filename carries the row
        main: highlightSegment(rel, dirEnd, rel.length, positions),
        detail: dir || '.',
      });
    },
    onSelect,
  });

  // Fast path: in a git repo, one `git ls-files` call lists everything
  // (.gitignore-respecting). A `null` result means "not a repo / git failed" —
  // fall back to the streaming walk. An empty array is a valid (empty) result,
  // not a fallback trigger. The handle methods are safe if the picker has closed.
  void listProjectFiles(cwd).then((paths) => {
    if (paths !== null) {
      picker.setItems(paths.slice(0, MAX_FILES).map((rel) => fileItem(cwd, rel)));
      return;
    }
    collectFiles(
      cwd,
      (rels) => picker.appendItems(rels.map((rel) => fileItem(cwd, rel))),
      () => picker.setLoading(false), // walk done — stop spinning even if nothing was found
    );
  });
}

/**
 * Build a picker item for a file at `rel` (relative to `cwd`). Matching runs
 * against the whole relative path, but the filename portion is boosted so it
 * outranks directory-only matches; the row's two-line split (filename over
 * directory) is done in the picker's `renderRow`.
 */
function fileItem(cwd: string, rel: string): PickerItem {
  const base = Path.basename(rel);
  const dirEnd = rel.length - base.length; // index where the filename starts
  return {
    value: Path.join(cwd, rel),
    text: rel,
    boostFrom: dirEnd,
  };
}

/**
 * Walk `root` for files. Calls `onAppend` with each batch of newly-discovered
 * paths (relative to `root`) — coalesced to ~once per `FLUSH_INTERVAL_MS` so a
 * large tree doesn't re-rank the picker on every tick — and `onDone` once the
 * walk finishes (which also fires when nothing was found, so the caller can stop
 * its loading state). Non-blocking: a fixed number of directories are scanned
 * per GLib idle tick.
 */
function collectFiles(root: string, onAppend: (rels: string[]) => void, onDone: () => void): void {
  const stack: string[] = [root];
  let pending: string[] = []; // discovered but not yet flushed to onAppend
  let total = 0; // total files found so far (drives the MAX_FILES cap)
  let lastFlush = 0; // timestamp of the last flush; 0 → flush the first batch ASAP

  const flush = () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    onAppend(batch);
  };

  const tick = () => {
    let scanned = 0;
    while (stack.length > 0 && scanned < DIRS_PER_TICK && total < MAX_FILES) {
      const dir = stack.pop();
      if (dir === undefined) break;
      scanned++;

      let entries: Fs.Dirent[];
      try {
        entries = Fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip it
      }
      for (const entry of entries) {
        if (total >= MAX_FILES) break;
        const full = Path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
        } else if (entry.isFile()) {
          pending.push(Path.relative(root, full));
          total++;
        }
      }
    }

    const done = stack.length === 0 || total >= MAX_FILES;
    const now = Date.now();
    if (done) {
      flush();
      onDone();
    } else if (now - lastFlush >= FLUSH_INTERVAL_MS) {
      lastFlush = now;
      flush();
      setTimeout(tick, 0);
    } else {
      setTimeout(tick, 0);
    }
  };
  setTimeout(tick, 0);
}
