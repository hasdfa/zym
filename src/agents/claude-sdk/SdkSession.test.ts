import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkSession, parseQuestions } from './SdkSession.ts';
import { Disposable } from '../../util/eventKit.ts';
import type { Transport, TransportOptions } from './transport.ts';
import type { StreamEvent } from './protocol.ts';

// A fake transport: records sent turns and lets the test drive the event stream
// synchronously, so we exercise SdkSession's event→domain mapping without
// spawning claude (or running the GLib loop).
class FakeTransport implements Transport {
  writable = true;
  readonly sent: unknown[] = [];
  private eventHandler: ((e: StreamEvent) => void) | null = null;
  private exitHandler: ((code: number | null) => void) | null = null;
  start(): void {}
  send(message: unknown): void { this.sent.push(message); }
  onEvent(h: (e: StreamEvent) => void): Disposable { this.eventHandler = h; return new Disposable(() => { this.eventHandler = null; }); }
  onExit(h: (code: number | null) => void): Disposable { this.exitHandler = h; return new Disposable(() => { this.exitHandler = null; }); }
  dispose(): void { this.writable = false; }
  emit(event: StreamEvent): void { this.eventHandler?.(event); }
  emitExit(code: number | null): void { this.exitHandler?.(code); }
}

function makeSession(): { session: SdkSession; fake: FakeTransport } {
  const fake = new FakeTransport();
  const session = new SdkSession({ cwd: '/tmp', createTransport: (_spec: TransportOptions) => fake });
  return { session, fake };
}

test('maps the stream into status + transcript domain events', () => {
  const { session, fake } = makeSession();
  const log: string[] = [];
  session.onStatus(() => log.push(`status:${session.status}`));
  session.onUserMessage(({ text }) => log.push(`user:${text}`));
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.onAssistantThinking(({ delta }) => log.push(`thinking:${delta}`));
  session.onToolUse(({ name }) => log.push(`tool:${name}`));

  session.start();

  // init carries the session id (no domain event, but captured).
  fake.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' } as StreamEvent);
  assert.equal(session.sessionId, 'sess-1');

  // A user turn → user row + working + the turn written to the transport.
  session.prompt('hello');
  assert.deepEqual(fake.sent, [{ type: 'user', message: { role: 'user', content: 'hello' } }]);

  // Text + thinking stream as token-level deltas (stream_event); the tool_use
  // arrives in the complete assistant event.
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } } } as unknown as StreamEvent);
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi there' } } } as unknown as StreamEvent);
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } } as StreamEvent);

  // Turn closes → idle.
  fake.emit({ type: 'result', subtype: 'success', result: 'hi there' } as StreamEvent);

  assert.deepEqual(log, [
    'user:hello',
    'status:working',
    'thinking:hmm',
    'assistant-start',
    'text:hi there',
    'tool:Bash',
    'status:idle',
  ]);
});

test('surfaces a non-streamed assistant reply (slash command) from the complete message', () => {
  // Slash-command replies (e.g. /context) arrive only as a complete `assistant`
  // event with NO preceding stream_event deltas — the text must still render.
  const { session, fake } = makeSession();
  const log: string[] = [];
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.start();

  session.prompt('/context');
  // No deltas — just the complete assistant message, then the result.
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '## Context Usage' }] } } as StreamEvent);
  fake.emit({ type: 'result', subtype: 'success' } as StreamEvent);

  assert.deepEqual(log, ['assistant-start', 'text:## Context Usage']);
  session.dispose();
});

test('does not double-render text that already streamed', () => {
  const { session, fake } = makeSession();
  const log: string[] = [];
  session.onAssistantStart(() => log.push('assistant-start'));
  session.onAssistantText(({ delta }) => log.push(`text:${delta}`));
  session.start();

  session.prompt('hi');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streamed' } } } as unknown as StreamEvent);
  // The complete message echoes the same text — it must NOT be emitted again.
  fake.emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'streamed' }] } } as StreamEvent);

  assert.deepEqual(log, ['assistant-start', 'text:streamed']);
  session.dispose();
});

