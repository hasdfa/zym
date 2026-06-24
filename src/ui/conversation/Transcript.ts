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
import { Gtk, Adw } from '../../gi.ts';
import { addStyles } from '../../styles.ts';
import { clearChildren, setMarkupSafe, escapeMarkup } from '../proseMarkup.ts';
import { describeTool, toolFilePath } from '../toolDisplay.ts';
import { iconSpan } from '../icons.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

addStyles(/* css */`
  #Transcript {
    font-size: 1.05em;
  }

  #Transcript viewport {
    padding: calc(2 * var(--t-spacing)) 0;
  }

  #Transcript .transcript-entry {
    padding: 0 calc(2 * var(--t-spacing));
    margin-bottom: calc(2 * var(--t-spacing));
  }

  /* Shared tool rows (tool-use / Bash / unknown event): a leading tool icon next to
     a toggle (a flat header button over a collapsible detail). The container owns
     the horizontal padding; the extra left indent nests tool activity under the
     turn. (The toggle/expand styling lives in ToolRow.ts.) */
  #Transcript .transcript-entry-tool {
    padding: 0 calc(2 * var(--t-spacing)) 0 calc(6 * var(--t-spacing));
   }

  /* Collapsed file-tool rows (Read/Write/Edit): a non-clickable tool-name label and
     each file path are all flat buttons, so they share the default button padding +
     metrics and line up. The head reads as a muted title; paths read as links (the
     .link class supplies the accent color). */
  #Transcript .transcript-file-icon { padding-right: 8px; }
  #Transcript .transcript-file-head { opacity: 0.85; }
  #Transcript .transcript-file-path {
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
  // While true, stay pinned to the bottom as the height changes; a user scroll up
  // past BOTTOM_GAP releases it, scrolling back to the bottom re-arms it.
  private stickToBottom = true;
  // How close to the bottom (px) still counts as "following" — the small gap window
  // that keeps autoscroll engaged through streaming, and absorbs the lag between
  // content growing and the pin catching up so fast output never self-releases.
  private static readonly BOTTOM_GAP = 32;
  // The open collapsed file-tool row (Read/Write/Edit/…), while a CONSECUTIVE run of
  // the SAME tool is appended to it. Any other entry clears it (see appendEntry).
  private fileGroup: { tool: string; files: InstanceType<typeof Gtk.Box> } | null = null;

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
    this.root.setName('Transcript')
    this.root.setChild(child);
    this.setupAutoScroll();
  }

  /** Append a top-level entry, tagging it with the shared entry class — the single
   *  owner of inter-entry spacing. Used directly only for MESSAGE entries; every
   *  non-message entry goes through appendToolEntry. */
  appendEntry(widget: Widget): void {
    this.fileGroup = null; // any other entry breaks a consecutive file-tool run
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

    if (!this.fileGroup || this.fileGroup.tool !== name) {
      const container = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL });
      container.addCssClass('transcript-file-row');

      const icon = new Gtk.Label({ valign: Gtk.Align.START });
      icon.addCssClass('transcript-file-icon');
      setMarkupSafe(icon, iconSpan(view.icon), view.icon);
      container.append(icon);

      // The tool name as a non-clickable flat button, so it carries the EXACT same
      // padding/metrics as the file-path buttons beside it — they line up.
      const head = new Gtk.Button({ valign: Gtk.Align.START });
      head.addCssClass('flat');
      head.addCssClass('transcript-file-head');
      head.setCanTarget(false); // a label, not a control — no hover, no click
      head.setFocusable(false);
      const headLabel = new Gtk.Label({ xalign: 0 });
      setMarkupSafe(headLabel, `<b>${escapeMarkup(view.title || name)}</b>`, view.title || name);
      head.setChild(headLabel);
      container.append(head);

      // Center the icon against the head ROW (not the whole stack): a vertical size
      // group ties the icon's height to the head button's, so its glyph centers on
      // that first row even as more paths stack below (same trick as ToolRow).
      const sizing = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.VERTICAL });
      sizing.addWidget(icon);
      sizing.addWidget(head);

      const files = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
      container.append(files);
      this.appendToolEntry(container); // wraps + clears fileGroup → assign it right after
      this.fileGroup = { tool: name, files };
    }

    const button = new Gtk.Button({ halign: Gtk.Align.START });
    button.addCssClass('flat');
    button.addCssClass('link');
    button.addCssClass('transcript-file-path');
    button.setChild(new Gtk.Label({ xalign: 0, label: display }));
    button.setTooltipText(absPath);
    button.on('clicked', () => opts.onOpenFile(absPath));
    this.fileGroup.files.append(button);
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

  /** Remove a previously-appended entry (e.g. an answered permission card). */
  removeEntry(widget: Widget): void {
    this.box.remove(widget);
  }

  /** Drop every entry. */
  clear(): void {
    clearChildren(this.box);
  }

  /** Scroll to the bottom on the next frame, but ONLY while following (the user
   *  hasn't scrolled up). `force` re-arms following first. Deferred to a tick because
   *  a freshly-appended widget isn't measured yet — `upper` is stale until the next
   *  layout pass (microtasks never run under the GLib loop — see memory
   *  `queuemicrotask-dead-under-glib-loop`). The steady pinning during streaming is
   *  done by setupAutoScroll's `changed` handler; this just covers the first frame. */
  scrollToBottom(force = false): void {
    if (force) this.stickToBottom = true;
    if (!this.stickToBottom) return;
    this.root.addTickCallback(() => {
      const adj = this.root.getVadjustment();
      adj.setValue(adj.getUpper() - adj.getPageSize());
      return false; // GLib SOURCE_REMOVE — run once
    });
  }

  // Keep the bottom pinned as the height changes (streaming output; a resume whose
  // height settles over several layout passes), until the user scrolls up past
  // BOTTOM_GAP. The KEY is pinning on the adjustment's `changed` (height) signal —
  // fired AFTER layout, when `upper` is correct — rather than at append time (when the
  // freshly-appended widget isn't measured yet). `value-changed` tracks whether we're
  // still at the bottom: a programmatic pin lands exactly there (stays armed); a user
  // scroll up releases it; scrolling back re-arms it.
  private setupAutoScroll(): void {
    const adj = this.root.getVadjustment();
    adj.on('changed', () => { if (this.stickToBottom) adj.setValue(adj.getUpper() - adj.getPageSize()); });
    adj.on('value-changed', () => {
      this.stickToBottom = adj.getUpper() - adj.getPageSize() - adj.getValue() <= Transcript.BOTTOM_GAP;
    });
  }
}
