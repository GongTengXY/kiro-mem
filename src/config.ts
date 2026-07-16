import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Language = 'zh' | 'en';

export interface Config {
  language: Language;
  worker: { port: number; host: string; logLevel: string };
  compression: {
    /** Number of concurrent ACP runtime processes. */
    concurrency: number;
    /** Per-prompt timeout for the ACP runtime, in milliseconds. */
    timeoutMs: number;
    /** Maximum repair retries when the model returns invalid JSON. */
    maxRetries: number;
  };
  context: {
    /** UTF-8 byte budget for the injected Observation index (agentSpawn < 10KB). */
    maxOutputBytes: number;
  };
  filter: {
    skipTools: string[];
  };
  runtime: {
    /**
     * Isolated KIRO_HOME used by the ACP compressor sub-agent. When empty,
     * the worker defaults to `<dataDir>/kiro-runtime`, which is the layout
     * `kiro-mem install` lays down.
     */
    kiroHome: string;
  };
}

const defaults: Config = {
  language: 'zh',
  worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
  compression: {
    concurrency: 3,
    timeoutMs: 30000,
    maxRetries: 2,
  },
  context: {
    maxOutputBytes: 8192,
  },
  filter: {
    skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
  },
  runtime: {
    kiroHome: '',
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
    compression: {
      concurrency: raw.compression?.concurrency ?? defaults.compression.concurrency,
      timeoutMs: raw.compression?.timeoutMs ?? defaults.compression.timeoutMs,
      maxRetries: raw.compression?.maxRetries ?? defaults.compression.maxRetries,
    },
    context: {
      maxOutputBytes:
        raw.context?.maxOutputBytes ?? defaults.context.maxOutputBytes,
    },
    filter: { ...defaults.filter, ...raw.filter },
    runtime: {
      kiroHome: raw.runtime?.kiroHome ?? defaults.runtime.kiroHome,
    },
  };
}
