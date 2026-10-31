// Integration tests against real voice servers, selected by environment
// variables. Each test refuses to run — loudly, not skipped — when its
// endpoint is not configured, so a missing setup is never mistaken for a pass.
//
//   FDC_TEST_REALTIME_URL   ws://…/v1/realtime   a live OpenAI-Realtime-compatible server
//                           (FDC_TEST_REALTIME_KEY  its bearer key, when it requires one)
//   FDC_TEST_CASCADE_URL    ws://…/voice          a live cascaded local pipeline
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider, type VoiceSession } from '../src/voice/index.ts';
import { UsageLedger } from '../src/core/usage-ledger.ts';

function endpoint(name: string): string {
  const url = process.env[name];
  if (!url) {
    console.error(`fdc: ${name} is not set. Point it at a real server, for example:`);
    console.error(`  ${name}=ws://127.0.0.1:8765/v1/realtime npm run test:voice-providers`);
    process.exit(2);
  }
  return url;
}

const ledger = () => new UsageLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fd-voice-int-')), 'budget.json'));
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));

async function realtime() {
  const url = endpoint('FDC_TEST_REALTIME_URL');
  const provider = createProvider('openai-realtime', { url, apiKey: process.env.FDC_TEST_REALTIME_KEY });
  const live: VoiceSession = provider.createSession({ budget: ledger(), instructions: 'Answer in one short sentence.', label: 'integration' });
  const transcripts: string[] = [];
  live.on('event', e => { if (e.type === 'session.output_transcript.delta') transcripts.push(e.delta); });
  await live.start();
  assert.equal(live.state, 'active', 'session activates against the real server');
  await live.append('commentary', 'Say exactly: integration ok.');
  live.audio(Buffer.alloc(24000 * 2, 0)); // one silent second
  for (let i = 0; i < 100 && !transcripts.join('').toLowerCase().includes('integration'); i++) await settle(200);
  assert.ok(transcripts.length > 0, 'the real server spoke a transcript back');
  const result = await live.close('integration done');
  assert.equal(result.reserved, true);
  console.log(`openai-realtime OK (${url}): transcript "${transcripts.join('').slice(0, 80)}"`);
}

async function cascade() {
  const url = endpoint('FDC_TEST_CASCADE_URL');
  const provider = createProvider('local-cascade', { url });
  const live: VoiceSession = provider.createSession({ budget: ledger(), instructions: 'Answer in one short sentence.', label: 'integration' });
  const events: string[] = [];
  live.on('event', e => events.push(e.type));
  await live.start();
  assert.equal(live.state, 'active', 'session activates against the real pipeline');
  live.audio(Buffer.alloc(24000 * 2, 0));
  await live.append('commentary', 'Say exactly: integration ok.');
  for (let i = 0; i < 100 && !events.includes('session.output_audio.delta'); i++) await settle(200);
  assert.ok(events.includes('session.output_audio.delta'), 'the real pipeline returned audio');
  const result = await live.close('integration done');
  assert.equal(result.usageSeconds, 0, 'a local pipeline bills nothing');
  console.log(`local-cascade OK (${url})`);
}

const which = process.argv[2];
if (which === 'realtime') await realtime();
else if (which === 'cascade') await cascade();
else { await realtime(); await cascade(); }
