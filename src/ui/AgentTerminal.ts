/*
 * AgentTerminal — a Terminal that hosts a terminal-based coding agent (an agent
 * CLI) rather than a plain login shell. It behaves exactly like Terminal except:
 *
 *   - it paints with the theme's editor background/foreground instead of
 *     inheriting the Adwaita view colors, so an agent session blends with the
 *     editor surface;
 *   - it carries its own selector identity (`AgentTerminal`) for command/keymap
 *     and CSS rules;
 *   - its initial title is the agent's name (until the CLI reports its own);
 *   - when the agent process exits the widget is NOT torn down: a "process
 *     exited" notice is printed into the terminal and the agent stays listed,
 *     flipped to an `exited` status (surfaced via `onDidChangeStatus`).
 *
 * The agent's argv comes from the `agent.command` config (default `['claude']`)
 * unless an explicit `command` is passed.
 */
import * as Path from 'node:path';
import { Gdk, Gtk } from '../gi.ts';
import { Terminal, type TerminalOptions } from './Terminal.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';

export interface AgentTerminalOptions extends TerminalOptions {
  /** Fired when the user presses Enter after the agent process has exited. */
  onCloseRequest?: () => void;
}

export class AgentTerminal extends Terminal {
  private _exited = false;
  private readonly statusHandlers: Array<() => void> = [];
  private readonly onCloseRequest?: () => void;

  constructor(options: AgentTerminalOptions = {}) {
    const command = options.command ?? resolveAgentCommand();
    super({ ...options, command, title: options.title ?? agentName(command) });
    this.onCloseRequest = options.onCloseRequest;
    this.root.setName('AgentTerminal'); // distinct identity from a plain Terminal
    this.applyThemeColors();

    // Track the live agent globally. On exit we keep it registered (so it stays
    // in the agent list as "exited") and leave the widget in place, printing a
    // notice instead. A second child-exited handler avoids touching `this` in the
    // super() call.
    quilx.agents.add(this);
    this.root.on('child-exited', () => this.onChildExited());
  }

  /** Whether the agent process has exited (the widget lingers afterward). */
  get exited(): boolean {
    return this._exited;
  }

  /** Subscribe to status changes (currently: running → exited). Returns unsub. */
  onDidChangeStatus(callback: () => void): () => void {
    this.statusHandlers.push(callback);
    return () => {
      const index = this.statusHandlers.indexOf(callback);
      if (index !== -1) this.statusHandlers.splice(index, 1);
    };
  }

  private onChildExited(): void {
    if (this._exited) return;
    this._exited = true;
    // Print a notice into the (now child-less) terminal so the pane shows why it
    // went quiet, rather than closing or freezing on the last frame.
    this.root.feed(encode('\r\n\x1b[2m── process exited (press enter to close) ──\x1b[0m\r\n'));
    for (const handler of this.statusHandlers) handler();
    this.installCloseOnEnter();
  }

  // After exit there is no child to consume input, so Enter requests closing the
  // (now-dead) widget. Capture phase so it fires before Vte swallows the key.
  private installCloseOnEnter(): void {
    if (!this.onCloseRequest) return;
    const keys = new Gtk.EventControllerKey();
    keys.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    keys.on('key-pressed', (keyval: number) => {
      if (keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) {
        this.onCloseRequest?.();
        return true;
      }
      return false;
    });
    this.root.addController(keys);
  }

  // Vte inherits the Adwaita view colors by default (see Terminal); override the
  // background (and foreground) with the theme's editor colors. Themes without
  // their own background keep the inherited colors.
  private applyThemeColors() {
    const { bg, fg } = theme.ui;
    if (!bg) return;
    this.root.setColors(parseColor(fg), parseColor(bg), null);
  }
}

/** A display name for the agent, from its argv (the program basename). */
function agentName(command: string[]): string {
  return command.length > 0 ? Path.basename(command[0]) : 'agent';
}

/** The configured agent argv (`agent.command`), falling back to `['claude']`. */
function resolveAgentCommand(): string[] {
  const value = quilx.config.get('agent.command');
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  return ['claude'];
}

/** Encode a string to the byte array Vte.feed expects. */
function encode(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

/** Parse a `#rrggbb` hex string into a Gdk.RGBA. */
function parseColor(hex: string): InstanceType<typeof Gdk.RGBA> {
  const rgba = new Gdk.RGBA();
  rgba.parse(hex);
  return rgba;
}
