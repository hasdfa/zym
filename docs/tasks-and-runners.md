# Tasks & runners

> Idea — not started.

Run tests/mains/scripts from the editor. Two decoupled layers, modeled on Zed
([syntax-aware tasks](https://zed.dev/blog/zed-decoded-tasks),
[debugger](https://zed.dev/blog/debugger)):

- **Detection** — tree-sitter `runnables.scm` tags runnable nodes
  (`@test`/`@main`); a gutter play-glyph + palette entry, with context vars
  derived from the node.
- **Locator** — a per-language `(task) → (exec config)` mapping that derives the
  concrete command by invoking the build tool (e.g. Cargo
  `--no-run --message-format=json` → artifact path) rather than guessing. This
  keeps detection toolchain-agnostic, fits plugin contribution points, and the
  same seam later yields a *debug* (DAP) config. See [debugger.md](debugger.md).
