/*
 * default.ts — the built-in keymap, as declarative data.
 *
 * Shape: `{ selector: { keystroke: 'command:name' } }`, exactly the input
 * `quilx.keymaps.add` takes. A quilx component is targeted by its name with an
 * `#id` selector (`#Panel`, `#FileTree`, …); a raw GTK widget by its type tag
 * (`GtkText`, `GtkSourceView.insert-mode`). The keystroke's command must be
 * registered by some component (commands live with their owner — e.g. Panel
 * registers `tab:*`, AppWindow registers `pane:*`/`file:*`). This table is the
 * single place to read or change the app's key bindings; `load.ts` registers it
 * and layers a user keymap on top.
 *
 * Subsystems that own a dynamic, mode-scoped keymap (the vim layer) register
 * their own table at load time and are intentionally not listed here.
 *
 * A binding value is a command name, or `{ command, args }` to pass arguments to
 * the command (e.g. `{ command: 'tab:go-to', args: [2] }`).
 */
import type { CommandRef } from '../KeymapManager.ts';

type Binding = string | CommandRef;

// Space-leader bindings: a `space` prefix then a mnemonic (Spacemacs-style).
// Registered on `#AppWindow` (an ancestor of everything), so the leader is
// available globally; text-input contexts release `space` with `unset!` (see
// below) so it still types literally there.
const SPACE_COMMANDS: Record<string, string> = {
  'space w': 'file:save',
  'space o': 'file:find', // fuzzy file picker
  'space space': 'command-palette:toggle',
  'space q': 'app:quit',
  'space t': 'terminal:new',
  'space a a': 'agent:switch', // open the agent picker
  'space a n': 'agent:new', // launch a new agent
  'space n': 'notifications:toggle-log', // show/hide the bottom notification log
  'space ,': 'config:open', // preferences (GNOME-style comma == settings)
  'space g l': 'git:pull', // git "l"oad / pull from upstream
  'space g p': 'git:push',
};

// Tab navigation. alt-, / alt-. switch to the previous / next tab; alt-1..8 jump
// to a tab by index via one parameterized command (`tab:go-to` with the 0-based
// index as its argument); alt-9 jumps to the last.
const TAB_BINDINGS: Record<string, Binding> = {
  'alt-,': 'tab:previous',
  'alt-.': 'tab:next',
  'alt-9': 'tab:go-to-last',
  'alt-c': 'tab:close', // close the focused panel child
};
for (let n = 1; n <= 8; n++) TAB_BINDINGS[`alt-${n}`] = { command: 'tab:go-to', args: [n - 1] };

export const DEFAULT_KEYMAP: Record<string, Record<string, Binding>> = {
  '#AppWindow': {
    // Vim-style split (pane) management.
    'ctrl-w v': 'pane:split-right',
    'ctrl-w s': 'pane:split-down',
    'ctrl-w c': 'pane:close',
    'ctrl-w h': 'pane:focus-left',
    'ctrl-w j': 'pane:focus-down',
    'ctrl-w k': 'pane:focus-up',
    'ctrl-w l': 'pane:focus-right',
    'ctrl-w w': 'pane:focus-next',
    'ctrl-w ctrl-w': 'pane:focus-next',

    ...SPACE_COMMANDS,
  },

  // Tab switching, routed to whichever panel holds focus.
  '#Panel': TAB_BINDINGS,

  // Vim-style file-tree navigation while the tree is focused.
  '#FileTree': {
    j: 'core:down',
    k: 'core:up',
    l: 'core:right', // enter a directory / open a file
    h: 'core:left', // collapse a directory / go to parent
    ',': 'tree:toggle-untracked-files', // show/hide files not tracked by git
    '.': 'tree:toggle-hidden-files', // show/hide dotfiles
  },

  // Vim-style agent-list navigation while the list is focused.
  '#AgentList': {
    j: 'core:down',
    k: 'core:up',
    l: 'core:right', // reveal the selected agent's terminal
  },

  // The notification log: while it has focus, bare keys act on the history
  // (vim-tree style). `c` clears it; `q` hides it (same command as the leader
  // toggle). The log takes no literal text input, so single keys are safe.
  '#NotificationLog': {
    c: 'notifications:clear',
    q: 'notifications:toggle-log',
  },

  // Any widget that takes literal text input carries the `.has-text-input` class
  // (text entries, the terminal / agent terminal, the editor in insert mode).
  // Releasing `space` there with `unset!` lets it type a literal space instead of
  // triggering the AppWindow leader. A widget adds/removes the class itself (the
  // editor toggles it per mode), so this one rule covers them all.
  '.has-text-input': { space: 'unset!' },
};
