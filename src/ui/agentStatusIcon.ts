/*
 * agentStatusIcon — the shared agent status indicator. The same dot/cog the
 * WorkbenchList sidebar shows on each agent row is reused by the agent picker, so
 * the two stay in lockstep: a colored dot (●) for idle/waiting/exited, or the
 * nf-md-cog-sync glyph while the agent is working.
 *
 * `createAgentStatusIcon` returns a live, self-updating Gtk.Label — for contexts
 * that hold real widgets (the sidebar list). `agentStatusMarkup` returns the
 * equivalent Pango markup — for contexts that render markup rather than widgets
 * (the picker rows, which are markup-only labels).
 */
import { Gtk, Pango } from '../gi.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { Icons } from './icons.ts';
import { escapeMarkup } from './proseMarkup.ts';
import type { AgentStatus, AgentTerminal, WorktreeInfo } from './AgentTerminal.ts';

export const STATUS_DOT = '●';
export const WORKING_GLYPH = String.fromCodePoint(0xf1978); // nf-md-cog-sync

// Status → indicator color: working (muted cog), waiting on the user (warning/
// amber), idle/ready (success/green), exited (muted).
const STATUS_COLOR: Record<AgentStatus, string> = {
  working: theme.ui.textMuted,
  waiting: theme.ui.warning,
  idle: theme.ui.success,
  exited: theme.ui.textMuted,
};

const DOT_CLASSES = ['quilx-agent-working', 'quilx-agent-waiting', 'quilx-agent-idle', 'quilx-agent-exited'];
addStyles(`
  .quilx-agent-working { color: ${STATUS_COLOR.working}; }
  .quilx-agent-waiting { color: ${STATUS_COLOR.waiting}; }
  .quilx-agent-idle    { color: ${STATUS_COLOR.idle}; }
  .quilx-agent-exited  { color: ${STATUS_COLOR.exited}; }
`);

// The working cog is rendered in the icon font; the plain dot uses the default
// font. Built lazily and shared across every icon.
let iconAttrs: InstanceType<typeof Pango.AttrList> | null = null;
function iconFontAttrs(): InstanceType<typeof Pango.AttrList> {
  if (!iconAttrs) {
    iconAttrs = Pango.AttrList.new();
    iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));
  }
  return iconAttrs;
}

/** Set `label` to reflect `status`: the colored dot, or the cog glyph while working. */
export function applyAgentStatus(label: InstanceType<typeof Gtk.Label>, status: AgentStatus): void {
  for (const cls of DOT_CLASSES) label.removeCssClass(cls);
  label.addCssClass(`quilx-agent-${status}`); // idle | working | waiting | exited
  if (status === 'working') {
    label.setText(WORKING_GLYPH);
    label.setAttributes(iconFontAttrs());
  } else {
    label.setText(STATUS_DOT);
    label.setAttributes(null);
  }
}

/**
 * A live status indicator for `agent`: a Gtk.Label that re-renders as the agent's
 * status changes. Call `dispose` to unsubscribe (e.g. when a row is rebuilt).
 */
export function createAgentStatusIcon(agent: AgentTerminal): {
  widget: InstanceType<typeof Gtk.Label>;
  dispose: () => void;
} {
  const label = new Gtk.Label({ label: STATUS_DOT });
  applyAgentStatus(label, agent.status);
  const dispose = agent.onDidChangeStatus(() => applyAgentStatus(label, agent.status));
  return { widget: label, dispose };
}

/**
 * Pango markup for an agent's status glyph — the same indicator as
 * `createAgentStatusIcon`, for contexts that render markup, not widgets (picker
 * rows). The color is inlined since a markup row carries no CSS class.
 */
export function agentStatusMarkup(status: AgentStatus): string {
  const color = STATUS_COLOR[status];
  if (status === 'working') {
    return `<span foreground="${color}" font_family="${ICON_FONT_FAMILY}">${WORKING_GLYPH}</span>`;
  }
  return `<span foreground="${color}">${STATUS_DOT}</span>`;
}

// --- Worktree ---------------------------------------------------------------

/** Pango markup for a linked-worktree badge (git glyph + branch/worktree name),
 *  or null when the agent isn't in a linked worktree (the common case). */
export function agentWorktreeMarkup(worktree: WorktreeInfo | null): string | null {
  if (!worktree?.linked) return null;
  const name = worktree.branch ?? worktree.name;
  return (
    `<span foreground="${theme.ui.textMuted}">` +
    `<span font_family="${ICON_FONT_FAMILY}">${Icons.git}</span> ${escapeMarkup(name)}</span>`
  );
}

/** Pango markup for an agent's current branch/worktree (git glyph + branch name,
 *  falling back to the worktree name), or null when it isn't inside a repo. Unlike
 *  `agentWorktreeMarkup` it shows for *any* checkout (not only linked worktrees)
 *  and carries no foreground — the caller styles it via CSS so it tracks the row's
 *  theme (see WorkbenchList's two-line rows). */
export function agentBranchMarkup(
  worktree: WorktreeInfo | null,
  branch: string | null = worktree?.branch ?? null,
): string | null {
  if (!worktree) return null;
  // `branch` is the live branch from the workbench's git (so an in-place checkout
  // shows immediately); fall back to the worktree name when detached.
  const name = branch ?? worktree.name;
  return `<span font_family="${ICON_FONT_FAMILY}">${Icons.git}</span> ${escapeMarkup(name)}`;
}
