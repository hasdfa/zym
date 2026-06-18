/*
 * Model picker — choose which Claude model to launch an agent with.
 *
 * Shows a short hardcoded list of named model configurations; selecting one
 * calls `onChoose` with extra argv to append to the agent command (e.g.
 * `['--model', 'claude-opus-4-8']`).
 */
import { Gtk } from '../gi.ts';
import { openPicker, highlightMarkup } from './Picker.ts';
import { Icons } from './icons.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

interface ModelConfig {
  /** Short display name shown in the picker. */
  label: string;
  /** One-line description shown in the detail column. */
  detail: string;
  /** Extra argv appended to the agent command (e.g. `--model <id>`). */
  extraArgs: string[];
}

const MODELS: ModelConfig[] = [
  {
    label: 'sonnet',
    detail: 'claude-sonnet-4-6 · fast, balanced',
    extraArgs: ['--model', 'claude-sonnet-4-6'],
  },
  {
    label: 'opus',
    detail: 'claude-opus-4-8 · most capable',
    extraArgs: ['--model', 'claude-opus-4-8'],
  },
];

/** Open a model picker overlay; `onChoose` receives the extra argv for the chosen model. */
export function openModelPicker(host: Overlay, onChoose: (extraArgs: string[]) => void): void {
  const byValue = new Map(MODELS.map((m) => [m.label, m]));

  openPicker({
    host,
    placeholder: 'Choose model…',
    promptIcon: Icons.terminal,
    items: MODELS.map((m) => ({ value: m.label, text: m.label })),
    formatMain: (item, positions) => {
      const m = byValue.get(item.value);
      return {
        main: highlightMarkup(item.text, positions),
        detail: m?.detail ?? '',
      };
    },
    onSelect: (value) => {
      const m = byValue.get(value);
      if (m) onChoose(m.extraArgs);
    },
  });
}
