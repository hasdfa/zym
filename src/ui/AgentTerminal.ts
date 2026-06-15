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
 *     flipped to an `exited` status;
 *   - for a `claude` agent it observes the session's live status (idle / working
 *     / waiting-for-permission) via Claude Code hooks: it spawns claude with a
 *     per-session `--settings` block whose hooks write a status word to a file
 *     this terminal watches (a Gio file monitor). See assets/hooks/agent-status.sh.
 *
 * Status changes are surfaced via `status` / `onDidChangeStatus`.
 *
 * The agent's argv comes from the `agent.command` config (default `['claude']`)
 * unless an explicit `command` is passed.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Gdk, Gio } from '../gi.ts';
import { Terminal, type TerminalOptions } from './Terminal.ts';
import { theme } from '../theme/theme.ts';
import { quilx } from '../quilx.ts';
import type { TabState } from '../SessionManager.ts';

/** Live status of an agent session. */
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'exited';

// node-gtk quirk: Gio.File instance methods are undefined on the concrete
// wrapper, so we reach them through the interface prototype (see git.ts/FileTree).
const FileProto = (Gio.File as any).prototype;

// The bundled hook reporter (assets/hooks/agent-status.sh), invoked by claude's
// hooks to write the session status to QUILX_STATUS_FILE.
const HOOK_SCRIPT = Path.join(
  Path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'hooks', 'agent-status.sh',
);

/** Resume a past `claude` conversation rather than starting fresh. */
export interface AgentResume {
  /** Resume a specific session id (`claude --resume <id>`). */
  sessionId?: string;
  /** Continue the most recent conversation in the cwd (`claude --continue`). */
  continue?: boolean;
  /** Branch a copy instead of appending to the original (`--fork-session`). */
  fork?: boolean;
}

export interface AgentTerminalOptions extends TerminalOptions {
  /** An initial prompt to launch the agent with (appended to its argv). */
  prompt?: string;
  /** Resume a past conversation rather than starting a new one (claude only). */
  resume?: AgentResume;
}

export class AgentTerminal extends Terminal {
  private _status: AgentStatus = 'idle';
  private readonly statusHandlers: Array<() => void> = [];
  private readonly statusFile: string | null;
  private statusMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  // Files the agent has edited, captured from a PostToolUse hook (via
  // `<statusFile>.files`); a watched, deduped, launch-order list.
  private filesMonitor: InstanceType<typeof Gio.FileMonitor> | null = null;
  private _changedFiles: string[] = [];
  private readonly fileHandlers: Array<() => void> = [];
  // A user-pinned display name (`rename`); when set it overrides the CLI's
  // reported (OSC) title.
  private _displayName: string | null = null;
  // The agent's argv as the user requested it (before `--settings` injection) and
  // its launch prompt — retained so a session can relaunch the agent verbatim.
  private readonly baseCommand: string[];
  private readonly launchPrompt?: string;
  // The claude session id, captured from the hooks (via `<statusFile>.session`),
  // for resuming / persisting the conversation. Read lazily and cached.
  private _sessionId: string | null = null;

  constructor(options: AgentTerminalOptions = {}) {
    const baseCommand = options.command ?? resolveAgentCommand();
    const integration = buildStatusIntegration(baseCommand, resumeFlags(options.resume));
    // A launch prompt rides along as a trailing argv element (e.g. `claude
    // "<prompt>"`), so the agent starts already working on it.
    const command = options.prompt
      ? [...integration.command, options.prompt]
      : integration.command;
    super({ ...options, command, title: options.title ?? agentName(baseCommand) });
    this.statusFile = integration.statusFile;
    this.baseCommand = baseCommand;
    this.launchPrompt = options.prompt;
    this.root.setName('AgentTerminal'); // distinct identity from a plain Terminal
    this.applyThemeColors();

    // Track the live agent globally. On exit we keep it registered (so it stays
    // in the agent list as "exited") and leave the widget in place, printing a
    // notice instead. A second child-exited handler avoids touching `this` in the
    // super() call.
    quilx.agents.add(this);
    this.terminal.on('child-exited', () => this.onChildExited());
    if (this.statusFile) {
      this.watchStatus(this.statusFile);
      this.watchChangedFiles(`${this.statusFile}.files`);
    }
  }

