/**
 * Vector-space identity and the pure helpers around it — everything about
 * embeddings that does NOT need the inference runtime.
 *
 * Why this file exists: `./embedding` statically imports
 * `@huggingface/transformers`, and after phase 1b the MCP server process must
 * not hold a model at all (query vectors come from the Worker over HTTP, so a
 * single model instance serves every repo sharing one dataDir). Merely
 * importing the transformers module costs a measured 54MB RSS / 128ms on this
 * machine even when `pipeline()` is never called — paid once per kiro-cli
 * session, which is exactly the per-process duplication phase 1b is removing.
 *
 * `./embedding` re-exports everything here, so existing call sites are
 * unaffected; only the paths that must stay runtime-free (the retrieval kernel,
 * the MCP server, the protocol module) import this file directly.
 */

/**
 * Identity of the embedding MODEL. Not the identity of the vector space —
 * see `embeddingSpaceKey()` in `./semantic-en`, which also carries the text
 * normalization protocol. Two vectors from this model built from differently
 * normalized text are not comparable, and 384 dimensions on both sides makes
 * that mistake invisible.
 */
export const EMBEDDING_MODEL = 'all-MiniLM-L6-v2';
export const MODEL_DTYPE = 'q8';
export const DIMENSIONS = 384;

export const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 1200;
export const DEFAULT_JOB_EMBEDDING_TIMEOUT_MS = 10000;

export class EmbeddingTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Embedding operation timed out after ${timeoutMs}ms`);
    this.name = 'EmbeddingTimeoutError';
  }
}

/**
 * Bound an embedding operation without leaving a late rejection unobserved.
 * The underlying local inference cannot be cancelled, but both fulfillment and
 * rejection remain handled after the timeout has won the race.
 */
export function withEmbeddingTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new EmbeddingTimeoutError(timeoutMs));
    }, timeoutMs);

    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The exact text that becomes an Observation's vector.
 *
 * Lives next to the space identity because it is part of the same contract:
 * changing this concatenation changes what the stored vectors *mean*, every bit
 * as much as changing the model does.
 *
 * It was inline inside the `embed_observation` job, which made it unreachable
 * from anything else. The offline retrieval probes under `benchmark/` have to
 * embed the same text the production job embeds — a second, hand-copied
 * concatenation there would silently measure a different vector space and
 * report the difference as an encoder result.
 *
 * Deliberately NOT included: `request`, `next_steps`, `evidence`, and the full
 * assistant response — the vector is for finding work, not for reproducing it,
 * and raw tool output would drag noise/PII into the space.
 *
 * Both normalization protocols use this same builder: `raw-v1` feeds it the
 * stored Observation fields, `semantic-en-v1` feeds it the English derived
 * values for the same fields. Keeping one builder is what makes the A/B a
 * text-only comparison.
 */
export function buildObservationSearchText(input: {
  title: string;
  summary: string;
  outcome: string | null;
  learned: string | null;
  concepts: string[];
  files: string[];
}): string {
  return [
    input.title,
    input.summary,
    input.outcome,
    input.learned,
    input.concepts.join(', '),
    input.files.join(', '),
  ]
    .filter(Boolean)
    .join('\n');
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  // vectors are already normalized, so dot product = cosine similarity
  return dot;
}

export function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

export function blobToEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
