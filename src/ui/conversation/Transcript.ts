/*
 * Transcript — the scrollable column of conversation "entries" shared by the main
 * AgentConversation and each subagent page (SubagentView). It is the single owner of:
 *   - the entries box,
 *   - the uniform inter-entry spacing (the `.transcript-entry` class, applied
 *     ONLY in appendEntry — so no caller ever repeats the class or its style),
 *   - stick-to-bottom autoscroll.
 *
 * Callers append top-level entries through `appendEntry`; they never touch the box or
 * the class directly.
 */
import Pango from 'gi:Pango-1.0';
import Gtk from 'gi:Gtk-4.0';
import Adw from 'gi:Adw-1';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { addStyles } from '../../styles.ts';
import { clearChildren, setMarkupSafe, escapeMarkup } from '../proseMarkup.ts';
import { describeTool, toolFilePath } from '../toolDisplay.ts';
import { iconSpan } from '../icons.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(/* css */`
  .Transcript {
    font-size: 1.05em;
  }

  .Transcript viewport {
    padding: calc(2 * var(--t-spacing)) 0;
  }

  .Transcript .transcript-entry {
    padding: 0 calc(2 * var(--t-spacing));
    margin-bottom: calc(2 * var(--t-spacing));
  }

  /* Shared tool rows (tool-use / Bash / unknown event): a leading tool icon next to
     a toggle (a flat header button over a collapsible detail). The container owns
     the horizontal padding; the extra left indent nests tool activity under the
     turn. (The toggle/expand styling lives in ToolRow.ts.) */
  .Transcript .transcript-entry-tool {
    padding: 0 calc(2 * var(--t-spacing)) 0 calc(6 * var(--t-spacing));
   }

  /* Consecutive-run groups (collapsed file-tool rows like Read/Write/Edit, and runs
     of subagent spawns): a leading icon + a non-clickable head label, with each item
     stacked to its right. The head + items are all flat buttons, so they share the
     default button padding + metrics and line up. The head reads as a muted title;
     file paths additionally read as links (.transcript-file-path). */
  .Transcript .transcript-file-icon { padding-right: 8px; }
  .Transcript .transcript-file-head { opacity: 0.85; }
  .Transcript .transcript-file-path {
    color: var(--window-fg-color);
    font-family: var(--t-font-monospace-family);
  }
