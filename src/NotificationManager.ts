/*
 * NotificationManager — the application-wide notification hub.
 *
 * Ported from Atom's `src/notification-manager.js` and exposed as
 * `zym.notifications`. Subsystems post notifications through the typed
 * `addInfo` / `addSuccess` / `addWarning` / `addError` / `addFatalError`
 * helpers; views (the toast overlay today, a log panel later) subscribe via
 * `onDidAddNotification` and render them.
 *
 * Unlike a fire-and-forget toast, the manager RETAINS every notification in
 * `notifications` (until `clear()`), so the planned log interface can replay the
 * full history. The timestamp is stamped here, at post time, in one place.
 */
import { Emitter, type Disposable } from './util/eventKit.ts';
import {
  Notification,
  type NotificationType,
  type NotificationOptions,
} from './Notification.ts';

export class NotificationManager {
  // The full, ordered history — the source of truth for the future log panel.
  private readonly notifications: Notification[] = [];
  private readonly emitter = new Emitter();

  // --- Typed posting helpers -------------------------------------------------

  /** Low-level diagnostic trace (e.g. unimplemented paths); the quietest level. */
  addTrace(message: string, options?: NotificationOptions): Notification {
    return this.add('trace', message, options);
  }

  addSuccess(message: string, options?: NotificationOptions): Notification {
    return this.add('success', message, options);
  }

  addInfo(message: string, options?: NotificationOptions): Notification {
    return this.add('info', message, options);
  }

  addWarning(message: string, options?: NotificationOptions): Notification {
    return this.add('warning', message, options);
  }

  addError(message: string, options?: NotificationOptions): Notification {
    return this.add('error', message, options);
  }

  addFatalError(message: string, options?: NotificationOptions): Notification {
    return this.add('fatal', message, options);
  }

  // --- Core ------------------------------------------------------------------

  /** Build a notification, retain it, and announce it to subscribers. */
  add(type: NotificationType, message: string, options: NotificationOptions = {}): Notification {
    const notification = new Notification(type, message, options, new Date());
    this.notifications.push(notification);
    this.emitter.emit('did-add-notification', notification);
    return notification;
  }

  /** A snapshot of the retained history (newest last). */
  getNotifications(): Notification[] {
    return this.notifications.slice();
  }

  /**
   * Run the default action of the most recent notification that has one (newest
   * first), returning whether anything was activated. Backs the
   * `notifications:activate` command.
   */
  activateLast(): boolean {
    for (let i = this.notifications.length - 1; i >= 0; i--) {
      if (this.notifications[i].hasDefaultAction()) return this.notifications[i].activate();
    }
    return false;
  }

  /** Drop the retained history; the log interface treats this as "cleared". */
  clear(): void {
    this.notifications.length = 0;
    this.emitter.emit('did-clear-notifications');
  }

  // --- Events ----------------------------------------------------------------

  onDidAddNotification(callback: (notification: Notification) => void): Disposable {
    return this.emitter.on('did-add-notification', callback as (value?: unknown) => void);
  }

  onDidClearNotifications(callback: () => void): Disposable {
    return this.emitter.on('did-clear-notifications', callback as (value?: unknown) => void);
  }
}
