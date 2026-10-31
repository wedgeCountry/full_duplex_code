import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { UsageLedger } from '../../core/usage-ledger.ts';
import { registerProvider, type AppendKind, type CloseResult, type LiveState, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';

/** How the Realtime protocol's roles map onto the bridge's append kinds: agent facts and standing instructions are developer turns, what the companion says aloud is its own. */
const APPEND_ROLES: Record<AppendKind, string> = { thinking: 'developer', commentary: 'assistant', instructions: 'developer' };

// The session config sent once the socket opens: PCM in both directions, server
// voice activity detection, and fdc's startup instructions.
function sessionUpdate(instructions: string, voice?: string) {
  return {
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions,
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      voice,
      turn_detection: { type: 'server_vad' },
    },
  };
}

// Realtime protocol events, restated as the Live-shaped events the rest of the
// bridge already listens for: audio the page should play, transcripts for the
// captions and the floor, and usage for the meters.
function asLiveEvent(event: any): Record<string, unknown> | undefined {
  if (event.type === 'response.audio.delta' && typeof event.delta === 'string') return { type: 'session.output_audio.delta', delta: event.delta };
  if (event.type === 'response.audio_transcript.delta' && typeof event.delta === 'string') return { type: 'session.output_transcript.delta', delta: event.delta };
  if (event.type === 'conversation.item.input_audio_transcription.completed' && typeof event.transcript === 'string') return { type: 'session.input_transcript.delta', delta: event.transcript };
  if (event.type === 'input_audio_buffer.speech_started') return { type: 'session.input_audio.append' };
  if (event.type === 'response.done') {
    const usage = event.response?.usage;
    if (usage) return { type: 'session.usage.updated', usage: { seconds: usage.seconds ?? usage.input_audio_seconds ?? 0 }, context_window: usage.context_window };
  }
  return undefined;
}

/**
 * A self-hosted OpenAI-Realtime-compatible server (for example Hugging Face's
 * speech-to-speech, served at ws://127.0.0.1:8765/v1/realtime): open VAD, STT,
 * LLM and TTS models behind the Realtime event set. WebSocket PCM transport
 * only, no server-side storage or forking, no delegation tokens: the mediator
 * falls back to turn-based hand-off for the operator's words.
 */
class RealtimeSession extends EventEmitter implements VoiceSession {
  id?: string; state: LiveState = 'new'; transport: 'webrtc' | 'websocket' = 'websocket';
  startedAt?: number; reservation?: string; instructions: string; store = false; stored = false;
  requested = false; answered = false; closeReason?: string; usageSeconds = 0;
  ws?: { bufferedAmount: number }; closed: Promise<CloseResult>; resolveClosed!: (result: CloseResult) => void;
  private socket?: WebSocket; private budget: UsageLedger; private label: string;
  private log: (event: Record<string, unknown>) => void; private url: string; private voice?: string; private apiKey?: string;
  constructor({ url, apiKey, budget, voice, instructions, label, log }: { url: string; apiKey?: string; budget: UsageLedger; voice?: string; instructions: string; label: string; log: (event: Record<string, unknown>) => void }) {
    super();
    this.url = url; this.apiKey = apiKey; this.budget = budget; this.voice = voice; this.instructions = instructions; this.label = label; this.log = log;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start() {
    if (this.state !== 'new') throw new Error('Session already started');
    this.reservation = this.budget.reserve(null, this.label);
    this.state = 'connecting';
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const socket = this.socket = new WebSocket(this.url, { headers, handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    this.ws = socket;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.abort('session startup timed out'), 20000);
      socket.on('open', () => socket.send(JSON.stringify(sessionUpdate(this.instructions, this.voice))));
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.updated') {
          clearTimeout(timer);
          this.state = 'active'; this.id = event.session?.id; this.startedAt = Date.now();
          this.budget.update(this.reservation!, 0, { sessionId: this.id });
          resolve(event);
        } else this.receive(event);
      });
      socket.on('error', error => { this.emit('fault', error); this.abort(error.message); reject(error); });
      socket.on('close', (code, reason) => { this.log({ type: 'bridge.live_socket_closed', code, reason: reason.toString() || undefined }); this.finish(false); });
    });
  }
  private receive(event: any) {
    const live = asLiveEvent(event);
    if (live) this.emit('event', live);
    this.emit('event', event);
    if (event.type === 'error') {
      this.emit('fault', new Error(event.error?.message ?? 'Realtime API error'));
      if (this.state !== 'closing') this.abort(event.error?.message ?? 'Realtime error');
    }
  }
  audio(pcm: Buffer) {
    if (this.state !== 'active' || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples');
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }));
  }
  async append(kind: AppendKind, content: string): Promise<unknown> {
    if (this.state !== 'active') throw new Error(`Live session is ${this.state}`);
    const eventId = randomUUID();
    this.socket!.send(JSON.stringify({
      type: 'conversation.item.create', event_id: eventId,
      item: { type: 'message', role: APPEND_ROLES[kind], content: [{ type: 'input_text', text: content }] },
    }));
    this.emit('sent', { type: `session.${kind}.append`, event_id: eventId, content });
    return {};
  }
  async greet(text: string) { await this.append('commentary', text); }
  close(reason = 'requested'): Promise<CloseResult> {
    this.closeReason ??= reason; this.requested = true;
    if (this.state === 'active') {
      this.state = 'closing';
      this.socket!.send(JSON.stringify({ type: 'session.close' }));
      setTimeout(() => this.abort('Final usage timeout'), 15000).unref();
    } else if (this.state === 'new' || this.state === 'connecting') this.abort(reason);
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
    this.budget.update(this.reservation!, this.usageSeconds, { finalized, sessionId: this.id, reason: this.closeReason });
    const result: CloseResult = { finalized, reserved: Boolean(this.reservation), usageSeconds: this.usageSeconds, sessionId: this.id, reason: this.closeReason ?? 'connection lost' };
    this.log({ type: 'bridge.closed', ...result });
    this.resolveClosed(result); this.emit('closed', result);
  }
}

// OpenAI-Realtime-compatible local servers: the URL comes from the provider's
// own config file; an optional bearer key authenticates hosted-compatible ones.
class OpenAiRealtimeProvider implements VoiceProvider {
  id = 'openai-realtime';
  capabilities: VoiceCapabilities = { nativeProtocol: false, webrtc: false, fork: false, contextRatio: false, usage: true };
  config: Record<string, unknown> & { apiKey?: string };
  constructor(config: Record<string, unknown> & { apiKey?: string }) { this.config = config; }
  createSession({ budget, voice, instructions = '', label = 'voice session', log = () => {} }: SessionOptions): VoiceSession {
    const url = typeof this.config.url === 'string' ? this.config.url : 'ws://127.0.0.1:8765/v1/realtime';
    return new RealtimeSession({ url, apiKey: this.config.apiKey, budget, voice, instructions, label, log });
  }
}

registerProvider('openai-realtime', config => new OpenAiRealtimeProvider(config as Record<string, unknown> & { apiKey?: string }));
