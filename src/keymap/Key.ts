/*
 * Key.ts — a single normalized keystroke.
 *
 * Ported from xedel's key.js. A `Key` captures the modifier flags plus a
 * canonical key `name` (e.g. "a", "A", "!", "escape"), built either from a GTK
 * key event (`fromArgs`) or from a keybinding description string like
 * "ctrl-shift-p" (`fromDescription`). The native keyboard layout (via
 * native-keymap) is used to resolve shifted symbols (e.g. "!" ⇄ shift-1).
 */
import { createRequire } from 'node:module';
import { Gdk } from '../gi.ts';
import { CORRECTIONS, LOWER_TO_UPPER, MODIFIERS } from './keySymbols.ts';

interface KeymapEntry {
  name: string;
  value: string;
  withShift: string;
  withAltGr?: string;
  withShiftAltGr?: string;
}

// native-keymap is a native CommonJS addon; load it via createRequire so this
// stays an ES module (same trick as gi.ts).
const nativeKeymap: Record<string, KeymapEntry> =
  createRequire(import.meta.url)('native-keymap').getKeyMap();

const keymap: KeymapEntry[] =
  Object.entries(nativeKeymap)
    .filter(([name]) => !name.startsWith('Numpad'))
    .map(([name, description]) => ({ ...description, name }));

const findKeymapShift = (string: string) =>
  keymap.find(k => k.withShift === string && k.value !== string);

const getKeyvalNameFromChar = (c: string): string =>
  Gdk.keyvalName(Gdk.unicodeToKeyval(c.charCodeAt(0))) ?? '';

const isDigit = (code: number) =>
  code >= 0x30 && code <= 0x39;

const isLetter = (code: number) =>
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a);

const isValidKeyvalName = (name: string) =>
  Gdk.keyvalName(Gdk.keyvalFromName(name)) === name;

const keyByDescription = new Map<string, Key | null>();

export class Key {
  ctrl = false;
  shift = false;
  alt = false;
  cmd = false;
  super = false;
  name: string | undefined = undefined;

  string: string | undefined = undefined;
  event: unknown = undefined;

  static fromArgs = (keyval: number, keycode: number, state: number): Key => {
    let shift = false;
    let name = Gdk.keyvalName(keyval) ?? '';
    const string = String.fromCharCode(Gdk.keyvalToUnicode(keyval));

    if (name in CORRECTIONS)
      name = CORRECTIONS[name];

    const keymapEntry =
      string.charCodeAt(0) >= 0x20 ?
        findKeymapShift(string) : undefined;

    if (keymapEntry) {
      name = keymapEntry.value;
      shift = true;
      // Normalize a single-symbol value (e.g. the backtick behind `~`) to its
      // keyval name (e.g. "grave"), matching how `fromDescription` names it.
      // Without this, shift+symbol keys whose base is itself a symbol would
      // never match a binding parsed from a description string. Letters/digits
      // (e.g. shift-4 ⇒ "4") are already symmetric, so leave them as-is.
      const code = name.charCodeAt(0);
      if (name.length === 1 && !isLetter(code) && !isDigit(code)) {
        name = getKeyvalNameFromChar(name);
      }
    }
    // eg "Escape", "BackSpace"
    else {
      name = name.toLowerCase();
    }

    const key  = new Key();
    key.ctrl   = Boolean(state & Gdk.ModifierType.CONTROL_MASK);
    key.shift  = shift || Boolean(state & Gdk.ModifierType.SHIFT_MASK);
    key.alt    = Boolean(state & Gdk.ModifierType.ALT_MASK);
    key.cmd    = false; // FIXME
    key.super  = Boolean(state & Gdk.ModifierType.SUPER_MASK);
    key.name   = name;
    key.string = string;
    key.event  = { keyval, keycode, state };

    return key;
  };

