# Session management

A *session* is the working state of one project root: which
files/terminals/agents are open, how they're laid out, and where the cursors sit
— distinct from `quilx.config`, which is global app settings. State is persisted
so it can be restored on demand, and unsaved work is never lost on exit.

**Status:** the core is **implemented** — `SessionManager` (`src/SessionManager.ts`,
storage/format, exposed as `quilx.session`) + `SessionController`
(`src/SessionController.ts`, per-window policy), wired from
`src/ui/AppWindow.ts`. See the Phasing checklist at the bottom for what's done vs.
outstanding. The one large unbuilt feature is **named sessions** (its own section
below — all `[ ]`). (Note: `tasks/index.md` still lists this whole section as
unchecked; that index is stale relative to the code and this page.)

This page covers the architecture; per-feature pages can split out later if they
grow.

## Decisions (locked)

These were settled up front and shape everything below:

- **Storage = central XDG state dir**, keyed by root path — *not* in-repo. A
  session lives at `$XDG_STATE_HOME/quilx/sessions/<filename>.json` (falling back
  to `~/.local/state`). Clean, never pollutes the project, and the natural home for
  a future "open another project's session" picker.
- **Naming/identity:** the filename is a **hash of the primary root** unless the
  user gives the session an explicit **name** (then a slug of the name). The hash
  is opaque, so **wherever a text label is needed** (picker, title) and there is no
  user name, show the **primary root's directory basename**, never the raw hash.
  Label resolution: `name ?? basename(primaryRoot)`.
- **Lifecycle is configurable** (`session.*`), with these defaults:
  - **Do not reopen on launch.** Restore is an explicit action (`session:restore`
    / a picker), never automatic. (A `session.restoreOnLaunch` opt-in exists for
    users who want it.)
  - **Autosave silently** (debounced on change + on quit) so a manual restore has
    something to load.
  - **Prompt on exit only if a widget reports modified data.** This requires a
    first-class **modified-status API/hook** that widgets expose (see below) — the
    centerpiece of this work, not an afterthought.
- **An explicit file arg suppresses restore.** `quilx foo.ts` means "just open
  this"; restore never fires implicitly off a launch. Restore is always the user
  asking for it.

## Constraints carried from the codebase

- **Single-rooted today, multi-root-ready format.** `process.cwd()` feeds
  `FileTree`, `GitRepo`, and `PROJECT_NAME`; the app opens one `initialFile`, so the
  MVP runtime is single-root. But the **storage format is shaped for multi-root now**
  (a list of *workspaces* with one active — see below), so adding the active-root
  switch later is a runtime change, not a format migration. The target model is
  agents.md's "the window holds the active root; viewing an agent in another
  worktree switches the active root (FileTree, GitRepo, GitBranchButton, title)" — i.e.
  **one active root at a time, switchable**, not several folders shown at once.
- **Sync `Fs` at startup/save is fine.** The "no node I/O on the main path" rule
  is about async `child_process`/promises starved by the GLib loop; `config/load.ts`
  already does synchronous `Fs.readFileSync`/`writeFileSync` at boot and on save.
  Session storage follows the same pattern.
- **Strip-only TS** (project memory): no enums, no parameter properties, no
  namespaces. The state shapes below are interfaces + discriminated unions.
- **One main component per file** under `src/ui` / `src/`, camel-cased.
- **Atom-derived spine.** `quilx` mirrors `atom`; `Config` mirrors `atom.config`;
  `eventKit` provides `Emitter`/`Disposable`. The serialize/deserialize seam below
  deliberately mirrors Atom's `serialize()` + `atom.deserializers` so the shape is
  familiar to the rest of the code.

## Current state holders (what a session must capture)

