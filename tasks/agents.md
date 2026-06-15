# Agents

Architecture plan for the Agents section. The basics (run an agent CLI in a tab,
list/switch them, live status) are done; the open work is depth:

1. **Agent profiles & customization** — named, configurable agent types (command,
   model, tools, prompt…), and first-class support for tools other than `claude`.
2. **Management UX** — close/kill/restart, attention notifications, richer list
   and picker, keybindings.
3. **Git worktree integration** — run an agent in its own worktree, and re-root
   the editor to that worktree when viewing it.

This page covers the architecture; per-feature pages can split out later
(`agents/profiles.md`, `agents/worktrees.md`) if they grow.

## Current state

What already exists and is reused, not rebuilt:

- **Per-person layouts** — `src/ui/Layout.ts` (renamed from `Workbench`) is one
  person's dock frame (left/right/top/bottom/center) plus an `owner` field naming
  its person. **Each person in the LayoutList owns a fully self-contained `Layout`** —
  its own center, its own Files/Source-Control, its own bottom docks. **Nothing is
  shared or reparented across layouts.** `buildLayout(owner)` builds the whole
  `LayoutBundle` (the `Layout` + every per-slot widget) and registers it in
  `AppWindow.bundles` (owner → bundle). `activateLayout(layout)` shows it
  (`overlay.setChild(layout.root)`) and `applyBundle` mirrors that bundle's widgets
  onto the `this.*` fields (`center`/`fileTree`/`gitPanel`/`leftPanel`/the four bottom
  docks/…), so the rest of AppWindow keeps addressing "the active layout" unchanged.
  `saveActiveBundle` writes the mutable bits (`filesTab`/`gitTab`/`bottomDock`) back
  before switching out. `activateOwner(owner)` is the convenience that resolves a
  person → their `Layout`; `cycleLayout(±1)` (bound to `super-,` / `super-.`) steps
  the active layout through `[user, …agents]` (the layout-list order), wrapping.
  Detached layouts stay alive, so a terminal's scrollback /
  open editors survive a switch. An agent's layout opens terminal-only —
  `buildLayout` only `setRight`s Files/Source-Control for the user; an agent's panel
  is still built (so `this.fileTree`/`gitPanel` stay valid and `file-tree:focus`/git
  commands can reveal it) but not shown on open. The terminal auto-opens on creation
  (`openAgent` → `buildLayout(agent)`); `closeAgent` drops its bundle.
  **Worktree-ready:** each agent already has its own Files/Git — a per-worktree
  build just needs a per-bundle root + `GitRepo` in `buildLayout`. **Deferred:**
  per-worktree roots; session restore of agent layouts (only the user layout is
  serialized); per-layout `NotificationLog`/`KeymapPanel` subscribe to global
  signals and aren't disposed on close (minor leak; agents are few).
- **`src/ui/AgentTerminal.ts`** — a `Terminal` subclass that spawns the agent CLI
  (`agent.command` config, default `['claude']`). Notable behaviour:
  - initial title = the agent's program basename until the CLI reports its own
    (OSC) title; `prompt` option appends a launch prompt to argv;
  - on process exit the widget is **not** torn down and the agent/layout is **not**
    closed — it prints a "process exited" notice, flips to `exited`, and stays
    listed; the user restarts (`agent:restart`/`r`) or closes (`agent:close`/`X`) it
    from the layout list when done;
  - **live status** (`idle | working | waiting | exited`, via `status` /
    `onDidChangeStatus`): for a `claude` agent it injects a per-session
    `--settings` block whose **hooks** write a status word to a file the terminal
    watches with a `Gio.FileMonitor`. Reporter: `assets/hooks/agent-status.sh`.
    `UserPromptSubmit`/`PreToolUse`→working, `Notification`→waiting/idle,
    `Stop`/`SessionStart`→idle.
- **`src/AgentManager.ts` — `quilx.agents`** — the registry: `add`/`remove`/
  `getAgents` (launch order) + `onDidAddAgent`/`onDidRemoveAgent`.
- **`src/ui/LayoutList.ts`** — the contents of the **LayoutSidebar** (the
  full-height column at the very left of the window, outside/left of the header
  bar; AppWindow wraps everything in a top-level horizontal `Gtk.Paned` —
  `sidebarSplit` — whose start child is the sidebar). Each entry is (will be)
  associated with a particular **workbench layout**: the first ("default",
  selected-by-default) row is the **user** (person glyph + name, as a pseudo-agent
  — `onActivateUser`), the rest are the running agents (status indicator + title +
  changed-files badge). **Never empty** (the user row is always present → no empty
  state); every row is one header-bar tall. Its top is an `Adw.HeaderBar` (themed
  to match the window header bar) whose only content is a flat **logo button**
  (a square placeholder glyph for now — will become the real logo — styled like the
  git branch button) that collapses the sidebar to icons-only / expands to
  icons+text — the width change is applied by the host via `onToggleCollapsed`
  (`sidebarSplit` position between `LAYOUT_SIDEBAR_COLLAPSED_WIDTH` and
  `LAYOUT_SIDEBAR_WIDTH`).