test('interrupt sends a control_request and the resulting error is treated as an intentional stop', () => {
  const { session, fake } = makeSession();
  const events: string[] = [];
  session.onError(({ message }) => events.push(`error:${message}`));
  session.onInterrupted(() => events.push('interrupted'));
  session.onStatus(() => events.push(`status:${session.status}`));
  session.start();

  session.prompt('do something long');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } } } as unknown as StreamEvent);

  // Interrupt mid-turn: returns true and writes a control_request.
  const sent = session.interrupt();
  assert.equal(sent, true);
  const ctrl = fake.sent[fake.sent.length - 1] as { type: string; request_id: string; request: { subtype: string } };
  assert.equal(ctrl.type, 'control_request');
  assert.equal(ctrl.request.subtype, 'interrupt');

  // The success ack flips the status to idle immediately, before the result.
  fake.emit({ type: 'control_response', response: { subtype: 'success', request_id: ctrl.request_id } } as unknown as StreamEvent);
  assert.equal(session.status, 'idle', 'status updated on interrupt ack');

  // The interrupt produces an error_during_execution result — surfaced as an
  // intentional stop (onInterrupted), NOT an error row.
  fake.emit({ type: 'result', subtype: 'error_during_execution', is_error: true } as StreamEvent);

  assert.ok(events.includes('interrupted'), 'fired onInterrupted');
  assert.ok(!events.some((e) => e.startsWith('error:')), 'no error surfaced');
  assert.equal(session.status, 'idle');
  session.dispose();
});

test('interrupt is a no-op when nothing is running', () => {
  const { session, fake } = makeSession();
  session.start();
  assert.equal(session.interrupt(), false); // idle → caller can fall back (ctrl-c copies)
  assert.equal(fake.sent.length, 0);
  session.dispose();
});

test('an unrecognised event type is surfaced via onUnhandled (not silently dropped)', () => {
  const { session, fake } = makeSession();
  const seen: unknown[] = [];
  session.onUnhandled(({ event }) => seen.push(event));
  session.start();

  // A known type is handled (no unhandled emission)...
  fake.emit({ type: 'result', subtype: 'success' } as StreamEvent);
  // ...an unmodeled top-level type (e.g. an incoming control_request) is surfaced.
  const mystery = { type: 'control_request', request: { subtype: 'mcp_message' } } as unknown as StreamEvent;
  fake.emit(mystery);

  assert.deepEqual(seen, [mystery]);
  session.dispose();
});

test('parseQuestions normalizes AskUserQuestion input and drops malformed questions', () => {
  const qs = parseQuestions({
    questions: [
      { question: 'Tabs or spaces?', header: 'Indentation', multiSelect: false,
        options: [{ label: 'Tabs', description: 'tab chars' }, { label: 'Spaces' }] },
      { question: 'no options here', options: [] }, // dropped (no options)
      { question: 'multi', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ],
  });
  assert.equal(qs.length, 2);
  assert.deepEqual(qs[0], {
    question: 'Tabs or spaces?', header: 'Indentation', multiSelect: false,
    options: [{ label: 'Tabs', description: 'tab chars' }, { label: 'Spaces', description: undefined }],
  });
  assert.equal(qs[1].multiSelect, true);
  assert.equal(qs[1].header, 'multi'); // falls back to the question text
});

test('parseQuestions returns [] for non-AskUserQuestion shapes', () => {
  assert.deepEqual(parseQuestions({ command: 'ls' }), []);
  assert.deepEqual(parseQuestions(null), []);
});

test('process exit flips to exited and fires onExit', () => {
  const { session, fake } = makeSession();
  let exitCode: number | null | undefined;
  session.onExit((code) => { exitCode = code; });
  session.start();
  fake.emitExit(3);
  assert.equal(session.status, 'exited');
  assert.equal(exitCode, 3);
  session.dispose();
});

test('a new turn re-opens a fresh assistant row', () => {
  const { session, fake } = makeSession();
  const starts: number[] = [];
  session.onAssistantStart(() => starts.push(1));
  session.start();

  session.prompt('one');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } } } as unknown as StreamEvent);
  fake.emit({ type: 'result', subtype: 'success' } as StreamEvent);

  session.prompt('two');
  fake.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } } } as unknown as StreamEvent);

  assert.equal(starts.length, 2); // one assistant-start per turn
  session.dispose();
});
