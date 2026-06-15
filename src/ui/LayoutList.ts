/*
 * LayoutList — the contents of the LayoutSidebar (the full-height column at the
 * very left of the window). Each entry is (will be) associated with a particular
 * workbench layout: the first ("default", selected-by-default) entry is the
 * **user** (rendered as a pseudo-agent), the rest are the running terminal agents
 * (`quilx.agents`). The list is never empty — the user entry is always present —
 * so there is no empty state.
 *
 * The top is an `Adw.HeaderBar` whose only content is a robot **button** that
 * toggles the sidebar between collapsed (icons only) and expanded (icons + text);
 * the host wires the actual width change via `onToggleCollapsed`.
 *
 * Activating an agent entry invokes `onActivate`; the user entry invokes
 * `onActivateUser`. Each agent row shows a status indicator + title + a changed-
 * files badge and stays in sync as agents launch, exit, or rename.
 *
 * The assembled widget (header bar + scrollable list) is exposed via `root`.
 */
import * as Os from 'node:os';
import { Adw, Gtk, Pango } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { ICON_FONT_FAMILY } from '../fonts.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { AgentTerminal } from './AgentTerminal.ts';

const USER_GLYPH = String.fromCodePoint(0xf007); // nf-fa-user (the default/user entry)
// Header logo placeholder (also the collapse toggle): a solid square glyph (so
// width == height) until there's a real logo. `LOGO_SIZE` makes the widget square.
const LOGO_GLYPH = '■'; // U+25A0 black square — placeholder
// Per-row status indicator: a round dot for idle/waiting/exited, nf-md-cog-sync
// while working.
const STATUS_DOT = '●';
const WORKING_GLYPH = String.fromCodePoint(0xf1978);
const CHANGED_GLYPH = String.fromCodePoint(0xf040); // nf-fa-pencil (changed-files badge)

// The per-row status indicator is colored by the agent's state: working (grey
// cog), waiting on the user (warning/amber), idle/ready (success/green), exited
// (muted).
const DOT_CLASSES = ['quilx-agent-working', 'quilx-agent-waiting', 'quilx-agent-idle', 'quilx-agent-exited'];
addStyles(`
  /* Each row is as tall as the header bar (an Adw.HeaderBar is 47px), so the list
     reads as a column of header-height entries. A transparent left border keeps
     the row content from shifting when the active row gains its accent indicator;
     a subtle bottom border separates the rows. */
  #LayoutList list row {
    min-height: 47px;
    border-left: 3px solid transparent;
    border-bottom: 1px solid ${theme.ui.border ?? 'alpha(currentColor, 0.1)'};
  }
  /* The active row is marked by an accent left-border indicator rather than a
     filled background. Force-clear every facet GTK/libadwaita uses to draw the
     selection highlight (background color + image, box-shadow); \`!important\`
     beats the theme's own selection rule. */
  #LayoutList list row:selected {
    color: ${theme.ui.fg ?? '#deddda'};
    background-color: ${theme.ui.bg};
    border-left-color: ${theme.ui.info ?? '#3584e4'};
  }
  /* Logo placeholder (also the collapse toggle): a solid square glyph, accent-
     colored. Swap for the real logo image when there is one. */
  #LayoutList .layoutlist-logo {
    color: ${theme.ui.fg ?? '#deddda'};
  }
  /* Per-row edited-files count — a flat, muted button (click opens the files). */
  #LayoutRow .layoutrow-files {
    min-width: 0;
    min-height: 0;
    padding: 0 2px;
    margin: 0;
    background: none;
    box-shadow: none;
  }
  #LayoutRow .layoutrow-files label {
    color: ${theme.ui.textMuted ?? '#9a9996'};
    font-size: 0.85em;
  }
  #LayoutRow .layoutrow-files:hover label { color: ${theme.ui.fg ?? '#deddda'}; }
  .quilx-agent-working { color: ${theme.ui.textMuted ?? '#9a9996'}; }
  .quilx-agent-waiting { color: ${theme.ui.warning ?? '#e5a50a'}; }
  .quilx-agent-idle    { color: ${theme.ui.success ?? '#2ec27e'}; }
  .quilx-agent-exited  { color: ${theme.ui.textMuted ?? '#9a9996'}; }
`);

