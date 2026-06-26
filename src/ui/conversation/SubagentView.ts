/*
 * SubagentView — the UI for spawned subagents (the `Agent` tool). A subagent's
 * activity is captured into its own transcript (see SdkSession); here it surfaces
 * as a single inline button in the main thread, an entry in a sticky "running"
 * panel, and a pushed NavigationView page showing the full transcript.
 */
import { Gtk, Adw } from '../../gi.ts';
import { CompositeDisposable } from '../../util/eventKit.ts';
import { theme } from '../../theme/theme.ts';
import { fonts } from '../../fonts.ts';
import { Message } from './Message.ts';
import { toolMarkup } from '../toolDisplay.ts';
import { escapeMarkup, setMarkupSafe } from '../proseMarkup.ts';
import { iconSpan } from '../icons.ts';
import { NERDFONT } from '../nerdfont.ts';
import { summarizeInput, truncateLines } from './format.ts';
import { StickyListPanel } from './StickyListPanel.ts';
import { ToolRow } from './ToolRow.ts';
import { Transcript } from './Transcript.ts';
import type { SdkSession } from '../../agents/claude-sdk/SdkSession.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/** Navigation surface the subagent page is pushed onto (the conversation's view). */
export interface PageNav {
  push(page: InstanceType<typeof Adw.NavigationPage>): void;
  pop(): void;
}

export class SubagentView {
  /** The running-subagents panel; mount `panel.root` in the layout. */
  readonly panel = new StickyListPanel('Subagents', 'is-below');
  private readonly running = new Map<string, { agentType: string; description: string; status: 'running' | 'completed' }>();

  private readonly session: Pick<SdkSession, 'getSubagent' | 'onSubagentUpdate'>;
  private readonly nav: PageNav;
  private readonly cwd: string;
  // View-lifetime bag (spawn ToolRows + open pages); disposed by AgentConversation.dispose().
  private readonly subs = new CompositeDisposable();
  // The running-panel link-button handlers, re-created on every `render()`; cleared per
  // render so they don't accumulate as subagents start/finish (node-gtk roots each — rule 2).
  private readonly renderSubs = new CompositeDisposable();

  constructor(session: Pick<SdkSession, 'getSubagent' | 'onSubagentUpdate'>, nav: PageNav, cwd: string) {
    this.session = session;
    this.nav = nav;
    this.cwd = cwd;
  }

  /** The `Agent` spawn → an inline ToolRow (returned, to append to the transcript;
   *  shares the icon/alignment of tool rows) plus an entry in the running panel.
   *  Clicking the row opens the subagent's transcript page. */
  spawn(id: string, input: unknown): Widget {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const type = typeof i.subagent_type === 'string' ? i.subagent_type : 'agent';
    const desc = typeof i.description === 'string' ? i.description : '';
    const header = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true });
    header.addCssClass('conversation-tool-header');
    setMarkupSafe(header, `<b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const toolRow = new ToolRow({ icon: NERDFONT.TOOL.SUBAGENT, header, onActivate: () => this.pushPage(id), subs: this.subs });
    // Show it in the running panel right away (driven by the spawn, not the later
    // task_started, so it's robust); hidden again on completion.
    this.running.set(id, { agentType: type, description: desc, status: 'running' });
    this.render();
    return toolRow.root;
  }

  /** Mark a subagent finished (hides it from the running panel). */
  done(id: string): void {
    const s = this.running.get(id);
    if (s) s.status = 'completed';
    this.render();
  }

  // A flat link-button "<icon> <type>  <description>" that opens the subagent page.
  private linkButton(id: string, glyph: string, type: string, desc: string, color?: string): InstanceType<typeof Gtk.Button> {
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${iconSpan(glyph, color)}  <b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const button = new Gtk.Button({ halign: Gtk.Align.START });
    button.addCssClass('flat');
    button.addCssClass('sticky-list-panel-link');
    button.setChild(label);
    this.renderSubs.connect(button, 'clicked', () => this.pushPage(id));
    return button;
  }

  private render(): void {
    this.renderSubs.clear(); // sever the previous render's panel link handlers
    const rows: Widget[] = [];
    for (const [id, s] of this.running) {
      if (s.status !== 'running') continue;
      rows.push(this.linkButton(id, NERDFONT.STATUS.SYNC, s.agentType, s.description, theme.ui.status.warning));
    }
    this.panel.render(rows);
  }

  // Push a page rendering the subagent's captured transcript; live-updates while running.
  private pushPage(id: string): void {
    // The same shared Transcript widget the main conversation uses — it owns the
    // entries box, the inter-entry spacing (its `.transcript-entry` class), and
    // stick-to-bottom; this code only builds the entries.
    const transcript = new Transcript();
    // Page-scoped bag: severed when the page is popped ('hidden'), or with the view if torn
    // down while still open. Owns the per-page transcript (its autoscroll vadjustment
    // handlers), the update sub, and the back/hidden handlers — all node-gtk-rooted (rule 2).
    const pageSubs = this.subs.nest();
    pageSubs.use(transcript);
    const render = () => {
      transcript.clear();
      const info = this.session.getSubagent(id);
      if (!info) return;
      // The instruction the main agent gave the subagent, at the top (a user turn).
      if (info.prompt) {
        const prompt = new Message('user');
        transcript.appendEntry(prompt.root);
        prompt.setMarkdown(info.prompt);
      }
      for (const m of info.messages) {
        if (m.kind === 'text') {
          const message = new Message('assistant');
          transcript.appendEntry(message.root);
          message.setMarkdown(m.text);
        } else {
          // The tool call + its result form ONE entry (the result stays tucked under
          // the call), mirroring a ToolRow + its detail in the main transcript.
          const entry = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
          const label = new Gtk.Label({ xalign: 0, wrap: true, selectable: true });
          label.addCssClass('conversation-tool-header');
          setMarkupSafe(label, toolMarkup(m.name, m.input, { cwd: this.cwd, monoFamily: fonts.monospaceFamily }), `${m.name} ${summarizeInput(m.input)}`);
          entry.append(label);
          if (m.result && m.result.text.trim()) {
            const out = new Gtk.Label({ xalign: 0, wrap: true, selectable: true, label: truncateLines(m.result.text.trim(), 12, 1200) });
            out.addCssClass('conversation-result');
            out.setMarginStart(22);
            entry.append(out);
          }
          transcript.appendToolEntry(entry); // a tool entry (not a message)
        }
      }
    };
    render();
    pageSubs.use(this.session.onSubagentUpdate(({ id: uid }) => { if (uid === id) render(); }));

    const info = this.session.getSubagent(id);
    const title = info ? `${info.agentType}${info.status === 'running' ? ' (running)' : ''}` : 'Subagent';
    const back = new Gtk.Button({ label: '‹ Back', halign: Gtk.Align.START });
    back.addCssClass('flat');
    pageSubs.connect(back, 'clicked', () => this.nav.pop());
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    header.addCssClass('conversation-page-header');
    header.append(back);
    header.append(new Gtk.Label({ label: title }));
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    page.addCssClass('conversation-surface');
    page.append(header);
    page.append(transcript.root);

    const navPage = Adw.NavigationPage.new(page, title);
    pageSubs.connect(navPage, 'hidden', () => pageSubs.dispose()); // stop refreshing + sever once popped
    this.nav.push(navPage);
  }

  /** Sever the panel + page handlers so a closed conversation stops pinning this view. */
  dispose(): void {
    this.renderSubs.dispose();
    this.subs.dispose();
  }
}
