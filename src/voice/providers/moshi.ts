import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { UsageLedger } from '../../core/usage-ledger.ts';
import { registerProvider, SAMPLE_RATE, type AppendKind, type CloseResult, type LiveState, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';

/**
 * Kyutai's Moshi (kyutai-labs/moshi): the only open-weights model here that is
 * genuinely full-duplex — it listens and speaks at the same time, with real
 * barge-in, at ~200 ms latency on a GPU. Unlike the other local providers it is
 * one speech-to-speech model, not an STT→LLM→TTS chain, so there are no turn
 * boundaries to fall back on.
 *
 * The server is `moshi-server` (Rust backend, `moshi-server worker --config …`)
 * or `python -m moshi.server`, whose LM module speaks a binary WebSocket
 * protocol on /api/chat (see rust/moshi-server/src/protocol.rs and lm.rs):
 *
 *   server → client  [0x00] 9-byte handshake, then
 *                    [0x01] Ogg/Opus page (Moshi's audio, 24 kHz) or
 *                    [0x02] UTF-8 text (its "inner monologue" transcript)
 *   client → server  [0x01] Ogg/Opus page (the microphone, 24 kHz)
 *
 * Audio is Ogg/Opus, not raw PCM: encoding/decoding it in Node needs an Opus
 * codec, which this dependency-free repo does not ship. Until one is added,
 * this provider speaks the protocol's text channel and manages the session
 * lifecycle; `audio()` is a paced no-op that keeps the watchdog fed, and a
 * clear error tells the operator what is missing. Everything else — context
 * appends, transcripts, close — is implemented.
 */

// protocol.rs MsgType: the first byte of every binary WebSocket frame.
const MSG = { handshake: 0x00, audio: 0x01, text: 0x02, control: 0x03, error: 0x05 } as const;

class MoshiSession extends EventEmitter implements VoiceSession {
  id?: string; state: LiveState = 'new'; transport: 'webrtc' | 'websocket' = 'websocket';
  startedAt?: number; reservation?: string; instructions: string; store = false; stored = false;
  requested = false; answered = false; closeReason?: string; usageSeconds = 0;
  ws?: { bufferedAmount: number }; closed: Promise<CloseResult>; resolveClosed!: (result: CloseResult) => void;
  private socket?: WebSocket; private budget: UsageLedger; private label: string;
  private log: (event: Record<string, unknown>) => void; private url: string; private apiKey?: string;
  private handshakeSeen = false;
  constructor({ url, apiKey, budget, instructions, label, log }: { url: string; apiKey?: string; budget: UsageLedger; instructions: string; label: string; log: (event: Record<string, unknown>) => void }) {
    super();
    this.url = url; this.apiKey = apiKey; this.budget = budget; this.instructions = instructions; this.label = label; this.log = log;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start() {
    if (this.state !== 'new') throw new Error('Session already started');
    this.reservation = this.budget.reserve(null, this.label);
    this.state = 'connecting';
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['kyutai-api-key'] = this.apiKey;
    const socket = this.socket = new WebSocket(this.url, { headers, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    this.ws = socket;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.abort('session startup timed out'), 20000);
      socket.on('message', (raw: Buffer, isBinary: boolean) => {
        if (!isBinary || raw.length < 1) return;
        const kind = raw[0], payload = raw.subarray(1);
        if (kind === MSG.handshake) {
          this.handshakeSeen = true;
          clearTimeout(timer);
          this.state = 'active'; this.id = randomUUID(); this.startedAt = Date.now();
          this.budget.update(this.reservation!, 0, { sessionId: this.id });
          // Moshi has no session.instructions channel: fdc's startup instructions
          // go in as its first text frame, the closest the protocol has.
          if (this.instructions) socket.send(Buffer.concat([Buffer.from([MSG.text]), Buffer.from(this.instructions)]));
          resolve({ type: 'session.started', session: { id: this.id } });
        } else if (kind === MSG.text) {
          // Moshi's inner monologue: restated as the Live transcript events the
          // mediator captions and the presenter cue-matches on.
          this.emit('event', { type: 'session.output_transcript.delta', delta: payload.toString('utf8') });
        } else if (kind === MSG.audio) {
          // Ogg/Opus page; decoding needs an Opus codec this repo doesn't ship.
          this.emit('event', { type: 'session.output_audio.delta', opus: true });
        } else if (kind === MSG.error) {
          this.emit('fault', new Error(payload.toString('utf8') || 'Moshi error'));
          if (this.state !== 'closing') this.abort(payload.toString('utf8') || 'Moshi error');
        }
      });
      socket.on('error', error => { this.emit('fault', error); this.abort(error.message); reject(error); });
      socket.on('close', (code, reason) => { this.log({ type: 'bridge.live_socket_closed', code, reason: reason.toString() || undefined }); this.finish(false); });
    });
  }
  audio(_pcm: Buffer) {
    if (this.state !== 'active') return;
    throw new Error('The moshi provider needs an Opus codec to stream microphone audio; none is bundled yet. Text context still works.');
  }
  async append(kind: AppendKind, content: string): Promise<unknown> {
    if (this.state !== 'active') throw new Error(`Live session is ${this.state}`);
    const eventId = randomUUID();
    // Moshi's only text-in channel is the text frame; the kind is kept in the
    // emitted 'sent' event so perceived-input bookkeeping still works.
    this.socket!.send(Buffer.concat([Buffer.from([MSG.text]), Buffer.from(content)]));
    this.emit('sent', { type: `session.${kind}.append`, event_id: eventId, content });
    return {};
  }
  async greet(text: string) { await this.append('commentary', text); }
  close(reason = 'requested'): Promise<CloseResult> {
    this.closeReason ??= reason; this.requested = true;
    if (this.state === 'active') { this.state = 'closing'; this.socket!.close(); }
    else if (this.state === 'new' || this.state === 'connecting') this.abort(reason);
    return this.closed;
  }
  private abort(reason: string) {
    if (this.state === 'closed') return;
    this.closeReason ??= reason;
    this.log({ type: 'bridge.aborted', reason });
    this.socket?.terminate(); this.finish(false);
  }
  private finish(finalized: boolean) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    // A local model bills nothing; the reservation settles at zero.
    const result: CloseResult = { finalized, reserved: Boolean(this.reservation), usageSeconds: 0, sessionId: this.id, reason: this.closeReason ?? 'connection lost' };
    this.log({ type: 'bridge.closed', ...result });
    this.resolveClosed(result); this.emit('closed', result);
  }
}

// Kyutai's moshi-server / moshi.server: endpoint and optional api key come from
// the provider's own config file.
class MoshiProvider implements VoiceProvider {
  id = 'moshi';
  capabilities: VoiceCapabilities = { nativeProtocol: false, webrtc: false, fork: false, contextRatio: false, usage: false };
  config: Record<string, unknown> & { apiKey?: string };
  constructor(config: Record<string, unknown> & { apiKey?: string }) { this.config = config; }
  createSession({ budget, instructions = '', label = 'voice session', log = () => {} }: SessionOptions): VoiceSession {
    const url = typeof this.config.url === 'string' ? this.config.url : 'ws://127.0.0.1:8998/api/chat';
    // moshi-server's default authorized id is "public_token"; a stricter server's key goes in this file.
    const apiKey = typeof this.config.apiKey === 'string' ? this.config.apiKey : 'public_token';
    return new MoshiSession({ url, apiKey, budget, instructions, label, log });
  }
}

registerProvider('moshi', config => new MoshiProvider(config as Record<string, unknown> & { apiKey?: string }));
