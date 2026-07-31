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

import type { SemanticEnRecord, SemanticEnRecordSource } from './semantic-en';

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
  /**
   * English derived value for the embedded fields (`semantic-en-v1`).
   *
   * Produced by the SAME compression response, not a second call: the encoder
   * only reads English well, and phase 1b's hot-path rule forbids adding an LLM
   * round trip anywhere. Optional because a compressor may not implement the
   * protocol (test doubles, the gold benchmark's raw arm) — `null`/absent means
   * "no English vector for this Observation", never "embed the Chinese text into
   * the English space".
   *
   * Shape only. Whether it may enter the vector space is decided by
   * `checkSemanticEnRecord()` against the fields actually stored.
   */
  semantic_en?: SemanticEnRecord | null;
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

  /**
   * Second and final attempt at the English derived value, used only when the
   * one that came back with the summary failed the guardrails.
   *
   * Off the interactive path (it runs inside the `summarize_turn` job), so an
   * extra ACP call here does not violate the hot-path rule. Optional: a
   * compressor that does not implement it makes the derived value `pending`
   * instead, which is a retryable state rather than a wrong vector.
   */
  normalizeSemanticEn?(source: SemanticEnRecordSource): Promise<SemanticEnRecord | null>;

  /** Observability counters. Optional so test doubles need not track them. */
  readonly stats?: CompressorStats;

  close?(): Promise<void>;
}
