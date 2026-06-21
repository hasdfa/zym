/*
 * agents/actions.ts — the tool-agnostic vocabulary for agent-defined "runnable
 * actions": a label + a shell command the agent registers when it finishes work
 * the user should run, test, or review outside the chat (start the dev server,
 * run the suite, open the app). The editor surfaces them as buttons in the
 * conversation and as editor commands (`agent:action-run-default` / picker).
 *
 * The agent registers them by calling the bundled bridge MCP tool `set_actions`
 * (assets/mcp/zymBridge.mjs), which writes the raw JSON to an IPC file; both
 * agent hosts (claude-tui's `ClaudeSession`, claude-sdk's `SdkSession`) read that
 * file and `parseActions` it into the normalized shape below before surfacing it.
 * The first action is the default (no explicit flag).
 */

/** A runnable action an agent has registered with the editor. */
export interface AgentAction {
  /** Stable id (slug of the label), used by the run commands and dedup. */
  id: string;
  /** Short button / command label. */
  label: string;
  /** The shell command the editor runs in the agent's worktree. */
  command: string;
  /** Where the command runs: `true` (default) opens a terminal tab; `false` runs
   *  it as a background process the button can stop (no terminal widget). */
  terminal: boolean;
}

/**
 * Normalize whatever the `set_actions` tool wrote (an array, or `{ actions: […] }`)
 * into a validated `AgentAction[]`: each entry needs a non-empty `label` and
 * `command`; ids are slugified from the label (deduped with a numeric suffix). The
 * first action is the default. A malformed / empty payload yields an empty list.
 */
export function parseActions(raw: unknown): AgentAction[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { actions?: unknown }).actions)
      ? (raw as { actions: unknown[] }).actions
      : [];

  const used = new Set<string>();
  const actions: AgentAction[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { label?: unknown; command?: unknown; terminal?: unknown };
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    const command = typeof e.command === 'string' ? e.command.trim() : '';
    if (!label || !command) continue;
    const id = uniqueId(slugify(label) || 'action', used);
    actions.push({ id, label, command, terminal: e.terminal !== false });
  }
  return actions;
}

/** The default action of a set — the first one, or null when empty. */
export function defaultAction(actions: readonly AgentAction[] | undefined): AgentAction | null {
  return actions?.[0] ?? null;
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}
