/*
 * Combobox — a thin reusable wrapper over Gtk.DropDown that maps a list of
 * `{ value, label }` options to a string-valued control: it shows each option's label,
 * returns the selected option's value, and can be re-populated. Two opt-ins:
 *
 *   - `search`: a type-ahead search entry in the popup. Wired *without* a GtkExpression
 *     (node-gtk can't manage one — GtkExpression isn't a GObject): the model is wrapped
 *     in a FilterListModel + CustomFilter, and the dropdown's own search entry drives the
 *     filter via its `search-changed` signal (the approach from
 *     https://discourse.gnome.org/t/example-of-gtk-dropdown-with-search-enabled-without-gtk-expression/12748).
 *   - `specialLabel`: one label rendered with emphasis (the `.combobox-special` accent),
 *     via a list-item factory.
 *
 * The value is resolved from the selected item's *string* (not its index), so it stays
 * correct while the search filter reorders/hides rows.
 */
import { Gtk, Gdk } from '../gi.ts';
import { addStyles } from '../styles.ts';

export interface ComboOption {
  /** Returned by `getValue()` and matched by `value` when (re)selecting. */
  value: string;
  /** Shown in the control and the popup list. */
  label: string;
}

export interface ComboboxConfig {
  options: ComboOption[];
  value: string;
  onChange?: (value: string) => void;
  /** Show a search entry in the popup and filter the list by it. */
  search?: boolean;
  /** Labels rendered with emphasis (the `.combobox-special` accent). */
  specialLabels?: string[];
  /** Labels rendered dimmed (the `.combobox-muted` look). */
  mutedLabels?: string[];
}

// Opacity (not a theme color var) for the muted look, so it also resolves in the
// dropdown's separate popup surface.
addStyles(/* css */`
  .combobox-special {
    color: var(--accent-color);
    font-weight: bold;
  }
  .combobox-muted {
    opacity: 0.55;
  }
`);

export class Combobox {
  readonly widget: InstanceType<typeof Gtk.DropDown>;
  private values: string[] = [];
  private labelToValue = new Map<string, string>();
  private applying = false; // suppress onChange while re-populating
  private base: InstanceType<typeof Gtk.StringList>;
  private readonly filtered: InstanceType<typeof Gtk.FilterListModel> | null = null;
  private query = '';

  constructor(config: ComboboxConfig) {
    this.base = Gtk.StringList.new(config.options.map((o) => o.label));
    if (config.search) {
      this.filtered = Gtk.FilterListModel.new(this.base, null);
      const filter = Gtk.CustomFilter.new((item: any) =>
        this.query === '' || String(item.getString()).toLowerCase().includes(this.query),
      );
      this.filtered.setFilter(filter);
      this.widget = Gtk.DropDown.new(this.filtered, null);
      this.widget.setEnableSearch(true);
      this.wireSearch(filter);
    } else {
      this.widget = Gtk.DropDown.new(this.base, null);
    }
    this.widget.addCssClass('flat');
    this.ingest(config.options);

    const special = new Set(config.specialLabels ?? []);
    const muted = new Set(config.mutedLabels ?? []);
    if (special.size > 0 || muted.size > 0) {
      const factory = new Gtk.SignalListItemFactory();
      factory.on('setup', (li: any) => li.setChild(new Gtk.Label({ xalign: 0 })));
      factory.on('bind', (li: any) => {
        const label = li.getChild();
        const text = (li.getItem() as any).getString();
        label.setText(text);
        label.removeCssClass('combobox-special');
        label.removeCssClass('combobox-muted');
        if (special.has(text)) label.addCssClass('combobox-special');
        else if (muted.has(text)) label.addCssClass('combobox-muted');
      });
      this.widget.setFactory(factory);
    }

    this.selectValue(config.value);
    if (config.onChange) {
      const onChange = config.onChange;
      this.widget.on('notify::selected', () => { if (!this.applying) onChange(this.getValue()); });
    }
  }

