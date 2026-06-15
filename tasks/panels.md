# Panels & layout

The workbench is a dock layout (`Workbench`) around a splittable center
(`PanelGroup`). The shared building block is `Panel` (`src/ui/Panel.ts`): a tab
host (Adw.TabBar + Adw.TabView) with a friendly empty-state placeholder. Every
tab group in the app — the center editor groups **and** the docks (file/git,
agents, the bottom Notifications/Diagnostics/References docks) — is a `Panel`.

- **`Panel`** — one tab strip. `add(widget, { title?, requireTabBar? })` is the
  *only* way content enters a panel.
- **`PanelGroup`** (center) — a binary tree of `Split` (Gtk.Paned) branches and
  `Panel` leaves; any split layout is expressible. Splitting/closing reshapes the
  tree; the last leaf may sit empty (shows the placeholder).
- **`Workbench`** — fixed dock slots (left/right/top/bottom) around the center.

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
  selection-colored outline (`theme.ui.selectedBg`).
- **Every panel child is marked `.is-panel-child`.** `add()` stamps the class on
  every child; it is the sole entry point, so no widget reaches a panel without
  it. Focus/active logic relies on that class to identify direct panel children.

## Tab bar

- Lone-tab is chromeless (tab bar hidden) — we drive `bar.setVisible` manually
  instead of Adw autohide (which animates a revealer). Exception: a child added
  with `requireTabBar: true` (editors) keeps its title shown at all times.
- `bar.setExpandTabs(false)` — tabs size to content (Adwaita caps + ellipsizes)
  rather than stretching to fill the width.

## Dock close behavior & the "zombie" rule

Re-adding a previously-closed widget into an Adw.TabView that is **detached
(unrooted)** yields a blank page (Adw leaves the closed child in a
not-yet-finalized page; see `showAgent`'s `getRoot()` gate). The rule: **never
`add()` into an unrooted tab view.**

- **Bottom docks (Notifications/Diagnostics/References)** — single persistent
  views. Closing the tab is intercepted (`onTabCloseRequest`) to *hide the dock*
  and veto the page close, so the view never tears down; the toggle re-shows it.
  This fixed reopening an empty bottom dock (`space l l` after `alt-c`).
- **Side docks (left Files/Git, Agents)** — keep **per-tab close**. Closing the
  last tab collapses the dock (`onEmpty` → detach from the left paned). The
  reveal/focus path (`revealLeftTab` / `ensureAgentDock`) **re-attaches (roots)
  the panel before re-adding the tab**, so the `add()` always targets a rooted
  view.
- **Agents in the center** — closing an agent tab keeps the process running;
  `showAgent` re-adds the widget to the always-rooted center, gated on
  `getRoot()`/unparent.

## Focus memory

Per-tab focus memory (`AppWindow.focusMemory`, keyed by the `.is-panel-child`
content widget, driven by the window's `notify::focus-widget`): re-activating a
panel restores focus to the exact widget that last held it in that tab (e.g. an
editor's search bar), falling back to the tab's default focus target.

## Status

- [x] Splittable center tree (`PanelGroup`); dock layout (`Workbench`).
- [x] Single active panel = focus container, with the overlay exception.
- [x] Focus-driven `.active-empty` outline; root-focusable panels.
- [x] `requireTabBar`, non-expanding tabs, tab-bar bottom border.
- [x] Zombie-safe dock close (bottom veto-hide; side per-tab close + safe re-add).
- [x] Per-tab focus memory.
