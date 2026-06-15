/*
 * Terminal — an interactive shell embedded in the editor: a Vte.Terminal that
 * spawns the user's login shell (`$SHELL`, falling back to `/bin/bash`) in a
 * pseudo-terminal and follows the system light/dark scheme. One Terminal per
 * panel/tab. The Vte widget owns its own scrollback and scrollbar, so the
 * widget is exposed directly via `root`.
 *
 * The shell process is launched in the constructor. When it exits, `onExit` is
 * fired (the host decides whether to close the tab or respawn). The shell's
 * reported title (OSC 0/2) is surfaced through `title` / `onTitleChange`, so a
 * tab can mirror e.g. the running command or current directory.
 */
import * as Os from 'node:os';
import {
  GLib,
  Gtk,
  Vte,
  type VteTerminal,
} from '../gi.ts';
import { monospaceFontDescription } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import type { TabState } from '../SessionManager.ts';

const SCROLLBACK_LINES = 10_000;
const DEFAULT_SHELL = '/bin/bash';
// The xterm window-title termprop (VTE_TERMPROP_XTERM_TITLE), set by OSC 0/2.
const XTERM_TITLE = 'xterm.title';

/** Terminal input modes (vim-like): `insert` types into the child; `normal`
 *  releases the keyboard to the app's leader / window-navigation commands. */
export type TerminalMode = 'normal' | 'insert';

// A terminal in normal mode gets a thin selection-colored frame while focused so
// the mode is visible (the keyboard is acting on the app, not the child). `:focus`
// (not `-within`) because normal mode focuses the container itself, not the Vte.
addStyles(`
  .quilx-terminal.terminal-normal:focus {
    outline: 1px solid ${theme.ui.selectedBg ?? '@theme_selected_bg_color'};
    outline-offset: -1px;
  }
`);

export interface TerminalOptions {
  /** Directory to start the shell in (defaults to the user's home directory). */
  cwd?: string;
  /** Shell to launch (defaults to `$SHELL`, then `/bin/bash`). */
  shell?: string;
  /**
   * Full argv to spawn instead of a login shell (e.g. an agent CLI). When set,
   * `shell` is ignored. Defaults to `[shell, '-l']`.
   */
  command?: string[];
  /** Initial title, shown until the child reports its own (OSC 0/2). */
  title?: string;
  /** Fired when the shell process exits, with its exit status. */
  onExit?: (status: number) => void;
}

export class Terminal {
  // A focusable container wrapping the Vte child. `root` (not the Vte) is the
  // selector identity and the keyboard-focus target in normal mode: focusing it
  // *steals* focus from the Vte so the child's cursor goes idle (un-focused, no
  // blink) and the child receives no keystrokes — there's no need to swallow keys.
  // Insert mode focuses the Vte directly.
  readonly root: InstanceType<typeof Gtk.Box>;
  protected readonly terminal: VteTerminal;

  private readonly onExit: (status: number) => void;
  // The launch directory, retained for session serialization. (The shell may cd
  // elsewhere; tracking the live cwd would need OSC 7 — out of scope for now.)
  protected readonly cwd: string;
  private _title: string;
  private _pid: number | null = null;
  private readonly titleHandlers: Array<() => void> = [];
  // Input mode. Insert (the default) types into the child as a normal terminal;
  // normal releases the keyboard so the app's `space` leader / `ctrl-w` window
  // navigation work. Escape ↔ `i` switch; `ctrl-[` still sends a literal Escape.
  private _mode: TerminalMode = 'insert';
  private readonly modeHandlers: Array<() => void> = [];

  constructor(options: TerminalOptions = {}) {
    this.onExit = options.onExit ?? (() => {});
    this.cwd = options.cwd ?? Os.homedir();
    this._title = options.title ?? 'Terminal';

    this.terminal = this.createTerminal();
    this.root = this.createContainer(this.terminal);
    this.followSystemColorScheme();
    this.spawnShell(options);
    this.setupModalInput();
  }

