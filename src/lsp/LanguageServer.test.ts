import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfigSection } from './LanguageServer.ts';

const settings = { eslint: { run: 'onType' }, format: { enable: false }, validate: 'on' };

test('getConfigSection: no section returns the whole settings object', () => {
  assert.equal(getConfigSection(settings, undefined), settings);
  assert.equal(getConfigSection(settings, ''), settings); // empty section (eslint uses this)
});

test('getConfigSection: a dotted path is traversed', () => {
  assert.equal(getConfigSection(settings, 'validate'), 'on');
  assert.deepEqual(getConfigSection(settings, 'eslint'), { run: 'onType' });
  assert.equal(getConfigSection(settings, 'eslint.run'), 'onType');
  assert.equal(getConfigSection(settings, 'format.enable'), false); // false is a real value, not "missing"
});

test('getConfigSection: a missing path or absent settings yields null (LSP "no config")', () => {
  assert.equal(getConfigSection(settings, 'nope'), null);
  assert.equal(getConfigSection(settings, 'eslint.nope'), null);
  assert.equal(getConfigSection(undefined, 'eslint'), null);
  assert.equal(getConfigSection(undefined, undefined), null);
});
