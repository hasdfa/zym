/*
 * quilx — the global application registry (analog to Atom's `atom` /
 * xedel's `xedel`).
 *
 * It holds the singletons the command/keymap subsystem reaches for: the command
 * manager, the keymap manager, and the active application window. The managers
 * and their helpers (`getActiveElements`, `KeymapManager`) import this singleton
 * directly; it is also attached to `globalThis.quilx` so it can be inspected
 * from the console and to mirror the Atom-style global.
 *
 * The window is wired in once by `AppWindow` (`quilx.window = …`) after it is
 * constructed, before `quilx.keymaps.initialize()`.
 */
import type { ApplicationWindow } from './gi.ts';
import { CommandManager } from './CommandManager.ts';
import { KeymapManager } from './KeymapManager.ts';

class Quilx {
  window: ApplicationWindow | null = null;
  readonly commands = new CommandManager();
  readonly keymaps = new KeymapManager();
}

export const quilx = new Quilx();

declare global {
  // eslint-disable-next-line no-var
  var quilx: Quilx;
}

(globalThis as { quilx?: Quilx }).quilx = quilx;