  /** The agent session's current status. */
  get status(): AgentStatus {
    return this._status;
  }

  // A pinned name (rename) wins over the CLI's reported title.
  get title(): string {
    return this._displayName ?? super.title;
  }

  /** Whether the user has pinned a custom name via `rename`. */
  get renamed(): boolean {
    return this._displayName !== null;
  }

  /** Pin a display name (empty clears it, reverting to the CLI title). */
  rename(name: string): void {
    this._displayName = name.trim() || null;
    this.emitTitleChange();
  }

  /** Whether the agent process has exited (the widget lingers afterward). */
  get exited(): boolean {
    return this._status === 'exited';
  }

  // --- Session integration ----------------------------------------------------

  /** The claude session id once a hook has reported it (null until then). */
  get sessionId(): string | null {
    if (this._sessionId) return this._sessionId;
    if (!this.statusFile) return null;
    try {
      this._sessionId = Fs.readFileSync(`${this.statusFile}.session`, 'utf8').trim() || null;
    } catch {
      /* not written yet */
    }
    return this._sessionId;
  }

  /** Session state: base argv + cwd + prompt, plus the session id so a restore can
   *  resume the conversation rather than start over. */
  serialize(): TabState | null {
    return {
      kind: 'agent',
      command: this.baseCommand,
      cwd: this.cwd,
      prompt: this.launchPrompt,
      sessionId: this.sessionId ?? undefined,
    };
  }

  /** A running agent is live work — it blocks exit until confirmed. */
  isModified(): boolean {
    return !this.exited;
  }

  /** Exit-prompt label, e.g. "claude (running)". */
  getModifiedLabel(): string {
    return `${this.title} (running)`;
  }

  /** Subscribe to status changes (idle/working/waiting/exited). Returns unsub. */
  onDidChangeStatus(callback: () => void): () => void {
    this.statusHandlers.push(callback);
    return () => {
      const index = this.statusHandlers.indexOf(callback);
      if (index !== -1) this.statusHandlers.splice(index, 1);
    };
  }

  /** Absolute paths of files the agent has edited this session (deduped). */
  get changedFiles(): string[] {
    return this._changedFiles.slice();
  }

  /** Subscribe to the edited-files list growing. Returns unsub. */
  onDidChangeFiles(callback: () => void): () => void {
    this.fileHandlers.push(callback);
    return () => {
      const index = this.fileHandlers.indexOf(callback);
      if (index !== -1) this.fileHandlers.splice(index, 1);
    };
  }

  // --- Hook-driven status -----------------------------------------------------

  // Watch the per-session status file the hooks write (atomically, via rename —
  // hence WATCH_MOVES) and reflect each new value as a status change.
  private watchStatus(statusFile: string): void {
    const file = Gio.File.newForPath(statusFile);
    this.statusMonitor = FileProto.monitorFile.call(file, Gio.FileMonitorFlags.WATCH_MOVES, null);
    this.statusMonitor!.on('changed', () => this.readStatus(statusFile));
  }

  private readStatus(statusFile: string): void {
    if (this._status === 'exited') return; // exit is terminal; ignore late writes
    let raw: string;
    try {
      raw = Fs.readFileSync(statusFile, 'utf8').trim();
    } catch {
      return; // mid-rename / removed
    }
    if (raw === 'working' || raw === 'waiting' || raw === 'idle') this.setStatus(raw);
  }

