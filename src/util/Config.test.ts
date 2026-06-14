import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from './Config.ts';

function makeConfig() {
  return new Config({
    enabled: { type: 'boolean', default: false },
    tabLength: { type: 'integer', default: 2, minimum: 1, maximum: 8 },
    ratio: { type: 'number', default: 0.5 },
    mode: { type: 'string', default: 'normal', enum: ['normal', 'insert'] },
    scopes: { type: 'array', default: [] },
  });
}

test('get falls back to the schema default', () => {
  const config = makeConfig();
  assert.equal(config.get('enabled'), false);
  assert.equal(config.get('tabLength'), 2);
  assert.equal(config.get('undeclared'), undefined);
});

test('getDefault is unaffected by set, and returns a fresh copy of containers', () => {
  const config = makeConfig();
  config.set('tabLength', 4);
  assert.equal(config.getDefault('tabLength'), 2);

  const a = config.getDefault('scopes') as unknown[];
  const b = config.getDefault('scopes') as unknown[];
  assert.notEqual(a, b);
  assert.deepEqual(a, []);
});

test('set coerces strings to the declared type', () => {
  const config = makeConfig();
  config.set('enabled', 'true' as unknown as boolean);
  assert.equal(config.get('enabled'), true);

  config.set('tabLength', '3' as unknown as number);
  assert.equal(config.get('tabLength'), 3);

  config.set('ratio', '1.5' as unknown as number);
  assert.equal(config.get('ratio'), 1.5);
});

test('integer values are clamped to their bounds', () => {
  const config = makeConfig();
  assert.equal(config.set('tabLength', 100), true);
  assert.equal(config.get('tabLength'), 8);
  config.set('tabLength', -5);
  assert.equal(config.get('tabLength'), 1);
});

test('enum violations and unparseable numbers are rejected without mutating', () => {
  const config = makeConfig();
  assert.equal(config.set('mode', 'visual'), false);
  assert.equal(config.get('mode'), 'normal');

  assert.equal(config.set('tabLength', 'not-a-number' as unknown as number), false);
  assert.equal(config.get('tabLength'), 2);
});

test('unset reverts to the default', () => {
  const config = makeConfig();
  config.set('tabLength', 6);
  assert.equal(config.has('tabLength'), true);
  config.unset('tabLength');
  assert.equal(config.has('tabLength'), false);
  assert.equal(config.get('tabLength'), 2);
});

test('toggle flips a boolean', () => {
  const config = makeConfig();
  config.toggle('enabled');
  assert.equal(config.get('enabled'), true);
  config.toggle('enabled');
  assert.equal(config.get('enabled'), false);
});

test('observe fires immediately and on change', () => {
  const config = makeConfig();
  const seen: unknown[] = [];
  const sub = config.observe('tabLength', (value) => seen.push(value));
  config.set('tabLength', 4);
  sub.dispose();
  config.set('tabLength', 5);
  assert.deepEqual(seen, [2, 4]);
});

test('onDidChange reports newValue and oldValue, and skips no-op sets', () => {
  const config = makeConfig();
  const changes: Array<{ newValue: unknown; oldValue: unknown }> = [];
  config.onDidChange('tabLength', (change) => changes.push(change));
  config.set('tabLength', 4);
  config.set('tabLength', 4); // no-op: equal value, no emit
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { newValue: 4, oldValue: 2 });
});

test('setSchema registers parameters at runtime', () => {
  const config = new Config();
  assert.equal(config.get('plugin.flag'), undefined);
  config.setSchema('plugin.flag', { type: 'boolean', default: true });
  assert.equal(config.get('plugin.flag'), true);
});

test('a scoped view prefixes keys onto the shared parent store', () => {
  const config = new Config();
  const scoped = config.scope('plugin').register({
    enabled: { type: 'boolean', default: false },
  });

  // Reads/writes go through to the parent under the namespaced key.
  assert.equal(scoped.get('enabled'), false);
  assert.equal(config.get('plugin.enabled'), false);

  scoped.set('enabled', true);
  assert.equal(config.get('plugin.enabled'), true);

  // Changes on the parent are visible through the scope, and vice versa.
  config.set('plugin.enabled', false);
  assert.equal(scoped.get('enabled'), false);
});