export interface LayoutListOptions {
  /** Fired when an agent row is activated (clicked / Enter). */
  onActivate?: (agent: AgentTerminal) => void;
  /** Fired when the default (user) row is activated. */
  onActivateUser?: () => void;
  /** Fired when the robot button toggles collapse; the host resizes the sidebar. */
  onToggleCollapsed?: (collapsed: boolean) => void;
  /** Restart an agent (respawn / resume) — the list's `r` key. */
  onRestart?: (agent: AgentTerminal) => void;
  /** Close an agent (kill if running, then retire) — the list's `X` key. */
  onClose?: (agent: AgentTerminal) => void;
  /** Rename an agent — the list's `R` key. */
  onRename?: (agent: AgentTerminal) => void;
  /** Open the files an agent has edited — the changed-files badge / `o` key. */
  onOpenChanges?: (agent: AgentTerminal) => void;
  /** Display name for the default (user) entry; defaults to the OS username. */
  userName?: string;
}

// A list entry: the always-present user row, or one of the running agents.
type Entry = { kind: 'user' } | { kind: 'agent'; agent: AgentTerminal };

export class LayoutList {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly scrolled: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly options: LayoutListOptions;
  private readonly userName: string;
  // Renders nerd-font glyphs (header robot, user, working cog) in the icon font.
  private readonly iconAttrs: InstanceType<typeof Pango.AttrList>;
  // Entries parallel to the list rows (user first, then agents in launch order).
  private rows: Entry[] = [];
  // The agent whose row is selected (kept stable across rebuilds); null selects the
  // user row by default. Reflects the last-focused agent; see AppWindow.
  private selected: AgentTerminal | null = null;
  // Collapsed = icons only (narrow); expanded = icons + text. Toggled by the
  // header-bar logo button.
  private collapsed = false;
  // Per-row unsubscribes (title + status + files), cleared on every rebuild.
  private rowUnsubs: Array<() => void> = [];
  private readonly subs = new CompositeDisposable();

  constructor(options: LayoutListOptions = {}) {
    this.options = options;
    this.userName = options.userName ?? Os.userInfo().username;

    this.iconAttrs = Pango.AttrList.new();
    this.iconAttrs.insert(Pango.attrFontDescNew(Pango.FontDescription.fromString(ICON_FONT_FAMILY)));

    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.SINGLE);
    this.listBox.on('row-activated', (row: any) => this.activate(this.rows[row.getIndex()]));

    this.scrolled = new Gtk.ScrolledWindow();
    this.scrolled.setChild(this.listBox);
    this.scrolled.setVexpand(true);

    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.root.setName('LayoutList'); // selector identity + CSS (#LayoutList)
    this.registerCommands();
    this.root.append(this.buildHeader());
    this.root.append(this.scrolled);

