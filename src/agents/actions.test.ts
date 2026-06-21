import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActions, defaultAction } from './actions.ts';

test('parseActions accepts both an array and a { actions } wrapper', () => {
  const list = [{ label: 'Run', command: 'npm start' }];
  assert.deepEqual(parseActions(list), parseActions({ actions: list }));
});

test('parseActions normalizes label/command and slugifies ids', () => {
  const actions = parseActions([{ label: '  Run Dev Server  ', command: '  npm run dev  ' }]);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].id, 'run-dev-server');
  assert.equal(actions[0].label, 'Run Dev Server');
  assert.equal(actions[0].command, 'npm run dev');
});

test('parseActions defaults terminal to true, honoring an explicit false', () => {
  const actions = parseActions([
    { label: 'a', command: 'a' },
    { label: 'b', command: 'b', terminal: true },
    { label: 'c', command: 'c', terminal: false },
  ]);
  assert.deepEqual(actions.map((x) => x.terminal), [true, true, false]);
});

test('parseActions drops entries missing a label or command', () => {
  const actions = parseActions([
    { label: 'ok', command: 'echo ok' },
    { label: '', command: 'echo nope' },
    { label: 'no-cmd', command: '   ' },
    { command: 'echo missing-label' },
    'not-an-object',
    null,
  ]);
  assert.deepEqual(actions.map((a) => a.label), ['ok']);
});

test('parseActions dedupes colliding ids with a numeric suffix', () => {
  const actions = parseActions([
    { label: 'Run', command: 'a' },
    { label: 'run', command: 'b' },
    { label: 'RUN', command: 'c' },
  ]);
  assert.deepEqual(actions.map((a) => a.id), ['run', 'run-2', 'run-3']);
});

test('parseActions returns an empty list for malformed / empty input', () => {
  assert.deepEqual(parseActions(null), []);
  assert.deepEqual(parseActions('nonsense'), []);
  assert.deepEqual(parseActions({ actions: [] }), []);
});

test('defaultAction is the first action, or null when empty', () => {
  const actions = parseActions([
    { label: 'a', command: 'a' },
    { label: 'b', command: 'b' },
  ]);
  assert.equal(defaultAction(actions)?.label, 'a');
  assert.equal(defaultAction([]), null);
  assert.equal(defaultAction(undefined), null);
});
