import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { UsageLedger } from '../../core/usage-ledger.ts';
import { registerProvider, SAMPLE_RATE, type AppendKind, type CloseResult, type LiveState, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';

/**
 * A self-hosted OpenAI-Realtime-compatible server (for example Hugging Face's
 * speech-to-speech, served at ws://127.0.0.1:8765/v1/realtime): open VAD→STT→LLM→TTS
 * models speaking the Realtime event set. WebSocket PCM transport only, no
 * server-side storage or forking, no delegation tokens — the mediator degrades
 * to turn-based hand-off for the operator's words.
 */
class RealtimeSession extends EventEmitter implements VoiceSession {
  id?: string; state: LiveState = 'new'; transport: 'webrtc' | 'websocket' = 'websocket';
  startedAt?: number; reservation?: string; instructions: string; store = false; stored = false;
  requested = false; answered = false; closeReason?: string; usageSeconds = 0;
  ws?: { bufferedAmount: number }; closed: Promise<CloseResult>; resolveClosed!: (r: CloseResult) => void;
  private socket?: WebSocket; private budget: UsageLedger; private voice?: string; private input: unknown[];
  private label: string; private log: (event: Record<string, unknown>) => void; private url: string; private apiKey?: string;
  constructor({ url, apiKey, budget, voice, instructions, input, label, log }: { url: string; apiKey?: string; budget: UsageLedger; voice?: string; instructions: string; input: unknown[]; label: string; log: (e: Record<string, unknown>) => void }) {
    super();
    this.url = url; this.apiKey = apiKey; this.budget = budget; this.voice = voice; this.instructions = instructions; this.input = input; this.label = label; this.log = log;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start() {
    if (this.state !== 'new') throw new Error('Session already started');
    this.reservation = this.budget.reserve(null, this.label);
    this.state = 'connecting';
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const ws = this.socket = new WebSocket(this.url, { headers, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    this.ws = ws;
    const ready = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.abort('session startup timed out'); }, 20000);
      ws.on('open', () => ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: this.instructions,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          voice: this.voice,
          turn_detection: { type: 'server_vad' },
        },
      })));
      ws.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.updated') { clearTimeout(timer); this.state = 'active'; this.id = event.session?.id; this.startedAt = Date.now(); this.budget.update(this.reservation!, 0, { sessionId: this.id }); resolve(event); }
        else this.receive(event);
      });
      ws.on('error', err => { this.emit('fault', err); this.abort(err.message); reject(err); });
      ws.on('close', (code, reason) => { this.log({ type: 'bridge.live_socket_closed', code, reason: reason.toString() || undefined }); this.finish(false); });
    });
    return ready;
  }
  private receive(event: any) {
    if (event.type === 'response.audio.delta' && typeof event.delta === 'string') {
      this.emit('event', { type: 'session.output_audio.delta', delta: event.delta });
    } else if (event.type === 'input_audio_buffer.speech_started') {
      this.emit('event', { type: 'session.input_audio.append' });
    } else if (event.type === 'conversation.item.input_audio_transcription.completed' || event.type === 'response.audio_transcript.delta') {
      const delta = event.transcript ?? event.delta;
      if (delta) this.emit('event', { type: event.type === 'response.audio_transcript.delta' ? 'session.output_transcript.delta' : 'session.input_transcript.delta', delta });
    } else if (event.type === 'response.done') {
      const usage = event.response?.usage;
      if (usage) this.emit('event', { type: 'session.usage.updated', usage: { seconds: usage.seconds ?? usage.input_audio_seconds ?? 0 }, context_window: usage.context_window });
    }
    this.emit('event', event);
    if (event.type === 'error') { this.emit('fault', new Error(event.error?.message ?? 'Realtime API error')); if (this.state !== 'closing') this.abort(event.error?.message ?? 'Realtime error'); }
  }
  audio(pcm: Buffer) {
    if (this.state !== 'active' || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples');
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
  }
  async append(kind: AppendKind, content: string): Promise<unknown> {
    if (this.state !== 'active') throw new Error(`Live session is ${this.state}`);
    const map: Record<AppendKind, string> = { thinking: 'developer', commentary: 'assistant', instructions: 'developer' };
    const eventId = randomUUID();
    this.socket!.send(JSON.stringify({
      type: 'conversation.item.create', event_id: eventId,
      item: { type: 'message', role: map[kind], content: [{ type: 'input_text', text: content }] },
    }));
    this.emit('sent', { type: `session.${kind}.append`, event_id: eventId, content });
    return {};
  }
  async greet(text: string) { await this.append('commentary', text); }
  close(reason = 'requested'): Promise<CloseResult> {
    this.closeReason ??= reason; this.requested = true;
    if (this.state === 'active') { this.state = 'closing'; this.socket!.send(JSON.stringify({ type: 'session.close' })); setTimeout(() => this.abort('Final usage timeout'), 15000).unref(); }
    else if (this.state === 'new' || this.state === 'connecting') this.abort(reason);
    return this.closed;
  }
  private abort(reason: string) {
    if (this.state === 'closed') return;
    this.closeReason ??= reason; this.log({ type: 'bridge.aborted', reason });
    this.socket?.terminate(); this.finish(false);
  }
  private finish(finalized: boolean) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.budget.update(this.reservation!, this.usageSeconds, { finalized, sessionId: this.id, reason: this.closeReason });
    const result: CloseResult = { finalized, reserved: Boolean(this.reservation), usageSeconds: this.usageSeconds, sessionId: this.id, reason: this.closeReason ?? 'connection lost' };
    this.log({ type: 'bridge.closed', ...result });
    this.resolveClosed(result); this.emit('closed', result);
  }
}

class OpenAiRealtimeProvider implements VoiceProvider {
  id = 'openai-realtime';
  capabilities: VoiceCapabilities = { nativeProtocol: false, webrtc: false, fork: false, contextRatio: false, usage: true };
  config: Record<string, unknown> & { apiKey?: string };
  constructor(config: Record<string, unknown> & { apiKey?: string }) { this.config = config; }
  createSession({ budget, voice, instructions = '', input = [], label = 'voice session', log = () => {}, store: _store, fork: _fork }: SessionOptions): VoiceSession {
    const url = typeof this.config.url === 'string' ? this.config.url : 'ws://127.0.0.1:8765/v1/realtime';
    return new RealtimeSession({ url, apiKey: this.config.apiKey, budget, voice, instructions, input, label, log });
  }
}

registerProvider('openai-realtime', config => new OpenAiRealtimeProvider(config as Record<string, unknown> & { apiKey?: string }));
