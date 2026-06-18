/*
 * The color-preview plugin — tints CSS color literals (hex, `rgb()`/`rgba()`,
 * `hsl()`/`hsla()`) with the color they represent, so `#ff0000` shows on a red
 * background. Language-agnostic: it scans buffer text, so colors light up in CSS,
 * SCSS, JS, HTML — anywhere the token appears.
 *
 * It is the first consumer of the `observeTextEditors` contribution point: for
 * each open editor it owns a decoration layer and re-syncs it (clear + re-tint
 * every literal) on edits, debounced. Background-tint only — a clickable swatch /
 * color picker is a later, focusable-overlay feature (see
 * tasks/code-editing/inline-widgets.md).
 *
 * The parsing/contrast logic is the pure, unit-tested `colors.ts`; this file is
 * just the editor wiring.
 */
import { GLib } from '../../gi.ts';
import { Disposable } from '../../util/eventKit.ts';
import type { Plugin, PluginContext } from '../../plugin/types.ts';
import { COLOR_LITERAL_RE, colorTint } from './colors.ts';

// Coalesce rapid edits before re-scanning the buffer. The scan is a cheap regex
// pass, but typing shouldn't trigger one per keystroke.
const DEBOUNCE_MS = 50;
const LAYER = 'color-preview';

export const colorPreviewPlugin: Plugin = {
  id: 'color-preview',
  name: 'Color preview',
  description: 'Tints CSS color literals (hex, rgb()/rgba(), hsl()/hsla()) with the color they represent.',

  activate(ctx: PluginContext) {
    ctx.observeTextEditors((editor) => {
      const layer = editor.decorations.layer(LAYER);
      let timer = 0;

      // Re-sync the whole layer from the current buffer (the TextDecorations
      // pattern: producers recompute their full set, tags track edits in between).
      const refresh = (): void => {
        layer.clear();
        editor.model.scan(COLOR_LITERAL_RE, ({ range, matchText }) => {
          const tint = colorTint(matchText);
          if (tint) layer.tint(range, tint);
        });
      };

      const schedule = (): void => {
        if (timer) GLib.sourceRemove(timer);
        timer = GLib.timeoutAdd(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
          timer = 0;
          refresh();
          return false; // GLib.SOURCE_REMOVE
        });
      };

      const sub = editor.model.onDidChangeText(schedule);
      refresh(); // initial paint of the loaded content

      return new Disposable(() => {
        if (timer) GLib.sourceRemove(timer);
        sub.dispose();
        layer.clear();
      });
    });
  },
};
