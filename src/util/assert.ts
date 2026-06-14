/*
 * assert.ts — assertion helpers (ported from xedel's utils/assert.js).
 */

export function assert(condition: unknown, message = 'Assertion failed'): asserts condition {
  if (condition) return;
  debugger;
  throw new Error(message);
}

export function unreachable(): never {
  debugger;
  throw new Error('unreachable');
}
