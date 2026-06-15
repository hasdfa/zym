/*
 * NotificationToasts — the transient, on-screen view of posted notifications.
 *
 * A bottom-right stack of toast cards (newest on top), the replacement for
 * Adw.ToastOverlay (which is bottom-center and offers no per-severity styling).
 * Each card shows the severity icon, the message and optional detail, an
 * optional action button, and a close button; the severity drives a CSS class
 * (`notification-<type>`) so the icon and accent border are colored per the
 * theme — see AppWindow.applyNotificationStyles.
 *
 * Non-dismissable toasts auto-expire after `timeout` seconds; dismissable ones
 * stay until closed. Either way, removing a card dismisses its notification so
 * the model stays in sync. Meant to be added as an overlay child aligned to the
 * bottom-right; the assembled stack is exposed via `root`.
 */
import { GLib, Gtk } from '../gi.ts';
import type { Notification } from '../Notification.ts';
import { Icons, iconLabel } from './icons.ts';

export interface NotificationToastsOptions {
  /** Seconds a non-dismissable toast stays before auto-expiring. */
  timeout: number;
}

const MAX_WIDTH_CHARS = 44;

export class NotificationToasts {
  readonly root: InstanceType<typeof Gtk.Box>;

  private readonly timeout: number;

  constructor(options: NotificationToastsOptions) {
    this.timeout = options.timeout;

    // The stack sits in the bottom-right corner at its natural size, so it never
    // covers (or steals clicks from) the rest of the overlay.
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    this.root.setName('NotificationToasts'); // CSS identity (#NotificationToasts)
    this.root.setHalign(Gtk.Align.END);
    this.root.setValign(Gtk.Align.END);
    this.root.setMarginEnd(12);
    this.root.setMarginBottom(12);
    this.root.setCanTarget(true);
  }

  /** Pop a toast for `notification`, newest on top. */
  show(notification: Notification): void {
    const card = this.buildCard(notification);
    this.root.prepend(card);
    notification.setDisplayed(true);
  }

  private buildCard(notification: Notification): InstanceType<typeof Gtk.Widget> {
    const icon = iconLabel(notification.getIcon());
    icon.setValign(Gtk.Align.START);
    icon.addCssClass('notification-icon');

    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    const message = new Gtk.Label({ xalign: 0, wrap: true });
    message.setText(notification.getMessage());
    message.setMaxWidthChars(MAX_WIDTH_CHARS);
    message.addCssClass('heading');
    text.append(message);

    const detail = notification.getDetail();
    if (detail) {
      const detailLabel = new Gtk.Label({ xalign: 0, wrap: true });
      detailLabel.setText(detail);
      detailLabel.setMaxWidthChars(MAX_WIDTH_CHARS);
      detailLabel.addCssClass('dim-label');
      text.append(detailLabel);
    }

    const card = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    card.addCssClass('NotificationToast'); // CSS identity (.NotificationToast)
    card.addCssClass(`notification-${notification.getType()}`); // per-severity hook
    card.append(icon);
    card.append(text);

    // The first action button maps onto the toast (the full set lives in the log).
    const [button] = notification.getOptions().buttons ?? [];
    if (button) {
      const action = new Gtk.Button({ label: button.text });
      action.setValign(Gtk.Align.CENTER);
      action.on('clicked', () => button.onDidClick());
      card.append(action);
    }

    const close = new Gtk.Button();
    close.setChild(iconLabel(Icons.close));
    close.setValign(Gtk.Align.START);
    close.addCssClass('flat');
    close.addCssClass('circular');
    card.append(close);

    // Auto-expire non-dismissable toasts; dismissable ones wait for the close
    // button. `dismiss()` on removal keeps the model in sync (a no-op for the
    // non-dismissable case, which is already considered dismissed).
    let timeoutId = 0;
    const remove = () => {
      if (timeoutId) {
        GLib.sourceRemove(timeoutId);
        timeoutId = 0;
      }
      this.root.remove(card);
      notification.dismiss();
    };
    close.on('clicked', remove);

    // Clicking the card body runs the default action and dismisses the toast.
    // The buttons above claim their own clicks, so they don't trip this gesture.
    if (notification.hasDefaultAction()) {
      card.addCssClass('activatable'); // hover/cursor affordance — see AppWindow
      const click = new Gtk.GestureClick();
      click.on('released', () => {
        notification.activate();
        remove();
      });
      card.addController(click);
    }
    if (!notification.isDismissable()) {
      timeoutId = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, this.timeout * 1000, () => {
        timeoutId = 0;
        this.root.remove(card);
        notification.dismiss();
        return false; // one-shot: remove the source
      });
    }

    return card;
  }
}
