/**
 * Query embedder that calls the local Worker instead of loading a model
 * (plan §5.4 / §10). The MCP server runs once per kiro-cli session, so embedding
 * in-process meant one copy of the model per open repo; the Worker is already a
 * per-dataDir singleton. Scope isolation is unaffected — it lives in `scope_key`
 * at the data layer and this call carries no scope, only text in, vector out.
 *
 * Never import `../embedding` here: the inference runtime costs 54MB RSS per
 * session (measured) for a model this process must never instantiate. Every
 * failure — Worker down, 429 backpressure, timeout, malformed reply — throws, and
 * the retrieval kernel treats that as "degrade to FTS-only".
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { getDataDir, loadConfig } from './config';
import { readLocalAuthToken } from './auth-token';
import { DIMENSIONS } from './embedding-space';

export interface WorkerEmbedderOptions {
  /** Data dir holding `.worker.port` and `.token`. Defaults to the real one. */
  dataDir?: string;
  /** Overrides the resolved port (tests point this at an ephemeral server). */
  port?: number;
  host?: string;
  /** Per-request deadline. Kept below the caller's embedding timeout. */
  timeoutMs?: number;
}

/**
 * `<dataDir>/.worker.port` is authoritative (written by the running Worker);
 * config is the fallback before the first start. Read on every call so a Worker
 * restart on a different port does not require restarting every MCP session.
 */
function resolveWorkerPort(dataDir: string, fallback: number): number {
  try {
    const raw = readFileSync(join(dataDir, '.worker.port'), 'utf-8').trim();
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    // No file yet — fall through to the configured default.
  }
  return fallback;
}

export class WorkerEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerEmbeddingError';
  }
}

/**
 * Build a `(text) => Float32Array` backed by `POST /embed/query`, injected as
 * `ObservationSearchDeps.generateEmbedding` so the kernel stays source-agnostic.
 */
export function createWorkerEmbedder(
  opts?: WorkerEmbedderOptions,
): (text: string) => Promise<Float32Array> {
  const dataDir = opts?.dataDir ?? getDataDir();
  const config = loadConfig();
  const host = opts?.host ?? config.worker.host;
  const timeoutMs = opts?.timeoutMs ?? 1000;

  return async (text: string): Promise<Float32Array> => {
    const port = opts?.port ?? resolveWorkerPort(dataDir, config.worker.port);
    const token = readLocalAuthToken(dataDir);
    const response = await fetch(`http://${host}:${port}/embed/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Lets the Worker attribute RSS to a recent MCP caller; not a liveness
        // heartbeat, and carries no scope, query text or path.
        'X-Kiro-Mem-Pid': String(process.pid),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      throw new WorkerEmbeddingError(`worker embed failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      ok?: boolean;
      embedding?: string;
      dimensions?: number;
    };
    if (!body.ok || typeof body.embedding !== 'string') {
      throw new WorkerEmbeddingError('worker embed returned no vector');
    }
    const buffer = Buffer.from(body.embedding, 'base64');
    // A short buffer must not be scored as a partial dot product — same guard as
    // the stored-blob read path.
    const expectedBytes = (body.dimensions ?? DIMENSIONS) * 4;
    if (buffer.byteLength !== expectedBytes) {
      throw new WorkerEmbeddingError(
        `worker embed length mismatch: ${buffer.byteLength} != ${expectedBytes}`,
      );
    }
    return new Float32Array(
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    );
  };
}