  private setStatus(status: AgentStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const handler of this.statusHandlers) handler();
  }

  // Watch the append-only edited-files log the PostToolUse hook writes, reflecting
  // each new path as a change.
  private watchChangedFiles(file: string): void {
    const gfile = Gio.File.newForPath(file);
    this.filesMonitor = FileProto.monitorFile.call(gfile, Gio.FileMonitorFlags.NONE, null);
    this.filesMonitor!.on('changed', () => this.readChangedFiles(file));
  }

  private readChangedFiles(file: string): void {
    let raw: string;
    try {
      raw = Fs.readFileSync(file, 'utf8');
    } catch {
      return; // not written yet / removed on exit
    }
    // Dedupe, preserving first-seen order; the hook appends one path per edit.
    const seen = new Set<string>();
    const files: string[] = [];
    for (const line of raw.split('\n')) {
      const path = line.trim();
      if (path && !seen.has(path)) {
        seen.add(path);
        files.push(path);
      }
    }
    if (files.length === this._changedFiles.length) return; // nothing new
    this._changedFiles = files;
    for (const handler of this.fileHandlers) handler();
  }

  private onChildExited(): void {
    if (this._status === 'exited') return;
    this.setStatus('exited');
    void this.sessionId; // cache the id before its file is removed (restart resumes it)
    // Print a notice into the (now child-less) terminal so the pane shows why it
    // went quiet, rather than closing or freezing on the last frame. The agent and
    // its layout linger — the user restarts (`r`) or closes (`X`) it from the layout
    // list when they're done reading the output.
    this.terminal.feed(encode('\r\n\x1b[2m── process exited ──\x1b[0m\r\n'));
    this.statusMonitor?.cancel();
    this.statusMonitor = null;
    this.filesMonitor?.cancel();
    this.filesMonitor = null;
    if (this.statusFile) {
      try { Fs.rmSync(this.statusFile, { force: true }); } catch { /* best effort */ }
      try { Fs.rmSync(`${this.statusFile}.session`, { force: true }); } catch { /* best effort */ }
      try { Fs.rmSync(`${this.statusFile}.files`, { force: true }); } catch { /* best effort */ }
    }
  }


  // Vte inherits the Adwaita view colors by default (see Terminal); override the
  // background (and foreground) with the theme's editor colors. Themes without
  // their own background keep the inherited colors.
  private applyThemeColors() {
    const { bg, fg } = theme.ui;
    if (!bg) return;
    this.terminal.setColors(parseColor(fg), parseColor(bg), null);
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

/**
 * For a `claude` agent, inject a per-session `--settings` block whose hooks
 * report status to a freshly-created status file; returns the augmented argv and
 * that file's path. For any other command, status integration is skipped.
 */
function buildStatusIntegration(
  command: string[],
  resume: string[] = [],
): { command: string[]; statusFile: string | null } {
  if (command.length === 0 || Path.basename(command[0]) !== 'claude') {
    return { command, statusFile: null }; // resume + status hooks are claude-only
  }
  const id = randomUUID();
  const dir = Path.join(process.env.XDG_RUNTIME_DIR || Os.tmpdir(), 'quilx', 'agents');
  const statusFile = Path.join(dir, id);
  try {
    Fs.mkdirSync(dir, { recursive: true });
    Fs.writeFileSync(statusFile, 'idle'); // exists up front so the monitor tracks it
    Fs.writeFileSync(`${statusFile}.files`, ''); // edited-files log (one path per line)
  } catch {
    return { command, statusFile: null }; // can't set up IPC — run plain
  }

  const run = (state: string) => `sh ${shellQuote(HOOK_SCRIPT)} ${state}`;
  const settings = {
    env: { QUILX_AGENT_ID: id, QUILX_STATUS_FILE: statusFile },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: run('idle') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: run('working') }] }],
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: run('working') }] }],
      // Record which files the agent edits, for change-awareness in the UI.
      PostToolUse: [{
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [{ type: 'command', command: run('files') }],
      }],
      Stop: [{ hooks: [{ type: 'command', command: run('idle') }] }],
      Notification: [{ hooks: [{ type: 'command', command: run('notification') }] }],
    },
  };
  // `--settings` is a single argv element (VTE spawns via execv, no shell), so the
  // JSON needs no shell-escaping; only the hook command strings (run by claude's
  // shell) are quoted.
  return {
    command: [command[0], ...resume, '--settings', JSON.stringify(settings), ...command.slice(1)],
    statusFile,
  };
}

/** The claude resume flags for a resume request (empty when starting fresh). */
function resumeFlags(resume?: AgentResume): string[] {
  if (!resume) return [];
  const base = resume.continue
    ? ['--continue']
    : resume.sessionId
      ? ['--resume', resume.sessionId]
      : [];
  if (base.length && resume.fork) base.push('--fork-session');
  return base;
}

/** Single-quote a string for embedding in a POSIX shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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
