import type { EventEmitter } from 'node:events';
import type { UsageLedger } from '../core/usage-ledger.ts';
import type { AppendKind } from '../core/context-queue.ts';

export type { AppendKind };
export const SAMPLE_RATE = 24000;

/**
 * How one voice session ended. `finalized` means the provider confirmed final
 * usage; `reserved` means a budget reservation was made for it.
 */
export interface CloseResult { finalized: boolean; reserved: boolean; usageSeconds: number; sessionId?: string; reason: string; closeCode?: number }

export type LiveState = 'new' | 'connecting' | 'active' | 'closing' | 'closed';

/**
 * One conversation with a voice backend, whatever the backend is. The rest of
 * the bridge (voice-sessions, mediator, context queue, watchdogs) talks only to
 * this interface, so providers can be swapped without touching the core.
 *
 * Events, all emitted on the session itself:
 * - 'event'  (raw provider event, normalized where the provider can) — the mediator
 *   listens for transcript, delegation and session events here;
 * - 'sent'   (a context append was sent) — perceived-input bookkeeping;
 * - 'answer' (WebRTC SDP answer for the page's offer) — only providers whose
 *   transport negotiates media;
 * - 'fault'  (an error the session survived or died of);
 * - 'closed' (CloseResult) — exactly once per session.
 */
export interface VoiceSession extends EventEmitter {
  /** Provider-local session id, once the session has started. */
  id?: string;
  state: LiveState;
  /** 'webrtc' when the page's microphone rides a negotiated media track, 'websocket' when the bridge streams PCM. */
  transport?: 'webrtc' | 'websocket';
  startedAt?: number;
  /** Budget reservation id for this session. */
  reservation?: string;
  /** The startup instructions, for the page's prompt preview. */
  instructions: string;
  /** Whether the session was asked to be stored for resuming/forking. */
  store: boolean;
  /** Whether the provider keeps the session for resuming/forking, as confirmed at startup. */
  stored: boolean;
  /** Set when someone (not the provider) asked for the close. */
  requested: boolean;
  /** Set once the page has the WebRTC media answer. */
  answered: boolean;
  /** Why the session closed, when it has. */
  closeReason?: string;
  /** Seconds of billable audio the provider reported. */
  usageSeconds: number;
  /** The provider's own final event, when it sent one before closing. */
  finalEvent?: { type?: string } & Record<string, unknown>;
  /** Underlying socket backpressure, when the transport has one. */
  ws?: { bufferedAmount: number };
  closed: Promise<CloseResult>;
  /** Starts the session, optionally with a WebRTC offer; resolves once the session is active. */
  start(sdp?: string): Promise<unknown>;
  /** Streams microphone PCM (24 kHz 16-bit mono) into the session. */
  audio(pcm: Buffer): void;
  /** Appends silent context ('thinking'/'commentary'/'instructions'), acknowledged by the provider. */
  append(kind: AppendKind, content: string, delegationId?: string | null): Promise<unknown>;
  /** A one-time welcome at the start of the connection. */
  greet(text: string): Promise<void>;
  /** Ends the session; resolves with its CloseResult. */
  close(reason?: string): Promise<CloseResult>;
}

/** What a session is created with. */
export interface SessionOptions {
  budget: UsageLedger;
  voice?: string;
  instructions?: string;
  input?: unknown[];
  label?: string;
  log?: (event: Record<string, unknown>) => void;
  /** Resume a stored session instead of starting new (provider may not support it). */
  store?: boolean;
  fork?: string;
}

/** A voice backend's capabilities: what the bridge may rely on. */
export interface VoiceCapabilities {
  /** The provider speaks a protocol the mediator's events understand natively (OpenAI Live's session.* events). */
  nativeProtocol: boolean;
  /** Media can be negotiated with a WebRTC offer from the page. */
  webrtc: boolean;
  /** The provider stores sessions server-side so a later session can fork them. */
  fork: boolean;
  /** The provider reports context-window fullness (session.usage.updated's ratio). */
  contextRatio: boolean;
  /** The provider reports billable usage seconds. */
  usage: boolean;
}

/**
 * One voice backend: configuration, capabilities, and the factory for its
 * sessions. This is the single entry point the rest of the bridge uses; which
 * backend is active comes from the selected provider's config file.
 */
export interface VoiceProvider {
  /** The provider's id, as in its config file's name (e.g. "openai-live"). */
  id: string;
  /** What the provider supports, so the bridge can degrade gracefully. */
  capabilities: VoiceCapabilities;
  /** Opens one voice session. */
  createSession(options: SessionOptions): VoiceSession;
}

/** Loads a provider by id from the registry; unknown ids are an error. */
export type ProviderFactory = (config: Record<string, unknown>) => VoiceProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(id: string, factory: ProviderFactory) {
  if (registry.has(id)) throw new Error(`Voice provider "${id}" is already registered`);
  registry.set(id, factory);
}

export function providerIds(): string[] { return [...registry.keys()]; }

export function createProvider(id: string, config: Record<string, unknown> = {}): VoiceProvider {
  const factory = registry.get(id);
  if (!factory) throw new Error(`Unknown voice provider "${id}". Available: ${providerIds().join(', ')}`);
  return factory(config);
}
