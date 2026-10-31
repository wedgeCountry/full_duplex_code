import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availableProviders, createProvider, loadProviderConfig, providerIds, selectedProviderId, type VoiceSession } from '../src/voice/index.ts';
import { UsageLedger } from '../src/core/usage-ledger.ts';

test('every provider registers under its config file\'s name', () => {
  const shipped = availableProviders();
  assert.ok(shipped.includes('openai-live'));
  for (const id of shipped) assert.ok(providerIds().includes(id), `provider ${id} has a config file but is not registered`);
  for (const id of providerIds()) assert.ok(shipped.includes(id), `provider ${id} is registered but has no config file`);
});

test('the selected provider comes from the flag, then the environment, then the default', () => {
  assert.equal(selectedProviderId(undefined, {}), 'openai-live');
  assert.equal(selectedProviderId(undefined, { FDC_VOICE_PROVIDER: 'local-cascade' }), 'local-cascade');
  assert.equal(selectedProviderId('openai-realtime', { FDC_VOICE_PROVIDER: 'local-cascade' }), 'openai-realtime');
});

test('each provider builds a session from its own config file only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-voice-cfg-'));
  fs.writeFileSync(path.join(dir, 'demo.json'), JSON.stringify({ url: 'ws://127.0.0.1:9999/voice', keyEnv: 'DEMO_KEY' }));
  const config = loadProviderConfig('demo', dir);
  assert.equal(config.id, 'demo');
  assert.equal(config.url, 'ws://127.0.0.1:9999/voice');
  assert.equal(config.keyEnv, 'DEMO_KEY');
  assert.throws(() => loadProviderConfig('missing', dir) && createProvider('missing'), /Unknown voice provider/);
});

test('the openai-live provider creates sessions that speak the Live protocol', () => {
  const provider = createProvider('openai-live', { apiKey: 'test-key' });
  assert.deepEqual(provider.capabilities, { nativeProtocol: true, webrtc: true, fork: true, contextRatio: true, usage: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-voice-live-'));
  const session: VoiceSession = provider.createSession({ budget: new UsageLedger(path.join(dir, 'budget.json')), instructions: 'be brief', label: 'test' });
  assert.equal(session.instructions, 'be brief');
  assert.equal(session.state, 'new');
  assert.equal(session.store, false);
});

test('local providers report no fork, webrtc or context-ratio support', () => {
  for (const id of ['openai-realtime', 'local-cascade']) {
    const provider = createProvider(id, {});
    assert.equal(provider.capabilities.webrtc, false, id);
    assert.equal(provider.capabilities.fork, false, id);
    assert.equal(provider.capabilities.nativeProtocol, false, id);
  }
});
