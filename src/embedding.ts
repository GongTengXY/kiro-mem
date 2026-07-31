import {
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';
import { resolve } from 'path';
import { MODEL_DTYPE } from './embedding-space';

// Local model bundled with the package — no network download needed.
//
// At runtime the worker code lives at ~/.kiro-mem/src/server/worker.ts and
// `import.meta.dir` therefore resolves to ~/.kiro-mem/src; the joined path is
// ~/.kiro-mem/models/all-MiniLM-L6-v2 — exactly where `kiro-mem install`
// copies the model files. During in-tree dev (`bun test`, `bun run …`) the
// same relative path lands on the project's own `models/` directory.
/**
 * Exported so the offline encoder-selection probes can point their own pipeline
 * at the SAME files and the SAME quantization the production job uses. A probe
 * that hardcoded this path (or picked a different dtype) would be benchmarking a
 * different vector space than the one shipping, and would report the difference
 * as a candidate's score.
 */
export const MODEL_LOCAL_PATH = resolve(import.meta.dir, '../models/all-MiniLM-L6-v2');

/**
 * The space identity, the search-text builder and the pure vector helpers live
 * in `./embedding-space`, which does NOT import the inference runtime. They are
 * re-exported here so every existing import of this module keeps working;
 * new code on a runtime-free path (MCP server, retrieval kernel) should import
 * from ./embedding-space directly.
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
 * Counts how many times this process actually instantiated the model.
 *
 * Phase 1b's lightweight gate is "one model instance per dataDir, not one per
 * repo / kiro-cli session". That claim is only checkable if the number is
 * observable, so the Worker reports it on `/health` and the concurrency test
 * asserts it stays at 1 while several scopes query at once.
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

/** How many model instances this process created (0 before the first embed). */
export function embeddingModelInitCount(): number {
  return modelInitCount;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data as Float64Array);
}
