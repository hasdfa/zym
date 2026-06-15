# Language configuration (grammar + LSP) and the plugin seam

## Context

Language knowledge is currently split and sourced inconsistently:
- `syntax/grammar.ts` — a hardcoded `SPECS` map (extensions → tree-sitter wasm +
  highlights query + fold types).
- `lsp/registry.ts` — **fetches** Helix `languages.toml` at runtime (cached +
  vendored snapshot), parses 155 KB of TOML, and resolves file → server config.

We want grammar **and** LSP config to be plugin-contributed, and to stop
runtime-fetching the LSP config (non-deterministic, network-dependent, decoupled
from the grammars, pulls ~177 irrelevant languages). And one language must
support **different server configs per project** (a JS project on Flow vs one on
tsserver vs Deno).

## Decisions

- **Curated, hand-authored built-in pack** (not a generated Helix dump). Each
  supported language is a small definition we own. (Helix `languages.toml` is a
  *reference* when authoring, not a runtime/generated dependency.)
- **Restructure first**, before more LSP features (code actions etc.), so they
  build on the unified seam.
- **No runtime fetch / no live TOML parse.** Delete `registry.refresh()` + the
  vendored `languages.toml` + `smol-toml`.

## `LanguageRegistry` (core, the plugin seam)

One registry keyed by language id; grammar and servers attach independently
(VSCode-style), so a plugin can contribute any subset.

```ts
registerLanguage({ id, fileTypes, filenames?, globs?, firstLinePattern? })   // detection
registerGrammar(langId, { wasm, highlights, foldTypes?, injections? })       // highlighting
registerServer(langId, ServerDef)                                            // LSP (0..n per language)
```

Resolution API: `languageForPath(path)`, `grammarFor(langId)`,
`activeServers(path)`, plus loaders (`grammar.ts` keeps wasm/query loading but
reads its specs from the registry).

Built-in languages register at startup (`src/lang/builtin/*`) — effectively the
first, in-process "plugin". External plugin *loading* (manifest + per-plugin
asset paths) lands with the broader Plugin-system task; this restructure is its
precursor.

## Multiple server configs per language (per-project selection)

```ts
interface ServerDef {
  name: string;                 // 'flow' | 'tsserver' | 'eslint' | …
  command: string;
  args?: string[];
  initializationOptions?: unknown;
  settings?: unknown;
  roots?: string[];             // ancestor markers → project root + activation
  singleFile?: boolean;         // activate with no root (root = file's dir); default false
  group?: string;               // mutual-exclusion group; highest-priority activated wins
  priority?: number;            // default 0
}
```

`activeServers(file)`:
1. `lang = languageForPath(file)` → candidate servers for the language.
2. Per candidate: walk ancestors for `roots` → `rootDir`; **activated** iff a root
   is found (or `singleFile` with root = file's dir).
3. Within each `group`, keep only the highest-`priority` activated server;
   ungrouped activated servers all stay.
4. → `{ server, rootDir }[]` to spawn/reuse (keyed by `(name, rootDir)`).

Example (`javascript`): flow (`roots:['.flowconfig']`, group `js-types`, prio 20),
tsserver (`roots:['tsconfig.json','jsconfig.json','package.json']`, group
`js-types`, prio 10), deno (`roots:['deno.json']`, group `js-types`, prio 30),
eslint (`roots:['.eslintrc',…]`, no group). → Flow project picks flow; plain
TS/JS picks tsserver; Deno picks deno; eslint runs alongside any. User config
overrides: disable a server, change priority, force one, or add servers.

## Implications for existing LSP code

- **`LspManager.resolve`** changes from "first server of the matched language" to
  `activeServers(file)` → ensure/reuse **each** active server. One document may
  now drive several servers (didOpen/didChange/didSave/didClose to all that are
  open for it).
- **Diagnostics must be namespaced per server.** `DiagnosticsStore` currently
  keys by path and *replaces*; with (e.g.) eslint + tsserver publishing for the
  same file they'd clobber. Re-key by `(serverName, path)` and merge for the
  gutter/squiggles/panel. Requests (hover/definition/references) target a single
  server (the language's primary in its group); only diagnostics merge.

## Migration plan (phased)

1. [x] `src/lang/`: `LanguageRegistry` + `types.ts` + `builtin.ts` (curated
   typescript/tsx; server defs with roots/group/priority — flow/tsserver/deno
   exclusion group + additive eslint) + `languages` singleton. Resolution
   (`languageForPath`, `grammarFor`, `activeServers` with activation + groups +
   priority + injectable `fileExists`). Unit-tested. **Additive — not yet
   consumed** by `grammar.ts`/`LspManager`.
2. [ ] Repoint `grammar.ts` to read grammar specs from the registry (keep
   wasm/query loading + the preload). `langIdForPath` → `languageForPath`.
3. [ ] Repoint `LspManager` to `activeServers(file)`; support multiple active
   servers.
4. [ ] Namespace `DiagnosticsStore` by `(serverName, path)` + merge.
5. [ ] Delete `lsp/registry.ts` fetch/cache + vendored `languages.toml` + `smol-toml`.
6. [ ] User config: `lsp.servers` overrides keep working (now keyed into the
   registry: disable / priority / command / settings / add).

## Open questions

- Group tie-break when several exclusive roots are present: priority (chosen) vs
  most-specific/closest root. Priority + user override should cover it.
- Do requests (hover/def) ever need a non-group "primary"? Start with: the
  highest-priority activated grouped server is primary; ungrouped (linters)
  contribute diagnostics only.
