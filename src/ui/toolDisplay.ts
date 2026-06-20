/*
 * toolDisplay — format an agent tool-use for the conversation view: a Nerd Font
 * icon, a title, and a human-readable detail drawn from the tool's salient input
 * (the command, the file path, the pattern…) instead of a raw JSON dump. Unknown
 * tools fall back to a generic icon + compact JSON.
 *
 * `describeTool` is the pure mapping (tested); `toolMarkup` builds the Pango markup
 * (icon in the icon font, title bold, detail in the app monospace font).
 */
import * as Os from 'node:os';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { escapeMarkup } from './proseMarkup.ts';
import { NERDFONT } from './nerdfont.ts';

// Tool icons come from the shared Nerd Font catalog (NERDFONT). Most live in the
// TOOL group; bash/grep reuse the EDITOR terminal/search glyphs.
const G = {
  bash: NERDFONT.EDITOR.TERMINAL,
  read: NERDFONT.TOOL.READ,
  write: NERDFONT.TOOL.WRITE,
  edit: NERDFONT.TOOL.EDIT,
  glob: NERDFONT.TOOL.GLOB,
  grep: NERDFONT.EDITOR.SEARCH,
  web: NERDFONT.TOOL.WEB,
  task: NERDFONT.TOOL.SUBAGENT,
  todo: NERDFONT.TOOL.TODO,
  notebook: NERDFONT.TOOL.NOTEBOOK,
  mcp: NERDFONT.TOOL.MCP,
  tool: NERDFONT.TOOL.GENERIC,
  skill: NERDFONT.TOOL.SKILL,
  question: NERDFONT.TOOL.QUESTION,
  workflow: NERDFONT.TOOL.WORKFLOW,
  clock: NERDFONT.TOOL.CLOCK,
  calendar: NERDFONT.TOOL.CALENDAR,
  eye: NERDFONT.TOOL.MONITOR,
  bolt: NERDFONT.TOOL.TRIGGER,
  bell: NERDFONT.TOOL.BELL,
  process: NERDFONT.TOOL.COGS,
  stop: NERDFONT.TOOL.STOP,
  design: NERDFONT.TOOL.DESIGN,
  plan: NERDFONT.TOOL.PLAN,
  worktree: NERDFONT.TOOL.WORKTREE,
} as const;

export interface ToolView {
  /** Nerd Font glyph (render with ICON_FONT_FAMILY). */
  icon: string;
  /** Short tool name / label. */
  title: string;
  /** A one-line, human-readable summary of the tool input. */
  detail: string;
}

