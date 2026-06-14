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
  Vte,
  type VteTerminal,
} from '../gi.ts';
import { monospaceFontDescription } from '../fonts.ts';
import type { TabState } from '../SessionManager.ts';

const SCROLLBACK_LINES = 10_000;
const DEFAULT_SHELL = '/bin/bash';
// The xterm window-title termprop (VTE_TERMPROP_XTERM_TITLE), set by OSC 0/2.
const XTERM_TITLE = 'xterm.title';

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
  readonly root: VteTerminal;

  private readonly onExit: (status: number) => void;
  // The launch directory, retained for session serialization. (The shell may cd
  // elsewhere; tracking the live cwd would need OSC 7 — out of scope for now.)
  protected readonly cwd: string;
  private _title: string;
  private _pid: number | null = null;
  private readonly titleHandlers: Array<() => void> = [];

  constructor(options: TerminalOptions = {}) {
    this.onExit = options.onExit ?? (() => {});
    this.cwd = options.cwd ?? Os.homedir();
    this._title = options.title ?? 'Terminal';

    this.root = this.createTerminal();
    this.followSystemColorScheme();
    this.spawnShell(options);
  }

  // --- Terminal widget -------------------------------------------------------

  private createTerminal(): VteTerminal {
    const terminal = new Vte.Terminal();
    terminal.setName('Terminal'); // selector identity for command/keymap rules
    terminal.addCssClass('has-text-input'); // release the `space` leader so it types
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

    this.root.spawnAsync(
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
    this.root.setColors(null, null, null);
  }

  // --- Identity --------------------------------------------------------------

  /** The tab/window title for this terminal (the shell's reported title). */
  get title(): string {
    return this._title;
  }

  focus() {
    this.root.grabFocus();
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

  /** Subscribe to title changes; returns an unsubscribe function. */
  onTitleChange(callback: () => void): () => void {
    this.titleHandlers.push(callback);
    return () => {
      const index = this.titleHandlers.indexOf(callback);
      if (index !== -1) this.titleHandlers.splice(index, 1);
    };
  }

  private emitTitleChange() {
    for (const callback of this.titleHandlers) callback();
  }
}