  getValue(): string {
    const item = this.widget.getSelectedItem() as any;
    if (item) {
      const v = this.labelToValue.get(item.getString());
      if (v !== undefined) return v;
    }
    return this.values[0] ?? '';
  }

  setOptions(options: ComboOption[], value: string): void {
    this.applying = true;
    this.base = Gtk.StringList.new(options.map((o) => o.label));
    if (this.filtered) this.filtered.setModel(this.base);
    else this.widget.setModel(this.base);
    this.ingest(options);
    this.selectValue(value);
    this.applying = false;
  }

  // Wire the dropdown's built-in search (found by walking the popup): live filtering, plus
  // the keyboard the popup doesn't give us here — Up/Down move the (filtered) selection,
  // Enter accepts + closes, Escape closes (just the popup), and typing a printable key on
  // the closed dropdown opens the popup seeded with that character.
  private wireSearch(filter: InstanceType<typeof Gtk.CustomFilter>): void {
    const entry = findDescendant(this.widget, (w) => w instanceof Gtk.SearchEntry) as
      | InstanceType<typeof Gtk.SearchEntry> | null;
    const popover = findDescendant(this.widget, (w) => w instanceof Gtk.Popover) as
      | InstanceType<typeof Gtk.Popover> | null;
    if (!entry || !popover) return;

    entry.on('search-changed', () => {
      this.query = (entry.getText() ?? '').toLowerCase();
      filter.changed(Gtk.FilterChange.DIFFERENT);
    });
    entry.on('activate', () => popover.popdown()); // Enter: commit the highlighted row

    // Up/Down navigate the filtered list, Escape closes the popup — in the capture phase so
    // they win over the entry's own handling and (for Escape) the surrounding card.
    const nav = new Gtk.EventControllerKey();
    nav.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    nav.on('key-pressed', (keyval: number) => {
      const n = (this.widget.getModel() as any)?.getNItems?.() ?? 0;
      switch (keyval) {
        case Gdk.KEY_Down: case Gdk.KEY_KP_Down:
          if (n > 0) this.widget.setSelected(Math.min(this.widget.getSelected() + 1, n - 1));
          return true;
        case Gdk.KEY_Up: case Gdk.KEY_KP_Up:
          if (n > 0) this.widget.setSelected(Math.max(this.widget.getSelected() - 1, 0));
          return true;
        case Gdk.KEY_Escape:
          popover.popdown();
          return true;
        default:
          return false;
      }
    });
    entry.addController(nav);

    // Typing on the closed dropdown opens the search seeded with that character.
    const typeToSearch = new Gtk.EventControllerKey();
    typeToSearch.setPropagationPhase(Gtk.PropagationPhase.CAPTURE);
    typeToSearch.on('key-pressed', (keyval: number, _keycode: number, state: number) => {
      if (popover.getVisible()) return false; // already open — let the search handle it
      if (state & (Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK)) return false;
      const ch = Gdk.keyvalToUnicode(keyval);
      if (ch < 32 || ch === 127) return false; // not a printable character
      popover.popup();
      entry.grabFocus();
      entry.setText(String.fromCharCode(ch));
      entry.setPosition(-1);
      return true;
    });
    this.widget.addController(typeToSearch);
  }

  private ingest(options: ComboOption[]): void {
    this.values = options.map((o) => o.value);
    this.labelToValue = new Map(options.map((o) => [o.label, o.value]));
  }

  private selectValue(value: string): void {
    const i = this.values.indexOf(value);
    this.widget.setSelected(i >= 0 ? i : 0);
  }
}

// Depth-first search of a widget's descendants (including popups, which are children in
// GTK4) for the first one matching `pred`.
function findDescendant(
  root: InstanceType<typeof Gtk.Widget>,
  pred: (w: InstanceType<typeof Gtk.Widget>) => boolean,
): InstanceType<typeof Gtk.Widget> | null {
  if (pred(root)) return root;
  for (let c = root.getFirstChild(); c; c = c.getNextSibling()) {
    const found = findDescendant(c, pred);
    if (found) return found;
  }
  return null;
}
