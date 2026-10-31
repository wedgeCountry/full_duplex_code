# Voice providers

Everything the bridge knows about a voice backend sits behind one contract, [`provider.ts`](provider.ts): a `VoiceProvider` (its capabilities and a session factory) and the `VoiceSession` it creates. The rest of the core (`voice-sessions.ts`, `mediator.ts`, `context-queue.ts`) talks only to `VoiceSession`, so backends live alongside each other and none names another.

- **One entry point:** [`index.ts`](index.ts) registers every provider and exports `createProvider(id, config)`. `src/cli.ts` picks the active one with `--voice-provider <id>` or `FDC_VOICE_PROVIDER` (default `openai-live`) and hands it to the bridge.
- **One config file each:** `config/voice/<id>.json` holds only that provider's settings (endpoint URL, model, voice, `keyEnv` naming the credential's environment variable). No provider reads another's file.

## The providers

| id | file | backend | transport | forks |
| --- | --- | --- | --- | --- |
| `openai-live` | [providers/openai-live.ts](providers/openai-live.ts) | OpenAI GPT Live (`/v1/live/sessions`) | WebRTC + WebSocket | yes |
| `openai-realtime` | [providers/openai-realtime.ts](providers/openai-realtime.ts) | self-hosted Realtime-compatible server (e.g. Hugging Face speech-to-speech) | WebSocket | no |
| `local-cascade` | [providers/local-cascade.ts](providers/local-cascade.ts) | local STT+LLM+TTS pipeline (Pipecat/LiveKit style) | WebSocket | no |

## Add a provider

1. Add `config/voice/<id>.json` with its settings and, when it needs a credential, a `"keyEnv"` naming the environment variable.
2. Add `src/voice/providers/<id>.ts`: implement `VoiceProvider`, declare its `VoiceCapabilities`, and `registerProvider('<id>', …)`.
3. Import the file in `src/voice/index.ts` and add a row to the table above.

Capabilities the bridge degrades on: without `nativeProtocol` the mediator falls back to turn-based hand-off; without `fork`, Resume voice reseeds from the conversation's text; without `webrtc` the page's microphone streams PCM over the WebSocket; without `usage`/`contextRatio` the meters stay empty.
