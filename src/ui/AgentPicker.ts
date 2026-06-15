/*
 * Agent picker — a quick-switcher over the running agents (`quilx.agents`).
 * Opens the fuzzy picker over the live agents' titles (with an "exited" marker
 * for finished ones) and invokes `onActivate` with the chosen agent, so the host
 * can reveal and focus its terminal.
 *
 * The agents are snapshotted when the picker opens. Titles aren't unique (two
 * `claude` agents read the same), so each display label is disambiguated and
 * mapped back to its specific agent rather than matched by title.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { proseMarkup } from './proseMarkup.ts';
import { quilx } from '../quilx.ts';
import type { AgentTerminal } from './AgentTerminal.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export interface AgentPickerOptions {
  /** Reveal and focus an existing agent's terminal (or, for send-to, its target). */
  onActivate: (agent: AgentTerminal) => void;
  /** Launch a new agent with the typed prompt. */
  onStart: (prompt: string) => void;
  /** Entry placeholder (e.g. "Send to agent…"). Defaults to "Switch to agent…". */
  placeholder?: string;
}

export function openAgentPicker(host: Overlay, options: AgentPickerOptions): void {
  const byLabel = new Map<string, AgentTerminal>();
  const items: string[] = [];

  for (const agent of quilx.agents.getAgents()) {
    const label = uniqueLabel(byLabel, agentLabel(agent));
    byLabel.set(label, agent);
    items.push(label);
  }

  openPicker({
    host,
    placeholder: options.placeholder ?? 'Switch to agent…',
    items,
    // Agent titles can carry `backtick` spans (claude reports them); render those
    // monospace, the rest as sans prose, with the fuzzy match highlighted.
    formatMain: (item, positions) => proseMarkup(item.text, positions),
    onSelect: (label) => {
      const agent = byLabel.get(label);
      if (agent) options.onActivate(agent);
    },
    action: {
      label: (query) => `Start agent: ${query}`,
      run: (query) => options.onStart(query),
    },
  });
}

/** An agent's display label: its title, with a marker for notable states. */
function agentLabel(agent: AgentTerminal): string {
  const marker =
    agent.status === 'exited' ? ' (exited)' :
    agent.status === 'waiting' ? ' (waiting)' :
    agent.status === 'working' ? ' (working)' : '';
  return `${agent.title}${marker}`;
}

/** Make `label` unique against already-used labels by appending " (2)", " (3)", … */
function uniqueLabel(used: Map<string, unknown>, label: string): string {
  if (!used.has(label)) return label;
  let n = 2;
  while (used.has(`${label} (${n})`)) n++;
  return `${label} (${n})`;
}
