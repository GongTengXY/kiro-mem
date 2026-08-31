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

  /**
   * Only the two fields the benchmark's encoder-selection probe needs: it pulls
   * candidate models from the Hub into a cache outside the repo, while production
   * stays on `local_files_only` against the bundled model. This module is a
   * hand-written shim — anything not declared here is invisible to the type
   * checker even though the package exports it.
   */
  export const env: {
    cacheDir: string | null;
    allowRemoteModels: boolean;
  };
}
