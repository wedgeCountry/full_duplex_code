import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { UsageLedger } from '../src/core/usage-ledger.ts';

const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean, tries = 100) => { for (let i = 0; i < tries && !check(); i++) await settle(); if (!check()) throw new Error('timed out waiting for the mock server'); };
import { createProvider, type VoiceSession } from '../src/voice/index.ts';

// A mock cascaded pipeline (STT+LLM+TTS behind one socket), speaking the wire
// protocol documented in src/voice/providers/local-cascade.ts.
async function mockCascade(t: TestContext, onCommand: (ws: WebSocket, event: any) => void = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-cascade-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  const received: any[] = [];
  let socket: WebSocket;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      received.push(event);
      if (event.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started', session: { id: 'cas-1' } }));
      else onCommand(ws, event);
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice`;
  const provider = createProvider('local-cascade', { url });
  const budget = new UsageLedger(path.join(dir, 'budget.json'));
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { provider, budget, received, socket: () => socket! };
}

const session = (provider: ReturnType<typeof createProvider>, budget: UsageLedger): VoiceSession =>
  provider.createSession({ budget, instructions: 'be brief', label: 'test' });

test('start sends the instructions and activates on session.started', async t => {
  const { provider, budget, received } = await mockCascade(t);
  const live = session(provider, budget);
  await live.start();
  assert.equal(live.state, 'active');
  assert.equal(live.id, 'cas-1');
  assert.equal(received[0].type, 'session.start');
  assert.equal(received[0].instructions, 'be brief');
  await live.close();
});

test('context appends and microphone audio go out as session frames', async t => {
  const { provider, budget, received } = await mockCascade(t);
  const live = session(provider, budget);
  const sent: any[] = [];
  live.on('sent', e => sent.push(e));
  await live.start();
  await live.append('thinking', 'agent facts');
  await live.greet('hi');
  live.audio(Buffer.from([3, 0, 4, 0]));
  await until(() => received.filter(e => e.type.endsWith('.append')).length >= 3);
  assert.deepEqual(received.filter(e => e.type.endsWith('.append')).map(e => [e.type, e.content ?? e.audio]), [
    ['session.thinking.append', 'agent facts'],
    ['session.commentary.append', 'hi'],
    ['session.input_audio.append', Buffer.from([3, 0, 4, 0]).toString('base64')],
  ]);
  assert.deepEqual(sent.map(e => e.type), ['session.thinking.append', 'session.commentary.append']);
  await live.close();
});

test('server events pass through to the bridge unchanged', async t => {
  const { provider, budget, socket } = await mockCascade(t);
  const live = session(provider, budget);
  await live.start();
  const events: any[] = [];
  live.on('event', e => events.push(e));
  socket().send(JSON.stringify({ type: 'session.output_audio.delta', delta: 'AAAA' }));
  socket().send(JSON.stringify({ type: 'session.output_transcript.delta', delta: 'done' }));
  await until(() => events.length >= 2);
  assert.deepEqual(events.map(e => e.type), ['session.output_audio.delta', 'session.output_transcript.delta']);
  await live.close();
});

test('closing an active session closes the socket and settles unfinalized with zero usage', async t => {
  const { provider, budget } = await mockCascade(t);
  const live = session(provider, budget);
  await live.start();
  const result = await live.close('requested');
  assert.equal(live.state, 'closed');
  assert.equal(result.finalized, false);
  assert.equal(result.usageSeconds, 0);
  assert.equal(result.reserved, true);
  assert.equal(budget.summary().runs[0].finalized, false);
});

test('closing before start settles without a reservation', async t => {
  const { provider, budget } = await mockCascade(t);
  const live = session(provider, budget);
  const result = await live.close();
  assert.equal(result.reserved, false);
  assert.equal(budget.summary().runs.length, 0);
});

test('a pipeline error aborts with a fault and an unfinalized close', async t => {
  const { provider, budget, socket } = await mockCascade(t);
  const live = session(provider, budget);
  await live.start();
  const faults: string[] = [];
  live.on('fault', e => faults.push(e.message));
  socket().send(JSON.stringify({ type: 'error', error: { message: 'tts exploded' } }));
  const result = await live.closed;
  assert.match(faults.join(' '), /tts exploded/);
  assert.equal(result.finalized, false);
});
