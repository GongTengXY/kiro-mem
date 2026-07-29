import {
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';
import { resolve } from 'path';

// Local model bundled with the package — no network download needed.
//
// At runtime the worker code lives at ~/.kiro-mem/src/server/worker.ts and
// `import.meta.dir` therefore resolves to ~/.kiro-mem/src; the joined path is
// ~/.kiro-mem/models/all-MiniLM-L6-v2 — exactly where `kiro-mem install`
// copies the model files. During in-tree dev (`bun test`, `bun run …`) the
// same relative path lands on the project's own `models/` directory.
const MODEL_LOCAL_PATH = resolve(import.meta.dir, '../models/all-MiniLM-L6-v2');
const MODEL_DTYPE = 'q8';
const DIMENSIONS = 384;

/**
 * Identity of the vector space, written alongside every stored blob AND used as
 * a read filter. Vectors from different models are not comparable, so changing
 * this constant must invalidate the old rows rather than silently mix them into
 * the same cosine ranking.
 */
export const EMBEDDING_MODEL = 'all-MiniLM-L6-v2';

export const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 1200;
export const DEFAULT_JOB_EMBEDDING_TIMEOUT_MS = 10000;

let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = pipeline('feature-extraction', MODEL_LOCAL_PATH, {
    dtype: MODEL_DTYPE,
    local_files_only: true,
  }).then((ext) => {
    extractor = ext;
    return ext;
  }).catch((error) => {
    // A failed best-effort prewarm must not permanently poison future retries.
    loading = null;
    throw error;
  });
  return loading;
}

export async function prewarmEmbeddingModel(): Promise<void> {
  await getExtractor();
}

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

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data as Float64Array);
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

export { DIMENSIONS };
