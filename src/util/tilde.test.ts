import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Os from 'node:os';
import { tildify, expandTilde } from './tilde.ts';

// Os.homedir() honours $HOME on POSIX, so derive expectations from it rather
// than hardcoding a path.
const home = Os.homedir();

test('tildify collapses $HOME (and paths under it) to ~', () => {
  assert.equal(tildify(home), '~');
  assert.equal(tildify(`${home}/src/zym`), '~/src/zym');
});

test('tildify leaves paths outside home — including sibling prefixes — unchanged', () => {
  assert.equal(tildify('/etc/hosts'), '/etc/hosts');
  assert.equal(tildify('/'), '/');
  // A string prefix of $HOME that is not a *path* prefix must not collapse.
  assert.equal(tildify(`${home}-old/x`), `${home}-old/x`);
});

test('expandTilde is the inverse of tildify', () => {
  assert.equal(expandTilde('~'), home);
  assert.equal(expandTilde('~/src/zym'), `${home}/src/zym`);
  assert.equal(expandTilde('/etc/hosts'), '/etc/hosts');
  // A bare `~name` (no slash) is not a home reference; leave it literal.
  assert.equal(expandTilde('~foo'), '~foo');
});
