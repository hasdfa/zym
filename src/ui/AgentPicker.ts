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
import { quilx } from '../quilx.ts';
import type { AgentTerminal } from './AgentTerminal.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openAgentPicker(host: Overlay, onActivate: (agent: AgentTerminal) => void): void {
  const byLabel = new Map<string, AgentTerminal>();
  const items: string[] = [];

  for (const agent of quilx.agents.getAgents()) {
    const label = uniqueLabel(byLabel, agentLabel(agent));
    byLabel.set(label, agent);
    items.push(label);
  }

  openPicker({
    host,
    placeholder: 'Switch to agent…',
    items,
    onSelect: (label) => {
      const agent = byLabel.get(label);
      if (agent) onActivate(agent);
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
