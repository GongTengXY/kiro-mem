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
  retrieval: {
    /**
     * Gray-release switch for independent semantic recall (plan §8.1 item 4,
     * the flag the plan calls `SEMANTIC_DISCOVERY_ENABLED`). It lives here
     * rather than in a new environment variable because this file is already
     * the project's configuration surface, and a retrieval strategy that can be
     * flipped by whatever env a session inherited is not auditable.
     *
     * `true` (default) — the phase 2C production policy: a query with a legal
     * `semantic_query_en` reaches the semantic leg even when FTS matched nothing.
     *
     * `false` — the explicit rollback: restores the phase 1b lexical-anchor
     * profile in full (gate on, floor 0.2, no semantic-only cap). Takes effect
     * for MCP servers started after the edit, i.e. the next Kiro session; no
     * schema change, no re-embedding, no vector-protocol change, so it can be
     * flipped back and forth freely.
     */
    semanticDiscovery: boolean;
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
  retrieval: {
    semanticDiscovery: true,
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

/** Directory name of the bundled compressor runtime under the data dir. */
export const DEFAULT_RUNTIME_DIRNAME = 'kiro-runtime';

/**
 * The single answer to "where does the compressor sub-agent's KIRO_HOME live?".
 *
 * Five places need this path — install (lay the files down), config (display
 * and preserve), diagnose (integrity check), the ACP smoke test, and the Worker
 * (actually run it) — and they used to compute it three different ways. The
 * failure mode was quiet and confusing: a user with a custom `kiroHome` had a
 * working runtime that `diagnose` declared broken because it inspected the
 * default directory instead, and a re-install silently overwrote their setting.
 *
 * An empty / whitespace-only value means "use the default", matching the
 * documented `"kiroHome": ""` in config.json.
 */
export function resolveRuntimeHome(kiroHome?: string | null, dataDir?: string): string {
  const explicit = kiroHome?.trim();
  if (explicit) return explicit;
  return join(dataDir ?? getDataDir(), DEFAULT_RUNTIME_DIRNAME);
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
    retrieval: {
      // Strict `=== false` rather than `??`: a config written before 2C has no
      // `retrieval` block at all, and an upgrade must not read that absence as
      // "the operator asked for the rollback profile". Only an explicit `false`
      // turns discovery off; any other value (missing, null, "off", 0) leaves the
      // frozen default on, where a typo cannot silently downgrade retrieval.
      semanticDiscovery: raw.retrieval?.semanticDiscovery !== false,
    },
    runtime: {
      kiroHome: raw.runtime?.kiroHome ?? defaults.runtime.kiroHome,
    },
  };
}