- **`src/ui/AgentPicker.ts`** — fuzzy quick-switcher over running agents, with a
  *Start agent: `<query>`* action that launches a new agent with the typed prompt.
- **`AppWindow`** — `openAgent(prompt?)` / `showAgent` (reattaches a persisted
  widget, gated on `getRoot()` so a desynced tab map can't strand or rip it),
  `agentChildren` (agent → center tab), `agent:new` / `agent:switch` commands,
  focus→`selectAgent`, and retiring an agent from the registry when its **exited**
  tab is closed.

## Constraints carried from the codebase

- **No node I/O on the main path.** Node's `child_process`/promises are starved by
  the GLib main loop; agent processes run in VTE, and any out-of-band git/tooling
  goes through `GitRepo.run`/`runOutput` (`Gio.Subprocess`) or `Gio.FileMonitor`.
- **Strip-only TS** (project memory): no enums, no parameter properties, no
  namespaces.
- **One main component per file** under `src/ui`, camel-cased after the component.
- **Config** via `quilx.config` (scoped, typed, observable, backed by
  `config.json`) — e.g. FileTree's `scope('FileTree').register({...})`.
- **Status is best-effort & claude-specific.** Hooks give working/waiting/idle/
  exited; there is *no* true "thinking" introspection. Non-claude tools get only
  alive/exited unless an adapter is written.

## Feature: agent profiles & customization

Replace the single `agent.command` with **named profiles** (agent *types*), so the
user can keep several configured agents and pick one when starting.

### Config schema (`agent.*`)

```ts
interface AgentProfile {
  name: string;                 // display + list/picker label
  kind?: 'claude' | 'generic';  // drives status integration (default inferred from command[0])
  command: string[];            // argv; default ['claude']
  description?: string;
  cwd?: string;                 // default: session cwd (see worktrees)
  env?: Record<string, string>;
  // claude-kind extras, translated to flags / --settings:
  model?: string;               // --model
  allowedTools?: string[];      // --allowed-tools
  permissionMode?: string;      // --permission-mode
  appendSystemPrompt?: string;  // --append-system-prompt
  addDirs?: string[];           // --add-dir
}
agent.profiles: AgentProfile[]   // new
agent.default: string            // profile name to use when unspecified
agent.command: string[]          // kept as a back-compat shorthand → a synthetic default profile
```

`resolveAgentCommand()` grows into a profile resolver. `buildStatusIntegration`
stays, gated on `kind === 'claude'` (or `basename(command[0]) === 'claude'`).
A `buildClaudeArgs(profile)` turns the claude extras into flags, merged with the
status `--settings` (claude lets later `--settings`/flags compose).

### Other tools than claude

`AgentTerminal` already runs arbitrary argv. The only claude-specific piece is the
hook-based status. So:

- **Generic kind** → no status hooks; status is just `working` (alive) vs `exited`
  — or stays a single neutral state. (We *could* still infer "waiting for input"
  for some tools later via heuristics, but not in the MVP.)
- Keep status reporting behind an **adapter seam**: today one `ClaudeStatusAdapter`
  (hooks + file watch). A second adapter (e.g. a tool that emits OSC/title states,
  or writes its own status file) can be slotted in by `kind` without touching the
  UI, which only sees `status` / `onDidChangeStatus`.

### UI

- The **picker/starter** gains a profile step: either a two-stage pick (choose
  profile → type prompt) or a prefix in the existing entry (`@review fix the bug`).
  Simplest first: a `agent:new` variant per profile, plus the default on `space a`.
- Optionally a small **config editor** entry (there is already `ConfigEditor`) —
  profiles are just `config.json`, so this is free to start.

## Feature: management UX

Concrete, mostly small additions on top of what exists:

- **Lifecycle commands** (registered on `AgentList` / `AppWindow`, bound centrally):
  - `agent:kill` — terminate the process (SIGTERM the VTE child) but keep the
    widget (it flips to `exited`).
  - `agent:close` — close the tab; if exited, retire from the registry (today's
    behaviour) — also expose it as an explicit command/row action.
  - `agent:restart` — respawn an exited (or running, after confirm) agent with the
    same profile/cwd; reuse the row.
  - `agent:reveal` / `agent:focus-next` / `agent:focus-prev` — navigation.
- **Attention notifications** — the high-value win now that status exists: when an
  agent transitions to **waiting** (needs permission) or **working→idle**
  (finished) while its tab is **not focused**, post a `quilx.notifications` event
  ("Agent *name* needs permission" / "…finished"). Add an **attention badge/count**
  on the AgentList header (number of `waiting` agents).
- **List ergonomics** — vim bare-key bindings while `#AgentList` is focused
  (`j`/`k` move, Enter reveal, `x` close, `r` restart), mirroring FileTree; hover
  action buttons on rows.
- **Rename** — *done*: `AgentTerminal.rename()` pins a display name over the CLI's
  reported title (`renamed` reports whether pinned); `agent:rename` prompts via the
  picker (the `R` key in the list).
- **Tab affordance** — *done*: the agent's tab title is prefixed with a status glyph
  (`agentTabTitle` in AppWindow), refreshed on status change; mirrors the sidebar
  indicator, sans colour.

## Feature: resume / persist conversations

Claude Code stores every session as a JSONL transcript at
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` (the dir name is the cwd with
`/` and `_` → `-`). A session is resumed with `claude --resume <id>` (or
`--continue` for the latest); `--fork-session` branches a copy instead of
appending. These compose with our `--settings` block, so status hooks keep working.

**Built (`src/agentSessions.ts`, `AgentTerminal`, `AppWindow`):**

- **Capture** — the hook reporter writes the live `session_id` (present in every
  hook payload) to `<statusFile>.session`; `AgentTerminal.sessionId` reads it.
- **Enumerate** — `listAgentSessions(cwd)` reads the transcript dir: filename → id,
  mtime → last activity, first `type:"user"` line → label. Newest first. Only the
  head of each transcript is read (cheap). All format-parsing is isolated here, as
  the JSONL format is Claude Code's internal one (subject to change).
- **Resume** — `AgentTerminal` takes a `resume: { sessionId? | continue?; fork? }`
  option → prepends `--resume <id>` / `--continue` (+ `--fork-session`) to the
  claude argv. Commands: `agent:resume` (a picker of past sessions, excluding any
  currently live, label + relative time → `space a r`) and `agent:continue`
  (`space a c`).
- **Persist across editor restarts** — `AgentTerminal.serialize()` now records
  `sessionId`; the (Session-management-owned) restore can relaunch a saved agent as
  `--resume <id>` to continue the conversation rather than start fresh. The
  `TabState` agent variant gained an optional `sessionId`.

**Open**: surface session branch/cost in the resume list; resume-with-prompt;
offer fork on resuming a *live* session; honor `cleanupPeriodDays` (transcripts are
pruned after ~30 days).

## Feature: reviewing an agent's work

Goal: let the user review **what one agent changed** — while it works (ongoing) or
after (past). The obstacle: a working tree shared by several agents (the main
folder, *or a worktree that hosts more than one agent* — see below) mixes
everyone's edits, so a plain `git diff` can't attribute a change to one agent.
Per-agent attribution is therefore the **primary** mechanism, needed even when
worktrees are in play. (Observed usage: parallel agents mostly edit **disjoint**
areas, so attribution-without-full-isolation is good enough for the common case.)

### Per-agent baselines (the attribution mechanism)

Capture each agent's "before" so its diff is well-defined:

- A `PreToolUse` hook on `Edit/Write/MultiEdit/NotebookEdit` copies the target
  file's *current* content into `<statusFile>.baseline/<encoded-path>` the **first**
  time this agent touches it — "the file as it was right before agent A started."
  Pairs with the existing `PostToolUse` → `.files` log (the touched set / "after").
- Agent A's change to a file = `diff(baseline, current)`. Tool-agnostic and under
  our control. (Claude keeps its own snapshots under `~/.claude/file-history/`, but
  it's internal/undocumented — at most a fallback for resumed sessions with no
  baseline.)
- Works in **any** tree, which is why it's primary: a worktree can hold several
  agents, so the worktree's own `git diff` ≠ a single agent's work.

### Review UI

- An **"Agent Changes" panel** — a `LocationList`-style list (like Diagnostics) of
  the agent's changed files with ± counts; selecting one opens its diff. The "✎ N"
  badge / `o` key graduates from "open the files" to "review the changes."
- A **diff view** per file (`baseline → current`): next/prev change, optionally
  per-hunk accept / revert.
- **Depends on the editor Diff renderer** (`code-editing/diff.md`, not built yet) —
  that's the rendering substrate. Sequence: diff display → agent review.

### Ongoing vs past

- **Ongoing**: a `Gio.FileMonitor` (reuse the `.files` watch) keeps the diff live as
  the agent edits.
- **Past**: baselines persist after the process exits (cleaned with `.files` /
  `.session` when the agent is retired), so a finished agent stays reviewable.
  Resumed sessions with no baseline fall back to claude's file-history or `git diff`.

### Parallel agents in one tree

- **Disjoint files** (the common case) → clean per-agent diffs, nothing more needed.
- **Overlap** (two live agents edit the same file): compare agents' `changedFiles`
  sets and **flag the overlap** in the agent list — attribution muddies and the
  agents can stomp each other. True isolation for that case = worktrees (below).

## Feature: git worktree integration

Goal: let agents run in **worktrees** (not only the main folder) so a group of
related agents shares an isolated branch, and "viewing an agent" can re-root the
editor to its worktree. **A worktree is its own axis, N:1 with agents — more than
one agent can run in the same worktree.** So a worktree gives *isolation between
worktrees*, while telling agents apart *within* a worktree still relies on the
per-agent baselines above.

### Backend (`GitRepo`)

Add worktree ops (subprocess, like the rest of mutating git):

```ts
listWorktrees(): { path: string; branch: string; head: string }[]; // `git worktree list --porcelain`
addWorktree(path: string, branch: string, onDone): void;           // run(['worktree','add', ...])
removeWorktree(path: string, onDone): void;                        // run(['worktree','remove', ...])
```

### Association & lifecycle

- An agent launch picks a worktree — an **existing** one or a **new**
  `<repo>/.quilx/worktrees/<name>` on a new branch (e.g. `agent/<name>`) — and the
  agent's `cwd` is set to it. Several agents may target the same worktree.
- The agent carries its `cwd` (already passed to VTE). Track `agent.cwd` so the UI
  can group agents by worktree, show the branch, and so reveal can re-root.
- Review at **two granularities**: the whole worktree's changes (`git diff` of the
  worktree) and one agent's slice within it (per-agent baselines, above).
- Lifecycle is **per worktree, not per agent** (it's shared): only when the **last**
  agent leaves a worktree do we offer **keep / merge / discard** the branch — and a
  worktree with uncommitted/unmerged work is never removed implicitly.

### Re-rooting the editor (the hard part)

Today the editor is single-rooted (`process.cwd()` feeds `FileTree`, `GitRepo`,
`PROJECT_NAME`). Two options:

- **MVP — open the worktree path in the file tree / git** scoped to that agent's
  view, without a full app re-root (e.g. a secondary FileTree root, or a
  "workspace folder" switch). Lowest blast radius.
- **Full — a Workspace/Session concept**: the window holds the active root; viewing
  an agent in another worktree switches the active root (FileTree, GitRepo,
  BranchButton, title) to it. This is really **Session management** (see that task)
  and should be designed with it, not bolted on. Flag the dependency rather than
  duplicating.

This item is the largest and most cross-cutting; recommend it **after** profiles +
UX, and co-designed with Session management.

## More ideas

Backlog beyond the three big features above, roughly in priority order. The first
group builds directly on the change-tracking / transcript plumbing that already
exists, so it's cheap and high-value; the rest are bigger or more speculative.

### Builds on what exists

- **Review an agent's diff** *(recommended next)* — promoted to its own design:
  see **Feature: reviewing an agent's work** above (per-agent baselines + an "Agent
  Changes" diff panel; the attribution mechanism that also works inside a shared
  worktree).
- **Live activity timeline** — a panel that tails the agent's transcript JSONL
  (already parsed by `agentSessions.ts` for resume) into a structured feed: tools
  used, files touched, assistant messages. A readable "what is it doing" view
  without watching the terminal scroll. Live via a `Gio.FileMonitor` on the
  transcript, isolated behind the same format-parsing seam as `agentSessions`.
- **OS notifications** — when an agent goes `waiting` / `working→idle` while the
  **window is unfocused**, fire a desktop `Gio.Notification` (today we only post
  in-app toasts via `notifyAgentAttention`). Gate on window focus; clicking the
  notification reveals the agent (same `reveal` callback).
- **Agent interrupt** — `agent:interrupt`: send ESC / `ctrl-c` to the child to stop
  the current action, a softer alternative to `agent:kill`. Trivial now that the
  modal terminal already sends ESC (`feedChild('\x1b')`); ctrl-c is `feedChild('\x03')`.
- **Jump to an agent's latest edit** — open the file the agent last touched **at the
  exact line** (not just the file). Needs the hook to record a position alongside the
  path in `<statusFile>.files` (e.g. the edit's first changed line), surfaced via the
  `o` action / a dedicated command.

### Bigger / speculative

- **Cost / context meter** — the claude `statusLine` JSON exposes `cost` and
  `context_window.used_percentage`; a second `--settings` `statusLine` hook could
  surface a per-agent cost/▮ context gauge in the row. (Deferred a couple of times;
  small and self-contained when picked up.)
- **Orchestration** — multiple agents on one task, or a "lead"/"review" agent
  watching another's diff. Speculative; out of scope until the basics are deep.

Done (moved out of ideas): **send-to-agent** (selection/file → current / picked /
new agent), **resume past conversations** (see the feature above), **file-change
awareness** (a `PostToolUse` Edit/Write/MultiEdit/NotebookEdit hook appends the
edited path to `<statusFile>.files`; `AgentTerminal.changedFiles` /
`onDidChangeFiles` watch it; the agent list shows a clickable "✎ N" badge whose
click — or the `o` key / `agent:open-changes` — opens the edited files, one
directly or several via a newest-first picker; each edit also triggers an immediate
`GitRepo.refresh()`), and **modal terminal input** (normal/insert via a focusable
container that steals focus from the Vte; see index.md).

## Shared concerns

- **Status is the spine.** Everything (dot, tab, notifications, badge) reads
  `AgentTerminal.status` / `onDidChangeStatus`; no parallel state.
- **Refresh** via the manager's events (`onDidAddAgent`/`onDidRemoveAgent`) + each
  agent's `onDidChangeStatus`; no manual cross-component pokes.
- **Feedback** through `quilx.notifications`, consistent with git ops.
- **Commands first, bindings central** (`src/keymaps/default.ts`), vim bare keys
  while the panel is focused — like FileTree.
- **Destructive ops** (kill, worktree discard) confirm first, never implicit.
- **Claude specifics stay isolated** behind the status adapter / arg builder, so
  the manager, list, and picker remain tool-agnostic.

## Phasing

- [ ] Profiles: `AgentProfile` config schema + resolver; back-compat with
      `agent.command`; `kind`-gated status integration
- [ ] Claude arg builder (model / tools / permission-mode / system-prompt) merged
      with the status `--settings`
- [ ] Picker/starter: choose a profile when launching
- [ ] Attention notifications (waiting / finished while unfocused) + header badge
- [x] Lifecycle commands: kill / close / restart / focus-next/prev (+ bindings,
      per-row hover actions)
- [x] Status in the tab title; rename
- [x] File-change awareness (PostToolUse hook → `.files`; agent-list badge)
- [ ] Editor Diff renderer (`code-editing/diff.md`) — substrate for review (blocks below)
- [ ] Review work: per-agent baselines (PreToolUse snapshot → `.baseline/`); "Agent
      Changes" diff panel (baseline → current); live (FileMonitor) + post-exit
- [ ] Overlap warning when two live agents edit the same file (compare `changedFiles`)
- [ ] `GitRepo` worktree ops (list / add / remove)
- [ ] Run agents in a worktree (cwd + branch; **N agents per worktree**; per-worktree
      keep/merge/discard when the last agent leaves)
- [ ] Re-root editor to a worktree (MVP scoped view; full re-root with Session
      management) + per-worktree vs per-agent (baseline) review granularity

## Open questions

- **Profile selection UX**: two-stage picker (profile → prompt) vs an `@profile`
  prefix in the prompt entry vs per-profile `agent:new:<name>` commands?
- **Generic-tool status**: leave non-claude agents at alive/exited, or attempt a
  generic "waiting for input" heuristic (PTY idle / prompt detection)?
- **Worktree re-rooting**: secondary scoped root (cheap) vs full window re-root
  (needs Session management) — how independent should an agent's view be?
- **Review granularity inside a shared worktree**: N agents per worktree means the
  worktree's `git diff` mixes them — is the default review view the *worktree* diff,
  the *per-agent* (baseline) diff, or both side by side? Baselines are the precise
  per-agent answer; the worktree diff is the "what's the net state" answer.
- **Baseline cost**: snapshot-on-first-edit (`PreToolUse` copy) is cheap per file
  but unbounded across a long session — cap by count/size, or rely on git for large
  files? And dedupe baselines when several agents share a worktree + file.
- **Kill semantics**: SIGTERM the VTE child directly, or `claude`-aware graceful
  shutdown? And should closing a *running* agent's tab ever kill it, or always
  detach (today) and require explicit `agent:kill`?
- **Rename vs CLI title**: when the user renames, does the agent's reported (OSC)
  title still override, or is the manual name pinned?
