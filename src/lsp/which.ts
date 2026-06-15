/*
 * Locating server executables. An LSP server command may live on PATH (a global
 * install) or in a project's `node_modules/.bin` (the common case — a repo ships
 * its own typescript-language-server / eslint). We search `node_modules/.bin`
 * from the server's root dir upward, then PATH.
 *
 * This lets project-local servers resolve when opening another repo, and lets a
 * server that isn't installed anywhere be skipped *before* spawning — a failed
 * spawn (ENOENT) otherwise looks like a crash and trips the restart loop, spamming
 * the notification log for a server the user simply doesn't have.
 */
import * as Fs from 'node:fs';
import * as Path from 'node:path';

/** `node_modules/.bin` for `rootDir` and every ancestor (nearest first). */
export function nodeModulesBinDirs(rootDir: string): string[] {
  const dirs: string[] = [];
  let dir = Path.resolve(rootDir);
  while (true) {
    dirs.push(Path.join(dir, 'node_modules', '.bin'));
    const parent = Path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Resolve a command to an executable path, searching `extraDirs` (e.g. project
 * `node_modules/.bin`) before PATH. A command containing a path separator is
 * treated as a literal path. Returns null when nothing executable is found.
 */
export function resolveCommand(command: string, extraDirs: string[] = []): string | null {
  if (command.includes('/')) return isExecutable(command) ? command : null;
  const pathDirs = (process.env.PATH ?? '').split(Path.delimiter).filter(Boolean);
  for (const dir of [...extraDirs, ...pathDirs]) {
    const full = Path.join(dir, command);
    if (isExecutable(full)) return full;
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    Fs.accessSync(file, Fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
