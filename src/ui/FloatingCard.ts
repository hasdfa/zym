/*
 * FloatingCard — the overlay "card" shell shared by the Picker and other floating
 * panels (e.g. the agent launcher). It owns the bits every floating card needs but
 * that aren't specific to a search list: mounting an opaque card at the top-centre
 * of a `Gtk.Overlay`, remembering and restoring focus, and dismissing when focus
 * leaves the card for another in-app widget (but not when the whole window is
 * deactivated). It knows nothing about the card's contents — the caller appends its
 * own widgets to `panel` and registers whatever keymap/commands it needs (the card
 * only provides `close`, which the caller can bind to Escape).
 */
import { Gtk } from '../gi.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Distance from the top of the overlay to the card. */
const CARD_MARGIN_TOP = 48;

export interface FloatingCardOptions {
  /** Overlay to mount the card in (supplied by the caller, e.g. AppWindow's). */
  host: Overlay;
  /** CSS `#id` for the card; the caller scopes its keymap/styles to this name. */
  name: string;
  /** Extra teardown run when the card closes (dispose subscriptions, timers). */
  onClose?: () => void;
}

export interface FloatingCardHandle {
  /** The card container — append the card's content to it. */
  readonly panel: InstanceType<typeof Gtk.Box>;
  /**
   * Dismiss the card. By default focus returns to whatever held it before the card
   * opened; pass `false` when the caller is about to move focus itself (e.g. after a
   * selection that opens an editor). Idempotent.
   */
  close(restoreFocus?: boolean): void;
  /** Whether the card has been dismissed. */
  isClosed(): boolean;
}

/**
 * Mount a floating card in `host` and return a handle. The card is added to the
 * overlay immediately (empty); the caller then appends its content to `panel`,
 * sizes it, and grabs focus into it.
 */
export function openFloatingCard(options: FloatingCardOptions): FloatingCardHandle {
  const { host } = options;

  // Remember whatever held focus before the card opened, so dismissing returns
  // focus there (e.g. back to the editor) rather than stranding it on the removed
  // overlay. Captured before the caller grabs focus into the card.
  const previousFocus = host.getRoot()?.getFocus() ?? null;

  // A floating, opaque card placed at the top-centre of the overlay.
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  panel.setName(options.name);
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(CARD_MARGIN_TOP);
  panel.overflow = Gtk.Overflow.HIDDEN;

  let closed = false;
  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    host.removeOverlay(panel);
    if (restoreFocus) previousFocus?.grabFocus();
  };

  // Dismiss when focus moves to another widget in the app (click elsewhere, tab
  // away): close and hand focus back to wherever it came from. `leave` fires only
  // when focus exits the panel *and* its descendants, so moving focus between the
  // card's own widgets doesn't trigger it.
  //
  // A `leave` also fires when the whole window is deactivated (alt-tabbing to
  // another app), but that must NOT close the card — it should still be there on
  // return. So defer a tick (let the focus/active state settle) and close only if
  // the window is still active: i.e. focus genuinely moved to another in-app widget
  // rather than the app losing focus entirely (where focus stays within the card).
  const focus = new Gtk.EventControllerFocus();
  focus.on('leave', () => {
    setTimeout(() => {
      if (closed) return;
      const root = panel.getRoot() as any;
      const windowActive = root?.isActive?.() ?? true;
      const focused = root?.getFocus?.() ?? null;
      const focusWithin = !!focused && (focused === panel || focused.isAncestor(panel));
      if (windowActive && !focusWithin) close();
    }, 0);
  });
  panel.addController(focus);

  host.addOverlay(panel);

  return {
    panel,
    close,
    isClosed: () => closed,
  };
}
