/**
 * Query embedder that calls the local Worker instead of loading a model.
 *
 * Why (plan §5.4 / §10): the MCP server runs once per kiro-cli session, so
 * embedding in-process meant one full copy of the model per open repo — three
 * repos, three sets of weights, three cold starts, and a first search that pays
 * the load. The Worker is already a per-dataDir singleton kept alive by
 * launchd/systemd, so it is the natural place for the single model instance.
 * Scope isolation is unaffected: it lives in `scope_key` at the data layer, and
 * this call carries no scope at all — only text in, vector out.
 *
 * Deliberately NOT imported from here: `../embedding`. Pulling the inference
 * runtime into this process would give back 54MB RSS per session (measured) for
 * a model it must never instantiate.
 *
 * Every failure — Worker down, 429 backpressure, timeout, malformed reply —
 * surfaces as a thrown error, which the retrieval kernel already treats as
 * "degrade to FTS-only". A search that returns keyword hits is a correct answer;
 * a search that waits on a dead Worker is not.
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
 * Resolve the Worker's port.
 *
 * `<dataDir>/.worker.port` is written by the running Worker and is therefore
 * authoritative; the config value is the fallback for the window before the
 * first start. Reading the file each time is intentional — a Worker restart on a
 * different port must not require restarting every MCP session.
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
 * Build a `(text) => Float32Array` backed by `POST /embed/query`.
 *
 * The returned function is what gets injected as
 * `ObservationSearchDeps.generateEmbedding`, so the retrieval kernel stays
 * unaware of where vectors come from.
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
    // A short/odd buffer must not be read as a shorter vector and scored against
    // a partial dot product — the same guard the stored-blob read path applies.
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
