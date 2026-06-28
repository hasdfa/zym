/*
 * toolRows — the shared builder for a tool-use transcript entry (Bash, file tools,
 * and generic tools). It is the SINGLE place that turns a `{name, input}` (+ later a
 * result / progress) into a row, so the main AgentConversation and each subagent page
 * (SubagentView) render tools identically.
 *
 * `appendToolRow` appends the entry to a `Transcript` and returns a handle the caller
 * wires to the tool's outcome:
 *   - the main conversation feeds `onResult`/`onProgress` from live stream events
 *     (keyed by tool_use_id in its own map);
 *   - a subagent page, which already holds the full captured `{name, input, result}`,
 *     just calls `onResult` once.
 *
 * Layout decisions (Bash command crop, file-tool collapsing, Task markdown card,
 * TodoWrite checklist, failure tint) live here, not in either caller.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import { theme } from '../../theme/theme.ts';
import { fonts } from '../../fonts.ts';
import { MarkdownView } from '../markdown/MarkdownView.ts';
import { toolBodyMarkup, toolFilePath, describeTool } from '../toolDisplay.ts';
import { escapeMarkup, setMarkupSafe } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { truncateLines, summarizeInput, progressLine } from './format.ts';
import { ToolRow, toolHeaderLabel } from './ToolRow.ts';
import { Transcript } from './Transcript.ts';
import { NERDFONT } from '../nerdfont.ts';
import type { CompositeDisposable } from '../../util/eventKit.ts';
import type { TaskProgress } from '../../agents/claude-sdk/SdkSession.ts';

// Tools whose first input path counts as a "changed file" (mirrors the claude-tui
// PostToolUse Edit|Write|MultiEdit|NotebookEdit hook). Shared with AgentConversation.
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ToolRowContext {
  /** Working directory, for shortening file paths in tool details. */
  cwd: string;
  /** Open a file a file-tool acts on (makes its row clickable + collapsible). */
  onOpenFile?: (path: string) => void;
  /** The owner's disposable bag — each built `ToolRow` registers with it so its
   *  node-gtk-rooted header-button handler is severed when the owner is torn down
   *  (the conversation / a subagent page). See `ToolRowOptions.subs`. */
  subs?: CompositeDisposable;
}

/** A built tool entry: the caller wires its result + (optional) live progress. */
export interface ToolEntry {
  /** The ToolRow, when this entry is a toggle/Bash row; absent for the collapsed
   *  file-group row (Read/Edit/Write), which isn't a ToolRow. */
  row?: ToolRow;
  /** Fill in the tool's result once it arrives (failure tint + output / Task card). */
  onResult(isError: boolean, text: string): void;
  /** Stream a background task's live progress into the row (toggle rows only). */
  onProgress?(p: TaskProgress): void;
}

/** Append a tool-use entry to `transcript` and return a handle to wire its result +
 *  progress. Bash gets a bespoke command row; Read/Write/Edit/… collapse into one
 *  grouped row per consecutive run (when `onOpenFile` is set); everything else is a
 *  generic toggle row. */
