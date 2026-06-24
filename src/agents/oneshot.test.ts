import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOneShotEnvelope } from './oneshot.ts';

test('parseOneShotEnvelope extracts the result text', () => {
  const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hello' });
  assert.deepEqual(parseOneShotEnvelope(raw), { ok: true, text: 'hello' });
});

test('parseOneShotEnvelope flags is_error', () => {
  const raw = JSON.stringify({ type: 'result', is_error: true, result: 'boom' });
  assert.deepEqual(parseOneShotEnvelope(raw), { ok: false, text: 'boom' });
});

test('parseOneShotEnvelope rejects junk / missing result', () => {
  assert.deepEqual(parseOneShotEnvelope(''), { ok: false, text: '' });
  assert.deepEqual(parseOneShotEnvelope('not json'), { ok: false, text: '' });
  assert.deepEqual(parseOneShotEnvelope('{"type":"result"}'), { ok: false, text: '' });
});
