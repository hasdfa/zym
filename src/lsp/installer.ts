/*
 * Server installer — obtains a missing LSP server's binary into a zym-managed
 * directory, so we never touch the user's global env or their project.
 *
 * Layout: each server installs under `$XDG_DATA_HOME/zym/lsp/<server>/`. For an
 * npm source that means `npm install <pkg>` there, landing the binary in
 * `<server>/node_modules/.bin/` — which `which.ts`/`LspManager` add to the server
 * search path and `LspClient` prepends to the spawned PATH. A raw `{ command }`
 * source just runs in that dir (escape hatch for non-npm servers).
 */
import { spawn } from 'node:child_process';
import * as Os from 'node:os';
import * as Path from 'node:path';
import * as Fs from 'node:fs';
import type { ServerDef, InstallSpec } from '../lang/types.ts';

/** Root of the managed install tree (`$XDG_DATA_HOME/zym/lsp`). */
export function managedRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME || Path.join(Os.homedir(), '.local', 'share');
  return Path.join(dataHome, 'zym', 'lsp');
}

/** The managed install dir for one server. */
export function managedServerDir(serverName: string): string {
  return Path.join(managedRoot(), serverName);
}

/** Where a managed server's executables land (npm `node_modules/.bin`). */
export function managedBinDir(serverName: string): string {
  return Path.join(managedServerDir(serverName), 'node_modules', '.bin');
}

export interface InstallResult {
  ok: boolean;
  /** A short human-readable outcome (success note or failure reason). */
  message: string;
}

/** The program + args that perform an install spec, run in the managed dir. */
export function installInvocation(spec: InstallSpec): { command: string; args: string[] } {
  if ('via' in spec) {
    // npm: install into the cwd (the managed dir) — bins land in node_modules/.bin.
    // `package` may be several whitespace-separated specs (e.g. a server + its
    // required `typescript`); `version` applies when it's a single package.
    const pkgs = spec.version ? [`${spec.package}@${spec.version}`] : spec.package.split(/\s+/).filter(Boolean);
    return { command: 'npm', args: ['install', '--no-save', '--no-fund', '--no-audit', ...pkgs] };
  }
  const [command, ...args] = spec.command;
  return { command, args };
}

/**
 * Install `server` into its managed dir. `onLog` receives stdout/stderr chunks
 * for progress. Resolves with the outcome — never rejects.
 */
export async function installServer(server: ServerDef, onLog?: (chunk: string) => void): Promise<InstallResult> {
  const spec = server.install;
  if (!spec) return { ok: false, message: `${server.name} has no install method` };

  const dir = managedServerDir(server.name);
  try {
    Fs.mkdirSync(dir, { recursive: true });
    // A minimal package.json keeps npm from walking up to a parent project.
    const pkgJson = Path.join(dir, 'package.json');
    if (!Fs.existsSync(pkgJson)) Fs.writeFileSync(pkgJson, '{ "private": true }\n');
  } catch (err) {
    return { ok: false, message: `could not prepare ${dir}: ${(err as Error).message}` };
  }

  const { command, args } = installInvocation(spec);
  return run(command, args, dir, onLog);
}

function run(command: string, args: string[], cwd: string, onLog?: (chunk: string) => void): Promise<InstallResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, message: (err as Error).message });
      return;
    }
    // ENOENT etc. (e.g. npm not on PATH) arrives as an 'error' event, not a throw.
    proc.on('error', (err) => resolve({ ok: false, message: `${command}: ${(err as Error).message}` }));
    proc.stdout?.on('data', (d) => onLog?.(d.toString()));
    proc.stderr?.on('data', (d) => onLog?.(d.toString()));
    proc.on('exit', (code) =>
      resolve(code === 0 ? { ok: true, message: 'installed' } : { ok: false, message: `${command} exited with code ${code}` }),
    );
  });
}
