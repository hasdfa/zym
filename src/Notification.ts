/*
 * Notification — a single, immutable-ish notification record.
 *
 * Ported from Atom's `src/notification.js`. A notification carries its `type`
 * (severity), a short `message`, and an `options` bag (longer `detail`,
 * markdown `description`, action `buttons`, whether it is `dismissable`, and an
 * optional captured `stack` for errors). It is created with a `timestamp` so a
 * future log interface can order and group entries.
 *
 * Lifecycle mirrors Atom: a non-dismissable notification is "dismissed" from
 * the start (the UI auto-expires it on a timeout); a dismissable one stays until
 * `dismiss()` is called. `displayed` tracks whether the UI has shown it yet, so
 * a notification added before its view exists isn't shown twice.
 */
import { Emitter, type Disposable } from './util/eventKit.ts';

export type NotificationType = 'success' | 'info' | 'warning' | 'error' | 'fatal';

export interface NotificationButton {
  text: string;
  onDidClick: () => void;
  /** Optional CSS class for styling the button. */
  className?: string;
}

export interface NotificationOptions {
  /** Secondary, monospace-ish text shown under the message (e.g. a file path). */
  detail?: string;
  /** Longer markdown body, shown when the notification is expanded. */
  description?: string;
  /** Override the default per-type icon name. */
  icon?: string;
  /** When true, the notification stays until explicitly dismissed. */
  dismissable?: boolean;
  /** Action buttons rendered on the notification. */
  buttons?: NotificationButton[];
  /** Captured stack trace, for error/fatal notifications. */
  stack?: string;
}

// Default symbolic icon names per severity (GTK named icons). Overridable via
// `options.icon`.
const DEFAULT_ICONS: Record<NotificationType, string> = {
  success: 'emblem-ok-symbolic',
  info: 'dialog-information-symbolic',
  warning: 'dialog-warning-symbolic',
  error: 'dialog-error-symbolic',
  fatal: 'dialog-error-symbolic',
};

export class Notification {
  readonly type: NotificationType;
  readonly message: string;
  readonly options: NotificationOptions;
  readonly timestamp: Date;

  private dismissed: boolean;
  private displayed = false;
  private readonly emitter = new Emitter();

  constructor(type: NotificationType, message: string, options: NotificationOptions = {}, timestamp: Date) {
    this.type = type;
    this.message = message;
    this.options = options;
    this.timestamp = timestamp;
    // Non-dismissable notifications are considered already dismissed: the UI is
    // expected to auto-expire them, and nothing waits on `dismiss()`.
    this.dismissed = !this.isDismissable();
  }

  // --- Reads -----------------------------------------------------------------

  getType(): NotificationType {
    return this.type;
  }

  getMessage(): string {
    return this.message;
  }

  getOptions(): NotificationOptions {
    return this.options;
  }

  getTimestamp(): Date {
    return this.timestamp;
  }

  getDetail(): string | undefined {
    return this.options.detail;
  }

  getIcon(): string {
    return this.options.icon ?? DEFAULT_ICONS[this.type];
  }

  isDismissable(): boolean {
    return this.options.dismissable ?? false;
  }

  isDismissed(): boolean {
    return this.dismissed;
  }

  getDisplayed(): boolean {
    return this.displayed;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Mark the notification dismissed; a no-op for non-dismissable ones. */
  dismiss(): void {
    if (!this.isDismissable() || this.dismissed) return;
    this.dismissed = true;
    this.emitter.emit('did-dismiss', this);
  }

  /** Record whether the UI has shown this notification. */
  setDisplayed(displayed: boolean): void {
    this.displayed = displayed;
    this.emitter.emit('did-display', this);
  }

  // --- Events ----------------------------------------------------------------

  onDidDismiss(callback: (notification: Notification) => void): Disposable {
    return this.emitter.on('did-dismiss', callback as (value?: unknown) => void);
  }

  onDidDisplay(callback: (notification: Notification) => void): Disposable {
    return this.emitter.on('did-display', callback as (value?: unknown) => void);
  }
}
