import {
  pipeline,
  type FeatureExtractionPipeline,
} from '@huggingface/transformers';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (loading) return loading;
  loading = pipeline('feature-extraction', MODEL_ID, {
    dtype: 'fp32',
  }).then((ext) => {
    extractor = ext;
    return ext;
  });
  return loading;
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

export function buildSearchText(obs: {
  title?: string | null;
  narrative?: string | null;
  facts?: string | null;
  concepts?: string | null;
}): string {
  const parts: string[] = [];
  if (obs.title) parts.push(obs.title);
  if (obs.narrative) parts.push(obs.narrative);
  if (obs.facts) {
    try {
      const arr = JSON.parse(obs.facts);
      if (Array.isArray(arr)) parts.push(arr.join('; '));
    } catch {}
  }
  if (obs.concepts) {
    try {
      const arr = JSON.parse(obs.concepts);
      if (Array.isArray(arr)) parts.push(arr.join(', '));
    } catch {}
  }
  return parts.join('\n');
}

export { DIMENSIONS };
