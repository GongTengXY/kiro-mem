/** SQLite schema for kiro-mem. */

// -------------------------------------------------------------
// Core layer — session isolation, the append-only turn truth layer,
// deterministic artifacts, and the persistent job queue. This is the
// ground truth that observations are projected from.
// -------------------------------------------------------------

export const CORE_SCHEMA = `
-- Isolation metadata. Not a memory container.
CREATE TABLE IF NOT EXISTS session_refs (
  session_id      TEXT PRIMARY KEY,
  cwd             TEXT NOT NULL,
  repo            TEXT,
  branch          TEXT,
  agent_name      TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  last_turn_seq   INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_refs_repo ON session_refs(repo);
CREATE INDEX IF NOT EXISTS idx_session_refs_last_seen ON session_refs(last_seen_at);

-- The real lifecycle unit. One Kiro turn = one row.
CREATE TABLE IF NOT EXISTS turns (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id            TEXT NOT NULL REFERENCES session_refs(session_id),
  seq                   INTEGER NOT NULL,
  cwd                   TEXT NOT NULL,
  repo                  TEXT,
  branch                TEXT,
  state                 TEXT NOT NULL,
  prompt_text           TEXT,
  prompt_hash           TEXT,
  started_at            TEXT NOT NULL,
  stopped_at            TEXT,
  last_event_at         TEXT NOT NULL,
  tool_event_count      INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_turns_repo_time ON turns(repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_turns_state ON turns(state, last_event_at);

-- Append-only raw hook events. Truth layer.
CREATE TABLE IF NOT EXISTS turn_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id           INTEGER NOT NULL REFERENCES turns(id),
  session_id        TEXT NOT NULL,
  event_seq         INTEGER NOT NULL,
  hook_event_name   TEXT NOT NULL,
  tool_name         TEXT,
  payload_json      TEXT NOT NULL,
  payload_size      INTEGER NOT NULL,
  redaction_state   TEXT NOT NULL DEFAULT 'redacted',
  created_at        TEXT NOT NULL,
  UNIQUE(turn_id, event_seq)
);

CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_turn_events_session ON turn_events(session_id, created_at);

-- Deterministic artifact extraction, no LLM involved.
CREATE TABLE IF NOT EXISTS turn_artifacts (
  turn_id              INTEGER PRIMARY KEY REFERENCES turns(id),
  tool_names_json      TEXT NOT NULL DEFAULT '[]',
  files_touched_json   TEXT NOT NULL DEFAULT '[]',
  commands_json        TEXT NOT NULL DEFAULT '[]',
  error_signals_json   TEXT NOT NULL DEFAULT '[]',
  decision_signals_json TEXT NOT NULL DEFAULT '[]',
  facts_json           TEXT NOT NULL DEFAULT '[]',
  stats_json           TEXT NOT NULL DEFAULT '{}',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

-- Persistent job queue.
CREATE TABLE IF NOT EXISTS jobs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type           TEXT NOT NULL,
  dedupe_key         TEXT,
  entity_type        TEXT,
  entity_id          TEXT,
  payload_json       TEXT NOT NULL,
  state              TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 100,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 5,
  available_at       TEXT NOT NULL,
  leased_at          TEXT,
  lease_owner        TEXT,
  last_error         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_fetch
  ON jobs(state, priority, available_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
  ON jobs(job_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Lightweight operational metrics for runtime observability (§12.4). This is
-- NOT memory — it holds append-only, time-windowed counters written by BOTH
-- the worker (ACP repair/contamination) and the MCP server (search requests,
-- FTS-only degradation, latency). Aggregated over a trailing 24h window and
-- opportunistically pruned; it never stores observation text.
CREATE TABLE IF NOT EXISTS metric_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'search' | 'acp_repair' | 'acp_contamination'
  kind         TEXT NOT NULL,
  -- search only: 1 when the query degraded to FTS-only (embedding unavailable).
  degraded     INTEGER NOT NULL DEFAULT 0,
  -- search only: end-to-end latency in milliseconds.
  latency_ms   INTEGER,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_metric_events_kind_time
  ON metric_events(kind, created_at);
`;

// -------------------------------------------------------------
// Observation layer — the immutable projection of a closed turn.
// One closed turn -> at most one Observation. Text fields are never
// updated after INSERT; the repair path is to rebuild from the core
// truth layer into a new projection, not to overwrite a row. There is
// deliberately no topic, no merge, and no superseded state.
// -------------------------------------------------------------