/** Map a tool name + input to an icon, title, and a formatted detail line. */
export function describeTool(name: string, input: unknown, cwd?: string): ToolView {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const p = (v: unknown): string => shortenPath(s(v), cwd);

  switch (name) {
    case 'Bash':
      // No label for Bash — the terminal icon + the command read clearly on their own.
      return { icon: G.bash, title: '', detail: s(i.command) || s(i.description) };
    case 'Read':
      return { icon: G.read, title: 'Read', detail: p(i.file_path) };
    case 'Write':
      return { icon: G.write, title: 'Write', detail: p(i.file_path) };
    case 'Edit':
      return { icon: G.edit, title: 'Edit', detail: p(i.file_path) };
    case 'MultiEdit':
      return { icon: G.edit, title: 'MultiEdit', detail: p(i.file_path) + (Array.isArray(i.edits) ? `  (${i.edits.length} edits)` : '') };
    case 'NotebookEdit':
      return { icon: G.notebook, title: 'NotebookEdit', detail: p(i.notebook_path) };
    case 'Glob':
      return { icon: G.glob, title: 'Glob', detail: s(i.pattern) + (i.path ? `  in ${p(i.path)}` : '') };
    case 'Grep':
      return { icon: G.grep, title: 'Grep', detail: s(i.pattern) + (i.path ? `  in ${p(i.path)}` : '') };
    case 'WebFetch':
      return { icon: G.web, title: 'WebFetch', detail: s(i.url) };
    case 'WebSearch':
      return { icon: G.grep, title: 'WebSearch', detail: s(i.query) };
    case 'Task':
      return { icon: G.task, title: i.subagent_type ? `Task · ${s(i.subagent_type)}` : 'Task', detail: s(i.description) || truncate(s(i.prompt), 120) };
    case 'TodoWrite':
      return { icon: G.todo, title: 'TodoWrite', detail: Array.isArray(i.todos) ? `${i.todos.length} item${i.todos.length === 1 ? '' : 's'}` : '' };

    // Skill / agent meta-tools.
    case 'Skill':
      return { icon: G.skill, title: 'Skill', detail: s(i.skill) + (i.args ? `  ${truncate(s(i.args), 80)}` : '') };
    case 'ToolSearch':
      return { icon: G.grep, title: 'ToolSearch', detail: s(i.query) };
    case 'AskUserQuestion': {
      const first = (Array.isArray(i.questions) ? i.questions[0] : undefined) as Record<string, unknown> | undefined;
      return { icon: G.question, title: 'AskUserQuestion', detail: first ? (s(first.header) || s(first.question)) : '' };
    }
    case 'Workflow':
      return { icon: G.workflow, title: 'Workflow', detail: s(i.name) || s(i.scriptPath) || '(inline script)' };

    // Task tracking (subjects/ids).
    case 'TaskCreate':
      return { icon: G.todo, title: 'TaskCreate', detail: s(i.subject) };
    case 'TaskUpdate':
      return { icon: G.todo, title: 'TaskUpdate', detail: (i.taskId ? `#${s(i.taskId)}` : '') + (i.status ? `  → ${s(i.status)}` : '') };
    case 'TaskGet':
      return { icon: G.todo, title: 'TaskGet', detail: i.taskId ? `#${s(i.taskId)}` : '' };
    case 'TaskList':
      return { icon: G.todo, title: 'TaskList', detail: '' };

    // Background-task I/O (bash/agent processes).
    case 'TaskOutput':
      return { icon: G.process, title: 'TaskOutput', detail: s(i.task_id) };
    case 'TaskStop':
      return { icon: G.stop, title: 'TaskStop', detail: s(i.task_id) || s(i.shell_id) };

    // Scheduling / monitoring / notifications.
    case 'ScheduleWakeup':
      return { icon: G.clock, title: 'ScheduleWakeup', detail: (typeof i.delaySeconds === 'number' ? `${i.delaySeconds}s` : '') + (i.reason ? `  ${s(i.reason)}` : '') };
    case 'CronCreate':
      return { icon: G.calendar, title: 'CronCreate', detail: s(i.cron) + (i.recurring === false ? '  (once)' : '') };
    case 'CronDelete':
      return { icon: G.calendar, title: 'CronDelete', detail: s(i.id) };
    case 'CronList':
      return { icon: G.calendar, title: 'CronList', detail: '' };
    case 'Monitor':
      return { icon: G.eye, title: 'Monitor', detail: s(i.description) || s(i.command) };
    case 'RemoteTrigger':
      return { icon: G.bolt, title: 'RemoteTrigger', detail: s(i.action) + (i.trigger_id ? `  ${s(i.trigger_id)}` : '') };
    case 'PushNotification':
      return { icon: G.bell, title: 'PushNotification', detail: truncate(s(i.message), 120) };

    // Design sync / plan mode / worktrees.
    case 'DesignSync':
      return { icon: G.design, title: 'DesignSync', detail: s(i.method) + (i.projectId ? `  ${s(i.projectId)}` : '') };
    case 'EnterPlanMode':
      return { icon: G.plan, title: 'EnterPlanMode', detail: '' };
    case 'ExitPlanMode':
      return { icon: G.plan, title: 'ExitPlanMode', detail: '' };
    case 'EnterWorktree':
      return { icon: G.worktree, title: 'EnterWorktree', detail: s(i.name) || s(i.path) };
    case 'ExitWorktree':
      return { icon: G.worktree, title: 'ExitWorktree', detail: s(i.action) };

    default:
      // MCP tools arrive as mcp__<server>__<tool>; show "server · tool".
      if (name.startsWith('mcp__')) {
        const parts = name.slice(5).split('__');
        return { icon: G.mcp, title: parts.join(' · '), detail: compactJson(input) };
      }
      return { icon: G.tool, title: name, detail: compactJson(input) };
  }
}

/** The file a tool acts on (for click-to-open), or null when it isn't a file tool. */
export function toolFilePath(name: string, input: unknown): string | null {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = name === 'NotebookEdit'
    ? i.notebook_path
    : name === 'Read' || name === 'Write' || name === 'Edit' || name === 'MultiEdit'
      ? i.file_path
      : undefined;
  return typeof path === 'string' && path ? path : null;
}

/** Pango markup for a tool-use row: icon (icon font) + bold title + mono detail. */
export function toolMarkup(name: string, input: unknown, opts: { cwd?: string; monoFamily: string }): string {
  const { icon, title, detail } = describeTool(name, input, opts.cwd);
  let markup = `<span font_family="${attrEscape(ICON_FONT_FAMILY)}">${escapeMarkup(icon)}</span>`;
  if (title) markup += `  <b>${escapeMarkup(title)}</b>`;
  if (detail) markup += `  <span face="${attrEscape(opts.monoFamily)}">${escapeMarkup(detail)}</span>`;
  return markup;
}

// --- helpers -----------------------------------------------------------------

// A path relative to `cwd` when under it, else with the home dir collapsed to `~`.
function shortenPath(path: string, cwd?: string): string {
  if (!path) return '';
  if (cwd && (path === cwd || path.startsWith(cwd + '/'))) return path.slice(cwd.length + 1) || path;
  const home = Os.homedir();
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length);
  return path;
}

function compactJson(input: unknown): string {
  if (input == null) return '';
  let text: string;
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return truncate(text, 200);
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function attrEscape(text: string): string {
  return escapeMarkup(text).replace(/"/g, '&quot;');
}
