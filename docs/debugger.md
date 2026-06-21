# Debugger (DAP)

> Idea — not started.

A debugger built on the **Debug Adapter Protocol** (DAP), mirroring the LSP
architecture (per-adapter lifecycle, plugin-contributed adapter defs, install
seam). It reuses the **Locator** from [tasks-and-runners.md](tasks-and-runners.md):
the same `(task) → exec config` resolution yields a *debug* config
(program/args/cwd/env), so detection stays toolchain-agnostic and adapters are
plugin contributions.

## Planned

- DAP client + per-(adapter, root) session lifecycle (launch/attach,
  threads/stackframes/scopes/variables, continue/step/pause).
- Breakpoints in the editor gutter (set/toggle/conditional/logpoints),
  persisted; current-line + exception markers.
- Debug UI — variables/watch/call-stack/breakpoints panels (reuse the
  `LocationList`/panel infra), a debug toolbar, and inline variable values
  (`VirtualText`).
- REPL / debug console; data-tips on hover (reuse the hover card).
- Adapter defs + install (mirror `ServerDef`/`lsp/installer.ts`): e.g.
  `debugpy`, `codelldb`, `js-debug`. `runnables.scm` `@debug` tags + a gutter
  run·debug code lens.
