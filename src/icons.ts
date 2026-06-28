/*
 * icons.ts — bundled SVG image icons.
 *
 * `ImageIcons` is the typed catalog of the SVGs under `assets/icons/`, keyed by
 * the constant names the pre-processor derives from each filename (e.g.
 * `cat-sleeping.svg` → `ImageIcons.CAT_SLEEPING`). The name→path map is generated
 * by `scripts/generate-icons.ts` into `icons.generated.ts`; this module turns each
 * entry into a builder that renders the SVG into a sized `Gtk.Image`:
 *
 *   const cat = ImageIcons.CAT_SLEEPING(52);
 *
 * These are symbolic SVGs (named `*-symbolic.svg`): loaded through
 * `Gtk.IconPaintable`, GTK treats the `-symbolic` suffix as a recolor hint and
 * tints them to the widget's `color` — so they follow the theme foreground like
 * the Nerd Font glyphs in `ui/icons.ts`, despite not living in an icon theme. The
 * suffix is load-bearing: drop it and GTK renders the SVG's authored colors
 * instead. The paintable also rasterizes the vector crisply at the requested
 * pixel size rather than scaling an intrinsic bitmap.
 */
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import Gio from 'gi:Gio-2.0';
import Gtk from 'gi:Gtk-4.0';
import { ICON_FILES } from './icons.generated.ts';

type Image = InstanceType<typeof Gtk.Image>;
type Paintable = InstanceType<typeof Gtk.IconPaintable>;

// Generated paths are repo-root-relative; this module lives in `src/`.
const ROOT_DIR = Path.join(Path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load a bundled symbolic SVG (repo-root-relative `path`) as a recolorable
 *  `Gtk.IconPaintable` rasterized at `pixelSize`. The paintable follows the
 *  widget's `color` (the `-symbolic` recolor hint) and stays crisp at any scale. */
function loadPaintable(path: string, pixelSize: number): Paintable {
  const file = Gio.File.newForPath(Path.join(ROOT_DIR, path));
  return Gtk.IconPaintable.newForFile(file, pixelSize, 1);
}

/** Render a bundled SVG into a `Gtk.Image` sized to `pixelSize`. */
function loadImage(path: string, pixelSize: number): Image {
  const image = Gtk.Image.newFromPaintable(loadPaintable(path, pixelSize));
  image.setPixelSize(pixelSize);
  return image;
}

/** Build a `Gtk.Image` for the named icon at `pixelSize`. */
type IconBuilder = (pixelSize: number) => Image;
/** Build a `Gtk.IconPaintable` for the named icon at `pixelSize`. */
type PaintableBuilder = (pixelSize: number) => Paintable;

/** The bundled icon catalog: `ImageIcons.CAT_SLEEPING(52)` → a sized `Gtk.Image`. */
export const ImageIcons = Object.fromEntries(
  Object.entries(ICON_FILES).map(([key, path]) => [key, (pixelSize: number) => loadImage(path, pixelSize)]),
) as Record<keyof typeof ICON_FILES, IconBuilder>;

/** The same catalog as raw paintables — for a single `Gtk.Image` whose icon is
 *  swapped in place via `setFromPaintable` (e.g. the live agent status icon)
 *  rather than a fresh widget per state. */
export const ImagePaintables = Object.fromEntries(
  Object.entries(ICON_FILES).map(([key, path]) => [key, (pixelSize: number) => loadPaintable(path, pixelSize)]),
) as Record<keyof typeof ICON_FILES, PaintableBuilder>;