- **`PanelGroup` (center)** — the splittable tree: `Split` branches (orientation +
  position) and `Panel` leaves (a tab strip). Tabs host one of:
  - **`TextEditor`** — `currentFile` + cursor/scroll (vim buffer model).
  - **`Terminal`** — a shell; only its `cwd` is meaningful (process can't restore).
  - **`AgentTerminal`** — `command` + `cwd` + launch `prompt`; process relaunch-only.
- **`FileTree` (left dock)** — `rootPath` + which directories are expanded.
- **`AgentManager` (`quilx.agents`)** — the live agent registry.
- **Docks** — notification log visible/hidden; left-paned split position.

AppWindow already holds the maps that tie widgets to tabs (`editors`,
`terminals`, `agentChildren`), so it is the natural orchestrator; `PanelGroup`
owns the split tree, so it owns the layout walk.

## The two seams

### 1. Serialize / deserialize (saving & restoring shape)

A small registry on **`SessionManager` (`quilx.session`)**, mirroring
`atom.deserializers` (actual signatures):

```ts
interface Serializable<T> {
  serialize(): T | null;            // null → "don't persist me" (e.g. an empty tab)
}

// quilx.session
registerDeserializer(kind: string, build: (state: TabState) => unknown | null): Disposable;
deserialize(state: TabState): unknown | null;
```

Leaf widgets (`TextEditor`/`Terminal`/`AgentTerminal`) implement `serialize()`
returning a tagged `TabState`. The widget construction/wiring lives in
`SessionController`'s `deserialize` (file → `createEditorTab`, terminal →
`createTerminalTab`, agent → relaunch via `restoreAgent`), which AppWindow
supplies — keeping claude/agent and editor specifics out of `SessionManager`.

`PanelGroup` owns the tree walk:

```ts
serializeLayout(serializeChild: (w: Widget) => TabState | null): PanelNode;
restoreLayout(node: PanelNode, buildChild: (s: TabState) => RestoredChild | null): void;
```

### 2. Modified-status (the exit prompt)

The locked decision — "prompt on exit only if a widget reports modified data" —
needs widgets to *report* that. A second optional interface, surfaced as a hook
so the exit path doesn't hard-code widget types:

```ts
interface SessionParticipant {
  isModified(): boolean;                 // unsaved/at-risk data?
  getModifiedLabel?(): string;           // for the prompt list, e.g. "foo.ts (unsaved)"
  saveModified?(): Promise<void> | void; // optional "Save all" support
}
```

- **`TextEditor`** → `isModified()` reads the buffer's modified flag (dirty since
  last save); `saveModified()` writes the file when it has a path.
- **`AgentTerminal`** → `isModified()` is true while the agent is **running**
  (`status !== 'exited'`); `getModifiedLabel()` → e.g. `"claude (running)"`. No
  `saveModified` (nothing to flush); on quit the process is killed. It's listed in
  the exit prompt as live work.
- **`Terminal`** (plain shell) → default *not* modified; never blocks exit.

`quilx.session.collectModified()` walks the registered participants; AppWindow's
`close-request` consults it.

## Storage format

Actual shapes (`src/SessionManager.ts`):

```ts
type TabState =
  | { kind: 'file';     path: string; cursor?: [number, number]; scroll?: number; dirty?: boolean }
  | { kind: 'terminal'; cwd: string }
  | { kind: 'agent';    command: string[]; cwd: string; prompt?: string; sessionId?: string };

type PanelNode =
  | { type: 'leaf';  tabs: TabState[]; activeIndex: number }
  | { type: 'split'; orientation: 'horizontal' | 'vertical';
      position: number; start: PanelNode; end: PanelNode };

// One root's working state. A window switches its active root by swapping which
// WorkspaceState is live (re-rooting FileTree/GitRepo/title) — see agents.md.
interface WorkspaceState {
  root: string;                 // the cwd / worktree path
  layout: PanelNode;
  fileTree?: { expanded: string[] };
  agent?: AgentTabState;        // present → this is an agent workbench (relaunch on restore)
}

interface SessionState {
  version: number;              // SESSION_VERSION (currently 1)
  name?: string;                // user-given; absent → label = basename(primaryRoot)
  savedAt: string;              // ISO timestamp, stamped by save()
  workspaces: WorkspaceState[]; // MVP runtime writes one user workspace + one per live agent
  activeWorkspace: number;      // index into workspaces; MVP: 0
  docks?: { notificationLog: boolean; leftSplit?: number };  // window-level, shared
  window?: { width: number; height: number; maximized: boolean };
}
```

`workspaces[0].root` is the **primary root** — the hash source and the default
label. `activeWorkspace` is always 0; the runtime carries no root-switch yet, so
restore rebuilds `workspaces[0]` (the user workspace) and relaunches the rest as
agent workbenches. Layering multi-root on later means: let the active-root switch
swap which workspace drives `FileTree`/`GitRepo`/`GitBranchButton`/title — no
format change.

