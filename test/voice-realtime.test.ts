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

// A mock OpenAI-Realtime-compatible server: it records what the session sends,
// answers session.update with session.updated, and can push any event.
async function mockRealtime(t: TestContext, onCommand: (ws: WebSocket, event: any) => void = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-rt-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  const received: any[] = [];
  let socket: WebSocket;
  server.on('connection', ws => {
    socket = ws;
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      received.push(event);
      if (event.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated', session: { id: 'rt-1' } }));
      else onCommand(ws, event);
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`;
  const provider = createProvider('openai-realtime', { url, apiKey: 'mock-key' });
  const budget = new UsageLedger(path.join(dir, 'budget.json'));
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { provider, budget, received, url, socket: () => socket! };
}

const session = (provider: ReturnType<typeof createProvider>, budget: UsageLedger, extra: Record<string, unknown> = {}): VoiceSession =>
  provider.createSession({ budget, instructions: 'be brief', label: 'test', ...extra });

test('start sends the session config and activates on session.updated', async t => {
  const { provider, budget, received, socket } = await mockRealtime(t);
  const live = session(provider, budget, { voice: 'alloy' });
  await live.start();
  assert.equal(live.state, 'active');
  assert.equal(live.id, 'rt-1');
  assert.equal(live.transport, 'websocket');
  const update = received.find(e => e.type === 'session.update');
  assert.equal(update.session.instructions, 'be brief');
  assert.equal(update.session.voice, 'alloy');
  assert.deepEqual(update.session.turn_detection, { type: 'server_vad' });
  await live.close('done');
  assert.ok(socket());
});

test('the bearer key from the config reaches the server handshake', async t => {
  let authorization: string | undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-rt-auth-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  server.on('connection', (ws, req) => { authorization = req.headers.authorization; ws.send(JSON.stringify({ type: 'session.updated', session: { id: 'x' } })); });
  const provider = createProvider('openai-realtime', { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime`, apiKey: 'mock-key' });
  const live = session(provider, new UsageLedger(path.join(dir, 'budget.json')));
  await live.start();
  assert.equal(authorization, 'Bearer mock-key');
  await live.close();
  for (const ws of server.clients) ws.terminate();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Realtime events are restated as Live events the bridge listens for', async t => {
  const { provider, budget, socket } = await mockRealtime(t);
  const live = session(provider, budget);
  await live.start();
  const events: any[] = [];
  live.on('event', e => events.push(e));
  socket().send(JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from('pcm').toString('base64') }));
  socket().send(JSON.stringify({ type: 'response.audio_transcript.delta', delta: 'Hello there' }));
  socket().send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hi you' }));
  socket().send(JSON.stringify({ type: 'response.done', response: { usage: { seconds: 4 } } }));
  await until(() => events.length >= 8);
  // Every server event passes through, and the ones the bridge cares about are
  // additionally restated in the Live shape (the restated event comes first).
  assert.deepEqual(events.map(e => e.type), [
    'session.output_audio.delta', 'response.audio.delta',
    'session.output_transcript.delta', 'response.audio_transcript.delta',
    'session.input_transcript.delta', 'conversation.item.input_audio_transcription.completed',
    'session.usage.updated', 'response.done',
  ]);
  await live.close();
});

test('appends become conversation items with the mapped role, and audio streams as base64 PCM', async t => {
  const { provider, budget, received } = await mockRealtime(t);
  const live = session(provider, budget);
  await live.start();
  await live.append('instructions', 'always test first');
  await live.append('commentary', 'working on it');
  live.audio(Buffer.from([1, 0, 2, 0]));
  await until(() => received.filter(e => e.type === 'conversation.item.create').length >= 2 && received.some(e => e.type === 'input_audio_buffer.append'));
  const kinds = received.filter(e => e.type === 'conversation.item.create');
  assert.equal(kinds[0].item.role, 'developer');
  assert.equal(kinds[0].item.content[0].text, 'always test first');
  assert.equal(kinds[1].item.role, 'assistant');
  assert.equal(received.find(e => e.type === 'input_audio_buffer.append').audio, Buffer.from([1, 0, 2, 0]).toString('base64'));
  assert.throws(() => live.audio(Buffer.from([1])), /complete 16-bit samples/);
  await live.close();
});

test('close sends session.close and settles with the reservation finalized at zero reported usage', async t => {
  const { provider, budget, received, socket } = await mockRealtime(t, (ws, event) => {
    if (event.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed' }));
  });
  const live = session(provider, budget);
  await live.start();
  const result = await live.close('operator ended voice');
  assert.equal(result.finalized, false);
  assert.equal(result.reserved, true);
  assert.equal(result.reason, 'operator ended voice');
  assert.equal(received.some(e => e.type === 'session.close'), true);
  assert.equal(budget.summary().runs.length, 1);
  socket(); // server still up at teardown
});

test('a server error aborts the session and reports a fault', async t => {
  const { provider, budget, socket } = await mockRealtime(t);
  const live = session(provider, budget);
  await live.start();
  const faults: string[] = [];
  live.on('fault', e => faults.push(e.message));
  socket().send(JSON.stringify({ type: 'error', error: { message: 'model overloaded' } }));
  const result = await live.closed;
  assert.equal(result.finalized, false);
  assert.match(faults.join(' '), /model overloaded/);
});
