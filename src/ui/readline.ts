/*
 * readline — reusable Emacs/readline-style editing keybindings for text entries.
 *
 * Any `Gtk.Editable` (a SearchEntry / Entry / Text) can opt in via
 * `enableReadline(entry)`: it tags the widget with the `.readline-input` class,
 * registers the shared `readline:*` command/keymap (once), and binds the commands
 * to that entry instance. Because everything goes through the app's normal
 * command/keymap system, bindings are introspectable (the keymap reference panel,
 * conflict detection) and overridable by the user keymap — and the same set drops
 * into any future entry that wants line-editing chords.
 *
 * The cursor/word operations run on the GtkEditable surface directly (character
 * offsets), so they work regardless of the underlying entry widget.
 */
import { Gtk } from '../gi.ts';
import { zym } from '../zym.ts';
import type { CommandMap } from '../CommandManager.ts';
import type { Disposable } from '../util/eventKit.ts';

/** CSS class marking an entry as readline-enabled; the shared keymap targets it. */
export const READLINE_INPUT_CLASS = 'readline-input';

// The slice of GtkEditable we drive (SearchEntry/Entry/Text all implement it),
// narrowed to the handful of methods used here. Positions are character offsets;
// `-1` means "end of text" for both setPosition and deleteText.
interface Editable {
  getText(): string;
  getPosition(): number;
  setPosition(position: number): void;
  deleteText(startPos: number, endPos: number): void;
}

// A word is a run of letters/digits/underscore (Unicode-aware), matching what's
// useful for paths and identifiers; everything else is a separator.
const isWordChar = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

/** First index after the word ahead of `pos` (skip separators, then the word). */
function forwardWord(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && !isWordChar(text[i])) i++;
  while (i < text.length && isWordChar(text[i])) i++;
  return i;
}

/** Start index of the word behind `pos` (skip separators, then the word). */
function backwardWord(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && !isWordChar(text[i - 1])) i--;
  while (i > 0 && isWordChar(text[i - 1])) i--;
  return i;
}

/** The readline editing commands, each bound to operate on `entry`. */
function readlineCommands(entry: Editable): CommandMap {
  const clamp = (p: number) => Math.max(0, Math.min(p, entry.getText().length));
  return {
    'readline:beginning-of-line': () => entry.setPosition(0),
    'readline:end-of-line': () => entry.setPosition(-1),
    'readline:forward-char': () => entry.setPosition(clamp(entry.getPosition() + 1)),
    'readline:backward-char': () => entry.setPosition(clamp(entry.getPosition() - 1)),
    'readline:forward-word': () => entry.setPosition(forwardWord(entry.getText(), entry.getPosition())),
    'readline:backward-word': () => entry.setPosition(backwardWord(entry.getText(), entry.getPosition())),
    'readline:delete-char': () => {
      const p = entry.getPosition();
      entry.deleteText(p, p + 1);
    },
    'readline:kill-line': () => entry.deleteText(entry.getPosition(), -1),
    'readline:backward-kill-line': () => entry.deleteText(0, entry.getPosition()),
    'readline:kill-word': () => {
      const p = entry.getPosition();
      entry.deleteText(p, forwardWord(entry.getText(), p));
    },
    'readline:backward-kill-word': () => {
      const p = entry.getPosition();
      entry.deleteText(backwardWord(entry.getText(), p), p);
    },
  };
}

// The keystroke → command table, registered once and scoped to any focused
// `.readline-input` entry. `alt-backspace` is kept as an alias for backward-kill.
// `ctrl-w` (backward-kill-word) shares a prefix with the window's `ctrl-w …` pane
// chord, but it's bound on the focused entry (nearer in the focus chain than the
// window), so the KeymapManager dispatches it immediately rather than waiting on
// that farther chord — see `preemptsChord`.
let keymapRegistered = false;
function registerReadlineKeymapOnce(): void {
  if (keymapRegistered) return;
  keymapRegistered = true;
  zym.keymaps.add('readline', {
    [`.${READLINE_INPUT_CLASS}`]: {
      'ctrl-a': 'readline:beginning-of-line',
      'ctrl-e': 'readline:end-of-line',
      'ctrl-f': 'readline:forward-char',
      'ctrl-b': 'readline:backward-char',
      'alt-f': 'readline:forward-word',
      'alt-b': 'readline:backward-word',
      'ctrl-d': 'readline:delete-char',
      'ctrl-k': 'readline:kill-line',
      'ctrl-u': 'readline:backward-kill-line',
      'alt-d': 'readline:kill-word',
      'ctrl-w': 'readline:backward-kill-word',
      'alt-backspace': 'readline:backward-kill-word',
    },
  });
}

/**
 * Enable readline-style editing chords on `entry` (any GtkEditable). Returns a
 * Disposable that removes the per-entry commands; the shared keymap persists (it
 * only fires for focused `.readline-input` entries, so it's harmless to leave).
 */
export function enableReadline(entry: InstanceType<typeof Gtk.Widget>): Disposable {
  entry.addCssClass(READLINE_INPUT_CLASS);
  registerReadlineKeymapOnce();
  return zym.commands.add(entry, readlineCommands(entry as unknown as Editable));
}
