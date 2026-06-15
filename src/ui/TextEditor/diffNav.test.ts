import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { changeStartRows } from './diffNav.ts';

describe('changeStartRows', () => {
  it('finds the first row of each contiguous changed region', () => {
    // c c a a c r c f → regions at rows 2 (added run), 5 (removed), 7 (filler)
    const kinds = ['context', 'context', 'added', 'added', 'context', 'removed', 'context', 'filler'];
    assert.deepEqual(changeStartRows(kinds), [2, 5, 7]);
  });

  it('handles a change at row 0 and no changes', () => {
    assert.deepEqual(changeStartRows(['removed', 'added', 'context']), [0]);
    assert.deepEqual(changeStartRows(['context', 'context']), []);
    assert.deepEqual(changeStartRows([]), []);
  });
});
