/*
 * load.ts — register the keymaps at startup.
 *
 * Layers two sources by priority: the built-in `DEFAULT_KEYMAP` (priority 0) and
 * an optional user keymap (priority 100) read from `$XDG_CONFIG_HOME/quilx/
 * keymap.json` (falling back to `~/.config`). The user file uses the same
 * `{ selector: { keystroke: command } }` shape and, being higher priority, wins
 * when it binds the same keystroke as a default.
 *
 * Both sources are validated first: unparseable selectors/keystrokes and empty
 * commands are reported as warnings (never thrown), so a single typo disables one
 * binding rather than the whole app.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { quilx } from '../quilx.ts';
import { parseSelector } from '../util/selectors.ts';
import { Key } from '../keymap/Key.ts';
import { DEFAULT_KEYMAP } from './default.ts';

type Binding = string | { command?: string; args?: unknown[] };
type Keymap = Record<string, Record<string, Binding>>;

const DEFAULT_PRIORITY = 0;
const USER_PRIORITY = 100;

function userKeymapPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  return Path.join(configHome, 'quilx', 'keymap.json');
}

// Warn (don't throw) on malformed entries: bad selectors, keystrokes that don't
// parse, or empty command names.
function validateKeymap(source: string, keymap: Keymap): void {
  for (const selector of Object.keys(keymap)) {
    const rules = parseSelector(selector); // also warns on unparseable / too-broad selectors
    if (rules.length === 0)
      console.warn(`[keymap:${source}] selector "${selector}" parsed to no rules`);

    const bindings = keymap[selector];
    for (const sequence of Object.keys(bindings)) {
      const value = bindings[sequence];
      const command = typeof value === 'string' ? value : value?.command;
      if (!command)
        console.warn(`[keymap:${source}] empty command for "${sequence}" (${selector})`);
      if (value && typeof value === 'object' && value.args !== undefined && !Array.isArray(value.args))
        console.warn(`[keymap:${source}] "args" for "${sequence}" (${selector}) must be an array`);
      for (const stroke of sequence.trim().split(/\s+/)) {
        if (Key.fromDescription(stroke) === null)
          console.warn(`[keymap:${source}] unparseable key "${stroke}" in "${sequence}" (${selector})`);
      }
    }
  }
}

function readUserKeymap(): Keymap | null {
  const path = userKeymapPath();
  let text: string;
  try {
    text = Fs.readFileSync(path, 'utf8');
  } catch {
    return null; // no user keymap — that's fine
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') {
      console.warn(`[keymap:user] ${path} is not a JSON object`);
      return null;
    }
    return parsed as Keymap;
  } catch (error) {
    console.warn(`[keymap:user] failed to parse ${path}: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Register the built-in keymap and, if present, the user's keymap on top (higher
 * priority). Validates each source before registering it.
 */
export function loadKeymaps(): void {
  validateKeymap('default', DEFAULT_KEYMAP);
  quilx.keymaps.add('default-keymap', DEFAULT_KEYMAP, DEFAULT_PRIORITY);

  const userKeymap = readUserKeymap();
  if (userKeymap) {
    validateKeymap('user', userKeymap);
    // Untrusted JSON (its `command` may be missing); validation above has already
    // warned, and a binding with no command resolves to nothing at dispatch.
    quilx.keymaps.add(
      'user-keymap',
      userKeymap as Record<string, Record<string, string | { command: string; args?: unknown[] }>>,
      USER_PRIORITY,
    );
  }
}
