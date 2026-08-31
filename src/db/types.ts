/** Row types for the kiro-mem SQLite layer. */

export type SessionRefState = 'active' | 'idle' | 'stale';

/**
 * No `quarantined` state: events that fail validation are rejected at the HTTP
 * boundary and never create a turn, so no turn can reach it.
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

/** Per-session metadata: event isolation and turn-seq allocation. Not a memory container. */
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

/** One Kiro turn (`userPromptSubmit` → … → `stop`): the truth unit an Observation is projected from. */
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

/** Append-only raw hook payloads — the truth layer that allows later re-compression / re-embedding. */
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

/** Deterministic extraction from a turn's raw events — no LLM, enables exact-match retrieval. */
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

// Observation — one closed turn -> at most one Observation. Text is immutable
// after INSERT; no state, no topic, no merge.

/**
 * `normal`: successful compression. `fallback`: retries exhausted, so the row
 * carries only request / known files / explicit errors, confidence_score = 0.
 */
export type ObservationQuality = 'normal' | 'fallback';

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

export interface ObservationEmbeddingRow {
  observation_id: number;
  /** Full vector-space key: model:dtype:dims:protocol (see semantic-en.ts). */
  model: string;
  dimensions: number;
  embedding: Buffer;
  created_at: string;
}

/**
 * `pending` and `failed` both mean "no `semantic-en-v1` vector", but the first
 * is retryable and the second records a translation the guardrails refused;
 * merging them makes a permanent protocol violation look like a queue backlog.
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

/** DB-derived observability snapshot (design §12.4). Computed from the persisted
 * tables only — no observation text is ever exposed. */
export interface ObservabilityStats {
  observations: {
    total: number;
    /** Split of `total` by {@link ObservationQuality}. */
    normal: number;
    fallback: number;
    pinned: number;
  };
  embeddings: {
    /** Observations with a vector in at least one current vector space. */
    ready: number;
    /** ready / total, 0..1. A proxy for how often hybrid search can use vectors. */
    coverage: number;
    /** Per-protocol breakdown: a `raw-v1`-only Observation is fully `ready` yet
     * invisible to an English query, so `ready` cannot tell if the rebuild finished. */
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
    /** End-to-end search latency in ms: mean, median, 95th percentile. */
    latencyMsAvg: number;
    latencyMsP50: number;
    latencyMsP95: number;
    /**
     * Requests that ran in the `semantic-en-v1` space (the guardrail accepted
     * the agent's `semantic_query_en`). Independent semantic recall exists only
     * there, so a low rate means the feature is shipped but mostly unreachable.
     */
    protocolSemanticEn: number;
    /** Requests without a usable English form; current search serves them FTS-only. */
    protocolRaw: number;
    /** protocolSemanticEn / requests, 0..1. */
    semanticEnRate: number;
    /**
     * Why the English form was unusable: `missing` plus the
     * `checkSemanticEnQuery` reject reasons. Bounded by that enum, so it cannot
     * grow with traffic, and it never contains query text.
     */
    semanticQueryIssues: Record<string, number>;
    /** Requests where discovery was requested by policy and available. */
    discoveryEffective: number;
    /** Requests with zero FTS candidates — only semantic recall can answer these. */
    zeroFts: number;
    /** Of those, how many returned at least one semantic-only result. */
    zeroFtsRecalled: number;
    semanticOnlyTotal: number;
    /** semanticOnlyTotal / requests. Compare against the frozen cap. */
    semanticOnlyPerRequest: number;
    /** Worst single request. Must never exceed the policy cap. */
    semanticOnlyMax: number;
    /**
     * Mean stored vectors the semantic leg could score. Near zero while a
     * `semantic-en-v1` rebuild is pending — "nothing comparable", which is not
     * the same reading as "nothing relevant".
     */
    comparableVectorsAvg: number;
    /** Mean active-space vectors across the whole searched scope. */
    scopeVectorsAvg: number;
    /** Worst case in the window. 0 means some search ran against an unembedded scope. */
    scopeVectorsMin: number;
    /** Requests where the count actually ran (the semantic step was reached). */
    scopeVectorsMeasured: number;
    /**
     * Requests whose scope had no vectors in the active space. Non-zero means
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
  /** Worker requests rejected by local token auth in the last 24h. Non-zero means
   * Hooks are failing silently — usually a token rotated under a running Worker. */
  auth24h: {
    unauthorized: number;
  };
  /** On-disk footprint. A growth rate needs a number that can be sampled repeatedly. */
  storage: {
    /** `kiro-mem.db` size in bytes. -1 when the file could not be stat'ed. */
    dbBytes: number;
    /**
     * `-wal` size in bytes. -1 when absent. Reported separately from `dbBytes`
     * because a WAL that dwarfs the database means checkpoints are starved by
     * long-lived readers, not that the corpus grew.
     */
    walBytes: number;
    /**
     * Approximate `turn_events` count from `MAX(rowid)`, not `COUNT(*)`, so
     * `/health` stays O(1) on a table that grows with every tool call. Exact
     * today; it can only over-report once a retention policy prunes.
     */
    turnEventsApprox: number;
    /** Jobs in terminal `succeeded` state — the set nothing ever deletes, so the one
     * that quantifies the leak. The `jobs` group above omits it. */
    jobsSucceeded: number;
  };
}