export const OBSERVATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  -- turn_id UNIQUE is the idempotency key: a job retry never produces a
  -- second Observation for the same turn.
  turn_id              INTEGER NOT NULL UNIQUE REFERENCES turns(id),
  -- scope_key is frozen at write time via computeScopeKey(repo, cwd) so
  -- retrieval never has to disambiguate NULL repo at read time.
  scope_key            TEXT NOT NULL,
  -- session_id + turn_seq are denormalized so timeline reads don't need an
  -- extra join back to turns.
  session_id           TEXT NOT NULL,
  turn_seq             INTEGER NOT NULL,
  repo                 TEXT,
  cwd_scope            TEXT NOT NULL,

  title                TEXT NOT NULL,
  summary              TEXT NOT NULL,
  request              TEXT,
  outcome              TEXT,
  learned              TEXT,
  next_steps           TEXT,
  memory_type          TEXT NOT NULL,

  files_touched_json   TEXT NOT NULL DEFAULT '[]',
  concepts_json        TEXT NOT NULL DEFAULT '[]',
  -- Bounded, explainable evidence digest (commands, errors, test/build
  -- results, files) — NOT a copy of full tool_response.
  evidence_json        TEXT NOT NULL DEFAULT '[]',
  importance_score     REAL NOT NULL DEFAULT 0,
  confidence_score     REAL NOT NULL DEFAULT 0,
  unresolved_score     REAL NOT NULL DEFAULT 0,

  is_pinned            INTEGER NOT NULL DEFAULT 0,
  -- 'normal' | 'fallback'. Expresses generation quality; it does NOT mean the
  -- row may be overwritten later.
  quality              TEXT NOT NULL,
  turn_started_at      TEXT NOT NULL,
  turn_stopped_at      TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_observations_scope_time
  ON observations(scope_key, turn_stopped_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_repo_time
  ON observations(repo, turn_stopped_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_pinned
  ON observations(is_pinned, turn_stopped_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_session_seq
  ON observations(session_id, turn_seq);

-- Vector index scoped to observations.
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id       INTEGER PRIMARY KEY REFERENCES observations(id),
  model                TEXT NOT NULL,
  dimensions           INTEGER NOT NULL,
  embedding            BLOB NOT NULL,
  created_at           TEXT NOT NULL
);
`;

export const OBSERVATIONS_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  summary,
  request,
  outcome,
  learned,
  next_steps,
  concepts_json,
  files_touched_json,
  evidence_json,
  content=observations,
  content_rowid=id,
  tokenize='trigram'
);
`;

// Observation text is immutable at the application layer (no updateObservation
// method exists), but is_pinned is mutable. The AFTER UPDATE trigger keeps the
// external-content FTS index consistent for any row-level UPDATE regardless of
// which column changed.
export const OBSERVATIONS_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, summary, request, outcome,
    learned, next_steps, concepts_json, files_touched_json, evidence_json)
  VALUES (new.id, new.title, new.summary, new.request, new.outcome,
    new.learned, new.next_steps, new.concepts_json, new.files_touched_json, new.evidence_json);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, summary, request, outcome,
    learned, next_steps, concepts_json, files_touched_json, evidence_json)
  VALUES ('delete', old.id, old.title, old.summary, old.request, old.outcome,
    old.learned, old.next_steps, old.concepts_json, old.files_touched_json, old.evidence_json);
END;

CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, summary, request, outcome,
    learned, next_steps, concepts_json, files_touched_json, evidence_json)
  VALUES ('delete', old.id, old.title, old.summary, old.request, old.outcome,
    old.learned, old.next_steps, old.concepts_json, old.files_touched_json, old.evidence_json);
  INSERT INTO observations_fts(rowid, title, summary, request, outcome,
    learned, next_steps, concepts_json, files_touched_json, evidence_json)
  VALUES (new.id, new.title, new.summary, new.request, new.outcome,
    new.learned, new.next_steps, new.concepts_json, new.files_touched_json, new.evidence_json);
END;
`;

/**
 * Single entry point for DB schema initialization. Called from the `MemoryDB`
 * constructor. Order matters: base tables first, then FTS virtual tables,
 * then triggers that depend on both.
 */
export const ALL_SCHEMA = [
  CORE_SCHEMA,
  OBSERVATIONS_SCHEMA,
  OBSERVATIONS_FTS_SCHEMA,
  OBSERVATIONS_FTS_TRIGGERS,
].join('\n');
