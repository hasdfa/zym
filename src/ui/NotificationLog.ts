/*
 * NotificationLog — the persistent view of `quilx.notifications`. A scrollable
 * list of every notification posted this session (newest at the bottom), the
 * counterpart to the transient toasts: toasts come and go, this is the history.
 *
 * Each row shows the severity icon, the message with optional `detail`, and the
 * post time. It backfills from `getNotifications()` on construction, appends a
 * row per `onDidAddNotification`, and empties on `onDidClearNotifications`.
 * Lives in the bottom dock, toggled by `notifications:toggle-log`.
 *
 * The assembled, scrollable list is exposed via `root`.
 */
import { Gtk } from '../gi.ts';
import { quilx } from '../quilx.ts';
import { CompositeDisposable } from '../util/eventKit.ts';
import type { Notification } from '../Notification.ts';

export class NotificationLog {
  readonly root: InstanceType<typeof Gtk.ScrolledWindow>;

  private readonly listBox: InstanceType<typeof Gtk.ListBox>;
  private readonly subs = new CompositeDisposable();

  constructor() {
    this.listBox = new Gtk.ListBox();
    this.listBox.setSelectionMode(Gtk.SelectionMode.NONE);
    this.listBox.addCssClass('NotificationList');

    this.root = new Gtk.ScrolledWindow();
    this.root.setName('NotificationLog'); // selector identity for keymap + CSS
    this.root.setChild(this.listBox);
    this.root.setVexpand(true);

    // Backfill the existing history, then stay live.
    for (const notification of quilx.notifications.getNotifications()) this.addRow(notification);
    this.subs.add(quilx.notifications.onDidAddNotification((n) => this.addRow(n as Notification)));
    this.subs.add(quilx.notifications.onDidClearNotifications(() => this.clearRows()));
  }

  /** Move keyboard focus into the log (so its scoped bindings apply). */
  focus(): void {
    this.listBox.grabFocus();
  }

  // Append one notification as a row: severity icon, message (+ optional detail),
  // and the post time. The type drives a CSS class so themes can color rows.
  private addRow(notification: Notification): void {
    const icon = new Gtk.Image({ iconName: notification.getIcon() });
    icon.setValign(Gtk.Align.START);

    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    const message = new Gtk.Label({ xalign: 0, wrap: true });
    message.setText(notification.getMessage());
    text.append(message);

    const detail = notification.getDetail();
    if (detail) {
      const detailLabel = new Gtk.Label({ xalign: 0, wrap: true });
      detailLabel.setText(detail);
      detailLabel.addCssClass('dim-label');
      text.append(detailLabel);
    }

    const time = new Gtk.Label({ xalign: 1 });
    time.setText(notification.getTimestamp().toLocaleTimeString());
    time.addCssClass('dim-label');
    time.setValign(Gtk.Align.START);

    const box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    box.setName('NotificationRow'); // CSS identity (#NotificationRow)
    box.addCssClass(`notification-${notification.getType()}`); // per-severity hook
    box.append(icon);
    box.append(text);
    box.append(time);

    const row = new Gtk.ListBoxRow();
    row.setSelectable(false);
    row.setActivatable(false);
    row.setChild(box);
    this.listBox.append(row);
  }

  private clearRows(): void {
    let child = this.listBox.getFirstChild();
    while (child) {
      const next = child.getNextSibling();
      this.listBox.remove(child);
      child = next;
    }
  }

  dispose(): void {
    this.subs.dispose();
  }
}
