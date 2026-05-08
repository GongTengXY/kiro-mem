/** Row types for the kiro-mem SQLite layer. */

// -------------------------------------------------------------
// V2 (Turn+) types
// -------------------------------------------------------------

export type SessionRefState = 'active' | 'idle' | 'stale';

export type TurnState = 'open' | 'closed' | 'archived' | 'quarantined';
export type SummarizationState = 'pending' | 'running' | 'ready' | 'failed';
export type MergeState = 'none' | 'clustered' | 'absorbed';
export type LegacyTrust = 'trusted' | 'legacy' | 'quarantined';

export type HookEventName =
  | 'agentSpawn'
  | 'userPromptSubmit'
  | 'postToolUse'
  | 'stop';

export type RedactionState = 'raw_blocked' | 'redacted' | 'passthrough';

export type MemoryKind = 'turn' | 'merged' | 'legacy_import';
export type MemoryType =
  | 'decision'
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'discovery'
  | 'change';
export type MemoryState = 'active' | 'superseded' | 'archived';
export type MemoryLinkRole = 'source' | 'anchor';

export type TopicStatus = 'active' | 'cooling' | 'archived';

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
 * One Kiro turn: `userPromptSubmit` → … → `stop`.
 * `state`, `summarization_state`, `merge_state` are independent axes so we never
 * collapse lifecycle / summary / aggregation into a single overloaded enum.
 */
export interface Turn {
  id: number;
  session_id: string;
  seq: number;
  cwd: string;
  repo: string | null;
  branch: string | null;
  state: TurnState;
  summarization_state: SummarizationState;
  merge_state: MergeState;
  memory_id: number | null;
  prompt_text: string | null;
  prompt_hash: string | null;
  started_at: string;
  stopped_at: string | null;
  last_event_at: string;
  tool_event_count: number;
  file_touch_count: number;
  has_error_signal: number; // 0/1 boolean flag
  legacy_trust: LegacyTrust;
  created_at: string;
  updated_at: string;
}

/**
 * Append-only raw hook payload rows. This is the truth layer that allows future
 * re-compression, re-clustering, re-embedding without data loss.
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

/**
/** User-facing memory unit. Derived from a single turn or merged from multiple turns. */
export interface Memory {
  id: number;
  memory_kind: MemoryKind;
  repo: string | null;
  cwd_scope: string | null;
  topic_id: number | null;
  /**
   * LLM-generated topic candidate from summarize_turn. Persisted so
   * normalize_topic can use the strongest available semantic signal instead of
   * falling back to concepts[0] / title truncation.
   */
  topic_candidate: string | null;
  title: string;
  summary: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  memory_type: MemoryType;
  importance_score: number;
  confidence_score: number;
  unresolved_score: number;
  files_touched_json: string;
  concepts_json: string;
  source_turn_count: number;
  is_pinned: number; // 0/1 boolean flag
  state: MemoryState;
  first_turn_at: string;
  last_turn_at: string;
  created_at: string;
  updated_at: string;
}

/** Traceability row from a memory back to its source turn(s). */
export interface MemoryTurnLink {
  memory_id: number;
  turn_id: number;
  ordinal: number;
  role: MemoryLinkRole;
}

/** Canonical topic used for aggregation, dedup, and context injection. */
export interface Topic {
  id: number;
  /**
   * Non-null uniqueness key, derived via `computeScopeKey(repo, cwd)`.
   * Paired with `canonical_label` to form the real UNIQUE constraint.
   */
  scope_key: string;
  repo: string | null;
  canonical_label: string;
  aliases_json: string;
  summary: string | null;
  unresolved_summary: string | null;
  status: TopicStatus;
  last_active_at: string;
  memory_count: number;
  created_at: string;
  updated_at: string;
}

/** Vector index row, scoped to memories. */
export interface MemoryEmbeddingRow {
  memory_id: number;
  model: string;
  dimensions: number;
  embedding: Buffer;
  created_at: string;
  updated_at: string;
}

/** Persistent job queue row. Replaces the in-memory `CompressionQueue`. */
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
