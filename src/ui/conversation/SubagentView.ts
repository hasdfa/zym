/*
 * SubagentView — the UI for spawned subagents (the `Agent` tool). A subagent's
 * activity is captured into its own transcript (see SdkSession); here it surfaces
 * as a single inline button in the main thread, an entry in a sticky "running"
 * panel, and a pushed NavigationView page showing the full transcript.
 */
import { Gtk, Adw } from '../../gi.ts';
import { Message } from './Message.ts';
import { escapeMarkup, setMarkupSafe } from '../proseMarkup.ts';
import { NERDFONT } from '../nerdfont.ts';
import { agentStatusMarkup } from '../agentStatusIcon.ts';
import { StickyListPanel } from './StickyListPanel.ts';
import { Transcript } from './Transcript.ts';
import { appendToolRow } from './toolRows.ts';
import type { AgentStatus } from '../../agents/types.ts';
import type { SdkSession } from '../../agents/claude-sdk/SdkSession.ts';

type Widget = InstanceType<typeof Gtk.Widget>;

/** The transcript group key + icon + head a run of subagent spawns collapses under,
 *  mirroring how Read groups (see Transcript.appendGroupItem). Exported so the
 *  conversation host appends spawns into the same group. */
export const SUBAGENT_GROUP = { key: 'Agent', icon: NERDFONT.TOOL.SUBAGENT, head: 'Agent' } as const;

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
  private readonly onOpenFile?: (path: string) => void;

  constructor(session: Pick<SdkSession, 'getSubagent' | 'onSubagentUpdate'>, nav: PageNav, cwd: string, onOpenFile?: (path: string) => void) {
    this.session = session;
    this.nav = nav;
    this.cwd = cwd;
    this.onOpenFile = onOpenFile;
  }

  /** The `Agent` spawn → a clickable inline item (returned, to append into the
   *  transcript's subagent group via SUBAGENT_GROUP — a run of spawns collapses into
   *  one entry, like Read) plus an entry in the running panel. Clicking the item
   *  opens the subagent's transcript page. */
  spawn(id: string, input: unknown): Widget {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const type = typeof i.subagent_type === 'string' ? i.subagent_type : 'agent';
    const desc = typeof i.description === 'string' ? i.description : '';
    // A flat item "<type>  <description>" stacked under the group's single subagent
    // icon (no per-item glyph — the group head carries it, like file-path rows).
    const label = new Gtk.Label({ xalign: 0, wrap: true, hexpand: true });
    label.addCssClass('conversation-tool-header');
    setMarkupSafe(label, `<b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const item = new Gtk.Button({ halign: Gtk.Align.START });
    item.addCssClass('flat'); // a flat button → shares the grouped head/item padding so it lines up
    item.setChild(label);
    item.on('clicked', () => this.pushPage(id));
    // Show it in the running panel right away (driven by the spawn, not the later
    // task_started, so it's robust); hidden again on completion.
    this.running.set(id, { agentType: type, description: desc, status: 'running' });
    this.render();
    return item;
  }

  /** Mark a subagent finished (hides it from the running panel). */
  done(id: string): void {
    const s = this.running.get(id);
    if (s) s.status = 'completed';
    this.render();
  }

  // A flat link-button "<status> <type>  <description>" that opens the subagent page.
  // The leading glyph is the shared agent status indicator (agentStatusIcon), so a
  // subagent reads the same as a top-level agent — `working` shows the ellipsis glyph.
  private linkButton(id: string, status: AgentStatus, type: string, desc: string): InstanceType<typeof Gtk.Button> {
    const label = new Gtk.Label({ xalign: 0, wrap: true });
    setMarkupSafe(label, `${agentStatusMarkup(status)}  <b>${escapeMarkup(type)}</b>${desc ? `  ${escapeMarkup(desc)}` : ''}`, `${type} ${desc}`);
    const button = new Gtk.Button({ halign: Gtk.Align.START });
    button.addCssClass('flat');
    button.addCssClass('sticky-list-panel-link');
    button.setChild(label);
    button.on('clicked', () => this.pushPage(id));
    return button;
  }

  private render(): void {
    const rows: Widget[] = [];
    for (const [id, s] of this.running) {
      if (s.status !== 'running') continue;
      rows.push(this.linkButton(id, 'working', s.agentType, s.description));
    }
    this.panel.render(rows);
  }

  // Push a page rendering the subagent's captured transcript; live-updates while running.
  private pushPage(id: string): void {
    // The same shared Transcript widget the main conversation uses — it owns the
    // entries box, the inter-entry spacing (its `.transcript-entry` class), and
    // stick-to-bottom; this code only builds the entries.
    const transcript = new Transcript();
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
          // The SAME shared builder the main transcript uses (Bash row, collapsed
          // file-tool group, generic toggle row), so a subagent's tools render
          // identically. We hold the full call+result, so wire the result at once.
          const entry = appendToolRow(transcript, m.name, m.input, { cwd: this.cwd, onOpenFile: this.onOpenFile });
          if (m.result) entry.onResult(m.result.isError, m.result.text);
        }
      }
    };
    render();
    const sub = this.session.onSubagentUpdate(({ id: uid }) => { if (uid === id) render(); });

    const info = this.session.getSubagent(id);
    const title = info ? `${info.agentType}${info.status === 'running' ? ' (running)' : ''}` : 'Subagent';
    const back = new Gtk.Button({ label: '‹ Back', halign: Gtk.Align.START });
    back.addCssClass('flat');
    back.on('clicked', () => this.nav.pop());
    const header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
    header.addCssClass('conversation-page-header');
    header.append(back);
    header.append(new Gtk.Label({ label: title }));
    const page = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    page.addCssClass('conversation-surface');
    page.append(header);
    page.append(transcript.root);

    const navPage = Adw.NavigationPage.new(page, title);
    navPage.on('hidden', () => sub.dispose()); // stop refreshing once popped
    this.nav.push(navPage);
  }
}
