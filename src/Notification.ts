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
import { Icons } from './ui/icons.ts';

export type NotificationType = 'trace' | 'success' | 'info' | 'warning' | 'error' | 'fatal';

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
  /**
   * The default action: run when the notification itself is clicked (toast or
   * log row) or via the `notifications:activate` command. Distinct from
   * `buttons`, which are explicit, secondary actions.
   */
  onDidClick?: () => void;
  /** Action buttons rendered on the notification. */
  buttons?: NotificationButton[];
  /** Captured stack trace, for error/fatal notifications. */
  stack?: string;
}

// Default Nerd Font icon glyph per severity (see ui/icons.ts). `getIcon()`
// returns a glyph rendered as label text; `options.icon` can override it.
const DEFAULT_ICONS: Record<NotificationType, string> = {
  trace: Icons.trace,
  success: Icons.success,
  info: Icons.info,
  warning: Icons.warning,
  error: Icons.error,
  fatal: Icons.fatal,
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

  /** Whether a default action (`options.onDidClick`) is set. */
  hasDefaultAction(): boolean {
    return typeof this.options.onDidClick === 'function';
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run the default action, if any. Returns whether one was present. */
  activate(): boolean {
    if (!this.options.onDidClick) return false;
    this.options.onDidClick();
    return true;
  }

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
