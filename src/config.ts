import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Language = 'zh' | 'en';

export interface Config {
  language: Language;
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
    maxMemories: number;
    maxOutputBytes: number;
    includePinned: boolean;
    includeSummary: boolean;
  };
  filter: {
    skipTools: string[];
  };
}

const defaults: Config = {
  language: 'zh',
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
  context: {
    maxMemories: 50,
    maxOutputBytes: 8192,
    includePinned: true,
    includeSummary: false,
  },
  filter: {
    skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
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
    language: raw.language === 'en' ? 'en' : 'zh',
    worker: { ...defaults.worker, ...raw.worker },
    compression: { ...defaults.compression, ...raw.compression },
    context: {
      ...defaults.context,
      ...raw.context,
      maxMemories: raw.context?.maxMemories ?? raw.context?.maxObservations ?? defaults.context.maxMemories,
    },
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
