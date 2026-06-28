/*
 * Regression: "the Git Panel content disappears completely (just before the File Tree
 * steals focus from it)". The center column (where the Git Panel and every center tab
 * live) is the start child of `hCenterRight`; the right dock (File Tree) is its end
 * child. `Workbench.applyDockExtent('right')` restores a dragged dock width with
 *   paned.setPosition(Math.max(0, paned.getWidth() - stored))
 * which yields 0 when the stored dock size is >= the current paned width (e.g. a session
 * saved on a larger window). With the center's shrink ENABLED (GtkPaned's default) a
 * position of 0 *unmaps* the center — the Git Panel vanishes the instant the dock is
 * revealed, right before `revealFileTree` moves focus into the tree. Disabling shrink on
 * the center makes GTK clamp the divider to the center's own minimum, so it never
 * collapses. This pins that mechanism.
 *
 * Mirrors the hCenterRight Paned config + applyDockExtent('right') math in
 * src/ui/workbench/Workbench.ts — keep them in sync.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import GLib from 'gi:GLib-2.0';
import Gtk from 'gi:Gtk-4.0';

Gtk.init();

const SIDEBAR_WIDTH = 220;
const WINDOW_WIDTH = 900;

// A 5ms heartbeat so a blocking `iteration(true)` always has an event to dispatch even
// once the window has settled (a quiescent window emits no frame ticks, which would
// otherwise block the loop forever).
GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, 5, () => GLib.SOURCE_CONTINUE);

const pumpUntil = (done: () => boolean, maxFrames = 200) => {
  const ctx = GLib.MainContext.default();
  for (let i = 0; i < maxFrames && !done(); i++) ctx.iteration(true);
};
// Drive a fixed number of frames so layout/allocation settles even once `done` holds.
const pumpFrames = (frames: number) => {
  const ctx = GLib.MainContext.default();
  for (let i = 0; i < frames; i++) ctx.iteration(true);
};

// Build the hCenterRight Paned (center = start, right dock = end) the way Workbench does.
// `protectCenter` toggles the fix (Workbench sets it true via setShrinkStartChild(false)).
function buildPaned(protectCenter: boolean) {
  // The center column with content that wants a real minimum width (like an editor/git panel).
  const center = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  center.addCssClass('GitPanel');
  const content = new Gtk.Label({ label: 'GIT PANEL CONTENT' });
  content.setSizeRequest(400, -1);
  center.append(content);

  const dock = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  dock.append(new Gtk.Label({ label: 'file tree' }));

  const hCenterRight = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
  hCenterRight.setStartChild(center);
  hCenterRight.setResizeEndChild(false);
  hCenterRight.setShrinkEndChild(false);
  if (protectCenter) hCenterRight.setShrinkStartChild(false); // the fix

  return { center, dock, hCenterRight };
}

// applyDockExtent('right') with a stored width that exceeds the paned (the trigger).
function revealDockWithStoredWidth(hCenterRight: any, dock: any, stored: number) {
  hCenterRight.setEndChild(dock);
  dock.setSizeRequest(SIDEBAR_WIDTH, -1);
  const width = hCenterRight.getWidth();
  if (stored != null && width > 0) hCenterRight.setPosition(Math.max(0, width - stored));
}

test('a stored dock width wider than the window collapses the center WITHOUT the fix', () => {
  const { center, dock, hCenterRight } = buildPaned(/* protectCenter */ false);
  const win = new Gtk.Window();
  win.setDefaultSize(WINDOW_WIDTH, 600);
  win.setChild(hCenterRight);
  win.present();
  // Pump until the paned is actually allocated (mapped flips true a frame before width lands).
  pumpUntil(() => hCenterRight.getWidth() > 0);
  assert.ok(center.getMapped() && hCenterRight.getWidth() > 0, 'sanity: center starts visible + allocated');

  revealDockWithStoredWidth(hCenterRight, dock, WINDOW_WIDTH + 50); // stored >= width → position 0
  pumpFrames(30); // let the bad position re-allocate
  // This is the bug: the center is unmapped (the Git Panel content has disappeared).
  assert.equal(center.getMapped(), false, 'center collapses/unmaps when shrink is allowed');
  win.destroy();
});

test('the center survives the same reveal WITH the fix (shrink disabled)', () => {
  const { center, dock, hCenterRight } = buildPaned(/* protectCenter */ true);
  const win = new Gtk.Window();
  win.setDefaultSize(WINDOW_WIDTH, 600);
  win.setChild(hCenterRight);
  win.present();
  pumpUntil(() => hCenterRight.getWidth() > 0);
  assert.ok(center.getMapped() && hCenterRight.getWidth() > 0, 'sanity: center starts visible + allocated');

  revealDockWithStoredWidth(hCenterRight, dock, WINDOW_WIDTH + 50);
  pumpFrames(30); // same settle window as above
  assert.ok(center.getMapped(), 'center stays visible — GTK clamps the divider to its minimum');
  assert.ok(center.getWidth() > 0, 'center keeps a non-zero width');
  win.destroy();
});
