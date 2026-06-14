/*
 * Vim wiring — connects the vendored vim core to quilx's command/keymap system.
 *
 * `attachVim` builds one VimState per editor and registers its commands against
 * that editor's view *instance* (so a keystroke dispatches to the right editor's
 * VimState). The keymaps are registered once, globally, scoped by mode CSS class
 * (`GtkSourceView.normal-mode` / `.insert-mode`); the KeymapManager matches a
 * focused view against them and dispatches the bound command, which the per-view
 * command bundle resolves to `vimState.operationStack.run(<OperationClass>)`.
 *
 * The bindings are data-driven: each table maps a keystroke to an operation
 * class name, and both the command name (`vim-mode-plus:<dasherized>`) and the
 * keymap entry are derived from it.
 */
import { quilx } from '../../../quilx.ts';
import type { EditorModel } from '../EditorModel.ts';
import VimState from './vim-state.js';
import { StatusBarManager } from './stubs.ts';
import './operations/mode.js'; // ActivateNormalMode
import './motion.js'; // self-registers the motion operations
import './operator.js'; // Delete/Yank and operator base
import './operator-insert.js'; // ActivateInsertMode/InsertAfter/Change/…
import './text-object.js'; // iw/aw/i(/a"/… (operator + visual targets)
import './misc-command.js'; // Undo/Redo/Mark/…

const dasherize = (name: string): string =>
  (name[0].toLowerCase() + name.slice(1)).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());

const commandName = (klass: string): string => `vim-mode-plus:${dasherize(klass)}`;

// Mode-entry operations, available only in normal mode.
const MODE_BINDINGS: Record<string, string> = {
  i: 'ActivateInsertMode',
  a: 'InsertAfter',
};

// Visual-mode activation, available in normal and visual modes (so V switches a
// characterwise selection to linewise, and v toggles back to normal).
const VISUAL_BINDINGS: Record<string, string> = {
  v: 'ActivateCharacterwiseVisualMode',
  V: 'ActivateLinewiseVisualMode',
};

// Single-key motions, available while NOT in insert mode.
const MOTION_BINDINGS: Record<string, string> = {
  h: 'MoveLeft',
  l: 'MoveRight',
  j: 'MoveDown',
  k: 'MoveUp',
  w: 'MoveToNextWord',
  W: 'MoveToNextWholeWord',
  b: 'MoveToPreviousWord',
  B: 'MoveToPreviousWholeWord',
  e: 'MoveToEndOfWord',
  E: 'MoveToEndOfWholeWord',
  '0': 'MoveToBeginningOfLine',
  '^': 'MoveToFirstCharacterOfLine',
  $: 'MoveToLastCharacterOfLine',
  G: 'MoveToLastLine',
  // `space` is intentionally left UNMAPPED. Upstream vim-mode-plus binds it to
  // MoveRight, but quilx reserves `space` as the leader key, so the editor must
  // never consume it. Do not add a `space`/`' '` binding here (or anywhere in
  // this file's tables).
};

// Multi-key motions (keystroke sequences), available while NOT in insert mode.
const SEQUENCE_BINDINGS: Record<string, string> = {
  'g g': 'MoveToFirstLine',
};

// Operators (await a motion/text-object target), available while NOT in insert mode.
// d/y/c await a target in normal mode but operate on the selection in visual mode.
// x/p have preset targets / no target, so they execute immediately.
const OPERATOR_BINDINGS: Record<string, string> = {
  d: 'Delete',
  y: 'Yank',
  c: 'Change',
  x: 'DeleteRight',
  p: 'PutAfter',
  P: 'PutBefore',
};

// Text objects, used as operator targets / visual selections. Bound only in
// operator-pending and visual modes (in normal mode `i`/`a` enter insert).
const TEXT_OBJECT_BINDINGS: Record<string, string> = {
  'i w': 'InnerWord',
  'a w': 'AWord',
  'i (': 'InnerParenthesis',
  'a (': 'AParenthesis',
  'i )': 'InnerParenthesis',
  'a )': 'AParenthesis',
  'i [': 'InnerSquareBracket',
  'a [': 'ASquareBracket',
  'i {': 'InnerCurlyBracket',
  'a {': 'ACurlyBracket',
  'i "': 'InnerDoubleQuote',
  'a "': 'ADoubleQuote',
  "i '": 'InnerSingleQuote',
  "a '": 'ASingleQuote',
};

// Misc commands (undo/redo), available while NOT in insert mode.
const MISC_BINDINGS: Record<string, string> = {
  u: 'Undo',
  'ctrl-r': 'Redo',
};

// Motions + operators are bound in every non-insert mode (notably operator-pending,
// so the motion that follows `d` resolves). Mode-entry keys (i/a) are normal-only.
const NON_INSERT_BINDINGS: Record<string, string> = {
  ...MOTION_BINDINGS,
  ...SEQUENCE_BINDINGS,
  ...OPERATOR_BINDINGS,
  ...MISC_BINDINGS,
};

// All operation classes a command is registered for, by class name.
const NORMAL_OPERATIONS: Record<string, string> = {
  ...MODE_BINDINGS,
  ...VISUAL_BINDINGS,
  ...NON_INSERT_BINDINGS,
  ...TEXT_OBJECT_BINDINGS,
};

let keymapsRegistered = false;

function toKeymap(bindings: Record<string, string>): Record<string, string> {
  const keymap: Record<string, string> = {};
  for (const [key, klass] of Object.entries(bindings)) keymap[key] = commandName(klass);
  return keymap;
}

function registerKeymapsOnce(): void {
  if (keymapsRegistered) return;
  keymapsRegistered = true;

  quilx.keymaps.add('vim-mode-plus', {
    // Mode-entry keys (i/a) are normal-only; v/V activate visual from normal too.
    'GtkSourceView.normal-mode': { ...toKeymap(MODE_BINDINGS), ...toKeymap(VISUAL_BINDINGS) },
    // Motions and operators apply in normal, operator-pending, and visual modes.
    'GtkSourceView:not(.insert-mode)': toKeymap(NON_INSERT_BINDINGS),
    // In visual mode: v/V switch wise (or toggle off) and text objects select.
    'GtkSourceView.visual-mode': { ...toKeymap(VISUAL_BINDINGS), ...toKeymap(TEXT_OBJECT_BINDINGS) },
    // Text objects are also operator targets in operator-pending mode.
    'GtkSourceView.operator-pending-mode': toKeymap(TEXT_OBJECT_BINDINGS),
    // Escape returns to normal mode from insert, operator-pending, and visual.
    'GtkSourceView:not(.normal-mode)': {
      escape: 'vim-mode-plus:activate-normal-mode',
    },
  });
}

/** Create and wire a VimState for `editor`, returning it. */
export function attachVim(editor: EditorModel): VimState {
  registerKeymapsOnce();

  const vimState = new VimState(editor, new StatusBarManager());

  const commands: Record<string, () => void> = {
    'vim-mode-plus:activate-normal-mode': () => {
      vimState.operationStack.run('ActivateNormalMode');
    },
  };
  for (const klass of Object.values(NORMAL_OPERATIONS)) {
    commands[commandName(klass)] = () => {
      vimState.operationStack.run(klass);
    };
  }

  quilx.commands.add(editor.view, commands);
  return vimState;
}
