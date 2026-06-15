import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from './registry.ts';

const SAMPLE = `
[language-server.typescript-language-server]
command = "typescript-language-server"
args = ["--stdio"]
config = { hostInfo = "quilx", typescript = { x = 1 } }

[language-server.rust-analyzer]
command = "rust-analyzer"
config = { files = { watcher = "server" } }

[language-server.deno]
command = "deno"
args = ["lsp"]

[language-server.no-command]
args = ["--stdio"]

[[language]]
name = "typescript"
file-types = ["ts", "mts", "cts"]
roots = ["package.json", "tsconfig.json"]
language-servers = ["typescript-language-server"]

[[language]]
name = "rust"
file-types = ["rs"]
roots = ["Cargo.toml"]
language-servers = ["rust-analyzer"]

[[language]]
name = "make"
file-types = ["Makefile", "mk", { glob = "*.mak" }]
language-servers = ["no-command"]

[[language]]
name = "python"
file-types = ["py", { glob = ".pythonrc" }]
language-servers = ["jedi", "pylsp"]
`;

test('matches by extension and resolves the server spec', () => {
  const reg = normalize(SAMPLE);
  const m = reg.serverSpecsForPath('/proj/src/a.ts');
  assert.ok(m);
  assert.equal(m.langId, 'typescript');
  assert.deepEqual(m.roots, ['package.json', 'tsconfig.json']);
  assert.equal(m.servers.length, 1);
  assert.equal(m.servers[0].command, 'typescript-language-server');
  assert.deepEqual(m.servers[0].args, ['--stdio']);
  assert.deepEqual(m.servers[0].config, { hostInfo: 'quilx', typescript: { x: 1 } });
});

test('alternate extensions and a server with no args default to []', () => {
  const reg = normalize(SAMPLE);
  assert.equal(reg.serverSpecsForPath('/x/y.mts')?.langId, 'typescript');
  const rust = reg.serverSpecsForPath('/x/main.rs');
  assert.deepEqual(rust?.servers[0].args, []);
});

test('unsupported extension returns null', () => {
  assert.equal(normalize(SAMPLE).serverSpecsForPath('/x/y.zzz'), null);
});

test('exact-filename and glob file-types match', () => {
  const reg = normalize(SAMPLE);
  // "Makefile" is an exact basename; "no-command" server is dropped, so make
  // resolves to no launchable servers and is therefore unmatched.
  assert.equal(reg.serverSpecsForPath('/x/Makefile'), null);
});

test('servers without a command are dropped; languages with none are skipped', () => {
  const reg = normalize(SAMPLE);
  // python has jedi (no def) + pylsp (no def) → both undefined → skipped.
  assert.equal(reg.serverSpecsForPath('/x/a.py'), null);
});

test('disabledLanguages removes a language', () => {
  const reg = normalize(SAMPLE, { disabledLanguages: ['rust'] });
  assert.equal(reg.serverSpecsForPath('/x/main.rs'), null);
  assert.ok(reg.serverSpecsForPath('/x/a.ts')); // others unaffected
});

test('serverOverrides replace command/args and deep-merge config', () => {
  const reg = normalize(SAMPLE, {
    serverOverrides: {
      typescript: { command: 'my-ts-ls', args: ['--lsp'], config: { typescript: { y: 2 } } },
    },
  });
  const s = reg.serverSpecsForPath('/x/a.ts')!.servers[0];
  assert.equal(s.command, 'my-ts-ls');
  assert.deepEqual(s.args, ['--lsp']);
  // deep-merge: existing typescript.x kept, y added, hostInfo kept.
  assert.deepEqual(s.config, { hostInfo: 'quilx', typescript: { x: 1, y: 2 } });
});