`SessionManager` resolves the path
(`<state>/quilx/sessions/<slug(name) ?? hash(primaryRoot)>.json`), reads/writes via
sync `Fs` (mkdir -p, atomic temp+rename), and validates `version`. Loading is keyed
by the current root's hash (`load(root)`), so a session is only ever loaded for its
own root — there's no separate cross-root guard yet. The hash keeps filenames short
and avoids path-length limits; the label never shows it (see Naming/identity).

## Lifecycle

- **Autosave** (`session.autosave`, default on): a debounced `saveNow()` on
  layout/tab/cursor changes (hook the same events that already drive the title and
  active-tab sync), plus a final flush in `close-request`.
- **Restore** is explicit: `session:restore` rebuilds the saved layout for the
  current cwd (notifying on anything it had to skip). `session.restoreOnLaunch`
  (default off) lets a bare `quilx` launch auto-restore; an explicit file arg
  always suppresses it.
- **Exit prompt**: `close-request` calls `collectModified()`. If non-empty (and
  `session.promptOnExitWhenModified`, default on), show an `Adw.AlertDialog`
  listing the modified widgets with **Save all / Discard / Cancel**; only proceed
  to `onQuit()` on Save-all (after saves) or Discard. "Save all" only applies to
  participants with `saveModified` (editors); running agents have nothing to save,
  so they're listed for awareness and killed on quit. Today's handler returns
  `false` (allow close) immediately — it becomes: block (`return true`), prompt,
  then quit on confirm.

## Config schema (`session.*`)

```ts
session.autosave: boolean                  // default true
session.restoreOnLaunch: boolean           // default false
session.promptOnExitWhenModified: boolean  // default true
session.autosaveDebounceMs: integer        // default 1000
```

Registered on `quilx.config` like the rest; editable via the existing
`ConfigEditor` for free.

## Commands

- `session:save` — force a save now. **Built** (`space s s`).
- `session:restore` — restore the current cwd's session into the workbench.
  **Built** (`space s r`).
- `session:open` — picker over *all* stored sessions (other roots) — **future**,
  pairs with multi-root.

Handlers on `#AppWindow`; bindings in `src/keymaps/default.ts`.

## Feature: named sessions — NOT IMPLEMENTED (plan)

Goal: let a project keep **several named sessions** and switch between them — e.g.
"review", "feature-x", "debugging" — instead of the single per-root autosave.
Nothing in this section is wired into the runtime yet; the phasing below is all
`[ ]`.

**Storage groundwork already in place** (no format change needed):
`SessionState.name?`; `SessionManager` already keys files by `slug(name)` when
named and `hash(root)` otherwise (`fileName()`, private), and `pathFor()` follows
suit — so a named session writes its own json (and gets its own `<file>.buffers/`
for free). Public helpers `list()`, `label(state)` (= `name ?? basename(root)`),
and `delete(state)` exist. What's missing is the **runtime notion of an active
session name** (no `currentName` anywhere yet) and the commands to drive it.

### The one runtime addition

`SessionController` is keyed only by `root`, so its `serialize()` always writes the
default (hash) file. Add a `currentName: string | null` (null = the default
autosave session): `serialize()` stamps `state.name = currentName ?? undefined`, so
autosave/flush target the *active named* file. Switching sessions sets it.

### Commands (`#AppWindow`, bound in `keymaps/default.ts`)

- `session:save-as` — prose-entry picker for a name → set `currentName`, `saveNow()`
  (writes `<slug>.json`). "Save the current workbench as a named session."
- `session:open` — picker over this root's sessions (`list()` filtered to
  `primaryRoot === cwd`, label + `relativeTime(savedAt)`, default session included
  as its basename). Selecting **switches**: flush the current session first, then
  load + apply the target (same path as `restore`: rebuild user layout, relaunch
  agents, apply docks/window), and set `currentName`. Replace semantics (the locked
  decision), so the previous workbench is torn down.
- `session:rename` — rename the active session (write under the new name, delete the
  old file + its `.buffers`, update `currentName`).
- `session:delete` — pick a session → `delete()` it (+ its buffer dir); refuse/guard
  deleting the active one (or switch to default first).

### Decisions to settle

- **Default ↔ named relationship:** the unnamed hash session is the implicit
  autosave; `save-as` forks the current state into a named file and makes it active
  (the default file stays as-is). Confirm fork-vs-move.
- **Switching with live agents:** replace semantics tears down the current
  workbench — running agents in the old session are closed (consistent with
  `closeAgent`). Confirm vs. carry-over.
