import { LiveSession } from '../../core/live-session.ts';
import { registerProvider, SAMPLE_RATE, type SessionOptions, type VoiceCapabilities, type VoiceProvider, type VoiceSession } from '../provider.ts';

export { LiveSession, SAMPLE_RATE };
export type { VoiceSession };

/**
 * OpenAI's GPT Live (`/v1/live/sessions`, model gpt-live-1): the provider fdc
 * started with. WebRTC or WebSocket transport, server-side session storage and
 * forking, delegation tokens, and usage reports. The API key comes from the
 * environment variable named by config/voice/openai-live.json ("OPENAI_API_KEY").
 */
class OpenAiLiveProvider implements VoiceProvider {
  id = 'openai-live';
  capabilities: VoiceCapabilities = { nativeProtocol: true, webrtc: true, fork: true, contextRatio: true, usage: true };
  config: Record<string, unknown> & { apiKey?: string };
  constructor(config: Record<string, unknown> & { apiKey?: string }) { this.config = config; }
  createSession({ budget, voice, instructions = '', input = [], label, log, store = false, fork }: SessionOptions): VoiceSession {
    const url = typeof this.config.url === 'string' ? this.config.url : undefined;
    return new LiveSession({ apiKey: this.config.apiKey ?? '', budget, voice, instructions, input, label, log, url, store, fork });
  }
}

registerProvider('openai-live', config => new OpenAiLiveProvider(config as Record<string, unknown> & { apiKey?: string }));
