/*
 * PluginManagerPanel — lists every registered plugin with its status (active,
 * disabled, failed) and source (builtin / user). Shows name, version, source,
 * and an error message for plugins that failed to activate.
 *
 * Refreshes each time it is shown (via `refresh()`). Built on a Gtk.ScrolledWindow
 * containing a Gtk.Box of rows, one per plugin. Exposed as `root`.
 */
import { Gtk, Pango } from '../gi.ts';
import { addStyles } from '../styles.ts';
import { theme } from '../theme/theme.ts';
import { plugins } from '../plugin/index.ts';
import { disabledPluginIds } from '../plugin/index.ts';
import type { PluginInfo } from '../plugin/PluginRegistry.ts';

const TEXT_MUTED = theme.ui.text.muted ?? 'rgba(255,255,255,0.5)';
const TEXT_ERROR = theme.ui.status?.error ?? '#e06c75';
const TEXT_OK = theme.ui.status?.success ?? '#98c379';

addStyles(`
  #PluginManagerPanel {
    padding: 8px 12px;
  }
  #PluginManagerPanel .plugin-row {
    padding: 6px 0;
    border-bottom: 1px solid rgba(127,127,127,0.15);
  }
  #PluginManagerPanel .plugin-row:last-child {
    border-bottom: none;
  }
  #PluginManagerPanel .plugin-name {
    font-weight: bold;
  }
  #PluginManagerPanel .plugin-badge {
    font-size: 0.8em;
    padding: 1px 5px;
    border-radius: 3px;
    opacity: 0.8;
  }
`);

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function badge(label: string, color: string): InstanceType<typeof Gtk.Label> {
  const lbl = new Gtk.Label({ label });
  lbl.addCssClass('plugin-badge');
  const attrs = Pango.AttrList.new();
  attrs.insert(Pango.attrForegroundAlphaNew(32768)); // tint the fg to match
  lbl.setAttributes(attrs);
  lbl.setMarkup(`<span foreground="${escapeMarkup(color)}">${escapeMarkup(label)}</span>`);
  return lbl;
}

function buildRow(info: PluginInfo): InstanceType<typeof Gtk.Box> {
  const row = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
  row.addCssClass('plugin-row');

  // Top line: name + version + badges
  const topLine = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });
  topLine.setValign(Gtk.Align.CENTER);

  const nameLabel = new Gtk.Label({ label: info.name, xalign: 0 });
  nameLabel.addCssClass('plugin-name');
  topLine.append(nameLabel);

  if (info.version) {
    const versionLabel = new Gtk.Label({ xalign: 0 });
    versionLabel.setMarkup(`<span foreground="${escapeMarkup(TEXT_MUTED)}">${escapeMarkup(info.version)}</span>`);
    topLine.append(versionLabel);
  }

  if (info.source === 'user') {
    topLine.append(badge('user', theme.ui.text.accent ?? '#61afef'));
  }

  if (info.disabled) {
    topLine.append(badge('disabled', TEXT_MUTED));
  } else if (info.error) {
    topLine.append(badge('failed', TEXT_ERROR));
  } else if (info.active) {
    topLine.append(badge('active', TEXT_OK));
  } else {
    topLine.append(badge('inactive', TEXT_MUTED));
  }

  row.append(topLine);

  // Second line: id + description
  if (info.description || info.id) {
    const detailLine = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 6 });

    const idLabel = new Gtk.Label({ xalign: 0 });
    idLabel.setMarkup(`<span foreground="${escapeMarkup(TEXT_MUTED)}" size="small">${escapeMarkup(info.id)}</span>`);
    detailLine.append(idLabel);

    if (info.description) {
      const descLabel = new Gtk.Label({ label: info.description, xalign: 0 });
      descLabel.setEllipsize(Pango.EllipsizeMode.END);
      descLabel.setMarkup(
        `<span foreground="${escapeMarkup(TEXT_MUTED)}" size="small"> — ${escapeMarkup(info.description)}</span>`,
      );
      detailLine.append(descLabel);
    }

    row.append(detailLine);
  }

  // Error line (only on failure)
  if (info.error) {
    const errLabel = new Gtk.Label({ xalign: 0 });
    errLabel.setMarkup(
      `<span foreground="${escapeMarkup(TEXT_ERROR)}" size="small">${escapeMarkup(info.error)}</span>`,
    );
    errLabel.setWrap(true);
    errLabel.setWrapMode(Pango.WrapMode.WORD_CHAR);
    row.append(errLabel);
  }

  return row;
}

export class PluginManagerPanel {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;
  private readonly list: InstanceType<typeof Gtk.Box>;

  constructor() {
    this.list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    this.list.setName('PluginManagerPanel');
    this.list.setValign(Gtk.Align.START);

    const viewport = new Gtk.Viewport();
    viewport.setChild(this.list);

    this.root = new Gtk.ScrolledWindow();
    this.root.setChild(viewport);
    this.root.setHexpand(true);
    this.root.setVexpand(true);

    this.refresh();
  }

  refresh(): void {
    // Clear existing rows
    let child = this.list.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.list.remove(child);
      child = next;
    }

    const disabled = disabledPluginIds();
    const infos = plugins.list(disabled);
    for (const info of infos) {
      this.list.append(buildRow(info));
    }
  }
}
