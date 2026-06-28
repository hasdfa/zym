/*
 * tilde — collapse/expand a leading `$HOME` ↔ `~` in a path string.
 *
 * `tildify` is for display (shorten an absolute path under the home directory);
 * `expandTilde` is its inverse, turning a `~`-prefixed path back into a real
 * filesystem path. Only a *leading* `$HOME`/`~` is touched, and only when it's
 * the home directory itself or a path beneath it — a sibling like
 * `/home/ana-old` (a prefix of the string but not of the directory) is left
 * alone. Paths outside home pass through unchanged.
 */
import * as Os from 'node:os';
import * as Path from 'node:path';

/** `/home/ana/src` → `~/src`, `/home/ana` → `~`; anything outside home unchanged. */
export function tildify(path: string): string {
  const home = Os.homedir();
  if (path === home) return '~';
  if (path.startsWith(home + Path.sep)) return '~' + path.slice(home.length);
  return path;
}

/** `~` → `/home/ana`, `~/src` → `/home/ana/src`; anything not `~`-rooted unchanged. */
export function expandTilde(path: string): string {
  const home = Os.homedir();
  if (path === '~') return home;
  if (path.startsWith('~' + Path.sep)) return home + path.slice(1);
  return path;
}
