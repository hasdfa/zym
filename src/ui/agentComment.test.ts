/*
 * Tests for formatAgentComment — the shared "comment to agent" message shape used by both the diff
 * surface and file-editor comments. Pure function, so no GTK / app setup needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentComment } from './agentComment.ts';

test('formats a plain code (file editor) comment', () => {
  const out = formatAgentComment({
    rel: 'src/foo.ts',
    line: 12,
    fence: 'typescript',
    body: 'const x = 1;\nconst y = 2;',
    locator: 'L12-13',
    comment: 'rename these',
  });
  assert.equal(
    out,
    [
      'src/foo.ts:12',
      '',
      '```typescript',
      'const x = 1;',
      'const y = 2;',
      '```',
      '',
      'On L12-13:',
      'rename these',
    ].join('\n'),
  );
});

test('formats a diff comment (diff fence + hunk body)', () => {
  const out = formatAgentComment({
    rel: 'src/bar.ts',
    line: 5,
    fence: 'diff',
    body: '@@ -5,1 +5,1 @@\n-old\n+new',
    locator: 'new L5, old L5',
    comment: 'why?',
  });
  assert.match(out, /^src\/bar\.ts:5\n\n```diff\n@@ -5,1 \+5,1 @@/);
  assert.match(out, /\nOn new L5, old L5:\nwhy\?$/);
});

test('an empty fence yields a bare code block', () => {
  const out = formatAgentComment({ rel: 'a', line: 1, fence: '', body: 'x', locator: 'L1', comment: 'c' });
  assert.equal(out, 'a:1\n\n```\nx\n```\n\nOn L1:\nc');
});
