/*
 * Theme picker — a fuzzy picker over the available themes (the `<name>.json` files
 * next to src/theme/theme.ts). The currently-active theme sorts first and is tagged
 * so it reads as the current choice; the chosen name is handed back to the caller,
 * which persists it to `theme.active`. Themes apply at startup, so the caller toasts
 * a restart hint rather than re-theming in place.
 */
import { openPicker, type PickerItem } from './Picker.ts';
import { Gtk } from '../gi.ts';
import { availableThemes } from '../theme/theme.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/**
 * Open the theme picker. `current` is the active theme name (listed first, tagged
 * `(current)`); `onSelect` is called with the chosen name — including `current`, so
 * the caller can short-circuit a no-op selection.
 */
export function openThemePicker(host: Overlay, current: string, onSelect: (name: string) => void): void {
  // Active theme first, then the rest alphabetically (availableThemes is sorted).
  const names = availableThemes().sort((a, b) => Number(b === current) - Number(a === current));

  const items: PickerItem[] = names.map((name) => {
    const label = name === current ? `${name}  (current)` : name;
    return { value: name, text: label, display: { main: [0, name.length], detail: [name.length, label.length] } };
  });

  openPicker({
    host,
    placeholder: 'Select theme…',
    items,
    onSelect: (name) => onSelect(name),
  });
}
