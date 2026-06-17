#!/usr/bin/env node
/*
 * quilx agent↔editor bridge — a minimal stdio MCP server exposing tools the
 * coding agent calls to talk to the quilx editor it runs inside.
 *
 * Today it offers one tool, `set_worktree`, which writes the agent's current git
 * worktree path to `$QUILX_STATUS_FILE.cwd` (atomic tmp+rename) — the same
 * IPC-file channel the status hooks use (see assets/hooks/agent-status.sh). The
 * editor watches that file and re-roots the agent's workbench (file tree, Source
 * Control, branch indicator) to match. Room for more tools later (open_file, …).
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio, per the MCP stdio spec.
 * Pure Node, no dependencies, so it runs straight from the bundled assets.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const STATUS_FILE = process.env.QUILX_STATUS_FILE;
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'set_worktree',
    description:
      'Tell the quilx editor which git worktree you are now working in, so it re-roots ' +
      'its file tree and Source Control to match. Call this immediately after you create ' +
      'or switch into a worktree (e.g. after `git worktree add <path>` then `cd <path>`). ' +
      'Pass the absolute path of the worktree root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the worktree root you are now working in.' },
      },
      required: ['path'],
    },
  },
];

/** Write the agent's current worktree path to the IPC file (atomic). */
function writeCwd(p) {
  if (!STATUS_FILE) return false;
  try {
    const tmp = `${STATUS_FILE}.cwd.tmp`;
    fs.writeFileSync(tmp, p);
    fs.renameSync(tmp, `${STATUS_FILE}.cwd`);
    return true;
  } catch {
    return false;
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function callTool(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name !== 'set_worktree') {
    replyError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  const p = typeof args.path === 'string' ? args.path : '';
  if (!p || !path.isAbsolute(p)) {
    reply(id, { content: [{ type: 'text', text: 'Error: `path` must be an absolute worktree path.' }], isError: true });
    return;
  }
  const ok = writeCwd(p);
  reply(id, {
    content: [{ type: 'text', text: ok ? `Editor re-rooted to ${p}` : 'Could not reach the editor (no IPC channel).' }],
    isError: !ok,
  });
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'quilx', version: '1.0.0' },
      });
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call':
      callTool(id, params);
      return;
    case 'ping':
      reply(id, {});
      return;
    default:
      // Notifications carry no id and need no response; unknown *requests* error.
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // ignore malformed lines
  }
  if (Array.isArray(msg)) {
    for (const m of msg) handle(m);
  } else {
    handle(msg);
  }
});
