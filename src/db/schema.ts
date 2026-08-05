/** SQLite schema for kiro-mem. */

import type { Database } from 'bun:sqlite';

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

-- Dedupe is scoped to ACTIVE jobs only.
--
-- A cross-state unique index (the original form) meant a terminal row held the
-- key forever: once a summarize_turn job went dead, turn:{id} could never be
-- enqueued again, so that turn was permanently left without an Observation and
-- enqueueJob swallowed every retry as a duplicate. Restricting the index to
-- pending/leased keeps in-flight dedupe intact while letting reconciliation
-- (kiro-mem repair) re-enqueue work WITHOUT deleting the dead row, so the
-- failure evidence stays queryable. Re-running a succeeded job is harmless: the
-- handler short-circuits on the existing Observation and observations.turn_id
-- is UNIQUE.
DROP INDEX IF EXISTS idx_jobs_dedupe;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe_active
  ON jobs(job_type, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'leased');

-- Lightweight operational metrics for runtime observability (§12.4). This is
-- NOT memory — it holds append-only, time-windowed counters written by BOTH
-- the worker (ACP repair/contamination) and the MCP server (search requests,
-- FTS-only degradation, latency). Aggregated over a trailing 24h window and
-- opportunistically pruned; it never stores observation text.
CREATE TABLE IF NOT EXISTS metric_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'search' | 'acp_repair' | 'acp_contamination' | 'auth_unauthorized'
  kind         TEXT NOT NULL,
  -- search only: 1 when the query degraded to FTS-only (embedding unavailable).
  degraded     INTEGER NOT NULL DEFAULT 0,
  -- search only: end-to-end latency in milliseconds.
  latency_ms   INTEGER,
  created_at   TEXT NOT NULL,
  -- --- phase 2C search columns (all search-only, all NULL on other kinds) ---
  -- Vector space the request ran in: 'semantic-en-v1' | 'raw-v1'. NULL on rows
  -- written before 2C, which is why the aggregation counts protocols explicitly
  -- instead of treating "not semantic-en" as raw.
  protocol           TEXT,
  -- Why the semantic leg was not in the English space: 'missing' (the caller
  -- never passed semantic_query_en) or a checkSemanticEnQuery reject reason.
  -- NULL when the derived value was accepted.
  reject_reason      TEXT,
  -- FTS candidate count. 0 identifies the zero-anchor queries that only
  -- independent semantic recall can answer.
  fts_count          INTEGER,
  -- Semantic candidates above the policy floor.
  semantic_count     INTEGER,
  -- Stored vectors in the active space that were available to score. Separates
  -- "nothing was relevant" from "this scope has no vectors under this protocol".
  comparable_vectors INTEGER,
  -- Vectors in the active space across the WHOLE search scope, not just the
  -- candidate pool (plan §8.2). NULL when the semantic step never ran, which is
  -- deliberately different from 0 = the scope really has none.
  scope_vectors      INTEGER,
  -- semantic-only results that survived the cap into the returned page.
  semantic_only      INTEGER,
  -- 1 when discovery was both requested by the policy AND available in this
  -- space. The gap against the policy is the gray-release signal.
  discovery          INTEGER
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
--
-- The primary key is (observation_id, model), NOT observation_id: "model" here
-- is the full vector-space key (model:dtype:dims:protocol, see
-- src/semantic-en.ts), and one Observation legitimately has one vector per
-- protocol — raw-v1 always, semantic-en-v1 once its English derived value
-- passes validation. A single-column key would have forced the two protocols to
-- overwrite each other, which is how a migration window silently turns into a
-- mixed-space ranking.
CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id       INTEGER NOT NULL REFERENCES observations(id),
  model                TEXT NOT NULL,
  dimensions           INTEGER NOT NULL,
  embedding            BLOB NOT NULL,
  created_at           TEXT NOT NULL,
  PRIMARY KEY (observation_id, model)
);

-- English semantic derived value for one Observation under one normalization
-- protocol (semantic-en-v1 today).
--
-- Deliberately NOT columns on "observations": that row is immutable and is the
-- audit record of what the turn actually said, while a derived value is
-- regenerable, versioned by protocol, and carries a lifecycle (pending → ready
-- / failed) plus the provenance needed to rebuild it when the protocol or the
-- translator changes. FTS, display and fallback never read this table.
--
-- "status" is the reason this is a table rather than a nullable column: a failed
-- normalization must be visible as "not translated yet", because the alternative
-- — writing a vector from a bad translation — looks identical to a good one at
-- read time.
CREATE TABLE IF NOT EXISTS observation_semantic_texts (
  observation_id       INTEGER NOT NULL REFERENCES observations(id),
  protocol             TEXT NOT NULL,
  -- 'ready' | 'pending' | 'failed'
  status               TEXT NOT NULL,
  -- JSON {title, summary, outcome, learned, concepts[]}; NULL unless ready.
  payload_json         TEXT,
  -- Who produced it, e.g. 'acp:kiro-mem-compressor'. A protocol upgrade or a
  -- translator change must be able to find the rows it invalidates.
  translator           TEXT NOT NULL,
  translator_version   TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0,
  failure_reason       TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  PRIMARY KEY (observation_id, protocol)
);

