/*
 * openUrl — open a URI in the user's default handler (browser), reporting a
 * failure through the notification manager. Shared by the GitHub buttons/pickers.
 */
import Gio from 'gi:Gio-2.0';
import { zym } from '../zym.ts';

export function openUrl(url: string): void {
  try {
    Gio.AppInfo.launchDefaultForUri(url, null);
  } catch (error) {
    zym.notifications.addError('Could not open link', { detail: (error as Error).message });
  }
}
