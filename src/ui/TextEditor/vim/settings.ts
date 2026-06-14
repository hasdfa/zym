/*
 * settings — the vim layer's view onto the global config.
 *
 * Stands in for vim-mode-plus's `settings` module: vendored code calls
 * `settings.get(param)` / `settings.set(param, value)` and occasionally observes
 * changes. Just as upstream reads its keys off `atom.config` under the
 * `vim-mode-plus` namespace, this registers its schema into the shared
 * `quilx.config` and exposes a namespaced view — so the global config stays the
 * single source of truth and these params show up as `vim-mode-plus.*`.
 *
 * We seed only the parameters the ported core actually reads and grow the schema
 * as more of vim-mode-plus comes online; this is deliberately not a verbatim
 * port of upstream's ~100-entry config.
 */
import type { ConfigSchema } from '../../../util/Config.ts';
import { quilx } from '../../../quilx.ts';

const schema: Record<string, ConfigSchema> = {
  debug: {
    type: 'boolean',
    default: false,
    description: 'Log internal vim-layer activity to the console.',
  },
  startInInsertMode: {
    type: 'boolean',
    default: false,
    description: 'Enter insert mode when an editor is first attached.',
  },
  startInInsertModeScopes: {
    type: 'array',
    default: [],
    description: 'Scopes (by selector) that should start in insert mode.',
  },
  clearHighlightSearchOnResetNormalMode: {
    type: 'boolean',
    default: false,
    description: 'Clear search highlights when normal mode is reset (e.g. via Escape).',
  },
  clearPersistentSelectionOnResetNormalMode: {
    type: 'boolean',
    default: false,
    description: 'Clear persistent selections when normal mode is reset.',
  },
  autoDisableInputMethodWhenLeavingInsertMode: {
    type: 'boolean',
    default: false,
    description: 'Disable the OS input method when leaving insert mode.',
  },
  wrapLeftRightMotion: {
    type: 'boolean',
    default: false,
    description: 'Allow h/l (and similar) to wrap across line boundaries.',
  },
  useClipboardAsDefaultRegister: {
    type: 'boolean',
    default: false,
    description: 'Yank/paste through the system clipboard by default.',
  },
  numberRegex: {
    type: 'string',
    default: '-?[0-9]+',
    description: 'Pattern used to find numbers under the cursor for increment/decrement.',
  },
  strictAssertion: {
    type: 'boolean',
    default: false,
    description: 'Throw on internal assertion failures instead of logging.',
  },

  // --- Operator behavior ---
  blackholeRegisteredOperators: {
    type: 'array',
    default: [],
    description: 'Operators (by command name) that write to the blackhole register.',
  },
  flashOnOperate: {
    type: 'boolean',
    default: false,
    description: 'Flash the operated-on range after an operator runs.',
  },
  flashOnOperateBlacklist: {
    type: 'array',
    default: [],
    description: 'Operators that never flash, even when flashOnOperate is on.',
  },
  autoSelectPersistentSelectionOnOperate: {
    type: 'boolean',
    default: false,
    description: 'Include persistent selections as operator targets automatically.',
  },
  stayOnDelete: {
    type: 'boolean',
    default: false,
    description: "Keep the cursor in place after delete instead of vim's default move.",
  },
  stayOnYank: {
    type: 'boolean',
    default: false,
    description: 'Keep the cursor in place after yank.',
  },
  stayOnChange: {
    type: 'boolean',
    default: false,
    description: 'Keep the cursor in place after change.',
  },
  stayOnOccurrence: {
    type: 'boolean',
    default: true,
    description: 'Keep the cursor in place when operating on occurrences.',
  },

  // --- Motion behavior ---
  stayOnVerticalMotion: {
    type: 'boolean',
    default: false,
    description: 'Keep the column on j/k instead of moving to the first character.',
  },
  useLanguageIndependentNonWordCharacters: {
    type: 'boolean',
    default: false,
    description: 'Use a fixed non-word character set for word motions, ignoring grammar.',
  },

  // --- Undo / redo ---
  setCursorToStartOfChangeOnUndoRedo: {
    type: 'boolean',
    default: false,
    description: 'Move the cursor to the start of the change after undo/redo.',
  },
  flashOnUndoRedo: {
    type: 'boolean',
    default: false,
    description: 'Flash the changed range after undo/redo.',
  },
};

export const settings = quilx.config.scope('vim-mode-plus').register(schema);
export default settings;