export function appendToolRow(transcript: Transcript, name: string, input: unknown, ctx: ToolRowContext): ToolEntry {
  if (name === 'Bash') return appendBashRow(transcript, input, ctx.subs);

  // Read/Write/Edit/… collapse into one row per consecutive run of the same tool —
  // the Transcript builds it; we only wire the (failure-only) result back here.
  if (ctx.onOpenFile && toolFilePath(name, input)) {
    const onResult = transcript.appendFileTool(name, input, { cwd: ctx.cwd, onOpenFile: ctx.onOpenFile });
    return { onResult };
  }

  const filePath = toolFilePath(name, input);
  const opensFile = !!(filePath && ctx.onOpenFile);

  // The icon goes in the row's leading slot; the header is just title + detail.
  // File tools open their file on click (no toggle); the rest toggle their detail.
  const { icon } = describeTool(name, input, ctx.cwd);
  const header = toolHeaderLabel();
  setMarkupSafe(header, toolBodyMarkup(name, input, { cwd: ctx.cwd, monoFamily: fonts.monospaceFamily }), `${name} ${summarizeInput(input)}`);

  const toolRow = new ToolRow({
    icon,
    header,
    onActivate: opensFile ? () => ctx.onOpenFile!(filePath!) : undefined,
    subs: ctx.subs,
  });

  // TodoWrite carries its checklist in the input — render it now, not on result.
  const todos = (input as { todos?: unknown })?.todos;
  if (name === 'TodoWrite' && Array.isArray(todos)) toolRow.content.append(renderTodos(todos));

  transcript.appendToolEntry(toolRow.root);

  // Background-task rows (run_in_background) get a live progress line.
  let progress: InstanceType<typeof Gtk.Label> | null = null;
  const entry: ToolEntry = {
    row: toolRow,
    onResult: (isError, text) => fillToolResult(toolRow, name, isError, text),
    onProgress: (p) => {
      if (!progress) {
        progress = new Gtk.Label({ xalign: 0, wrap: true });
        progress.addCssClass('conversation-system');
        toolRow.content.append(progress);
      }
      progress.setText(progressLine(p));
      toolRow.setExpanded(true); // surface live progress as it streams in
      transcript.scrollToBottom();
    },
  };
  transcript.scrollToBottom();
  return entry;
}

/** How a Bash tool-use splits across its row's header (the expander button) and the
 *  expanded detail. The Bash tool input carries a human-readable command `description`;
 *  when present, the header shows that prose and the command drops into the detail —
 *  otherwise the header is the command itself (and the detail holds only the output).
 *  Pure, so the split is unit-tested. */
export function bashRowParts(input: unknown): { headerText: string; headerIsCommand: boolean; detailCommand: string | null } {
  const command = (input as { command?: unknown })?.command;
  const description = (input as { description?: unknown })?.description;
  const cmd = typeof command === 'string' ? command : summarizeInput(input);
  const desc = typeof description === 'string' ? description.trim() : '';
  return desc
    ? { headerText: desc, headerIsCommand: false, detailCommand: cmd }
    : { headerText: cmd, headerIsCommand: true, detailCommand: null };
}

