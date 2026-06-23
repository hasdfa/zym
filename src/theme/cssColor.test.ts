/*
 * Tests for the display-free parts of the cssColor bridge: app-registry resolution,
 * the static fallback, and gdkRgbaToString. The live CSS-engine probe needs a GTK
 * display and is validated separately by poc/adwaita-probe.ts, so these run headless
 * and resolve from app/fallback only. (The color tables live in adwaitaColors.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdkRgbaToString, lookupCSSColor } from './cssColor.ts';
import { APP_COLORS } from './adwaitaColors.ts';

test('lookupCSSColor resolves app-color tokens per the passed scheme (no display)', () => {
  assert.equal(lookupCSSColor('dark', '--info-color'), APP_COLORS['--info-color'].dark);
  assert.equal(lookupCSSColor('light', '--info-color'), APP_COLORS['--info-color'].light);
  assert.equal(lookupCSSColor('dark', '--hint-bg-color'), APP_COLORS['--hint-bg-color'].dark);
});

test('lookupCSSColor falls back to the static palette when GTK cannot resolve', () => {
  // No display in `node --test`, so the probe is skipped and the static fallback
  // answers for a known libadwaita name, per the passed scheme.
  assert.equal(lookupCSSColor('dark', '--view-bg-color'), '#1d1d20');
  assert.equal(lookupCSSColor('light', '--view-bg-color'), '#ffffff');
});

test('lookupCSSColor throws on an unknown variable name', () => {
  assert.throws(() => lookupCSSColor('dark', '--not-a-real-color'), /cannot resolve/);
});

test('gdkRgbaToString emits #rrggbb when opaque and #rrggbbaa otherwise', () => {
  assert.equal(gdkRgbaToString({ red: 1, green: 0, blue: 0, alpha: 1 }), '#ff0000');
  assert.equal(gdkRgbaToString({ red: 0, green: 1, blue: 0, alpha: 0.5 }), '#00ff0080');
  assert.equal(gdkRgbaToString({ red: 0, green: 0, blue: 0, alpha: 0 }), '#00000000');
});
