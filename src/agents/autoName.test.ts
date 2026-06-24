import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNamePrompt, parseAgentName, generateAgentName } from './autoName.ts';
import type { OneShotAgent } from './oneshot.ts';

test('buildNamePrompt embeds the task context and the title format', () => {
  const prompt = buildNamePrompt('  add a /rename endpoint  ');
  assert.match(prompt, /add a \/rename endpoint/);
  assert.match(prompt, /ONLY a JSON object/);
  assert.match(prompt, /\[Action\/Category\]: \[Specific Focus\]/);
});

test('parseAgentName reads a plain JSON object', () => {
  assert.deepEqual(
    parseAgentName('{"name":"Fix: Login Bug","description":"Fix the login bug"}'),
    { name: 'Fix: Login Bug', description: 'Fix the login bug' },
  );
});

test('parseAgentName tolerates code fences and surrounding prose', () => {
  const raw = 'Sure!\n```json\n{"name": "Refactor: Payment Module", "description": "Refactor the payment module"}\n```\n';
  assert.deepEqual(parseAgentName(raw), { name: 'Refactor: Payment Module', description: 'Refactor the payment module' });
});

test('parseAgentName tidies the title (quotes/whitespace) and falls back description→name', () => {
  assert.deepEqual(parseAgentName(JSON.stringify({ name: '  "Fix:   Login Bug"  ' })), {
    name: 'Fix: Login Bug',
    description: 'Fix: Login Bug',
  });
});

test('parseAgentName caps an over-long title', () => {
  const result = parseAgentName(JSON.stringify({ name: 'Refactor: ' + 'x'.repeat(80), description: 'd' }));
  assert.ok(result && result.name.length <= 40);
});

test('parseAgentName returns null on invalid / nameless input', () => {
  assert.equal(parseAgentName('no json here'), null);
  assert.equal(parseAgentName('{not valid json}'), null);
  assert.equal(parseAgentName('{"description":"only a description"}'), null);
});

function stubAgent(reply: string | Error): OneShotAgent & { lastPrompt?: string } {
  const agent: OneShotAgent & { lastPrompt?: string } = {
    run(prompt) {
      agent.lastPrompt = prompt;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
  return agent;
}

test('generateAgentName runs the built prompt through the agent and parses', async () => {
  const agent = stubAgent('{"name":"my-task","description":"My task"}');
  const result = await generateAgentName(agent, 'do my task');
  assert.deepEqual(result, { name: 'my-task', description: 'My task' });
  assert.match(agent.lastPrompt!, /do my task/); // the context reached the agent
});

test('generateAgentName resolves null on unparseable output, skips empty context', async () => {
  assert.equal(await generateAgentName(stubAgent('garbage'), 'x'), null);
  const idle = stubAgent('unused');
  assert.equal(await generateAgentName(idle, '   '), null); // empty context → never calls the agent
  assert.equal(idle.lastPrompt, undefined);
});

test('generateAgentName propagates a one-shot failure', async () => {
  await assert.rejects(generateAgentName(stubAgent(new Error('spawn failed')), 'x'), /spawn failed/);
});
