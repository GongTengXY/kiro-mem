import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type Language = 'zh' | 'en';

export interface Config {
  language: Language;
  worker: { port: number; host: string; logLevel: string };
  compression: {
    /** Number of concurrent ACP runtime processes. */
    concurrency: number;
    /** Runtimes idle-TTL retirement may never reclaim. `1` keeps one ACP
     * process warm so low-frequency compression skips cold start. */
    minWarmRuntimes: number;
    /** Idle milliseconds before a released ACP runtime is retired. `0` turns
     * idle retirement off; it never means "kill immediately". */
    idleTtlMs: number;
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
     * `SEMANTIC_DISCOVERY_ENABLED`). In config rather than an env var so
     * retrieval strategy stays auditable.
     * `true` (default, phase 2C): a legal `semantic_query_en` reaches the
     * semantic leg even when FTS matched nothing. `false`: rollback to the phase
     * 1b lexical-anchor profile (gate on, floor 0.2, no semantic-only cap) for
     * sessions started after the edit; no schema or vector-protocol change.
     */
    semanticDiscovery: boolean;
  };
  runtime: {
    /** Isolated KIRO_HOME for the ACP compressor sub-agent. Empty falls back to
     * `<dataDir>/kiro-runtime`, the layout `kiro-mem install` lays down. */
    kiroHome: string;
  };
}

const defaults: Config = {
  language: 'zh',
  worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
  compression: {
    concurrency: 3,
    minWarmRuntimes: 1,
    idleTtlMs: 600000,
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
 * Single answer to "where is the compressor sub-agent's KIRO_HOME?". Install,
 * config, diagnose, the ACP smoke test and the Worker all need it and once
 * computed it three ways: a custom `kiroHome` gave a working runtime that
 * `diagnose` declared broken, and a re-install silently overwrote the setting.
 * Empty / whitespace-only means "use the default".
 */
export function resolveRuntimeHome(kiroHome?: string | null, dataDir?: string): string {
  const explicit = kiroHome?.trim();
  if (explicit) return explicit;
  return join(dataDir ?? getDataDir(), DEFAULT_RUNTIME_DIRNAME);
}

/** Smallest idle TTL a config file may ask for; below it the pool restarts ACP
 * more than it compresses. The pool takes any positive value, which lets unit
 * tests use millisecond TTLs. */
const MIN_CONFIG_IDLE_TTL_MS = 1000;
/** 24h. Beyond this is indistinguishable from "never reclaim", spelled 0. */
const MAX_CONFIG_IDLE_TTL_MS = 86_400_000;

/**
 * `0` is legal and means "idle retirement off", so this cannot be a plain clamp:
 * `Math.max` would raise it to the floor and give continuous recycling to an
 * operator who asked for none. Unusable values (negative, NaN, Infinity,
 * non-numeric) fall back to the default, not 0 — "reclaim nothing" is unsafe.
 */
function sanitizeIdleTtlMs(value: unknown): number {
  if (value === 0) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return defaults.compression.idleTtlMs;
  }
  return Math.min(MAX_CONFIG_IDLE_TTL_MS, Math.max(MIN_CONFIG_IDLE_TTL_MS, value));
}

/** `0 <= minWarmRuntimes <= concurrency` (plan §4.1). 0 is legal and means
 * "retire down to an empty pool"; only unusable values fall back to the default. */
function sanitizeMinWarmRuntimes(value: unknown, concurrency: number): number {
  const ceiling = Math.max(0, Number.isFinite(concurrency) ? Math.floor(concurrency) : 0);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return Math.min(defaults.compression.minWarmRuntimes, ceiling);
  }
  return Math.min(Math.floor(value), ceiling);
}

export function loadConfig(): Config {
  const configPath = join(getDataDir(), 'config.json');
  if (!existsSync(configPath)) return defaults;

  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return {
    language: raw.language === 'en' ? 'en' : 'zh',
    worker: { ...defaults.worker, ...raw.worker },
    compression: (() => {
      const concurrency =
        raw.compression?.concurrency ?? defaults.compression.concurrency;
      return {
        concurrency,
        // Clamped against the concurrency in effect, not the default:
        // `minWarmRuntimes: 3` under `concurrency: 1` must not pin slots that
        // cannot exist.
        minWarmRuntimes: sanitizeMinWarmRuntimes(
          raw.compression?.minWarmRuntimes,
          concurrency,
        ),
        idleTtlMs: sanitizeIdleTtlMs(raw.compression?.idleTtlMs),
        timeoutMs: raw.compression?.timeoutMs ?? defaults.compression.timeoutMs,
        maxRetries: raw.compression?.maxRetries ?? defaults.compression.maxRetries,
      };
    })(),
    context: {
      maxOutputBytes:
        raw.context?.maxOutputBytes ?? defaults.context.maxOutputBytes,
    },
    filter: { ...defaults.filter, ...raw.filter },
    retrieval: {
      // Strict `=== false`, not `??`: a config written before 2C has no
      // `retrieval` block, and that absence must not read as "the operator asked
      // for the rollback". Only an explicit `false` turns discovery off.
      semanticDiscovery: raw.retrieval?.semanticDiscovery !== false,
    },
    runtime: {
      kiroHome: raw.runtime?.kiroHome ?? defaults.runtime.kiroHome,
    },
  };
}
