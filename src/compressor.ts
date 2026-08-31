/**
 * Memory compressor abstraction: interface and result types only. The single
 * implementation is `ACPCompressor` in `./acp/compressor`.
 *
 * Do not re-add a test-only compressor here. The previous one (S3) hand-copied
 * the prompt builder and silently skipped `validateSchema`, so every integration
 * test asserted on a pipeline enforcing none of the shipping invariants. Tests
 * now drive `ACPCompressor` with a fake pool (`tests/support/fake-acp-pool.ts`).
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
   * English derived value for the embedded fields (`semantic-en-v1`), produced by
   * the SAME compression response: the encoder only reads English well, and phase
   * 1b's hot-path rule forbids an extra LLM round trip. `null`/absent means "no
   * English vector for this Observation", never "embed the Chinese text into the
   * English space". Shape only — admission is decided by
   * `checkSemanticEnRecord()` against the fields actually stored.
   */
  semantic_en?: SemanticEnRecord | null;
}

/** Runtime counters exposed by the ACP-backed compressor (design §12.4).
 * Cumulative since worker start. */
export interface CompressorStats {
  /** ACP runtime pool size. */
  total: number;
  busy: number;
  queued: number;
  /** Runtime restarts (over-job-limit recycles + error/contamination recycles). */
  restarts: number;
  /** Recycles caused by tool-call contamination of the pure compressor session. */
  contaminations: number;
  repairs: number;
  /** Times repair was exhausted and the job degraded to a fallback Observation. */
  parseFallbacks: number;
  /**
   * Per-slot detail, when the implementation is process-pool backed. Optional so
   * the aggregate counters keep working for non-pool implementations; declared
   * here, not only on `ACPPool`, so `/health` reads it without class narrowing.
   */
  slots?: {
    pid: number | null;
    jobCount: number;
    idleMs: number;
    busy: boolean;
  }[];
}

/** Abstract interface for memory compression; the worker depends on this. */
export interface MemoryCompressor {
  /** Compress one closed turn into an atomic Observation. Must not categorize
   * into a topic or merge other history. */
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
   * Second and final attempt at the English derived value, used only when the one
   * that came back with the summary failed the guardrails. Runs inside the
   * `summarize_turn` job, off the interactive path, so the extra ACP call does not
   * violate the hot-path rule. Optional: without it the value stays `pending`, a
   * retryable state rather than a wrong vector.
   */
  normalizeSemanticEn?(source: SemanticEnRecordSource): Promise<SemanticEnRecord | null>;

  /** Observability counters. Optional so test doubles need not track them. */
  readonly stats?: CompressorStats;

  close?(): Promise<void>;
}
