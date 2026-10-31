import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Each voice provider has its own configuration file, `config/voice/<id>.json`,
 * holding only what that provider needs (endpoint, model, key name, transport).
 * The selected provider is chosen by id — `--voice-provider <id>`, else
 * FDC_VOICE_PROVIDER, else the "default" entry — and its file is loaded here.
 * Environment variables still override: a `KEY_ENV` entry names the variable
 * that must hold the credential, and `*_URL` entries may point elsewhere.
 */
export interface ProviderConfig {
  id: string;
  /** Environment variable that must hold the credential, when the provider needs one. */
  keyEnv?: string;
  /** Anything else from the provider's own JSON file, passed to its factory. */
  [field: string]: unknown;
}

const configRoot = fileURLToPath(new URL('../../config/voice', import.meta.url));

/** The ids of every provider that ships a config file. */
export function availableProviders(root = configRoot): string[] {
  try { return fs.readdirSync(root).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).sort(); }
  catch { return []; }
}

/** Reads one provider's config file; a missing file yields just the id. */
export function loadProviderConfig(id: string, root = configRoot): ProviderConfig {
  const file = path.join(root, `${id}.json`);
  let fields: Record<string, unknown> = {};
  try { fields = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`config/voice/${id}.json: ${(error as Error).message}`); }
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new Error(`config/voice/${id}.json must hold a JSON object`);
  return { id, ...fields };
}

/** Which provider is active: the flag, else the environment, else "openai-live". */
export function selectedProviderId(flag?: string, env = process.env): string {
  return flag ?? env.FDC_VOICE_PROVIDER ?? 'openai-live';
}

/** The active provider's config, with its credential resolved from the environment. */
export function activeProviderConfig(flag?: string, env = process.env, root = configRoot): { config: ProviderConfig; apiKey?: string } {
  const id = selectedProviderId(flag, env);
  const config = loadProviderConfig(id, root);
  const keyEnv = typeof config.keyEnv === 'string' ? config.keyEnv : undefined;
  const apiKey = keyEnv ? env[keyEnv] : undefined;
  return { config, apiKey };
}