    // Rebuild the list whenever the global agent set changes.
    this.subs.add(quilx.agents.onDidAddAgent(() => this.rebuild()));
    this.subs.add(quilx.agents.onDidRemoveAgent(() => this.rebuild()));
    this.rebuild();
  }

  /** Whether the sidebar is collapsed (icons only). */
  get isCollapsed(): boolean {
    return this.collapsed;
  }

  // The sidebar header bar: an Adw.HeaderBar (so its height/chrome matches the
  // window header bar beside it) whose only content is a left-aligned logo button
  // — styled flat like the git branch button — that toggles collapse. The logo is
  // a square placeholder for now (no asset yet). `.layout-header` lets the chrome
  // theme the bar.
  private buildHeader(): InstanceType<typeof Adw.HeaderBar> {
    const bar = new Adw.HeaderBar();
    bar.addCssClass('layout-header');
    bar.setShowStartTitleButtons(false);
    bar.setShowEndTitleButtons(false);
    bar.setTitleWidget(new Gtk.Box()); // clear the centered title — logo only

    const logo = new Gtk.Label({ label: LOGO_GLYPH }); // placeholder; swap for the real logo
    logo.addCssClass('layoutlist-logo');
    logo.setValign(Gtk.Align.CENTER);
    logo.setHalign(Gtk.Align.CENTER);
    const button = new Gtk.Button();
    button.setChild(logo);
    button.addCssClass('flat'); // same flat style as the git branch button
    button.setTooltipText('Collapse / expand the sidebar');
    button.on('clicked', () => this.toggleCollapsed());
    bar.packStart(button);
    return bar;
  }

  // Toggle collapsed (icons only) ↔ expanded (icons + text): re-render the rows and
  // let the host resize the sidebar.
  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.rebuild();
    this.options.onToggleCollapsed?.(this.collapsed);
  }

  private rebuild(): void {
    for (const unsub of this.rowUnsubs) unsub();
    this.rowUnsubs = [];

    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }

    // The user entry is always first; agents follow in launch order.
    this.rows = [{ kind: 'user' }, ...quilx.agents.getAgents().map((agent): Entry => ({ kind: 'agent', agent }))];
    for (const entry of this.rows) {
      this.listBox.append(entry.kind === 'user' ? this.buildUserRow() : this.buildAgentRow(entry.agent));
    }

    this.applySelection();
  }

  // A row box carrying the #LayoutRow identity. When collapsed it holds only the
  // leading icon; expanded, the icon plus the supplied trailing widgets.
  private rowBox(icon: InstanceType<typeof Gtk.Widget>, ...trailing: InstanceType<typeof Gtk.Widget>[]): InstanceType<typeof Gtk.ListBoxRow> {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    box.setName('LayoutRow');
    box.append(icon);
    if (!this.collapsed) for (const w of trailing) box.append(w);
    const row = new Gtk.ListBoxRow();
    row.setChild(box);
    return row;
  }

  // The default row: the user, rendered like an agent — a person glyph + name.
  private buildUserRow(): InstanceType<typeof Gtk.ListBoxRow> {
    const icon = new Gtk.Label({ label: USER_GLYPH });
    icon.setAttributes(this.iconAttrs);
    const label = new Gtk.Label({ label: this.userName, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    return this.rowBox(icon, label);
  }

  private buildAgentRow(agent: AgentTerminal): InstanceType<typeof Gtk.ListBoxRow> {
    // Status indicator: a colored dot, or the cog glyph while working. Shown in
    // both modes; kept in sync.
    const dot = new Gtk.Label({ label: STATUS_DOT });
    this.applyStatus(dot, agent);
    this.rowUnsubs.push(agent.onDidChangeStatus(() => this.applyStatus(dot, agent)));

    if (this.collapsed) return this.rowBox(dot); // icon only

    const label = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    label.setText(agent.title);
    this.rowUnsubs.push(agent.onTitleChange(() => label.setText(agent.title)));

    // Changed-files badge (pencil + count) — a flat button that opens the edited
    // files; hidden until the agent edits one.
    const filesLabel = new Gtk.Label({ useMarkup: true });
    const files = new Gtk.Button();
    files.setChild(filesLabel);
    files.addCssClass('flat');
    files.addCssClass('layoutrow-files');
    files.setCanFocus(false);
    files.on('clicked', () => this.options.onOpenChanges?.(agent));
    const updateFiles = () => this.applyFiles(files, filesLabel, agent);
    updateFiles();
    this.rowUnsubs.push(agent.onDidChangeFiles(updateFiles));

    return this.rowBox(dot, label, files);
  }

  // Activate an entry: reveal the agent's terminal, or run the user action.
  private activate(entry: Entry | undefined): void {
    if (!entry) return;
    if (entry.kind === 'user') this.options.onActivateUser?.();
    else this.options.onActivate?.(entry.agent);
  }

  // --- Keyboard navigation (vim bare keys while #LayoutList is focused) --------

  private registerCommands(): void {
    quilx.commands.add(this.root, {
      'core:down': () => this.moveSelection(1),
      'core:up': () => this.moveSelection(-1),
      'core:top': () => this.selectIndex(0), // `g g`
      'core:bottom': () => this.selectIndex(this.rows.length - 1), // `G`
      'core:right': () => this.activate(this.selectedEntry()), // reveal the selection
      // Lifecycle on the selected row (a no-op on the user row).
      'agent:restart': () => this.withSelectedAgent((a) => this.options.onRestart?.(a)),
      'agent:rename': () => this.withSelectedAgent((a) => this.options.onRename?.(a)),
      'agent:close': () => this.withSelectedAgent((a) => this.options.onClose?.(a)),
      'agent:open-changes': () => this.withSelectedAgent((a) => this.options.onOpenChanges?.(a)),
    });
  }

  private selectedEntry(): Entry | undefined {
    const row = this.listBox.getSelectedRow();
    return row ? this.rows[row.getIndex()] : undefined;
  }

  // Run `fn` with the agent of the currently selected row, if it's an agent row.
  private withSelectedAgent(fn: (agent: AgentTerminal) => void): void {
    const entry = this.selectedEntry();
    if (entry?.kind === 'agent') fn(entry.agent);
  }

  private moveSelection(delta: number): void {
    const selectedRow = this.listBox.getSelectedRow();
    const current = selectedRow ? selectedRow.getIndex() : -1;
    this.selectIndex(current + delta);
  }

  // Select (and scroll/focus) the row at `index`, clamped into range.
  private selectIndex(index: number): void {
    if (this.rows.length === 0) return;
    const clamped = Math.max(0, Math.min(index, this.rows.length - 1));
    const row = this.listBox.getRowAtIndex(clamped);
    if (row) {
      this.listBox.selectRow(row);
      row.grabFocus();
    }
  }

  /** Move keyboard focus into the list (so its scoped bindings apply and the
   *  pane-navigation commands see focus as being within the layout list). */
  focus(): void {
    const row = this.listBox.getSelectedRow() ?? this.listBox.getRowAtIndex(0);
    if (row) row.grabFocus();
    else this.listBox.grabFocus();
  }

  /** Select the row for `agent`, or the default user row when `null`. Called when
   *  an agent gains/loses focus. */
  selectAgent(agent: AgentTerminal | null): void {
    this.selected = agent;
    this.applySelection();
  }

  // Reflect `this.selected` onto the list box (the user row when nothing is
  // selected, so a default entry is always highlighted).
  private applySelection(): void {
    const index = this.selected
      ? this.rows.findIndex((e) => e.kind === 'agent' && e.agent === this.selected)
      : 0; // the user row
    const row = this.listBox.getRowAtIndex(index >= 0 ? index : 0);
    if (row) this.listBox.selectRow(row);
  }

  // The changed-files badge: a pencil glyph + count, or hidden when none. The
  // glyph is rendered in the icon font via a markup span; the tooltip lists names.
  private applyFiles(
    button: InstanceType<typeof Gtk.Button>,
    label: InstanceType<typeof Gtk.Label>,
    agent: AgentTerminal,
  ): void {
    const changed = agent.changedFiles;
    if (changed.length === 0) {
      button.setVisible(false);
      return;
    }
    button.setVisible(true);
    label.setMarkup(`<span font_family="${ICON_FONT_FAMILY}">${CHANGED_GLYPH}</span> ${changed.length}`);
    const names = changed.map((path) => path.split('/').pop() ?? path);
    button.setTooltipText(`Edited ${changed.length} file${changed.length === 1 ? '' : 's'} — click to open:\n${names.join('\n')}`);
  }

  private applyStatus(dot: InstanceType<typeof Gtk.Label>, agent: AgentTerminal): void {
    for (const cls of DOT_CLASSES) dot.removeCssClass(cls);
    dot.addCssClass(`quilx-agent-${agent.status}`); // idle | working | waiting | exited
    // Working shows the cog glyph (icon font); the rest show the plain dot.
    if (agent.status === 'working') {
      dot.setText(WORKING_GLYPH);
      dot.setAttributes(this.iconAttrs);
    } else {
      dot.setText(STATUS_DOT);
      dot.setAttributes(null);
    }
  }

  dispose(): void {
    for (const unsub of this.rowUnsubs) unsub();
    this.rowUnsubs = [];
    this.subs.dispose();
  }
}
