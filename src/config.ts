import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface Config {
  worker: { port: number; host: string; logLevel: string };
  compression: {
    provider: 'anthropic' | 'openai' | 'ollama' | 'custom';
    model: string;
    apiKey: string;
    baseUrl: string | null;
    maxTokens: number;
    temperature: number;
    concurrency: number;
    enabled: boolean;
  };
  context: {
    maxSessions: number;
    maxOutputBytes: number;
    includePinned: boolean;
  };
  session: { timeoutMinutes: number; autoComplete: boolean };
  filter: {
    skipTools: string[];
    skipSmallReads: boolean;
    smallReadThreshold: number;
  };
}

const defaults: Config = {
  worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
  compression: {
    provider: 'anthropic',
    model: 'gpt-5.4',
    apiKey: '',
    baseUrl: null,
    maxTokens: 800,
    temperature: 0.1,
    concurrency: 6,
    enabled: true,
  },
  context: { maxSessions: 10, maxOutputBytes: 8192, includePinned: true },
  session: { timeoutMinutes: 30, autoComplete: true },
  filter: {
    skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
    skipSmallReads: true,
    smallReadThreshold: 100,
  },
};

export function getDataDir(): string {
  return (
    process.env.KIRO_MEMORY_DATA_DIR ||
    join(process.env.HOME || '~', '.kiro-mem')
  );
}

export function loadConfig(): Config {
  const configPath = join(getDataDir(), 'config.json');
  if (!existsSync(configPath)) return defaults;

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return {
    worker: { ...defaults.worker, ...raw.worker },
    compression: { ...defaults.compression, ...raw.compression },
    context: { ...defaults.context, ...raw.context },
    session: { ...defaults.session, ...raw.session },
    filter: { ...defaults.filter, ...raw.filter },
  };
}

export function resolveEnvValue(val: string): string {
  if (val.startsWith('${') && val.endsWith('}')) {
    const envKey = val.slice(2, -1);
    return process.env[envKey] || '';
  }
  return val;
}
