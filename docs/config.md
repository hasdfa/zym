# Configuration

The user-facing side (file location, format, the preferences window) is in the
README's [Configuration](../README.md#configuration) section. This page is the
implementation: the store, how the schema is assembled, persistence, and the
settings UI.

## The store — `src/util/Config.ts`

`Config` is a schema-driven key→value store modelled on Atom's `atom.config`.
Every parameter is declared up front as a `ConfigSchema` (`type`, `default`,
optional `enum` / `minimum` / `maximum` / `description`); keys are flat dotted
strings (`editor.tabLength`). The schema is what makes the store more than a
map:

- **Defaults live with the declaration** — `get` returns the explicit value if
  one was `set`, else the schema `default`; `has` tells the two apart; `unset`
  restores the default precisely.
- **`set` coerces and validates** against the schema entry: `"4"`→`4` for an
  integer, `"true"`→`true` for a boolean, numbers clamped to
  `minimum`/`maximum`, values outside an `enum` or of the wrong shape rejected
  (returns `false`, stores nothing). Undeclared keys are stored as-is. See
  `coerce`.
- **Reads/writes are observable** — `observe` fires immediately then on change;
  `onDidChange` fires `{ newValue, oldValue }`. Both return Disposables. This is
  how live config edits propagate to widgets without a restart.

`ScopedConfig` (`config.scope('ns')`) is a namespaced facade: every key is
prefixed with `ns.` so a subsystem works with short keys while values live in
the one shared store. `register(schema)` declares a whole namespace at once.

## Assembling the schema

The schema is built up at startup from several sources, all into the single
`zym.config` instance (`new Config(CONFIG_SCHEMA)` in `src/zym.ts`):

- **Baseline** — `CONFIG_SCHEMA` in `src/zym.ts` (`core.*`, `editor.*`).
- **Subsystems** contribute their own namespaces at load time via
  `zym.config.scope('ns').register({...})` — e.g. `src/ui/FileTree.ts`
  (`fileTree.*`) and the vim layer's `src/ui/TextEditor/vim/settings.ts`
  (`vim-mode-plus.*`).
- **Plugins** add/remove keys on activate/deactivate through
  `PluginContext` (`addSchema` / `removeSchema`), so a key disappears from the
  schema — and the settings UI — when its plugin unloads.

Because the settings UI and `saveConfig` both enumerate `schemaEntries()`, a key
only becomes editable/persistable once something has declared it.

## Persistence & watching — `src/config/load.ts`

`loadConfig()` (called once at startup, returns a Disposable that stops the
watcher):

1. Ensures `$XDG_CONFIG_HOME/zym/config.json` exists (creates the dir, seeds
   `{}` if absent).
2. Reads + applies it, then installs a `Gio` file monitor so later edits
   re-apply live.

- `readConfig` returns `null` on anything wrong (missing, mid-write truncation,
  not a JSON object) so a watch tick simply skips — saves arrive as several
  monitor events (truncate / temp+rename) and re-reading is idempotent.
- `applyConfig` calls `zym.config.set` per key and **tracks which keys took
  effect**; a key present last time but absent now is `unset` back to its
  default. So the file stays the source of truth for *what is overridden*.
- `saveConfig` (used by the settings UI after an edit) writes only keys whose
  value differs from the schema default — resetting a key drops it from the
  file. The monitor then observes the write and re-applies it as a no-op.

## Settings UI — `src/ui/ConfigEditor.ts`

`openConfigEditor(parent)` builds an `Adw.PreferencesWindow` from the live
schema: `schemaEntries()` bucketed by namespace (the part before the first dot)
into `Adw.PreferencesGroup`s, one row per key. The widget is picked from the
schema — `enum`→combo, `boolean`→switch, `integer`/`number`→spin (bounded by
min/max), `string`→entry, array/object→entry holding JSON. Row/group titles are
the raw key segments, not prettified.

Sync is two-way: editing a row writes through `zym.config.set` then
`saveConfig`; each row also `observe`s its key so an external edit (hand-edited
`config.json`, or any other writer) updates the widget. A `syncing` guard makes
programmatic updates skip the row's own change handler so the two directions
don't loop. The whole window's subscriptions are a `CompositeDisposable` torn
down on `close-request`.

## Commands

Registered on `#AppWindow` (`AppWindow.registerConfigCommands`):

- `config:open-editor` — the preferences window (`space , ,`).
- `config:open-as-text` — open `config.json` in an editor tab (`space , c`).
- `keymap:open-as-text` — open the user `keymap.json`, creating it from a `{}`
  seed first (`ensureUserKeymap` in `src/keymaps/load.ts`); `space , k`. See
  [commands-keymaps.md](commands-keymaps.md) for the user keymap layer.
