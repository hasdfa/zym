/*
 * ConfigEditor — an Adwaita preferences window over `zym.config`.
 *
 * It reads the live config schema (`schemaEntries()`) and renders one row per
 * parameter, grouped by namespace. Group and row labels are the raw config keys
 * (e.g. `fileTree`, `hideHidden`) rather than prettified names — we value
 * transparency over polished labels (see the README), so what you see is exactly
 * what you write in `config.json`. The widget is chosen
 * from the schema: a boolean is a switch, a number a spin row (bounded by the
 * schema's min/max), an `enum` a combo, a string an entry, and an array/object an
 * entry holding JSON. Editing a row writes through `zym.config.set` and
 * persists via `saveConfig`.
 *
 * The window stays in sync with the config the other way too: each row `observe`s
 * its key, so a live edit to `config.json` (or any other writer) updates the
 * widget. A `syncing` guard makes those programmatic updates skip the widget's
 * own change handler, so the two directions never loop.
 *
 * Opened per invocation via `openConfigEditor` and disposed when closed.
 */
import { Adw, Gtk, type ApplicationWindow } from '../gi.ts';
import { zym } from '../zym.ts';
import { saveConfig } from '../config/load.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { ConfigSchema, ConfigValue } from '../util/Config.ts';

type Row = InstanceType<typeof Adw.PreferencesRow>;

/** Open the preferences window over `parent`. */
export function openConfigEditor(parent: ApplicationWindow): void {
  new ConfigEditor(parent).present();
}

class ConfigEditor {
  private readonly window: InstanceType<typeof Adw.PreferencesWindow>;
  private readonly subs = new CompositeDisposable();
  // True while a row is being updated from a config change, so the widget's own
  // change handler doesn't write back and loop.
  private syncing = false;

  constructor(parent: ApplicationWindow) {
    this.window = new Adw.PreferencesWindow();
    this.window.setTitle('Preferences');
    this.window.setTransientFor(parent);
    this.window.setSearchEnabled(true);
    this.window.setDefaultSize(640, 720);

    this.build();

    this.window.on('close-request', () => {
      this.subs.dispose();
      return false; // let the window close normally
    });
  }

  present(): void {
    this.window.present();
  }

  private build(): void {
    const page = new Adw.PreferencesPage();
    for (const [namespace, entries] of this.groupByNamespace()) {
      const group = new Adw.PreferencesGroup();
      group.setTitle(namespace);
      for (const [key, schema] of entries) group.add(this.buildRow(key, schema));
      page.add(group);
    }
    this.window.add(page);
  }

  // Bucket schema keys by the part before their first dot (their namespace).
  private groupByNamespace(): Array<[string, Array<[string, ConfigSchema]>]> {
    const groups = new Map<string, Array<[string, ConfigSchema]>>();
    for (const [key, schema] of zym.config.schemaEntries()) {
      const dot = key.indexOf('.');
      const namespace = dot === -1 ? 'general' : key.slice(0, dot);
      const list = groups.get(namespace) ?? [];
      list.push([key, schema]);
      groups.set(namespace, list);
    }
    return [...groups.entries()];
  }

  private buildRow(key: string, schema: ConfigSchema): Row {
    if (schema.enum) return this.buildComboRow(key, schema);
    switch (schema.type) {
      case 'boolean':
        return this.buildSwitchRow(key, schema);
      case 'integer':
      case 'number':
        return this.buildSpinRow(key, schema);
      case 'string':
        return this.buildEntryRow(key, schema, false);
      default:
        return this.buildEntryRow(key, schema, true); // array / object as JSON
    }
  }

  private buildSwitchRow(key: string, schema: ConfigSchema): Row {
    const row = new Adw.SwitchRow();
    this.setMeta(row, key, schema, true);
    row.on('notify::active', () => {
      if (this.syncing) return;
      zym.config.set(key, row.getActive());
      saveConfig();
    });
    this.observe(key, (v) => row.setActive(Boolean(v)));
    return row;
  }

  private buildSpinRow(key: string, schema: ConfigSchema): Row {
    const isInt = schema.type === 'integer';
    const lower = schema.minimum ?? (isInt ? -1_000_000 : -1e9);
    const upper = schema.maximum ?? (isInt ? 1_000_000 : 1e9);
    const step = isInt ? 1 : 0.1;
    const adjustment = new Gtk.Adjustment({
      value: Number(zym.config.get(key) ?? 0),
      lower,
      upper,
      stepIncrement: step,
      pageIncrement: step * 10,
    });
    const row = new Adw.SpinRow({ adjustment, digits: isInt ? 0 : 2 });
    this.setMeta(row, key, schema, true);
    adjustment.on('value-changed', () => {
      if (this.syncing) return;
      zym.config.set(key, adjustment.getValue());
      saveConfig();
    });
    this.observe(key, (v) => adjustment.setValue(Number(v ?? 0)));
    return row;
  }

  private buildComboRow(key: string, schema: ConfigSchema): Row {
    const options = schema.enum ?? [];
    const row = new Adw.ComboRow();
    this.setMeta(row, key, schema, true);
    row.setModel(Gtk.StringList.new(options.map((o) => String(o))));
    row.on('notify::selected', () => {
      if (this.syncing) return;
      const i = row.getSelected();
      if (i < 0 || i >= options.length) return;
      zym.config.set(key, options[i] as ConfigValue);
      saveConfig();
    });
    this.observe(key, (v) => {
      const i = options.findIndex((o) => JSON.stringify(o) === JSON.stringify(v));
      if (i >= 0) row.setSelected(i);
    });
    return row;
  }

  private buildEntryRow(key: string, schema: ConfigSchema, json: boolean): Row {
    const row = new Adw.EntryRow();
    this.setMeta(row, key, schema, false); // EntryRow has no subtitle
    row.setShowApplyButton(true);

    const toText = (v: ConfigValue | undefined) =>
      json ? JSON.stringify(v ?? null) : String(v ?? '');

    row.on('apply', () => {
      if (this.syncing) return;
      let value: ConfigValue;
      if (json) {
        try {
          value = JSON.parse(row.getText());
        } catch {
          zym.notifications.addError(`Invalid JSON for ${key}`);
          this.sync(() => row.setText(toText(zym.config.get(key))));
          return;
        }
      } else {
        value = row.getText();
      }
      if (!zym.config.set(key, value)) {
        zym.notifications.addError(`Invalid value for ${key}`);
        this.sync(() => row.setText(toText(zym.config.get(key))));
        return;
      }
      saveConfig();
    });

    this.observe(key, (v) => row.setText(toText(v)));
    return row;
  }

  // Title is the key's last segment verbatim (not prettified — see the README's
  // note on valuing transparency over polished labels); description as tooltip,
  // and as subtitle on rows that support one.
  private setMeta(row: Row, key: string, schema: ConfigSchema, hasSubtitle: boolean): void {
    const dot = key.indexOf('.');
    row.setTitle(dot === -1 ? key : key.slice(dot + 1));
    if (schema.description) {
      row.setTooltipText(schema.description);
      if (hasSubtitle) (row as unknown as { setSubtitle(s: string): void }).setSubtitle(schema.description);
    }
  }

  // Subscribe a row to its key. `observe` fires immediately, so this also seeds
  // the row's initial value. Updates run under the `syncing` guard.
  private observe(key: string, update: (value: ConfigValue | undefined) => void): void {
    this.subs.add(zym.config.observe(key, (v) => this.sync(() => update(v))));
  }

  private sync(fn: () => void): void {
    this.syncing = true;
    try {
      fn();
    } finally {
      this.syncing = false;
    }
  }
}
