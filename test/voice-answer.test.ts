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

// A mock of the answer package's WS /v1/chat endpoint (REQUIREMENTS-fdc.md):
// session.start carries the instructions, appends are acked by client_event_id.
async function mockAnswerChat(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-answer-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.on('listening', resolve));
  const received: any[] = [];
  server.on('connection', ws => {
    ws.on('message', raw => {
      const event = JSON.parse(raw.toString());
      received.push(event);
      if (event.type === 'session.start') ws.send(JSON.stringify({ type: 'session.started', session: { id: 'answer-1' } }));
      else if (event.type?.endsWith('.append') && event.event_id) ws.send(JSON.stringify({ type: event.type.replace('.append', '.appended'), client_event_id: event.event_id }));
      else if (event.type === 'session.close') { ws.send(JSON.stringify({ type: 'session.closed', reason: 'close_requested' })); ws.close(); }
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat`;
  const provider = createProvider('answer', { url });
  const budget = new UsageLedger(path.join(dir, 'budget.json'));
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { provider, budget, received };
}

test('the answer provider targets /v1/chat and starts with the fdc instructions', async t => {
  const { provider, budget, received } = await mockAnswerChat(t);
  assert.equal(provider.id, 'answer');
  assert.deepEqual(provider.capabilities, { nativeProtocol: false, webrtc: false, fork: false, contextRatio: false, usage: false });
  const live: VoiceSession = provider.createSession({ budget, instructions: 'Summarize the agent work briefly.', label: 'test' });
  await live.start();
  assert.equal(live.state, 'active');
  assert.equal(live.id, 'answer-1');
  await until(() => received.length >= 1);
  assert.equal(received[0].type, 'session.start');
  assert.equal(received[0].instructions, 'Summarize the agent work briefly.');
  await live.close();
});

test('appends are acked by echoing client_event_id, audio streams as base64 PCM, close settles cleanly', async t => {
  const { provider, budget, received } = await mockAnswerChat(t);
  const live: VoiceSession = provider.createSession({ budget, instructions: 'x', label: 'test' });
  await live.start();
  await live.append('thinking', 'agent ran the tests: all green');
  await live.append('instructions', 'always summarize first');
  live.audio(Buffer.from([5, 0, 6, 0]));
  await until(() => received.filter(e => e.type?.endsWith('.append')).length >= 3);
  const appends = received.filter(e => e.type?.endsWith('.append'));
  assert.deepEqual(appends.map(e => [e.type, e.content ?? e.audio]), [
    ['session.thinking.append', 'agent ran the tests: all green'],
    ['session.instructions.append', 'always summarize first'],
    ['session.input_audio.append', Buffer.from([5, 0, 6, 0]).toString('base64')],
  ]);
  const result = await live.close('operator ended voice');
  assert.equal(result.finalized, false);
  assert.equal(result.reserved, true);
  assert.equal(result.reason, 'operator ended voice');
});
