import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { UsageLedger } from '../../core/usage-ledger.ts';
import { registerProvider, type AppendKind, type CloseResult, type LiveState, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';

/**
 * A cascaded local pipeline (Pipecat / LiveKit Agents style): local STT, a local
 * LLM and local TTS behind one WebSocket that speaks the same minimal event set
 * this provider defines. Half-duplex by nature — the pipeline answers after the
 * operator's turn ends — and free: no provider reports usage, so the ledger's
 * reservation settles at zero.
 *
 * Wire protocol (JSON text frames, PCM 24 kHz 16-bit mono base64 in `audio`):
 *   client → server  session.start { instructions }
 *                    session.input_audio.append { audio }
 *                    session.<thinking|commentary|instructions>.append { event_id, content }
 *                    session.close
 *   server → client  session.started { session: { id } }
 *                    session.output_audio.delta { delta }
 *                    session.input_transcript.delta { delta } / session.output_transcript.delta { delta }
 *                    error { error: { message } }
 */
class CascadeSession extends EventEmitter implements VoiceSession {
  id?: string; state: LiveState = 'new'; transport: 'webrtc' | 'websocket' = 'websocket';
  startedAt?: number; reservation?: string; instructions: string; store = false; stored = false;
  requested = false; answered = false; closeReason?: string; usageSeconds = 0;
  ws?: { bufferedAmount: number }; closed: Promise<CloseResult>; resolveClosed!: (result: CloseResult) => void;
  private socket?: WebSocket; private budget: UsageLedger; private label: string;
  private log: (event: Record<string, unknown>) => void; private url: string;
  constructor({ url, budget, instructions, label, log }: { url: string; budget: UsageLedger; instructions: string; label: string; log: (event: Record<string, unknown>) => void }) {
    super();
    this.url = url; this.budget = budget; this.instructions = instructions; this.label = label; this.log = log;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
  }
  async start() {
    if (this.state !== 'new') throw new Error('Session already started');
    this.reservation = this.budget.reserve(null, this.label);
    this.state = 'connecting';
    const socket = this.socket = new WebSocket(this.url, { handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
    this.ws = socket;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.abort('session startup timed out'), 20000);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'session.start', instructions: this.instructions })));
      socket.on('message', raw => {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.started') {
          clearTimeout(timer);
          this.state = 'active'; this.id = event.session?.id ?? randomUUID(); this.startedAt = Date.now();
          this.budget.update(this.reservation!, 0, { sessionId: this.id });
          resolve(event);
        } else if (event.type === 'error') {
          this.emit('fault', new Error(event.error?.message ?? 'cascade error'));
          this.abort(event.error?.message ?? 'cascade error');
        } else this.emit('event', event);
      });
      socket.on('error', error => { this.emit('fault', error); this.abort(error.message); reject(error); });
      socket.on('close', (code, reason) => { this.log({ type: 'bridge.live_socket_closed', code, reason: reason.toString() || undefined }); this.finish(false); });
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
    this.closeReason ??= reason;
    this.log({ type: 'bridge.aborted', reason });
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

// Local pipelines need no credential; the endpoint comes from the provider's
// own config file.
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
