declare module '@huggingface/transformers' {
  export interface FeatureExtractionPipeline {
    (
      text: string,
      options?: { pooling?: string; normalize?: boolean },
    ): Promise<{ data: Float32Array | Float64Array | number[] }>;
  }

  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<FeatureExtractionPipeline>;
}
