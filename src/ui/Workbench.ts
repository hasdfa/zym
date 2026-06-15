/*
 * Workbench — the dock layout with named fixed slots (left / right / top /
 * bottom) around a center area, built from nested Gtk.Paned so each populated
 * dock is resizable. An empty slot is set to `null`, so its Paned shows only the
 * other child (no handle). The center holds the splittable PanelGroup (the
 * dynamic panel tree). Exposed via `root`.
 *
 * The top and bottom docks sit *inside the center column* — i.e. within the
 * width left between the left and right docks, not spanning the whole window —
 * and open at roughly a quarter of the column's height.
 *
 * Nesting (outermost → in):
 *   hLeft[ left | hCenterRight[ vTop[ top | vBottom[ center | bottom ] ] | right ] ]
 */
import { Gtk } from '../gi.ts';

const SIDEBAR_WIDTH = 220;
// Fraction of the center column height a top/bottom dock takes when opened.
const DOCK_FRACTION = 0.25;

// Anything with a single top-level widget can occupy a dock slot — a Panel for
// the side docks, the splittable PanelGroup for the center.
type Dockable = { root: InstanceType<typeof Gtk.Widget> };

export class Workbench {
  readonly root: InstanceType<typeof Gtk.Paned>;

  private readonly hLeft: InstanceType<typeof Gtk.Paned>;
  private readonly hCenterRight: InstanceType<typeof Gtk.Paned>;
  private readonly vTop: InstanceType<typeof Gtk.Paned>;
  private readonly vBottom: InstanceType<typeof Gtk.Paned>;

  constructor() {
    this.hLeft = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.hCenterRight = new Gtk.Paned({ orientation: Gtk.Orientation.HORIZONTAL });
    this.vTop = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });
    this.vBottom = new Gtk.Paned({ orientation: Gtk.Orientation.VERTICAL });

    // Fixed inner structure; the slots are the outer children set via setX().
    // The center column (top / center / bottom stacked) lives between the left
    // and right docks, so top/bottom never span under the side docks.
    this.vTop.setEndChild(this.vBottom);
    this.hCenterRight.setStartChild(this.vTop);
    this.hLeft.setEndChild(this.hCenterRight);

    // Keep the left sidebar at a fixed width and not shrinking under the editor.
    this.hLeft.setPosition(SIDEBAR_WIDTH);
    this.hLeft.setResizeStartChild(false);
    this.hLeft.setShrinkStartChild(false);

    this.root = this.hLeft;
    this.root.setName('Workbench'); // selector identity for command/keymap rules
  }

  setLeft(panel: Dockable | null) {
    this.hLeft.setStartChild(panel?.root ?? null);
  }

  setCenter(panel: Dockable | null) {
    this.vBottom.setStartChild(panel?.root ?? null);
  }

  setRight(panel: Dockable | null) {
    this.hCenterRight.setEndChild(panel?.root ?? null);
  }

  setTop(panel: Dockable | null) {
    this.vTop.setStartChild(panel?.root ?? null);
    if (panel) this.sizeDock(this.vTop, DOCK_FRACTION); // top is the start child
  }

  setBottom(panel: Dockable | null) {
    this.vBottom.setEndChild(panel?.root ?? null);
    if (panel) this.sizeDock(this.vBottom, 1 - DOCK_FRACTION); // bottom is the end child
  }

  // Position a vertical dock paned so the dock takes DOCK_FRACTION of the column
  // height. `startFraction` is the share given to the paned's start child.
  private sizeDock(paned: InstanceType<typeof Gtk.Paned>, startFraction: number) {
    const height = paned.getHeight();
    if (height > 0) paned.setPosition(Math.round(height * startFraction));
  }
}
