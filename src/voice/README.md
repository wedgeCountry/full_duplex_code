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
| `moshi` | [providers/moshi.ts](providers/moshi.ts) | Kyutai Moshi via `moshi-server` (`/api/chat`) — genuinely full-duplex, ~200 ms, real barge-in | WebSocket (binary, Ogg/Opus) | no |

### Moshi

Moshi is the only provider here that talks and listens at the same time — one open-weights speech-to-speech model (7B, Mimi codec), not a pipeline, so there are no turn boundaries. Run `moshi-server worker --config config.toml` (Rust backend; `python -m moshi.server` also works) and point `config/voice/moshi.json` at its `/api/chat` endpoint. The wire protocol (one-byte frame kinds, Ogg/Opus audio, UTF-8 text) is documented in the provider file, from `rust/moshi-server/src/protocol.rs` and `lm.rs`. Known limit, stated in the code: Node has no Opus codec bundled, so `audio()` refuses loudly until one is added; text context, transcripts and session lifecycle are implemented.

## Add a provider

1. Add `config/voice/<id>.json` with its settings and, when it needs a credential, a `"keyEnv"` naming the environment variable.
2. Add `src/voice/providers/<id>.ts`: implement `VoiceProvider`, declare its `VoiceCapabilities`, and `registerProvider('<id>', …)`.
3. Import the file in `src/voice/index.ts` and add a row to the table above.

Capabilities the bridge degrades on: without `nativeProtocol` the mediator falls back to turn-based hand-off; without `fork`, Resume voice reseeds from the conversation's text; without `webrtc` the page's microphone streams PCM over the WebSocket; without `usage`/`contextRatio` the meters stay empty.

## Tests

- **Unit, offline:** `test/voice-realtime.test.ts`, `test/voice-cascade.test.ts` and `test/voice-moshi.test.ts` run each provider against a mock WebSocket server on 127.0.0.1 that speaks its protocol (Moshi's mock speaks the binary frame kinds); they are part of `npm test`.
- **Integration, against real servers:** `npm run test:voice-providers` (`scripts/test-voice-providers.ts`) needs `FDC_TEST_REALTIME_URL` (plus `FDC_TEST_REALTIME_KEY` when the server requires a key), `FDC_TEST_CASCADE_URL` and/or `FDC_TEST_MOSHI_URL`; it exits with an error naming the missing variable when one is not set, so an unconfigured run can never look like a pass.