`);

export interface TranscriptOptions {
  /** Cap the entries column to this width (px) via an Adw.Clamp pinned to the left. */
  maxWidth?: number;
}

export class Transcript {
  /** The scrollable root — mount this in the layout. */
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;
  // The vertical column of entries.
  private readonly box: InstanceType<typeof Gtk.Box>;
  // Follow new content to the bottom; released when the user scrolls up, re-armed within
  // REARM_GAP of the bottom (see setupAutoScroll).
  private stickToBottom = true;
  // Set while we pin, so the `value-changed` our pin emits isn't read as a user scroll.
  private pinning = false;
  // Previous value + upper, to tell a user scroll up (value fell, height held) from our
  // own pin and from a clamp on shrinking content.
  private lastValue = 0;
  private lastUpper = 0;
  // Distance from the bottom (px) that still counts as "at the bottom" for re-arming.
  private static readonly REARM_GAP = 16;
  // The open consecutive-run group (collapsed file-tool rows like Read/Write/Edit, or
  // a run of subagent spawns): one leading icon + head, with each call stacked as an
  // item to its right. Keyed so a run of the same `key` extends; any other entry
  // clears it (see appendEntry). `items` is the box new items append into.
  private group: { key: string; items: InstanceType<typeof Gtk.Box> } | null = null;
  // The two vadjustment handlers wired in setupAutoScroll capture `this`; node-gtk roots
  // each behind a Global handle, so an un-disconnected one pins this Transcript (→ its whole
  // entries column) after the conversation closes. `dispose()` severs them. See rule 2.
  private readonly subs = new CompositeDisposable();

  constructor(opts: TranscriptOptions = {}) {
    this.box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });

    let child: Widget = this.box;
    if (opts.maxWidth != null) {
      // Cap the column to a readable measure (GTK CSS has no max-width). halign START
      // pins it left (Clamp centres by default); threshold == max → a hard cap.
      const clamp = new Adw.Clamp();
      clamp.setMaximumSize(opts.maxWidth);
      clamp.setTighteningThreshold(opts.maxWidth);
      clamp.setHalign(Gtk.Align.START);
      clamp.setChild(this.box);
      child = clamp;
    }
    this.root = new Gtk.ScrolledWindow({ vexpand: true });
    this.root.addCssClass('Transcript');
    this.root.setChild(child);
    this.setupAutoScroll();
  }

  /** Append a top-level entry, tagging it with the shared entry class — the single
   *  owner of inter-entry spacing. Used directly only for MESSAGE entries; every
   *  non-message entry goes through appendToolEntry. */
  appendEntry(widget: Widget): void {
    this.group = null; // any other entry breaks a consecutive grouped run
    widget.addCssClass('transcript-entry');
    this.box.append(widget);
  }

  /** Append a NON-message entry (tool rows, single rows, cards, …). The ONLY way to
   *  add such an entry: it wraps `widget` in a `.transcript-entry-tool` box, so the
   *  tool-entry gutter/indent is owned in exactly one place — no caller sets that
   *  class itself. */
  appendToolEntry(widget: Widget): void {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.addCssClass('transcript-entry-tool');
    box.append(widget);
    this.appendEntry(box);
  }

  /** Append a Read/Write/Edit (file-path tool) call as a collapsed row: a leading
   *  tool icon + a non-clickable tool-name label, with each call's file path stacked
   *  to its right as a clickable link that opens the file. CONSECUTIVE calls of the
   *  SAME tool extend one row; any other entry starts a fresh one. Returns an
   *  `onResult` the caller wires to the tool's result so a FAILURE still surfaces. */
  appendFileTool(
    name: string,
    input: unknown,
    opts: { cwd: string; onOpenFile: (path: string) => void },
  ): (isError: boolean, text: string) => void {
    const view = describeTool(name, input, opts.cwd);
    const absPath = toolFilePath(name, input) ?? '';
    const display = view.detail || absPath;

    // Group by tool name (Read/Edit/…), with the tool's icon + name as the head.
    const items = this.ensureGroup(name, view.icon, view.title || name);

    // The path fills the row's width and ellipsizes in the MIDDLE — keeping the
    // leading dirs AND the filename visible — so a long path never widens the
    // transcript into horizontal scroll; the full path stays on the tooltip.
    const label = new Gtk.Label({ xalign: 0, label: display, hexpand: true });
    label.setSingleLineMode(true); // ellipsize needs a single line
    label.setEllipsize(Pango.EllipsizeMode.MIDDLE);
    const button = new Gtk.Button({ hexpand: true });
    button.addCssClass('flat');
    button.addCssClass('link');
    button.addCssClass('transcript-file-path');
    button.setChild(label);
    button.setTooltipText(absPath);
    this.subs.connect(button, 'clicked', () => opts.onOpenFile(absPath));
    items.append(button);
    this.scrollToBottom();

    // A successful file op is boilerplate (suppressed); surface only a FAILURE — tint
    // the path link as an error and carry the message in its tooltip.
    return (isError, text) => {
      if (!isError) return;
      button.addCssClass('error');
      const msg = text.trim();
      if (msg) button.setTooltipText(msg);
    };
  }

  /** Append `item` into a consecutive-run group keyed by `key` — a leading `icon` +
   *  bold `head`, with each item stacked to its right (the same layout file tools
   *  use). Used to collapse a run of subagent (`Agent`) spawns into one entry, like
   *  Read does. A run of the same `key` extends; any other entry starts a fresh one. */
  appendGroupItem(key: string, icon: string, head: string, item: Widget): void {
    this.ensureGroup(key, icon, head).append(item);
    this.scrollToBottom();
  }

  // Build (or reuse) the consecutive-run group for `key`: a leading icon + a
  // non-clickable bold head, with a vertical `items` box stacked to its right. A run
  // of the same key reuses the open group; otherwise a fresh container is appended.
  // Returns the `items` box new entries append into.
  private ensureGroup(key: string, icon: string, head: string): InstanceType<typeof Gtk.Box> {
    if (this.group && this.group.key === key) return this.group.items;

    const container = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
    container.addCssClass('transcript-file-row');

    const iconLabel = new Gtk.Label({ valign: Gtk.Align.START });
    iconLabel.addCssClass('transcript-file-icon');
    setMarkupSafe(iconLabel, iconSpan(icon), icon);
    container.append(iconLabel);

    // The head as a non-clickable flat button, so it carries the EXACT same
    // padding/metrics as the item buttons beside it — they line up.
    const headButton = new Gtk.Button({ valign: Gtk.Align.START });
    headButton.addCssClass('flat');
    headButton.addCssClass('transcript-file-head');
    headButton.setCanTarget(false); // a label, not a control — no hover, no click
    headButton.setFocusable(false);
    const headLabel = new Gtk.Label({ xalign: 0 });
    setMarkupSafe(headLabel, `<b>${escapeMarkup(head)}</b>`, head);
    headButton.setChild(headLabel);
    container.append(headButton);

    // Center the icon against the head ROW (not the whole stack): a vertical size
    // group ties the icon's height to the head button's, so its glyph centers on
    // that first row even as more items stack below (same trick as ToolRow).
    const sizing = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
    sizing.addWidget(iconLabel);
    sizing.addWidget(headButton);

    const items = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    container.append(items);
    this.appendToolEntry(container); // wraps + clears the group → assign it right after
    this.group = { key, items };
    return items;
  }

  /** Remove a previously-appended entry (e.g. an answered permission card). */
  removeEntry(widget: Widget): void {
    this.box.remove(widget);
  }

  /** Drop every entry. */
  clear(): void {
    this.group = null; // the open run's box is about to be removed — don't reuse it
    clearChildren(this.box);
  }

  /** Follow new content to the bottom while in stick mode. `force` re-arms and pins now
   *  (e.g. on show); otherwise the `changed` handler pins when the height changes. */
  scrollToBottom(force = false): void {
    if (force) { this.stickToBottom = true; this.pinToBottom(); }
  }

  // Jump to the bottom, flagged `pinning` so its value-change isn't read as a user
  // scroll. Called from `changed` (during layout, `upper` final) so it lands correctly.
  private pinToBottom(): void {
    const adj = this.root.getVadjustment();
    this.pinning = true;
    adj.setValue(adj.getUpper() - adj.getPageSize());
    this.pinning = false;
  }

  // Pin on the adjustment's `changed` (height) signal, NOT a per-frame tick loop: that
  // fought GTK's own scroll handling (kinetic / scrollbar) and made scrolling up janky.
  // `changed` fires only on a content-height change (never from a user scroll), so the
  // two never contend; `value-changed` tracks the user — a scroll up (value fell, height
  // held) releases stick mode, returning within REARM_GAP re-arms it. It runs before the
  // layout that emits `changed`, so a streaming-while-scrolling frame releases first.
  private setupAutoScroll(): void {
    const adj = this.root.getVadjustment();
    this.lastValue = adj.getValue();
    this.lastUpper = adj.getUpper();
    this.subs.connect(adj, 'changed', () => { if (this.stickToBottom) this.pinToBottom(); });
    this.subs.connect(adj, 'value-changed', () => {
      const value = adj.getValue();
      const upper = adj.getUpper();
      if (!this.pinning) {
        if (value < this.lastValue - 0.5 && upper >= this.lastUpper - 0.5) {
          this.stickToBottom = false; // user scrolled up — yield immediately
        } else if (upper - adj.getPageSize() - value <= Transcript.REARM_GAP) {
          this.stickToBottom = true; // back within the re-arm window
        }
      }
      this.lastValue = value;
      this.lastUpper = upper;
    });
  }

  /** Sever the vadjustment autoscroll handlers so a closed conversation stops pinning
   *  this Transcript. Called from `AgentConversation.dispose()`. */
  dispose(): void {
    this.subs.dispose();
  }
}
