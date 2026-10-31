import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { UsageLedger } from '../../core/usage-ledger.ts';
import { registerProvider, type AppendKind, type CloseResult, type LiveState, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';

/**
 * A cascaded local pipeline (Pipecat / LiveKit Agents style: local STT + local
 * LLM + local TTS behind one WebSocket). Half-duplex by nature: the provider
 * answers after the operator's turn ends, so the mediator's turn handling is
 * what carries the conversation. No billing: usage seconds stay zero.
 */
class CascadeSession extends EventEmitter implements VoiceSession {
  id?: string; state: LiveState = 'new'; transport: 'webrtc' | 'websocket' = 'websocket';
  startedAt?: number; reservation?: string; instructions: string; store = false; stored = false;
  requested = false; answered = false; closeReason?: string; usageSeconds = 0;
  ws?: { bufferedAmount: number }; closed: Promise<CloseResult>; resolveClosed!: (r: CloseResult) => void;
  private socket?: WebSocket; private budget: UsageLedger; private label: string;
  private log: (event: Record<string, unknown>) => void; private url: string;
  constructor({ url, budget, instructions, label, log }: { url: string; budget: UsageLedger; instructions: string; label: string; log: (e: Record<string, unknown>) => void }) {
    super();
    this.url = url; this.budget = budget; this.instructions = instructions; this.label = label; this.log = log;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start() {
    if (this.state !== 'new') throw new Error('Session already started');
    this.reservation = this.budget.reserve(null, this.label);
    this.state = 'connecting';
    const ws = this.socket = new WebSocket(this.url, { handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    this.ws = ws;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.abort('session startup timed out'), 20000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'session.start', instructions: this.instructions })));
      ws.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.started') { clearTimeout(timer); this.state = 'active'; this.id = event.session?.id ?? randomUUID(); this.startedAt = Date.now(); resolve(event); }
        else if (event.type === 'session.output_audio.delta' || event.type === 'session.output_transcript.delta' || event.type === 'session.input_transcript.delta') this.emit('event', event);
        else if (event.type === 'error') { this.emit('fault', new Error(event.error?.message ?? 'cascade error')); this.abort(event.error?.message ?? 'cascade error'); }
        this.emit('event', event);
      });
      ws.on('error', err => { this.emit('fault', err); this.abort(err.message); reject(err); });
      ws.on('close', (code, reason) => { this.log({ type: 'bridge.live_socket_closed', code, reason: reason.toString() || undefined }); this.finish(false); });
    });
  }
  audio(pcm: Buffer) {
    if (this.state !== 'active' || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (pcm.length % 2) throw new Error('PCM must contain complete 16-bit samples');
    this.socket.send(JSON.stringify({ type: 'session.input_audio.append', audio: pcm.toString('base64') }));
  }
  async append(kind: AppendKind, content: string): Promise<unknown> {
    if (this.state !== 'active') throw new Error(`Live session is ${this.state}`);
    const eventId = randomUUID();
    this.socket!.send(JSON.stringify({ type: `session.${kind}.append`, event_id: eventId, content }));
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
    this.closeReason ??= reason; this.log({ type: 'bridge.aborted', reason });
    this.socket?.terminate(); this.finish(false);
  }
  private finish(finalized: boolean) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const result: CloseResult = { finalized, reserved: Boolean(this.reservation), usageSeconds: this.usageSeconds, sessionId: this.id, reason: this.closeReason ?? 'connection lost' };
    this.log({ type: 'bridge.closed', ...result });
    this.resolveClosed(result); this.emit('closed', result);
  }
}

class LocalCascadeProvider implements VoiceProvider {
  id = 'local-cascade';
  capabilities: VoiceCapabilities = { nativeProtocol: false, webrtc: false, fork: false, contextRatio: false, usage: false };
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) { this.config = config; }
  createSession({ budget, instructions = '', label = 'voice session', log = () => {} }: SessionOptions): VoiceSession {
    const url = typeof this.config.url === 'string' ? this.config.url : 'ws://127.0.0.1:8080/voice';
    return new CascadeSession({ url, budget, instructions, label, log });
  }
}

registerProvider('local-cascade', config => new LocalCascadeProvider(config));
