# Panels & layout

The workbench is a dock layout (`Workbench`, `src/ui/Workbench.ts`) around a
splittable center (`PanelGroup`, `src/ui/PanelGroup.ts`). The shared building
block is `Panel` (`src/ui/Panel.ts`): a tab host (Adw.TabBar + Adw.TabView) with
a friendly empty-state placeholder. Every tab group in the app — the center
editor groups **and** the docks (Files/Source-Control side dock, the bottom
Notifications/Diagnostics/Keybindings docks) — is a `Panel`.

- **`Panel`** — one tab strip. `add(widget, { title?, requireTabBar? })` is the
  *only* way content enters a panel.
- **`PanelGroup`** (center) — a binary tree of `Split` (Gtk.Paned) branches and
  `Leaf`/`Panel` leaves; any split layout is expressible. Splitting/closing
  reshapes the tree; the root leaf may sit empty (shows the placeholder).
  Supports a `pinned` leaf (an agent's terminal) that can't be split or
  collapsed; opens beside it land in the work area (`openPanel` / `ensureWorkArea`).
- **`Workbench`** — fixed dock slots (left/right/top/bottom, nested Gtk.Paned)
  around the center. One Workbench per "person" (the user, each agent); switching
  person swaps which Workbench the window shows (see tasks/agents.md). The
  Files/Source-Control dock lives in the **right** slot — note the misleading
  `leftPanel` field / `revealLeftTab` names, which dock via `setRight`.

## Dock visibility (toggleable docks)

Each dock side is **independently show/hide-able without discarding its panels**.
`Workbench` tracks a side's assigned *content* and its *visibility* separately
(`dockContent` / `dockVisible`); the Paned slot shows the content only when the
side is both occupied and visible, so hiding a dock just detaches its widget
(tabs/state live on inside it) and re-showing re-attaches the same widget.

- API: `setDockVisible(side, visible)` / `toggleDock(side)` (no-op on an empty
  side) / `isDockVisible(side)` / `isDockOccupied(side)` / `dockVisibility()`.
- The content setters (`setLeft/Right/Top/Bottom`) **force the side visible** when
  given non-null content — putting something in a dock means you want to see it —
  so the content pickers (bottom dock notifications/diagnostics/keymap, side-dock
  `revealLeftTab`) need no separate "show" call. The bottom-dock content toggles
  (`toggleNotificationLog`/`toggleDiagnosticsPanel`/`toggleKeymapPanel`) only
  *close* when their panel is the currently-**shown** content; if it's selected but
  the dock was hidden via the visibility toggle, they re-reveal it.
- Commands `dock:toggle-{left,right,top,bottom}` (`ctrl-w g h/j/k/l`, by vim
  direction: h=left, j=bottom, k=top, l=right), handled in
  `AppWindow.toggleDockSide` (focuses into a freshly-shown dock; falls focus back to
  the center when hiding out from under it). Left/top carry no built-in content yet,
  so toggling them is a no-op + toast until a plugin contributes a panel there.
- **Session-persisted**: `SessionDocks.visible` (per-side flags) is saved/restored
  with the rest of the dock state; a toggle schedules an autosave. Sessions from
  before this feature have no `visible` entry and restore all sides shown.

## Active / focus management

Decisions (implemented in `Panel` + `PanelGroup`):

- **One active panel at a time — the one containing keyboard focus.** `Panel`
  owns a single static `activePanel`. Each panel installs an
  `EventControllerFocus` on its root; on `enter` it calls `activate()`, becoming
  the active panel and deactivating the previous one (a leaf *or* a dock). The
  center's `PanelGroup` syncs its active **leaf** via the `onActivate` callback
  (so "where new tabs open" follows focus); docks just flip active state.
- **Overlay exception.** Focus moving onto an overlay (command palette, file
  picker, popover that isn't parented inside a panel) fires no panel's `enter`,
  so the active panel is left unchanged. Activation is `enter`-only — we never
  deactivate on `leave` — which is what gives the exception for free.
- **Panels accept focus on their top-level widget.** `Panel.root` is
  `focusable`, so a panel can take focus and steal the active state even with no
  focusable content (e.g. an empty pane after a split — `focusEmptyState()`
  grabs the root, not the placeholder).
- **`.active-empty` outline = direct keyboard focus on a panel-level widget.**
  Applied (focus-driven, via `updateFocusOutline`) to whichever widget holds
  *direct* focus when that widget is the panel root (empty pane) or a direct
  panel child. Content that delegates focus to a descendant (an editor's view)
  shows its own focus ring and gets no outline. Styled with a thin
  selection-colored outline (`theme.ui.surface.selected`).
- **Every panel child is marked `.is-panel-child`.** `add()` stamps the class on
  every child; it is the sole entry point, so no widget reaches a panel without
  it. Focus/active logic relies on that class to identify direct panel children.
  `Panel.containing(child)` resolves a child back to its panel (a `WeakMap`).

## Tab bar

- Lone-tab is chromeless (tab bar hidden) — we drive `bar.setVisible` manually
  instead of Adw autohide (which animates a revealer). Exception: a child added
  with `requireTabBar: true` (editors) keeps its title shown at all times.
- `bar.setExpandTabs(false)` — tabs size to content (Adwaita caps + ellipsizes)
  rather than stretching to fill the width. The tab bar has a bottom border.

## Dock close behavior & the "zombie" rule

Re-adding a previously-closed widget into an Adw.TabView that is **detached
(unrooted)** yields a blank page (Adw leaves the closed child in a
not-yet-finalized page). The rule: **never `add()` into an unrooted tab view.**

- **Bottom docks (Notifications/Diagnostics/Keybindings)** — single persistent
  views. Each panel's `onTabCloseRequest` (`hideBottomDock`) intercepts the tab
  close to *hide the dock* and veto the page close, so the view never tears down;
  re-toggling (e.g. `space l l` for Diagnostics, `space n` for Notifications)
  re-shows the same widget with no rebuild.
- **Side dock (right Files/Source-Control)** — keeps **per-tab close**. Closing
  the last tab collapses the dock (`leftPanel`'s `onEmpty` → `detachDock` →
  `setRight(null)`). The reveal/focus path (`revealLeftTab`) **re-attaches
  (roots) the panel via `setRight` before re-adding the tab** (unparenting any
  closed page first), so the `add()` always targets a rooted view.
- **Agents** — each agent's terminal is pinned into its own Workbench's center
  (`PanelGroup.pinChild`); the agent tab-close is vetoed and switching person
  just swaps the shown Workbench, so the process keeps running.

## Focus memory

Per-tab focus memory (`AppWindow.focusMemory`, keyed by the `.is-panel-child`
content widget, driven by the window's `notify::focus-widget`): re-activating a
panel restores focus to the exact widget that last held it in that tab (e.g. an
editor's search bar), falling back to the tab's default focus target. Focus on
the tab's own root drops the entry (so restore re-derives from the tab itself).

## Status

- [x] Splittable center tree (`PanelGroup`) with a pinnable agent leaf; dock
  layout (`Workbench`), one per person.
- [x] Single active panel = focus container, with the overlay exception.
- [x] Focus-driven `.active-empty` outline; root-focusable panels.
- [x] `requireTabBar`, non-expanding tabs, tab-bar bottom border.
- [x] Zombie-safe dock close (bottom veto-hide; side per-tab close + safe re-add).
- [x] Per-tab focus memory.
- [x] Toggleable dock visibility (left/right/top/bottom) keeping panels alive,
  session-persisted (see "Dock visibility" above).
