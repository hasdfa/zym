/*
 * chromeStyles — the window's themeable chrome stylesheet. Self-registers a
 * single dynamic, hot-reloadable sheet at module load (this module only registers
 * styles, so a re-import is safe). It reads the current `theme`; on a future theme
 * switch, `applyNotificationStyles()` re-applies it. Nothing here touches a window.
 */
import { styles } from '../styles.ts';
import { theme } from '../theme/theme.ts';

// Severity styling shared by the toasts and the log: each `notification-<type>`
// colors its icon, and a toast card gets a matching left accent border, so the
// severity is legible at a glance. Colors come from the theme's semantic keys
// (fatal reuses error); applied independently of the chrome so it works even
// for themes that leave the chrome to Adwaita.
function notificationCss(): string {
  const { status: { info, success, warning, error }, text: { muted: textMuted }, surface: { popover: popoverBg }, shadow } = theme.ui;
  const colors: Record<string, string> = {
    trace: textMuted,
    info,
    success,
    warning,
    error,
    fatal: error,
  };

  const rules = [
    `.NotificationToast {
      background-color: ${popoverBg};
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 8px 10px;
      min-width: 260px;
      box-shadow: 0 2px 8px ${shadow};
    }`,
    // Clickable toasts (default action) get a hover tint.
    `.NotificationToast.activatable:hover { background-color: shade(${popoverBg}, 1.15); }`,
  ];
  for (const [type, color] of Object.entries(colors)) {
    rules.push(`.notification-${type} .notification-icon { color: ${color}; }`);
    rules.push(`.NotificationToast.notification-${type} { border-left: 4px solid ${color}; }`);
    rules.push(`.NotificationRow.notification-${type} { border-left: 3px solid ${color}; padding-left: 6px; }`);
  }

  return rules.join('\n');
}

// A render function (re-applied on hot-reload and via refresh()), since the sheet
// is theme-derived. Module-top so node-gtk watches this file.
const notificationSheet = styles.add(notificationCss);

/** Re-apply the notification chrome (e.g. after a future theme switch). */
export function applyNotificationStyles(): void {
  notificationSheet.refresh();
}
