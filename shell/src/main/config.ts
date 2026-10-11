/**
 * Shell configuration (spec 13). Read in the main process only; nothing here
 * is ever sent to a renderer. The only secret is the RAG service token.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ShellConfig {
  ragUrl: string;
  serviceToken: string;
  plannerImpl: 'cline' | 'fallback';
  planner: 'hosted' | 'ollama';
  plannerUrl: string;
  plannerModel: string;
  plannerApiKey: string;
  plannerProviderId: string;
  /** "none" disables the thinking pass (Ollama: ~1 s/step instead of ~20 s). Empty = model default. */
  plannerReasoning: string;
  hotkey: string;
  searchCommandPhrases: string[];
  /** Route catalog files (JSON) for "guide me to <service>"; their hosts are allowlisted. */
  routeCatalogs: string[];
  allowedHosts: string[];
  helplineFallback: string;
  startUrl: string;
  debugLog: boolean;
}

/** Minimal .env loader: KEY=VALUE lines; real environment variables win. */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function list(value: string | undefined, fallback: string[], lower = true): string[] {
  if (!value || !value.trim()) return fallback;
  return value
    .split(',')
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

/**
 * "find X" / "search for X" are ghost-cursor guidance now; only "findyt X"
 * types a YouTube search. Old .env files still list "search for,find", so
 * those two phrases are dropped from SEARCH_COMMAND_PHRASES here.
 */
export function searchPhrasesFrom(value: string | undefined): string[] {
  const phrases = list(value, ['findyt']).filter((p) => p !== 'find' && p !== 'search for' && p !== 'search');
  return phrases.length ? phrases : ['findyt'];
}

export const DEFAULT_ALLOWED_HOSTS = [
  'eci.gov.in',
  'www.eci.gov.in',
  'voters.eci.gov.in',
  'uidai.gov.in',
  'myaadhaar.uidai.gov.in',
  'google.com',
  'www.google.com',
  'youtube.com',
  'www.youtube.com',
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShellConfig {
  const planner = env.PLANNER === 'hosted' ? 'hosted' : 'ollama';
  return {
    ragUrl: (env.RAG_URL ?? 'http://127.0.0.1:8008').replace(/\/$/, ''),
    serviceToken: env.SERVICE_TOKEN ?? 'change-me-dev-token',
    plannerImpl: env.PLANNER_IMPL === 'fallback' ? 'fallback' : 'cline',
    planner,
    plannerUrl:
      env.PLANNER_URL ?? (planner === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.cline.bot/api/v1'),
    plannerModel: env.PLANNER_MODEL ?? (planner === 'ollama' ? 'gemma4:12b' : 'anthropic/claude-sonnet-4-6'),
    plannerApiKey: env.PLANNER_API_KEY ?? env.CLINE_API_KEY ?? (planner === 'ollama' ? 'ollama' : ''),
    plannerProviderId: env.PLANNER_PROVIDER_ID ?? 'openai-compatible',
    plannerReasoning: env.PLANNER_REASONING ?? (planner === 'ollama' ? 'none' : ''),
    hotkey: env.HOTKEY ?? 'Ctrl+Shift+Space',
    searchCommandPhrases: searchPhrasesFrom(env.SEARCH_COMMAND_PHRASES),
    routeCatalogs: list(env.ROUTE_CATALOGS, ['parivahan.UP.json'], false),
    allowedHosts: list(env.ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS),
    helplineFallback: env.HELPLINE_FALLBACK ?? 'Voter Helpline 1950 | UIDAI 1947',
    startUrl: env.START_URL ?? 'https://voters.eci.gov.in/',
    debugLog: env.DEBUG_LOG === '1',
  };
}

/** Repo root .env first, then shell/.env (either may hold the dev values). */
export function loadEnvFiles(appPath: string): void {
  loadDotEnv(join(appPath, '.env'));
  loadDotEnv(resolve(appPath, '..', '.env'));
}
