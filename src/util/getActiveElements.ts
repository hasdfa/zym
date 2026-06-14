/*
 * getActiveElements.ts — the focused widget and its ancestor chain.
 *
 * Ported from xedel's utils/get-active-element.js. Returns the currently focused
 * widget first, then each of its GTK parents up to the window root. Command and
 * keymap lookups walk this list so a binding can target the focused widget or
 * any ancestor.
 */
import type { Gtk } from '../gi.ts';
import { quilx } from '../quilx.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

export function getActiveElements(): Widget[] {
  const activeElement = quilx.window?.getFocus();
  if (!activeElement)
    return [];
  const elements: Widget[] = [activeElement];
  let current: Widget | null = activeElement;
  while (current && (current = current.getParent()) !== null) {
    elements.push(current);
  }

  return elements;
}
