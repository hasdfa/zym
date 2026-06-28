/*
 * agentStatusIcon — the shared agent status indicator.
 *
 * The widget path (`createAgentStatusIcon`, used by the WorkbenchList sidebar rows
 * and the conversation footer) renders a bundled symbolic `ImageIcons` SVG, swapped
 * in place on a single `Gtk.Image` as the agent's status changes:
 *   - dot            → idle / disconnected (the dimmed "not running" state)
 *   - warning shield → waiting (needs permission)
 *   - loading (…)    → working (in progress)
 *   - warning        → error (POC-only for now)
 * Colour comes from a per-status CSS class (symbolic icons recolor to `color`):
 * idle is success-green, waiting is warning-amber, error is error-red, working is
 * muted, and disconnected dims the inherited foreground via opacity.
 *
 * The markup path (`agentStatusMarkup`) is for contexts that render Pango markup
 * rather than widgets (the picker rows / SubagentView, which are markup-only
 * labels and can't embed a Gtk.Image): it mirrors the same states with the
 * equivalent glyphs (● / …).
 */
import Gtk from 'gi:Gtk-4.0';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { ImagePaintables } from '../icons.ts';
import { Icons } from './icons.ts';
import { NERDFONT } from './nerdfont.ts';
import { escapeMarkup } from './proseMarkup.ts';
import type { AgentStatus, WorktreeInfo } from './AgentTerminal.ts';
import type { Agent } from '../agents/types.ts';

export const STATUS_DOT = '●';
export const WORKING_GLYPH = NERDFONT.STATUS.WORKING;

// The pixel size of the status image (the SVGs are authored on a 16px grid).
const STATUS_ICON_SIZE = 16;

// status → bundled symbolic icon (see ImageIcons). `idle`/`disconnected` share the
// filled dot — colour/opacity (below) distinguishes them; `waiting` (needs permission)
// shows the warning shield; `working` the loading ellipsis; `error` the warning sign.
const STATUS_ICON: Record<AgentStatus, keyof typeof ImagePaintables> = {
  idle: 'DOT',
  waiting: 'WARNING_SHIELD',
  working: 'LOADING',
  disconnected: 'DOT',
  error: 'WARNING',
};

// Status → indicator color for the *colored* states (waiting → warning/amber, idle →
// success/green, error → error/red), used by the *markup* path only — markup can't
// read CSS variables, so it interpolates the literal. The CSS path uses the matching
// var(--t-ui-status-*) directly. The muted states — working (ellipsis) and
// disconnected (not running) — carry no color; they dim the inherited foreground
// (Adwaita's muted idiom: `--dim-opacity` in CSS, `alpha="55%"` in markup).
const STATUS_COLOR: Partial<Record<AgentStatus, string>> = {
  waiting: theme.ui.status.warning,
  idle: theme.ui.status.success,
  error: theme.ui.status.error,
};

// Symbolic icons recolor to the CSS `color`, so each status drives the tint: the
// colored states set an explicit foreground (waiting → amber, idle → green, error →
// red); the muted states (working, disconnected) leave `color` inherited and instead
// dim via opacity (Adwaita's muted idiom — see the markup path's `alpha="55%"`).
const STATUS_CLASSES = ['zym-agent-working', 'zym-agent-waiting', 'zym-agent-idle', 'zym-agent-disconnected', 'zym-agent-error'];
addStyles(`
  .zym-agent-working { color: var(--t-ui-text-muted); }
  .zym-agent-waiting { color: var(--t-ui-status-warning); }
  .zym-agent-idle    { color: var(--t-ui-status-success); }
  .zym-agent-error   { color: var(--t-ui-status-error); }
  .zym-agent-disconnected { opacity: var(--dim-opacity); }
`);

/** Set `image` to reflect `status`: swap its symbolic icon (`STATUS_ICON`) and the
 *  colour class, in place — the widget stays the same so callers keep their slot. */
export function applyAgentStatus(image: InstanceType<typeof Gtk.Image>, status: AgentStatus): void {
  for (const cls of STATUS_CLASSES) image.removeCssClass(cls);
  image.addCssClass(`zym-agent-${status}`); // idle | working | waiting | disconnected | error
  image.setFromPaintable(ImagePaintables[STATUS_ICON[status]](STATUS_ICON_SIZE));
}

/**
 * A live status indicator for `agent`: a Gtk.Image whose icon re-renders as the
 * agent's status changes. Call `dispose` to unsubscribe (e.g. when a row is rebuilt).
 */
export function createAgentStatusIcon(agent: Agent): {
  widget: InstanceType<typeof Gtk.Image>;
  dispose: () => void;
} {
  const image = new Gtk.Image();
  image.setPixelSize(STATUS_ICON_SIZE);
  const update = () => applyAgentStatus(image, agent.status);
  update();
  const unsubStatus = agent.onDidChangeStatus(update);
  return { widget: image, dispose: unsubStatus };
}

/**
 * Pango markup for an agent's status glyph — the same indicator as
 * `createAgentStatusIcon`, for contexts that render markup, not widgets (picker
 * rows). The color is inlined since a markup row carries no CSS class.
 */
export function agentStatusMarkup(status: AgentStatus): string {
  const color = STATUS_COLOR[status];
  // Colored states carry an explicit foreground; the muted states dim the
  // inherited foreground (alpha="55%") instead — see STATUS_COLOR.
  const fg = color ? `foreground="${color}"` : `alpha="55%"`;
  if (status === 'working') {
    return `<span ${fg} font_family="${ICON_FONT_FAMILY}">${WORKING_GLYPH}</span>`;
  }
  return `<span ${fg}>${STATUS_DOT}</span>`;
}

/**
 * An agent tab's title: the status glyph prefixed to the agent's name. Adw tab
 * titles are plain text (no markup, no colour), so the dot can't be colour-coded
 * like the sidebar — the waiting state instead drives Adw's native
 * `needs-attention` tab highlight (see AppWindow.updateAgentTab).
 */
export function agentTabTitle(agent: Agent): string {
  const glyph = agent.status === 'working' ? WORKING_GLYPH : STATUS_DOT;
  return `${glyph} ${agent.title}`;
}

// --- Worktree ---------------------------------------------------------------

/** Pango markup for a linked-worktree badge (git glyph + branch/worktree name),
 *  or null when the agent isn't in a linked worktree (the common case). */
export function agentWorktreeMarkup(worktree: WorktreeInfo | null): string | null {
  if (!worktree?.linked) return null;
  const name = worktree.branch ?? worktree.name;
  return (
    `<span alpha="55%">` +
    `<span font_family="${ICON_FONT_FAMILY}">${Icons.git}</span> ${escapeMarkup(name)}</span>`
  );
}

