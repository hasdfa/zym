/*
 * Tracked GTK event controllers — leak-safe attach/detach.
 *
 * node-gtk roots a controller's signal-handler closures behind persistent
 * (global) handles for as long as the controller stays connected. A controller
 * left on a widget that is then removed from the list/tree and dropped keeps the
 * whole widget subtree (row → box → labels …) alive forever: the rooted closure
 * pins it even though it is detached from the window. This is the leak class
 * behind unbounded idle-RSS growth from list churn — Picker / Combobox / GitPanel
 * rows are rebuilt per keystroke (or per poll), and each removed row that still
 * carries a hover/click controller is pinned. See docs/lifecycle-and-disposal.md.
 *
 * Add controllers to *recycled* widgets through `trackController`, then sever them
 * with `detachControllers(widget)` before the widget is removed/discarded, so the
 * rooted closures are released and the subtree can be collected. (node-gtk's
 * `Gtk.Widget.observeControllers()` list model exposes no usable item accessor in
 * this build, so we remember the controllers ourselves rather than enumerate.)
 */
import { Gtk } from '../gi.ts';

type Widget = InstanceType<typeof Gtk.Widget>;
type Controller = InstanceType<typeof Gtk.EventController>;

const byWidget = new WeakMap<Widget, Set<Controller>>();

/** Attach `controller` to `widget` and remember it so `detachControllers` can
 *  release it later. Use in place of `widget.addController(controller)` whenever
 *  the widget may be removed/recycled while the app is running. */
export function trackController(widget: Widget, controller: Controller): void {
  widget.addController(controller);
  let set = byWidget.get(widget);
  if (!set) byWidget.set(widget, (set = new Set()));
  set.add(controller);
}

/** Remove every controller added to `widget` via `trackController`, releasing
 *  node-gtk's rooted signal closures so the widget (and its subtree) can be
 *  collected. Idempotent; a no-op on widgets with no tracked controllers. */
export function detachControllers(widget: Widget): void {
  const set = byWidget.get(widget);
  if (!set) return;
  for (const controller of set) widget.removeController(controller);
  byWidget.delete(widget);
}
