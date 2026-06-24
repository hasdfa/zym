import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Fs from 'node:fs';
import * as Path from 'node:path';
import { tmpDir } from './util/testTmp.ts';

// transcriptDir() resolves under os.homedir(), which honours $HOME on POSIX; point
// it at a throwaway dir so the round-trip never touches the real ~/.claude. Safe
// because `node --test` runs each test file in its own process.
process.env.HOME = tmpDir('agent-sessions-home');
const { transcriptDir, writeCustomTitle, readSessionName } = await import('./agentSessions.ts');

const CWD = '/home/u/proj';
const SID = '11111111-2222-3333-4444-555555555555';

function seedTranscript(lines: object[]): string {
  const dir = transcriptDir(CWD);
  Fs.mkdirSync(dir, { recursive: true });
  const file = Path.join(dir, `${SID}.jsonl`);
  Fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('writeCustomTitle appends a record readSessionName reads back', () => {
  seedTranscript([{ type: 'user', message: { role: 'user', content: 'hi' } }]);
  assert.equal(readSessionName(CWD, SID), null); // no title yet
  writeCustomTitle(CWD, SID, 'my session');
  assert.equal(readSessionName(CWD, SID), 'my session');
});

test('writeCustomTitle no-ops when the transcript does not exist', () => {
  writeCustomTitle(CWD, 'no-such-session', 'ignored'); // must not throw or create a file
  assert.equal(readSessionName(CWD, 'no-such-session'), null);
});

test('the latest custom title wins; custom title beats ai-title', () => {
  seedTranscript([{ type: 'ai-title', aiTitle: 'auto name' }]);
  assert.equal(readSessionName(CWD, SID), 'auto name'); // falls back to the auto title
  writeCustomTitle(CWD, SID, 'first');
  writeCustomTitle(CWD, SID, 'second');
  assert.equal(readSessionName(CWD, SID), 'second'); // custom title overrides, last wins
});
