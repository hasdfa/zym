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

type Box = InstanceType<typeof Gtk.Box>;

export class NotificationToasts {
  readonly root: Box;

  private readonly timeout: number;
  // Live toasts that can be transformed in place, keyed by `replaceKey`: a later
  // notification with the same key reuses the same card widget instead of
  // stacking a new one (both still appear as separate rows in the log).
  private readonly replaceable = new Map<string, { card: Box; cancelTimer: () => void; notification: Notification }>();

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

  /**
   * Pop a toast for `notification`, newest on top — unless it carries a
   * `replaceKey` matching a live toast, in which case that same card is
   * transformed in place (e.g. "installing…" → "installed").
   */
  show(notification: Notification): void {
    const key = notification.getReplaceKey();
    const prev = key ? this.replaceable.get(key) : undefined;
    if (prev) {
      // Reuse the existing widget: stop its timer, drop the old severity class,
      // mark the superseded notification dismissed (it stays in the log), and
      // refill the card with the new content.
      prev.cancelTimer();
      prev.card.removeCssClass(`notification-${prev.notification.getType()}`);
      prev.notification.dismiss();
      const cancelTimer = this.fillCard(prev.card, notification);
      this.replaceable.set(key!, { card: prev.card, cancelTimer, notification });
      notification.setDisplayed(true);
      return;
    }

    const card = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 8 });
    card.addCssClass('NotificationToast'); // CSS identity (.NotificationToast)
    const cancelTimer = this.fillCard(card, notification);
    this.root.prepend(card);
    if (key) this.replaceable.set(key, { card, cancelTimer, notification });
    notification.setDisplayed(true);
  }

  // (Re)fill `card` with `notification`'s content + behavior. Returns a function
  // that cancels the auto-expire timer (called when the card is reused in place).
  private fillCard(card: Box, notification: Notification): () => void {
    for (let child = card.getFirstChild(); child; ) {
      const next = child.getNextSibling();
      card.remove(child);
      child = next;
    }
    card.addCssClass(`notification-${notification.getType()}`); // per-severity hook

    // An in-progress notification shows a spinner where the severity icon goes.
    let icon: InstanceType<typeof Gtk.Widget>;
    if (notification.isLoading()) {
      const spinner = new Gtk.Spinner();
      spinner.start();
      icon = spinner;
    } else {
      icon = iconLabel(notification.getIcon());
    }
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
    const cancelTimer = () => {
      if (timeoutId) {
        GLib.sourceRemove(timeoutId);
        timeoutId = 0;
      }
    };
    const forget = () => {
      const key = notification.getReplaceKey();
      if (key && this.replaceable.get(key)?.card === card) this.replaceable.delete(key);
    };
    const remove = () => {
      cancelTimer();
      this.root.remove(card);
      notification.dismiss();
      forget();
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
        forget();
        return false; // one-shot: remove the source
      });
    }

    return cancelTimer;
  }
}
