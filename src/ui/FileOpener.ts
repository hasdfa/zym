/*
 * File opener — a path-navigating "open file" picker.
 *
 * Unlike `FilePicker` (a recursive fuzzy walk over relative paths), this opener
 * keeps a *full path* in its prompt and lists exactly the entries of whatever
 * directory that path currently denotes: the prompt's directory part (everything
 * up to the last `/`) chooses the directory, and the trailing part fuzzy-filters
 * its entries. Editing the path re-lists; choosing a folder descends into it
 * (the prompt is rewritten to that folder, in place — see Picker `onSelect`),
 * and choosing a file opens it.
 *
 * Listing a single directory is a cheap synchronous `readdirSync`, so it runs
 * through the Picker's `fetch` source (re-queried, debounced, as the directory
 * part changes) and resolves immediately — no background walk needed.
 *
 * The prompt works in *tilde-reduced* path space: `$HOME` and anything under it
 * shows as `~`, and the prompt, the listed entries, and the fuzzy filter all use
 * that form (so the typed `~/…` still matches the rows). `~` is expanded back to
 * `$HOME` only at the filesystem boundary (`readdir`, open, create). Deleting the
 * `~` therefore navigates up out of home into its parent (`/home`, or the
 * OS-equivalent) rather than collapsing to nothing — see `directoryOf`.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { openPicker, highlightSegment, escapeMarkup, type PickerItem } from './Picker.ts';
import { renderRowSingleLine } from './PickerRow.ts';
import { fileIconGlyph } from './fileIcons.ts';
import { tildify, expandTilde } from '../util/tilde.ts';
import Gtk from 'gi:Gtk-4.0';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** A directory entry, carrying its kind so the row and selection can branch on it. */
interface FileItem extends PickerItem {
  isDir: boolean;
}

/**
 * Open the path-navigating file opener rooted at `dir` (an absolute path, e.g.
 * the workbench cwd). `onChoose` is called with the absolute path of the chosen
 * file; folders descend in place instead.
 */
export function openFileOpener(host: Overlay, dir: string, onChoose: (path: string) => void): void {
  openPicker({
    host,
    placeholder: 'Open file…',
    promptIcon: fileIconGlyph('', true), // the folder glyph, matching the directory rows
    disableIconPadding: true, // rows render their own icons via renderRow; skip the prompt-indent
    // The prompt holds a full path (with `$HOME` shown as `~`); seed it with the
    // starting directory (trailing slash → list its contents, with an empty filter).
    query: withTrailingSlash(tildify(dir)),
    // Re-list whenever the directory part of the path changes; the Picker's local
    // fuzzy filter narrows + highlights the entries against the typed path in
    // between (debounced re-list, instant filter).
    fetch: (query, onResult) => onResult(listDir(directoryOf(query))),
    // Show just the entry's name with a file/folder glyph and (folders) a trailing
    // slash; the shared directory prefix is already in the prompt, so a muted detail
    // column would only repeat it on every row. The glyph needs a blank cell for
    // files so names align, so it stays inline in the markup rather than using the
    // renderer's icon slot.
    renderRow: (item, positions) => {
      const f = item as FileItem;
      const base = Path.basename(item.text);
      const start = item.text.length - base.length;
      const name = highlightSegment(item.text, start, item.text.length, positions);
      // Only folders carry a glyph (a leading folder icon); files get a blank cell
      // in its place so their names still line up under the folders'.
      const icon = f.isDir ? escapeMarkup(fileIconGlyph(base, true)) : ' ';
      const row = `${icon}  ${name}${f.isDir ? '/' : ''}`;
      return renderRowSingleLine({ main: row });
    },
    frecency: 'file',
    onSelect: (value, item) => {
      // Descend into a folder by rewriting the prompt to it (Picker re-lists and
      // stays open, keeping the `~` form); open a file by closing and handing back
      // its real absolute path (expanding any `~`).
      if ((item as FileItem).isDir) return withTrailingSlash(value);
      onChoose(expandTilde(value));
    },
    action: {
      label: (query) => `Create: ${Path.basename(query)}`,
      // Only surface when the query names a file (non-empty basename, no trailing slash).
      visible: (query) => !query.endsWith('/') && Path.basename(query).length > 0,
      run: (query) => {
        const target = expandTilde(query);
        Fs.mkdirSync(Path.dirname(target), { recursive: true });
        if (!Fs.existsSync(target)) Fs.writeFileSync(target, '');
        onChoose(target);
      },
    },
  });
}

/**
 * The directory part of a typed path: everything up to (and not past) the last
 * `/`. Computed on the expanded (`~`→`$HOME`) path and re-tildified, so `~`
 * behaves exactly like the home path it stands for — in particular, the bare
 * `~` (its trailing slash deleted) yields home's parent (`/home`, or the
 * OS-equivalent), so deleting the `~` navigates up out of home.
 */
function directoryOf(input: string): string {
  const expanded = expandTilde(input);
  const slash = expanded.lastIndexOf('/');
  if (slash < 0) return '.';
  return tildify(expanded.slice(0, slash) || '/'); // keep root as "/", not ""
}

/** `path` with exactly one trailing slash (so it reads as "this directory"). */
function withTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * List `dir`'s entries as picker items (folders first, then files, each sorted
 * by name). `dir` may be `~`-rooted; it's expanded for the `readdir`, but each
 * item's path is re-tildified so its `text` stays in the same `~` form as the
 * typed prompt (and so home itself, listed from `/home`, reads as `~`). `text`
 * is that path so it fuzzy-matches the typed prompt, with `boostFrom` at the
 * filename so name matches outrank directory ones. An unreadable directory
 * yields no entries (the picker shows "No matches").
 */
function listDir(dir: string): FileItem[] {
  const abs = expandTilde(dir);
  let entries: Fs.Dirent[];
  try {
    entries = Fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: FileItem[] = [];
  const files: FileItem[] = [];
  for (const entry of entries) {
    const value = tildify(Path.join(abs, entry.name));
    const isDir = entry.isDirectory();
    // basename(value), not entry.name: tildify collapses home itself to `~`, whose
    // basename is `~` rather than the directory's real name.
    const item: FileItem = { value, text: value, boostFrom: value.length - Path.basename(value).length, isDir };
    (isDir ? dirs : files).push(item);
  }
  const byName = (a: FileItem, b: FileItem) => a.text.localeCompare(b.text);
  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}