// Bash (shared ToolRow): the header — the command's description when one is given, else
// the command itself (monospace, cropped to its first line collapsed) — is the button
// toggling the detail, which holds the full command (whenever the description owns the
// header) above the output. A non-zero exit only reveals a trailing red dot — the icon and
// header colour stay put (a miss is often normal).
function appendBashRow(transcript: Transcript, input: unknown, subs?: CompositeDisposable): ToolEntry {
  const { headerText, headerIsCommand, detailCommand } = bashRowParts(input);

  // The command renders as plain monospace (no syntax highlighting); the description is prose.
  const monoWrap = (text: string) => `<span face="${escapeMarkup(fonts.monospaceFamily)}">${escapeMarkup(text)}</span>`;

  const label = new Gtk.Label({ xalign: 0, hexpand: true });
  label.addCssClass('conversation-tool-header');
  let onToggle: ((expanded: boolean) => void) | undefined;
  if (headerIsCommand) {
    // Collapsed: the command is cropped to its first line; the full (multiline)
    // command shows only once expanded.
    const firstLine = headerText.split('\n', 1)[0];
    const multiline = headerText.includes('\n');
    onToggle = (expanded: boolean) => {
      const full = expanded || !multiline;
      const text = full ? headerText : firstLine;
      label.setWrap(full);
      label.setEllipsize(full ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
      setMarkupSafe(label, monoWrap(text), text);
    };
    onToggle(false);
  } else {
    // The description is prose: a single ellipsized line, unchanged across toggles.
    label.setSingleLineMode(true);
    label.setEllipsize(Pango.EllipsizeMode.END);
    setMarkupSafe(label, escapeMarkup(headerText), headerText);
  }

  // A trailing red dot (shown on a non-zero exit) at the far end of the row.
  const errorDot = new Gtk.Label({ valign: Gtk.Align.CENTER, visible: false });
  errorDot.addCssClass('bash-error-dot');
  setMarkupSafe(errorDot, iconSpan(NERDFONT.STATUS.DOT, theme.ui.status.error), '●');
  const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, hexpand: true });
  header.append(label);
  header.append(errorDot);

  const toolRow = new ToolRow({ icon: describeTool('Bash', input).icon, header, onToggle, subs });

  // When the description owns the header, the command itself lives in the expanded
  // detail (monospace, selectable), above any output.
  if (detailCommand !== null) {
    const cmdLabel = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
    cmdLabel.addCssClass('conversation-bash-command');
    setMarkupSafe(cmdLabel, monoWrap(detailCommand), detailCommand);
    toolRow.content.append(cmdLabel);
  }

  transcript.appendToolEntry(toolRow.root);

  let progress: InstanceType<typeof Gtk.Label> | null = null;
  const entry: ToolEntry = {
    row: toolRow,
    onResult: (isError, text) => {
      const trimmed = text.trim();
      if (trimmed) {
        const out = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 40, 4000) });
        out.addCssClass('conversation-result');
        toolRow.content.append(out);
      }
      // A non-zero exit is often normal (grep/test miss): just show the dot, don't
      // auto-expand (the user opens the output if wanted).
      if (isError) errorDot.setVisible(true);
    },
    // Background-bash progress (run_in_background); shown in the detail body.
    onProgress: (p) => {
      if (!progress) {
        progress = new Gtk.Label({ xalign: 0, wrap: true });
        progress.addCssClass('conversation-system');
        toolRow.content.append(progress);
      }
      progress.setText(progressLine(p));
      toolRow.setExpanded(true);
      transcript.scrollToBottom();
    },
  };
  transcript.scrollToBottom();
  return entry;
}

// Fill a non-Bash tool row's result: a red ✗ on failure (which also expands the
// row), then a markdown card for Task (the subagent's report) or a truncated text
// preview otherwise, into the row's collapsible detail section.
function fillToolResult(toolRow: ToolRow, name: string, isError: boolean, text: string): void {
  if (isError) {
    toolRow.setStatus('error', NERDFONT.STATUS.CROSS); // ✗ + error-tinted icon/header
    toolRow.setExpanded(true); // surface the failure without a click
  }
  // File tools (Read/Write/Edit/…): the file is opened on the side via the
  // clickable row, and the result is just a boilerplate "created/updated" notice —
  // don't dump it into the conversation (only a failure still shows its error text).
  if ((name === 'Read' || EDIT_TOOLS.has(name)) && !isError) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  if (name === 'Task' || name === 'Agent') {
    const view = new MarkdownView();
    view.root.addCssClass('conversation-task-result');
    toolRow.content.append(view.root);
    view.setMarkdown(trimmed);
  } else {
    const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(trimmed, 8, 800) });
    label.addCssClass('conversation-result');
    toolRow.content.append(label);
  }
}

// A TodoWrite checklist: one glyph-prefixed row per todo (completed struck through).
function renderTodos(todos: unknown[]): InstanceType<typeof Gtk.Box> {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  for (const raw of todos) {
    const todo = (raw && typeof raw === 'object' ? raw : {}) as { content?: unknown; status?: unknown };
    const content = typeof todo.content === 'string' ? todo.content : '';
    const status = todo.status;
    const glyph = status === 'completed' ? NERDFONT.TASK.DONE : status === 'in_progress' ? NERDFONT.TASK.ACTIVE : NERDFONT.TASK.OPEN;
    const color = status === 'completed' ? theme.ui.status.success : status === 'in_progress' ? theme.ui.status.warning : undefined;
    const body = status === 'completed' ? `<s>${escapeMarkup(content)}</s>` : escapeMarkup(content);
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${iconSpan(glyph, color)}  ${body}`, content);
    box.append(label);
  }
  return box;
}
