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
import { NotificationManager } from './NotificationManager.ts';
import { AgentManager } from './AgentManager.ts';
import { Config, type ConfigSchema } from './util/Config.ts';

/*
 * The application-wide config schema (Atom's `core.*` / `editor.*`). This is the
 * general, non-vim baseline; subsystems contribute their own namespaced
 * parameters at load time via `quilx.config.scope(namespace).register(...)` —
 * see `ui/TextEditor/vim/settings.ts`, which registers under `vim-mode-plus`.
 */
const CONFIG_SCHEMA: Record<string, ConfigSchema> = {
  'core.followSystemColorScheme': {
    type: 'boolean',
    default: true,
    description: 'Follow the system light/dark preference for the active theme.',
  },
  'editor.tabLength': {
    type: 'integer',
    default: 2,
    minimum: 1,
    maximum: 16,
    description: 'Number of spaces a tab is rendered as.',
  },
  'editor.fontFamily': {
    type: 'string',
    default: '',
    description: 'Editor font family; empty uses the platform monospace default.',
  },
  'editor.fontSize': {
    type: 'integer',
    default: 13,
    minimum: 6,
    maximum: 100,
    description: 'Editor font size in points.',
  },
  'agent.command': {
    type: 'array',
    default: ['claude'],
    description: 'Argv of the terminal agent launched by AgentTerminal (agent:new).',
  },
};

class Quilx {
  window: ApplicationWindow | null = null;
  readonly commands = new CommandManager();
  readonly keymaps = new KeymapManager();
  readonly notifications = new NotificationManager();
  readonly agents = new AgentManager();
  readonly config = new Config(CONFIG_SCHEMA);
}

export const quilx = new Quilx();

declare global {
  // eslint-disable-next-line no-var
  var quilx: Quilx;
}

(globalThis as { quilx?: Quilx }).quilx = quilx;
