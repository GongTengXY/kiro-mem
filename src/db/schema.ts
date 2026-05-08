/** SQLite schema for kiro-mem (V2 Turn+). */

// -------------------------------------------------------------
// -------------------------------------------------------------

export const V2_SCHEMA = `
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
  summarization_state   TEXT NOT NULL,
  merge_state           TEXT NOT NULL,
  memory_id             INTEGER REFERENCES memories(id),
  prompt_text           TEXT,
  prompt_hash           TEXT,
  started_at            TEXT NOT NULL,
  stopped_at            TEXT,
  last_event_at         TEXT NOT NULL,
  tool_event_count      INTEGER NOT NULL DEFAULT 0,
  file_touch_count      INTEGER NOT NULL DEFAULT 0,
  has_error_signal      INTEGER NOT NULL DEFAULT 0,
  legacy_trust          TEXT NOT NULL DEFAULT 'trusted',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE(session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_turns_repo_time ON turns(repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_turns_session_seq ON turns(session_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_turns_summary_state ON turns(summarization_state, stopped_at);
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

-- Canonical topics: aggregation + dedup + context injection anchor.
CREATE TABLE IF NOT EXISTS topics (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  repo                TEXT,
  canonical_label     TEXT NOT NULL,
  aliases_json        TEXT NOT NULL DEFAULT '[]',
  summary             TEXT,
  unresolved_summary  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  last_active_at      TEXT NOT NULL,
  memory_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_repo_label
  ON topics(repo, canonical_label);
CREATE INDEX IF NOT EXISTS idx_topics_last_active
  ON topics(last_active_at DESC);

-- User-facing primary memory unit.
-- object returned by MCP \`search\`.
CREATE TABLE IF NOT EXISTS memories (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_kind         TEXT NOT NULL,
  repo                TEXT,
  cwd_scope           TEXT,
  topic_id            INTEGER REFERENCES topics(id),
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  request             TEXT,
  investigated        TEXT,
  learned             TEXT,
  completed           TEXT,
  next_steps          TEXT,
  memory_type         TEXT NOT NULL,
  importance_score    REAL NOT NULL DEFAULT 0,
  confidence_score    REAL NOT NULL DEFAULT 0,
  unresolved_score    REAL NOT NULL DEFAULT 0,
  files_touched_json  TEXT NOT NULL DEFAULT '[]',
  concepts_json       TEXT NOT NULL DEFAULT '[]',
  source_turn_count   INTEGER NOT NULL DEFAULT 1,
  is_pinned           INTEGER NOT NULL DEFAULT 0,
  state               TEXT NOT NULL DEFAULT 'active',
  first_turn_at       TEXT NOT NULL,
  last_turn_at        TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_repo_time ON memories(repo, last_turn_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_topic_time ON memories(topic_id, last_turn_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state, is_pinned, last_turn_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(memory_kind);

-- Memory → source turn traceability.
CREATE TABLE IF NOT EXISTS memory_turn_links (
  memory_id           INTEGER NOT NULL REFERENCES memories(id),
  turn_id             INTEGER NOT NULL REFERENCES turns(id),
  ordinal             INTEGER NOT NULL,
  role                TEXT NOT NULL DEFAULT 'source',
  PRIMARY KEY(memory_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_turn_links_turn ON memory_turn_links(turn_id);

-- Vector index scoped to memories.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id          INTEGER PRIMARY KEY REFERENCES memories(id),
  model              TEXT NOT NULL,
  dimensions         INTEGER NOT NULL,
  embedding          BLOB NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
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
`;

export const V2_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  summary,
  request,
  investigated,
  learned,
  completed,
  next_steps,
  concepts_json,
  files_touched_json,
  content=memories,
  content_rowid=id,
  tokenize='trigram'
);
`;

export const V2_FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, summary, request, investigated,
    learned, completed, next_steps, concepts_json, files_touched_json)
  VALUES (new.id, new.title, new.summary, new.request, new.investigated,
    new.learned, new.completed, new.next_steps, new.concepts_json, new.files_touched_json);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, summary, request, investigated,
    learned, completed, next_steps, concepts_json, files_touched_json)
  VALUES ('delete', old.id, old.title, old.summary, old.request, old.investigated,
    old.learned, old.completed, old.next_steps, old.concepts_json, old.files_touched_json);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, summary, request, investigated,
    learned, completed, next_steps, concepts_json, files_touched_json)
  VALUES ('delete', old.id, old.title, old.summary, old.request, old.investigated,
    old.learned, old.completed, old.next_steps, old.concepts_json, old.files_touched_json);
  INSERT INTO memories_fts(rowid, title, summary, request, investigated,
    learned, completed, next_steps, concepts_json, files_touched_json)
  VALUES (new.id, new.title, new.summary, new.request, new.investigated,
    new.learned, new.completed, new.next_steps, new.concepts_json, new.files_touched_json);
END;
`;

/**
 * Single entry point for DB schema initialization. Called from the `MemoryDB`
 * constructor and from the migration entry. Order matters: base tables first,
 * then FTS virtual tables, then triggers that depend on both.
 */
export const ALL_SCHEMA = [
  V2_SCHEMA,
  V2_FTS_SCHEMA,
  V2_FTS_TRIGGERS,
].join('\n');
