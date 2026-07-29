/**
 * Memory compressor abstraction.
 *
 * This file owns only the interface and result types. The single implementation
 * is `ACPCompressor` in `./acp/compressor`, which routes compression prompts
 * through `kiro-cli acp`.
 *
 * There used to be a second, test-only `Compressor` class here that adapted a
 * string-in/string-out provider and carried a hand-maintained copy of the
 * production prompt builder (S3). Tests now drive `ACPCompressor` with a fake
 * pool (`tests/support/fake-acp-pool.ts`) instead: same prompt, same JSON parse,
 * same schema validation, same output bounds, same repair retries. A duplicate
 * kept "byte-for-byte in sync" by hand is a divergence waiting to happen, and
 * the copy silently skipped `validateSchema` entirely — so every integration
 * test was asserting on a pipeline whose compressor enforced none of the
 * invariants the shipping one does.
 */

/** Observation summary output — maps directly to an `observations` row. */
export interface ObservationSummaryResult {
  title: string;
  summary: string;
  request: string;
  /** What actually happened / was verified / left incomplete. */
  outcome: string;
  learned: string;
  next_steps: string;
  memory_type: string;
  files_touched: string[];
  concepts: string[];
  /** Bounded, explainable proof: commands, errors, tests. */
  evidence: string[];
  importance_score: number;
  confidence_score: number;
  unresolved_score: number;
}

/**
 * Runtime counters exposed by the ACP-backed compressor for observability
 * (design §12.4). Cumulative since worker start.
 */
export interface CompressorStats {
  /** ACP runtime pool size. */
  total: number;
  busy: number;
  queued: number;
  /** Runtime restarts (over-job-limit recycles + error/contamination recycles). */
  restarts: number;
  /** Recycles caused by tool-call contamination of the pure compressor session. */
  contaminations: number;
  /** JSON-repair prompt attempts. */
  repairs: number;
  /** Times repair was exhausted and the job degraded to a fallback Observation. */
  parseFallbacks: number;
}

/** Abstract interface for memory compression. The worker depends on this, not concrete impl. */
export interface MemoryCompressor {
  /**
   * Compress one closed turn into an atomic Observation. Consumes the user
   * prompt, the assistant's final response, and deterministic artifacts. Must
   * not categorize into a topic or merge other history.
   */
  summarizeObservation(input: {
    user_prompt: string;
    assistant_response: string;
    artifacts: {
      files_touched: string[];
      commands: string[];
      test_signals: string[];
      error_signals: string[];
      facts: string[];
    };
  }): Promise<ObservationSummaryResult>;

  /** Observability counters. Optional so test doubles need not track them. */
  readonly stats?: CompressorStats;

  close?(): Promise<void>;
}
