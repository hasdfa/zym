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
import { Gtk, Adw } from '../gi.ts';
import { addStyles } from '../styles.ts';

type Overlay = InstanceType<typeof Gtk.Overlay>;

/** Default distance from the top of the overlay to the card (the Picker's position). */
const CARD_MARGIN_TOP = 48 * 2;

/** Fade-in/out duration (ms) when `fade` is enabled. */
const FADE_MS = 110;

// The shared drop shadow for every floating card (a soft, wide blur with no spread —
// a large spread reads as a dark halo — at reduced opacity), and the optional dim
// scrim painted behind a card over the rest of the window.
addStyles(/* css */`
  .floating-card {
    box-shadow: 0px 8px 28px 0px alpha(var(--t-ui-shadow), 0.55);
  }
  .floating-card-scrim {
    background-color: alpha(black, 0.35);
  }
`);

export interface FloatingCardOptions {
  /** Overlay to mount the card in (supplied by the caller, e.g. AppWindow's). */
  host: Overlay;
  /** CSS `#id` for the card; the caller scopes its keymap/styles to this name. */
  name: string;
  /** Distance from the top of the overlay to the card (default 48, the Picker's). */
  top?: number;
  /** Dim the rest of the window with a scrim behind the card; clicking it dismisses. */
  dim?: boolean;
  /** Fade the card (and scrim) in on open and out on close. */
  fade?: boolean;
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

  // Optional dim scrim behind the card, covering the rest of the window. Added first so
  // it sits below the panel; clicking it dismisses the card (standard modal behaviour).
  let scrim: InstanceType<typeof Gtk.Box> | null = null;
  if (options.dim) {
    scrim = new Gtk.Box();
    scrim.addCssClass('floating-card-scrim');
    const click = new Gtk.GestureClick();
    click.on('released', () => close());
    scrim.addController(click);
    host.addOverlay(scrim);
  }

  // A floating, opaque card placed at the top-centre of the overlay.
  const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
  panel.setName(options.name);
  panel.addCssClass('floating-card'); // shared drop shadow
  panel.setHalign(Gtk.Align.CENTER);
  panel.setValign(Gtk.Align.START);
  panel.setMarginTop(options.top ?? CARD_MARGIN_TOP);
  panel.overflow = Gtk.Overflow.HIDDEN;

  // Fade the card + scrim together by tweening a shared opacity (Adw respects the
  // system reduce-motion / enable-animations setting, jumping straight to the end).
  const setOpacity = (v: number) => { panel.setOpacity(v); scrim?.setOpacity(v); };
  const fadeTo = (to: number, onDone?: () => void) => {
    const target = Adw.CallbackAnimationTarget.new((v) => setOpacity(v));
    const anim = new Adw.TimedAnimation({
      widget: panel, valueFrom: panel.getOpacity(), valueTo: to, duration: FADE_MS,
      easing: Adw.Easing.EASE_OUT_CUBIC, target,
    });
    if (onDone) anim.on('done', onDone);
    anim.play();
  };

  let closed = false;
  const close = (restoreFocus = true) => {
    if (closed) return;
    closed = true;
    options.onClose?.();
    const remove = () => {
      host.removeOverlay(panel);
      if (scrim) host.removeOverlay(scrim);
      if (restoreFocus) previousFocus?.grabFocus();
    };
    if (options.fade) fadeTo(0, remove);
    else remove();
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
      // Only dismiss when focus genuinely moved to another in-app widget. A null focus
      // means a transient popup grabbed it onto its own surface (e.g. a Gtk.DropDown's
      // list opening) — that must NOT dismiss the card, or the card would vanish the
      // moment one of its dropdowns opens.
      if (windowActive && focused && !focusWithin) close();
    }, 0);
  });
  panel.addController(focus);

  host.addOverlay(panel);

  // Fade in (from fully transparent) once mounted.
  if (options.fade) {
    setOpacity(0);
    fadeTo(1);
  }

  return {
    panel,
    close,
    isClosed: () => closed,
  };
}
