/*
 * Command picker — a command palette over the picker UI. Enumerates every
 * command currently available to the focused widget and its ancestors (via the
 * CommandManager), opens the fuzzy picker over their names, and dispatches the
 * chosen command back to the element that offered it.
 *
 * The available commands are snapshotted *before* the picker grabs focus, so the
 * list reflects the context the user was in (the editor, the file tree, …) rather
 * than the picker itself.
 */
import { Gtk } from '../gi.ts';
import { openPicker } from './Picker.ts';
import { getActiveElements } from '../util/getActiveElements.ts';
import { quilx } from '../quilx.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

export function openCommandPicker(host: Overlay): void {
  const elements = getActiveElements();
  const commands = quilx.commands.getAvailableCommands(elements);
  // Map each name back to the element it should dispatch to.
  const elementByName = new Map(commands.map((c) => [c.name, c.element]));

  openPicker({
    host,
    placeholder: 'Run command…',
    items: commands.map((c) => c.name).sort(),
    onSelect: (name) => {
      const element = elementByName.get(name);
      if (element) quilx.commands.dispatch(element, name);
    },
  });
}