  // --- Terminal widget -------------------------------------------------------

  // The focusable container hosting the Vte. It carries the selector identity
  // (name + `.quilx-terminal`) and the mode classes, and is what the keymap
  // manager / window focus see (the Vte is its only child).
  private createContainer(terminal: VteTerminal): InstanceType<typeof Gtk.Box> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.setName('Terminal'); // selector identity for command/keymap rules
    box.addCssClass('quilx-terminal'); // shared selector for both Terminal & AgentTerminal
    box.setFocusable(true); // so normal mode can hold focus instead of the Vte
    box.append(terminal);
    return box;
  }

  private createTerminal(): VteTerminal {
    const terminal = new Vte.Terminal();
    terminal.setVexpand(true);
    terminal.setHexpand(true);
    terminal.setScrollbackLines(SCROLLBACK_LINES);
    terminal.setScrollOnOutput(false);
    terminal.setScrollOnKeystroke(true);
    terminal.setMouseAutohide(true);
    terminal.setFont(monospaceFontDescription());

    // The shell/agent's reported title (xterm OSC 0/2). VTE 0.78+ deprecated the
    // `window-title-changed` signal in favor of termprops, so the title arrives as
    // the `xterm.title` termprop via the detailed `termprop-changed` signal.
    terminal.on('termprop-changed', (name: string) => {
      if (name !== XTERM_TITLE) return;
      const value = (terminal as any).getTermpropString(XTERM_TITLE) as string | string[] | null;
      this._title = (Array.isArray(value) ? value[0] : value) || 'Terminal';
      this.emitTitleChange();
    });
    terminal.on('child-exited', (status: number) => this.onExit(status));
    return terminal;
  }

  // --- Shell process ---------------------------------------------------------

  private spawnShell(options: TerminalOptions) {
    // A custom command (e.g. an agent CLI) runs verbatim; otherwise a login
    // shell, so the user's profile (PATH, prompt, aliases) is sourced.
    const shell = options.shell ?? process.env.SHELL ?? DEFAULT_SHELL;
    const argv = options.command ?? [shell, '-l'];
    const envv = Object.entries(process.env).map(([key, value]) => `${key}=${value}`);

    this.terminal.spawnAsync(
      Vte.PtyFlags.DEFAULT,
      this.cwd,
      argv,
      envv,
      GLib.SpawnFlags.SEARCH_PATH,
      // child setup MUST be null: node-gtk would run a JS callback inside the
      // forked child (between fork and exec), where re-entering V8 segfaults the
      // child — VTE then fires `child-exited` immediately and the tab vanishes.
      null as any,
      -1, // no spawn timeout
      null, // no cancellable
      (_terminal: unknown, pid: number, error: { message: string } | null) => {
        // A spawn failure never starts a child, so `child-exited` won't fire;
        // report it explicitly instead of leaving a silent, empty terminal.
        if (error || pid === -1) {
          this.onExit(127);
          console.error(`Terminal: failed to spawn ${argv[0]}: ${error?.message ?? 'unknown error'}`);
        } else {
          this._pid = pid; // captured so `kill()` can signal the child
        }
      },
    );
  }

  // --- Style scheme: follow the system light/dark preference -----------------

  private followSystemColorScheme() {
    // Vte reads its colors from the widget's CSS context, which libadwaita
    // already flips with the system scheme; clearing any explicit override lets
    // it inherit the themed foreground/background.
    this.terminal.setColors(null, null, null);
  }

  // --- Identity --------------------------------------------------------------

  /** The tab/window title for this terminal (the shell's reported title). */
  get title(): string {
    return this._title;
  }

  focus() {
    // Insert focuses the Vte (typing); normal focuses the container (keys go to
    // the app, the Vte cursor idles). So focusing respects the current mode.
    (this._mode === 'insert' ? this.terminal : this.root).grabFocus();
  }

  // Whether keyboard focus is currently inside this terminal (the container or
  // the Vte). Used so a mode switch only moves focus when we already have it.
  private containsFocus(): boolean {
    let widget = this.root.getRoot()?.getFocus?.() ?? null;
    while (widget) {
      if (widget === this.root) return true;
      widget = widget.getParent();
    }
    return false;
  }

  // --- Input mode (vim-like normal/insert) -----------------------------------

  /** The current input mode. */
  get mode(): TerminalMode {
    return this._mode;
  }

  /** Switch input mode. Insert hands the keyboard to the child (and releases the
   *  `space` leader); normal hands it back to the app's leader/window commands. */
  setMode(mode: TerminalMode): void {
    if (mode === this._mode) return;
    const hadFocus = this.containsFocus();
    this._mode = mode;
    this.applyMode();
    // Move focus to the mode's target (Vte in insert, container in normal) so the
    // child cursor activates/idles accordingly — but only if we already held focus.
    if (hadFocus) this.focus();
    for (const handler of this.modeHandlers) handler();
  }

  /** Subscribe to mode changes (normal ↔ insert). Returns an unsubscribe fn. */
  onDidChangeMode(callback: () => void): () => void {
    this.modeHandlers.push(callback);
    return () => {
      const index = this.modeHandlers.indexOf(callback);
      if (index !== -1) this.modeHandlers.splice(index, 1);
    };
  }

  // Wire the modal behaviour: register the mode commands, apply the initial mode,
  // and switch to insert when the Vte is clicked (a click focuses the Vte, so the
  // mode must follow — keeping "focus target == mode" invariant; this is also why
  // no key-swallowing guard is needed: in normal mode the Vte simply isn't focused).
  private setupModalInput(): void {
    quilx.commands.add(this.root, {
      'terminal:insert-mode': () => this.setMode('insert'),
      'terminal:normal-mode': () => this.setMode('normal'),
      'terminal:send-escape': () => this.feedChild('\x1b'),
    });
    this.applyMode();

    const click = new Gtk.GestureClick();
    click.on('pressed', () => this.setMode('insert'));
    this.terminal.addController(click);
  }

  // Reflect the mode onto the widget's CSS classes: `.has-text-input` (which
  // releases the `space` leader) is present only in insert mode, and the
  // `.terminal-insert` / `.terminal-normal` classes drive the mode keymaps + cue.
  private applyMode(): void {
    const insert = this._mode === 'insert';
    if (insert) this.root.addCssClass('has-text-input');
    else this.root.removeCssClass('has-text-input');
    if (insert) this.root.addCssClass('terminal-insert');
    else this.root.removeCssClass('terminal-insert');
    if (insert) this.root.removeCssClass('terminal-normal');
    else this.root.addCssClass('terminal-normal');
  }

  // --- Session integration ---------------------------------------------------

  /** Session state for this tab. Overridden by AgentTerminal for `kind: 'agent'`. */
  serialize(): TabState | null {
    return { kind: 'terminal', cwd: this.cwd };
  }

  /**
   * Signal the child process (default SIGTERM). A direct kill(2) syscall — safe
   * under the GLib loop (unlike node async). No-op before spawn / after exit; the
   * resulting `child-exited` drives the rest (status, exit notice).
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this._pid === null) return;
    try {
      process.kill(this._pid, signal);
    } catch {
      /* already gone */
    }
  }

  /**
   * Write `text` to the child as if typed at the keyboard — used to push editor
   * context (a selection, a file path) into an agent's input. No trailing newline
   * is added, so the recipient can keep editing before submitting.
   */
  feedChild(text: string): void {
    this.terminal.feedChild(Array.from(new TextEncoder().encode(text)));
  }

  /** Subscribe to title changes; returns an unsubscribe function. */
  onTitleChange(callback: () => void): () => void {
    this.titleHandlers.push(callback);
    return () => {
      const index = this.titleHandlers.indexOf(callback);
      if (index !== -1) this.titleHandlers.splice(index, 1);
    };
  }

  /** Notify title subscribers. Protected so subclasses (AgentTerminal's rename)
   *  can surface a title override through the same channel. */
  protected emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }
}