  static fromEvent = (event: any): Key => {
    let shift = false;
    let name = Gdk.keyvalName(event.keyval) ?? '';
    const string = String.fromCharCode(Gdk.keyvalToUnicode(event.keyval));

    if (name in CORRECTIONS)
      name = CORRECTIONS[name];

    const keymapEntry =
      string.charCodeAt(0) >= 0x20 ?
        findKeymapShift(string) : undefined;

    if (keymapEntry) {
      name = keymapEntry.value;
      shift = true;
    }
    // eg "Escape", "BackSpace"
    else {
      name = name.toLowerCase();
    }

    const key = new Key();
    key.cmd = false; // FIXME
    key.ctrl = event.ctrlKey;
    key.shift = shift || event.shiftKey;
    key.alt = event.altKey;
    key.super = event.superKey;
    key.name = name;
    key.string = event.string;
    key.event = event;

    Object.freeze(key);
    return key;
  };

  static fromDescription = (description: string): Key | null => {
    const cachedKey = keyByDescription.get(description);
    if (cachedKey !== undefined)
      return cachedKey;

    const key = new Key();

    const parts = description.split('-');

    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      if (part === '') {
        part = '-';
        i += 1;
      }

      if (part in CORRECTIONS)
        part = CORRECTIONS[part];

      const lcPart = part.toLowerCase();

      if (lcPart === 'ctrl') {
        key.ctrl = true;
      }
      else if (lcPart === 'shift') {
        key.shift = true;
      }
      else if (lcPart === 'alt') {
        key.alt = true;
      }
      else if (lcPart === 'cmd') {
        key.cmd = true;
      }
      else if (lcPart === 'super') {
        key.super = true;
      }
      else if (i === parts.length - 1) {
        let name = part;
        let string = part;

        const keymapEntry = findKeymapShift(string);
        if (keymapEntry) {
          name = keymapEntry.value;
          key.shift = true;
        }

        // key value, eg "a", "A", "!"
        if (name.length === 1) {
          const code = name.charCodeAt(0);

          if (!isLetter(code) && !isDigit(code)) {
            name = getKeyvalNameFromChar(name);
          }

        }
        // key name, eg "grave", "Escape", "escape"
        else {
          if (!isValidKeyvalName(name) && !LOWER_TO_UPPER[name.toLowerCase()]) {
            console.warn(`Couldn't parse key: "${description}"`);
            keyByDescription.set(description, null);
            return null;
          }

          string = String.fromCharCode(Gdk.keyvalToUnicode(Gdk.keyvalFromName(name)));
          name = name.toLowerCase();

          const keymapEntry =
            string.charCodeAt(0) >= 0x20 ?
              findKeymapShift(string) : undefined;

          if (keymapEntry) {
            name = getKeyvalNameFromChar(keymapEntry.value);
            key.shift = true;
          }
        }

        key.name = name;
      }
      else {
        console.warn(`Couldn't parse key: "${description}"`);
        keyByDescription.set(description, null);
        return null;
      }
    }

    Object.freeze(key);
    keyByDescription.set(description, key);
    return key;
  };

  equals(other: Key): boolean {
    if (this === other) return true;
    if (this.ctrl !== other.ctrl) return false;
    if (this.shift !== other.shift) return false;
    if (this.alt !== other.alt) return false;
    if (this.super !== other.super) return false;
    if (this.name !== other.name) return false;
    return true;
  }

  isLetter(): boolean {
    return /^[a-zA-Z]$/.test(this.name ?? '');
  }

  isDigit(): boolean {
    return /^[0-9]$/.test(this.name ?? '');
  }

  isModifier(): boolean {
    return MODIFIERS.has(this.name ?? '');
  }

  toString(): string {
    return [
      this.super ? 'super' : undefined,
      this.ctrl ? 'ctrl' : undefined,
      this.alt ? 'alt' : undefined,
      this.shift ? 'shift' : undefined,
      this.name,
    ]
    .filter(Boolean)
    .join('-');
  }
}
