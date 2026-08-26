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
   * Runtime environment knobs. Only the two fields the benchmark's
   * encoder-selection probe needs are declared: it downloads candidate models
   * from the Hub into a cache directory outside the repo, while production stays
   * on `local_files_only` against the bundled model.
   *
   * This whole module is a hand-written shim, so anything not listed here is
   * invisible to the type checker even though the package exports it.
   */
  export const env: {
    cacheDir: string | null;
    allowRemoteModels: boolean;
  };
}
