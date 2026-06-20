/**
 * Test-only temp-dir helper. Every directory it hands out is tracked and removed when the test
 * process exits, so repeated test runs don't accumulate `/tmp/quilx-*` directories. The exit hook
 * (rather than node:test's `after()`) means cleanup still runs even when a test throws mid-file.
 */
import * as Fs from 'node:fs';
import * as Os from 'node:os';
import * as Path from 'node:path';

const created: string[] = [];
let hooked = false;

/** Create a unique temp dir named `quilx-<prefix>-XXXXXX`, removed on process exit. */
export function tmpDir(prefix: string): string {
  if (!hooked) {
    hooked = true;
    process.on('exit', () => {
      for (const dir of created) {
        try { Fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    });
  }
  const dir = Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), `quilx-${prefix}-`)));
  created.push(dir);
  return dir;
}
