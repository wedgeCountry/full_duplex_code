import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { UsageLedger } from '../src/core/usage-ledger.ts';
import { createProvider, type VoiceSession } from '../src/voice/index.ts';

const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean, tries = 100) => { for (let i = 0; i < tries && !check(); i++) await settle(); if (!check()) throw new Error('timed out waiting for the mock server'); };

// protocol.rs MsgType bytes, as the mock server speaks them.
const MSG = { handshake: 0x00, audio: 0x01, text: 0x02, error: 0x05 } as const;
const frame = (kind: number, payload: Buffer | string = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from([kind]), Buffer.isBuffer(payload) ? payload : Buffer.from(payload)]);

// A mock moshi-server LM socket: sends the 9-byte handshake on connect, records
// text frames, and can push transcript (text) and error frames.
async function mockMoshi(t: TestContext, onMessage: (ws: WebSocket, kind: number, payload: Buffer) => void = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-moshi-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  const received: { kind: number; payload: Buffer }[] = [];
  let socket: WebSocket;
  server.on('connection', ws => {
    socket = ws;
    ws.send(frame(MSG.handshake, Buffer.alloc(8)));
    ws.on('message', (raw: Buffer) => {
      const kind = raw[0], payload = raw.subarray(1);
      received.push({ kind, payload });
      onMessage(ws, kind, payload);
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`;
  const provider = createProvider('moshi', { url, apiKey: 'public_token' });
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

test('start waits for the 9-byte handshake, sends the startup instructions as a text frame, and activates', async t => {
  const { provider, budget, received } = await mockMoshi(t);
  const live = session(provider, budget);
  await live.start();
  assert.equal(live.state, 'active');
  assert.ok(live.id);
  await until(() => received.length >= 1);
  assert.equal(received[0].kind, MSG.text);
  assert.equal(received[0].payload.toString(), 'be brief');
  await live.close();
});

test('the kyutai-api-key header from the config reaches the server handshake', async t => {
  let key: string | undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-moshi-auth-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  server.on('connection', (ws, req) => { key = String(req.headers['kyutai-api-key']); ws.send(frame(MSG.handshake, Buffer.alloc(8))); });
  const provider = createProvider('moshi', { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/chat`, apiKey: 'secret-id' });
  const live = session(provider, new UsageLedger(path.join(dir, 'budget.json')));
  await live.start();
  assert.equal(key, 'secret-id');
  await live.close();
  for (const ws of server.clients) ws.terminate();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Moshi text frames are restated as output transcript deltas for the bridge', async t => {
  const { provider, budget, socket } = await mockMoshi(t);
  const live = session(provider, budget);
  await live.start();
  const events: any[] = [];
  live.on('event', e => events.push(e));
  socket().send(frame(MSG.text, 'Working on it'));
  await until(() => events.length >= 1);
  assert.deepEqual(events[0], { type: 'session.output_transcript.delta', delta: 'Working on it' });
  await live.close();
});

test('appends go out as text frames and are reported as sent with their kind', async t => {
  const { provider, budget, received } = await mockMoshi(t);
  const live = session(provider, budget);
  const sent: any[] = [];
  live.on('sent', e => sent.push(e));
  await live.start();
  await live.append('instructions', 'always test first');
  await live.greet('hello');
  await until(() => received.filter(r => r.kind === MSG.text).length >= 3);
  assert.equal(received[1].payload.toString(), 'always test first');
  assert.equal(received[2].payload.toString(), 'hello');
  assert.deepEqual(sent.map(e => e.type), ['session.instructions.append', 'session.commentary.append']);
  await live.close();
});

test('a server error frame aborts with a fault and an unfinalized close at zero usage', async t => {
  const { provider, budget, socket } = await mockMoshi(t);
  const live = session(provider, budget);
  await live.start();
  const faults: string[] = [];
  live.on('fault', e => faults.push(e.message));
  socket().send(frame(MSG.error, 'model exploded'));
  const result = await live.closed;
  assert.match(faults.join(' '), /model exploded/);
  assert.equal(result.finalized, false);
  assert.equal(result.usageSeconds, 0);
  assert.equal(result.reserved, true);
});

test('microphone audio is refused loudly until an Opus codec is bundled', async t => {
  const { provider, budget } = await mockMoshi(t);
  const live = session(provider, budget);
  await live.start();
  assert.throws(() => live.audio(Buffer.alloc(1920 * 2)), /Opus codec/);
  await live.close();
});