- **Scope of `session:open`:** **this root only** for named sessions (no window
  re-root). Cross-root open (other projects) stays the separate multi-root item
  below — it needs the active-root switch (now cheap given per-workbench cwd/git).
- **Remember active across launches:** optionally persist the last-active session
  name (tiny window-state) so a relaunch reopens it; MVP launches the default.

### Phasing

- [ ] `currentName` in `SessionController` (serialize stamps `name`; save/flush target
      the named file); `session:save-as` + `session:rename`.
- [ ] `session:open` picker (this root) → flush-then-switch (reuse the restore path).
- [ ] `session:delete` + active-session guard; (later) persist last-active across launches.
- [ ] Cross-root `session:open` — folds into the multi-root item below.

## Edge cases

- **Missing files** on restore → skip the tab, aggregate into one notification
  ("N files no longer exist"). Never block the restore.
- **Cursor out of range** (file shrank on disk) → clamp to the buffer's bounds.
- **Unsaved buffer *contents*** are now persisted: a per-session buffer cache
  (`<sessionfile>.buffers/<sha1(path)>`, `SessionManager.writeBuffers`/`readBuffer`)
  stores modified editors' text on each save; restore reopens dirty tabs from the
  cache and re-marks them modified (`Document.restoreUnsaved`). Path + cursor +
  scroll are stored regardless; the exit prompt remains the guard for unwritten work.
- **Agents** are recorded as their own workspaces (one `WorkspaceState` per agent
  workbench, marked by an `agent` field — its relaunch identity from
  `AgentTerminal.serialize`) after the primary (user) workspace. On **restore** each
  is relaunched **resumed** (`--resume <id>`, via `resumeOptions`), which also
  restores its worktree (see agents.md) and does *not* re-run the original launch
  prompt. Relaunch is fine here because restore is explicit (or the opt-in
  `restoreOnLaunch`), not a surprise. An agent with no session id is relaunched
  fresh with its prompt; one already open is skipped (no duplicate). After relaunch,
  the agent's work-area **files are reopened** from its saved layout (rooted in that
  workbench); the work-area *split geometry* isn't preserved (the pinned-agent center
  doesn't fit the generic `restoreLayout` path, so files reopen as a flat strip).
- **Stale/corrupt session file** → warn and ignore (like the config loader); never
  throw, never block startup.
- **Empty/placeholder tabs** serialize to `null` and are dropped.

## Phasing

- [x] `SessionManager` (`quilx.session`): XDG path resolution, versioned read/write
      (atomic), `session.*` config schema, the deserializer registry.
- [x] Serialize seam: `Serializable` on `TextEditor`/`Terminal`/`AgentTerminal`;
      `PanelGroup.serializeLayout`/`restoreLayout`; `FileTree` expansion state.
- [x] Modified-status seam: `SessionParticipant` hook + `collectModified()`; the
      exit-prompt `Adw.AlertDialog` (Save all / Discard / Cancel) replacing the
      immediate quit.
- [x] Lifecycle wiring: debounced autosave + on-quit flush; `session:restore` /
      `session:save` commands + keymap; launch-arg suppresses restore.
      (`SessionController`, wired from `AppWindow`; `space s s` / `space s r`.)
- [x] Cursor save/restore (with clamping) and missing-file skip notifications.
- [x] Scroll save/restore (top visible row → top on restore, deferred via the
      lazy-open pendingScroll path).
- [x] Window geometry (width/height/maximized) in the session; applied pre-`present`
      at launch (GTK4 ignores resize once mapped).
- [x] Unsaved-buffer cache (`<sessionfile>.buffers/`): modified editors' text saved
      on each save; restore reopens dirty tabs from cache, re-marked modified.
- [x] Agents in sessions — each agent workbench serialized as a `WorkspaceState`
      (with an `agent` relaunch identity); relaunched resumed (worktree restored) on
      explicit `session:restore` / `restoreOnLaunch`, deduped against live agents.
      Work-area files are reopened from the saved layout (split geometry not
      preserved).
- [ ] Multi-root sessions + `session:open` picker — co-design with agent worktrees.

## Open questions

None blocking for the built core — the decisions above are settled and shipped.
The remaining design debates (default ↔ named relationship, switching with live
agents, persisting the last-active session) all sit under the unbuilt named-sessions
feature; see "Decisions to settle" there.