CREATE INDEX IF NOT EXISTS idx_observation_semantic_status
  ON observation_semantic_texts(protocol, status);
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

/**
 * Shape changes that `CREATE TABLE IF NOT EXISTS` cannot express.
 *
 * Called from the `MemoryDB` constructor after the declarative schema, so a
 * fresh database short-circuits on every step. Each migration must be
 * idempotent and safe to run while another process holds the same file open —
 * both the Worker and the MCP server construct `MemoryDB`.
 */
export function migrateSchema(db: Database): void {
  migrateObservationEmbeddingsPrimaryKey(db);
  migrateMetricEventsSearchColumns(db);
}

/**
 * Rebuild `observation_embeddings` when an existing database still has the old
 * single-column primary key.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot change a key, so without this an upgraded
 * install would keep a table where storing a `semantic-en-v1` vector overwrites
 * the `raw-v1` one for the same Observation — the protocol isolation would be
 * declared in the schema file and absent in the actual database.
 *
 * Existing rows are preserved rather than dropped. They were written under the
 * bare model name, which is no longer a valid space key, so they are inert at
 * read time; `kiro-mem repair` re-embeds them under the new key locally, with no
 * ACP call. Dropping them would have been simpler and would have destroyed the
 * only copy of work that a repair could still use.
 */
function migrateObservationEmbeddingsPrimaryKey(db: Database): void {
  const row = db
    .query(
      "SELECT sql AS sql FROM sqlite_master WHERE type = 'table' AND name = 'observation_embeddings'",
    )
    .get() as { sql: string | null } | null;
  const sql = row?.sql ?? '';
  if (!sql || sql.includes('PRIMARY KEY (observation_id, model)')) return;

  db.exec(`
    CREATE TABLE observation_embeddings__migrating (
      observation_id       INTEGER NOT NULL REFERENCES observations(id),
      model                TEXT NOT NULL,
      dimensions           INTEGER NOT NULL,
      embedding            BLOB NOT NULL,
      created_at           TEXT NOT NULL,
      PRIMARY KEY (observation_id, model)
    );
    INSERT INTO observation_embeddings__migrating
      (observation_id, model, dimensions, embedding, created_at)
      SELECT observation_id, model, dimensions, embedding, created_at
        FROM observation_embeddings;
    DROP TABLE observation_embeddings;
    ALTER TABLE observation_embeddings__migrating RENAME TO observation_embeddings;
  `);
}

/**
 * Add the phase 2C search columns to an existing `metric_events` table.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on a database that already has the
 * table, so without this an upgraded install would keep the 4-column shape and
 * every `recordSearchMetric` INSERT would fail — silently, because metric writes
 * are best-effort by design. The result would be a release whose whole gray
 * release rests on counters that are never written.
 *
 * Additive and idempotent: existing rows keep NULL in the new columns, which the
 * aggregation reads as "unknown" rather than as zero. No table rebuild, so it
 * cannot lose the ACP / auth history a running Worker has already written, and
 * an older Worker binary keeps working against the new shape (it just leaves the
 * new columns NULL) — the compound-key incompatibility phase 1b hit came from a
 * rebuild, and this migration deliberately avoids that class.
 */
function migrateMetricEventsSearchColumns(db: Database): void {
  const existing = new Set(
    (db.query('PRAGMA table_info(metric_events)').all() as { name: string }[]).map((c) => c.name),
  );
  const columns: [string, string][] = [
    ['protocol', 'TEXT'],
    ['reject_reason', 'TEXT'],
    ['fts_count', 'INTEGER'],
    ['semantic_count', 'INTEGER'],
    ['comparable_vectors', 'INTEGER'],
    ['scope_vectors', 'INTEGER'],
    ['semantic_only', 'INTEGER'],
    ['discovery', 'INTEGER'],
  ];
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.run(`ALTER TABLE metric_events ADD COLUMN ${name} ${type}`);
  }
}
