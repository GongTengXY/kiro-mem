import {
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';
import { resolve } from 'path';
import { MODEL_DTYPE } from './embedding-space';

// Local model bundled with the package — no network download. `import.meta.dir`
// is ~/.kiro-mem/src at runtime, so this resolves to
// ~/.kiro-mem/models/all-MiniLM-L6-v2 where `kiro-mem install` copies the files;
// in-tree dev resolves to the project's own `models/`.
/**
 * Exported so the offline probes use the same files and quantization as the
 * production job: a different path or dtype would benchmark a different vector
 * space and report the difference as a candidate's score.
 */
export const MODEL_LOCAL_PATH = resolve(import.meta.dir, '../models/all-MiniLM-L6-v2');

/**
 * Re-exported from `./embedding-space` so existing imports keep working. New code
 * on a runtime-free path should import from there directly.
 */
export {
  EMBEDDING_MODEL,
  MODEL_DTYPE,
  DIMENSIONS,
  DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS,
  DEFAULT_JOB_EMBEDDING_TIMEOUT_MS,
  EmbeddingTimeoutError,
  withEmbeddingTimeout,
  buildObservationSearchText,
  cosineSimilarity,
  embeddingToBlob,
  blobToEmbedding,
} from './embedding-space';

let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;
/**
 * Phase 1b's gate is "one model instance per dataDir, not one per repo / kiro-cli
 * session". Only checkable if observable, so the Worker reports it on `/health`
 * and the concurrency test asserts it stays at 1 while several scopes query.
 */
let modelInitCount = 0;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = pipeline('feature-extraction', MODEL_LOCAL_PATH, {
    dtype: MODEL_DTYPE,
    local_files_only: true,
  }).then((ext) => {
    extractor = ext;
    modelInitCount++;
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

export function embeddingModelInitCount(): number {
  return modelInitCount;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data as Float64Array);
}
