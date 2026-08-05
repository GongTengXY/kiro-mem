/** Row types for the kiro-mem SQLite layer. */

export type SessionRefState = 'active' | 'idle' | 'stale';

/**
 * `quarantined` was removed: nothing ever assigned it. Events that fail
 * validation are rejected at the HTTP boundary (the `quarantined: true`
 * response flag) and never create a turn, so a turn could not reach that state
 * — keeping it in the union advertised an isolation mechanism that did not run.
 */
export type TurnState = 'open' | 'closed' | 'archived';

export type HookEventName =
  | 'agentSpawn'
  | 'userPromptSubmit'
  | 'postToolUse'
  | 'stop';

export type RedactionState = 'raw_blocked' | 'redacted' | 'passthrough';

/** Deterministic classification of an observation. Not a topic. */
export type MemoryType =
  | 'decision'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'discovery'
  | 'change';

export type JobState = 'pending' | 'leased' | 'succeeded' | 'failed' | 'dead';

/**
 * Per-session metadata. Not a memory container. Used for:
 *   - event isolation via `session_id`
 *   - per-session turn seq allocation
 *   - coarse-grained diagnostics / cleanup policy
 */
export interface SessionRef {
  session_id: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  agent_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_turn_seq: number;
  state: SessionRefState;
  created_at: string;
  updated_at: string;
}

/**
 * One Kiro turn: `userPromptSubmit` → … → `stop`. The append-only truth unit
 * that an Observation is projected from.
 */
export interface Turn {
  id: number;
  session_id: string;
  seq: number;
  cwd: string;
  repo: string | null;
  branch: string | null;
  state: TurnState;
  prompt_text: string | null;
  started_at: string;
  stopped_at: string | null;
  last_event_at: string;
  tool_event_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Append-only raw hook payload rows. This is the truth layer that allows future
 * re-compression, re-embedding without data loss.
 */
export interface TurnEvent {
  id: number;
  turn_id: number;
  session_id: string;
  event_seq: number;
  hook_event_name: HookEventName | string;
  tool_name: string | null;
  payload_json: string;
  payload_size: number;
  redaction_state: RedactionState;
  created_at: string;
}

/**
 * Deterministic extraction from a turn's raw events. Does NOT depend on LLM.
 * Used to cheapen the compression prompt and enable exact-match retrieval.
 */
export interface TurnArtifacts {
  turn_id: number;
  tool_names_json: string;
  files_touched_json: string;
  commands_json: string;
  error_signals_json: string;
  decision_signals_json: string;
  facts_json: string;
  stats_json: string;
  created_at: string;
  updated_at: string;
}

/** Persistent job queue row. */
export interface Job {
  id: number;
  job_type: string;
  dedupe_key: string | null;
  entity_type: string | null;
  entity_id: string | null;
  payload_json: string;
  state: JobState;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: string;
  leased_at: string | null;
  lease_owner: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

// -------------------------------------------------------------
// Observation — the immutable projection of a single closed turn.
// One closed turn -> at most one Observation. Text fields are immutable
// after INSERT. There is intentionally no state, topic, or merge concept.
// -------------------------------------------------------------

/**
 * Observation generation quality.
 * - `normal`: produced by a successful compression.
 * - `fallback`: compression exhausted retries; the row carries only
 *   request / known files / explicit errors with confidence_score = 0.
 */
export type ObservationQuality = 'normal' | 'fallback';

/**
 * Primary memory unit: one closed turn -> at most one Observation.
 * `memory_type` is a deterministic classification, not a topic. Text fields
 * are never updated after INSERT.
 */
export interface Observation {
  id: number;
  /** Idempotency key. UNIQUE — a job retry never creates a second row. */
  turn_id: number;
  /** Frozen at write time via computeScopeKey(repo, cwd). */
  scope_key: string;
  /** Denormalized from the source turn for join-free timeline reads. */
  session_id: string;
  turn_seq: number;
  repo: string | null;
  cwd_scope: string;

  title: string;
  summary: string;
  request: string | null;
  /** What actually happened / was verified / left incomplete. */
  outcome: string | null;
  learned: string | null;
  next_steps: string | null;
  memory_type: MemoryType;

  files_touched_json: string;
  concepts_json: string;
  /** Bounded explainable evidence digest (commands, errors, test/build, files). */
  evidence_json: string;
  importance_score: number;
  confidence_score: number;
  unresolved_score: number;

