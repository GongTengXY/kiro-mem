/**
 * Vector-space identity and the pure helpers around it — everything about
 * embeddings that does not need the inference runtime.
 *
 * `./embedding` statically imports `@huggingface/transformers`, and merely
 * importing that module costs a measured 54MB RSS / 128ms on this machine even
 * when `pipeline()` is never called. The MCP server must not hold a model (query
 * vectors come from the Worker over HTTP), so the paths that must stay
 * runtime-free — retrieval kernel, MCP server, protocol module — import this file
 * directly; `./embedding` re-exports it all for existing call sites.
 */

/**
 * Identity of the embedding model, not of the vector space — see
 * `embeddingSpaceKey()` in `./semantic-en`, which also carries the text
 * normalization protocol. Vectors built from differently normalized text are not
 * comparable, and 384 dimensions on both sides makes that mistake invisible.
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

/** Local inference cannot be cancelled, so both outcomes stay handled after the timeout wins — a late rejection must never go unobserved. */
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
 * The exact text that becomes an Observation's vector — part of the space
 * contract, since changing this concatenation changes what stored vectors mean as
 * much as changing the model does. The offline probes under `benchmark/` call it
 * for that reason: a hand-copied concatenation would measure a different space
 * and report the difference as an encoder result.
 *
 * Excluded: `request`, `next_steps`, `evidence` and the full assistant response —
 * the vector is for finding work, not reproducing it, and raw tool output would
 * drag noise and PII into the space. Both protocols share this builder (`raw-v1`
 * feeds stored fields, `semantic-en-v1` the English derived values), which is
 * what keeps the A/B a text-only comparison.
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
