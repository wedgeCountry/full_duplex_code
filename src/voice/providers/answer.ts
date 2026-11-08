import { registerProvider, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';
import { CascadeSession } from './local-cascade.ts';

/**
 * The `answer` package (wedgeCountry/answer) as a voice backend: its WS /v1/chat
 * endpoint runs VAD → STT → a small local LM → TTS in one session socket, speaking
 * the same wire protocol as local-cascade (the session class is shared, not
 * duplicated). The LM call carries fdc's instructions (session.start.instructions,
 * updated by session.instructions.append) — see REQUIREMENTS-fdc.md in the answer
 * repo. Free and half-duplex: no usage, no forking, no WebRTC.
 */
class AnswerProvider implements VoiceProvider {
  id = 'answer';
  capabilities: VoiceCapabilities = { nativeProtocol: false, webrtc: false, fork: false, contextRatio: false, usage: false };
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) { this.config = config; }
  createSession({ budget, instructions = '', label = 'voice session', log = () => {} }: SessionOptions): VoiceSession {
    const url = typeof this.config.url === 'string' ? this.config.url : 'ws://127.0.0.1:8000/v1/chat';
    return new CascadeSession({ url, budget, instructions, label, log });
  }
}

registerProvider('answer', config => new AnswerProvider(config));