  is_pinned: number; // 0/1 boolean flag
  quality: ObservationQuality;
  turn_started_at: string;
  turn_stopped_at: string;
  created_at: string;
}

/** Vector index row, scoped to observations. */
export interface ObservationEmbeddingRow {
  observation_id: number;
  /** Full vector-space key: model:dtype:dims:protocol (see semantic-en.ts). */
  model: string;
  dimensions: number;
  embedding: Buffer;
  created_at: string;
}

/**
 * Lifecycle of an English derived value.
 *
 * `pending` and `failed` both mean "this Observation has no `semantic-en-v1`
 * vector". They are distinct because the first is retryable and the second
 * records a translation the guardrails refused — losing that distinction would
 * make a permanent protocol violation look like a queue backlog.
 */
export type SemanticTextStatus = 'ready' | 'pending' | 'failed';

/** The English derived value payload, mirroring the embedded fields. */
export interface SemanticEnPayload {
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
}

/** One derived value for one Observation under one normalization protocol. */
export interface ObservationSemanticTextRow {
  observation_id: number;
  protocol: string;
  status: SemanticTextStatus;
  /** JSON-encoded {@link SemanticEnPayload}; NULL unless status is `ready`. */
  payload_json: string | null;
  translator: string;
  translator_version: string | null;
  attempts: number;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * DB-derived observability snapshot (design §12.4). Everything here is computed
 * from the persisted tables — no observation text is ever exposed.
 */
export interface ObservabilityStats {
  observations: {
    total: number;
    /** quality='normal' (successful compression). */
    normal: number;
    /** quality='fallback' (compression degraded to deterministic evidence). */
    fallback: number;
    pinned: number;
  };
  embeddings: {
    /** Observations with a vector in at least one CURRENT vector space. */
    ready: number;
    /** ready / total, 0..1. A proxy for how often hybrid search can use vectors. */
    coverage: number;
    /**
     * Per-protocol breakdown. `ready` alone cannot answer the question phase 1b
     * actually asks — "is the `semantic-en-v1` rebuild finished for this
     * dataDir?" — because an Observation with only a `raw-v1` vector is fully
     * `ready` and completely invisible to an English query.
     */
    byProtocol: { protocol: string; spaceKey: string; ready: number; coverage: number }[];
    /** Derived-value lifecycle for `semantic-en-v1` (rebuild progress). */
    semanticEn: { ready: number; pending: number; failed: number };
  };
  jobs: {
    pending: number;
    leased: number;
    dead: number;
  };
  /** Job outcomes in the last 24h, derived from jobs.updated_at. */
  jobs24h: {
    succeeded: number;
    dead: number;
  };
  /** MCP search activity in the last 24h, from metric_events (§12.4, plan §8.2). */
  search24h: {
    requests: number;
    /** Requests that degraded to FTS-only (embedding unavailable). */
    ftsOnly: number;
    /** ftsOnly / requests, 0..1. */
    degradeRate: number;
    /** Mean end-to-end search latency (ms). */
    latencyMsAvg: number;
    /** Median end-to-end search latency (ms). */
    latencyMsP50: number;
    /** 95th-percentile search latency (ms). */
    latencyMsP95: number;
    /**
     * Requests that ran in the `semantic-en-v1` space, i.e. the agent supplied a
     * `semantic_query_en` the guardrail accepted. This is the coverage number
     * the phase 2C gray release turns on: independent semantic recall is only
     * available in this space, so a low rate means the feature is shipped but
     * mostly unreachable, no matter how good the offline numbers are.
     */
    protocolSemanticEn: number;
    /** Requests that fell back to the `raw-v1` space. */
    protocolRaw: number;
    /** protocolSemanticEn / requests, 0..1. */
    semanticEnRate: number;
    /**
     * Why the English form was unusable, keyed by reason: `missing` (never
     * passed) plus the `checkSemanticEnQuery` reject reasons. Bounded by that
     * enum, so it cannot grow with traffic, and it never contains query text.
     */
    semanticQueryIssues: Record<string, number>;
    /** Requests where discovery was requested by policy AND available. */
    discoveryEffective: number;
    /** Requests with zero FTS candidates — only semantic recall can answer these. */
    zeroFts: number;
    /** Of those, how many returned at least one semantic-only result. */
    zeroFtsRecalled: number;
    /** semantic-only results returned across the window. */
    semanticOnlyTotal: number;
    /** semanticOnlyTotal / requests. Compare against the frozen cap. */
    semanticOnlyPerRequest: number;
    /** Worst single request. Must never exceed the policy cap. */
    semanticOnlyMax: number;
    /**
     * Mean number of stored vectors the semantic leg could actually score. Near
     * zero while a `semantic-en-v1` rebuild is pending, which is the difference
     * between "nothing relevant" and "nothing comparable".
     */
    comparableVectorsAvg: number;
    /**
     * Mean vectors in the ACTIVE space across the searched scope — the whole
     * workspace, not the 200-row candidate pool (plan §8.2). On a large workspace
     * `comparableVectorsAvg` saturates at the pool size and stops being able to
     * say whether the scope is embedded; this does not.
     */
    scopeVectorsAvg: number;
    /** Worst case in the window. 0 means some search ran against an unembedded scope. */
    scopeVectorsMin: number;
    /** Requests where the count actually ran (the semantic step was reached). */
    scopeVectorsMeasured: number;
    /**
     * Requests whose scope had NO vectors in the active space. Non-zero means
     * semantic recall was structurally impossible for them — a rebuild or job
     * backlog issue, not a relevance one.
     */
    emptyScopeRequests: number;
  };
  /** ACP repair / contamination events in the last 24h, from metric_events (§12.4). */
  acp24h: {
    repairs: number;
    contaminations: number;
  };
  /**
   * Worker requests rejected by local token auth in the last 24h. Non-zero
   * means Hooks are failing silently — usually a token rotated underneath a
   * running Worker.
   */
  auth24h: {
    unauthorized: number;
  };
}
