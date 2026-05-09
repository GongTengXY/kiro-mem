/** kiro-mem database layer (V2 Turn+). */

import { Database } from 'bun:sqlite';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getDataDir } from '../config';
import { ALL_SCHEMA } from './schema';
import { computeScopeKey } from './scope';
import type {
  SessionRef,
  SessionRefState,
  Turn,
  TurnState,
  SummarizationState,
  LegacyTrust,
  TurnEvent,
  HookEventName,
  RedactionState,
  TurnArtifacts,
  Memory,
  MemoryKind,
  MemoryType,
  MemoryState,
  MemoryTurnLink,
  MemoryLinkRole,
  Topic,
  TopicStatus,
  MemoryEmbeddingRow,
  Job,
  JobState,
} from './types';

// Re-export types
export * from './types';
export { computeScopeKey } from './scope';

// ---------- Helpers ----------

/** Current timestamp in ISO 8601 UTC. Single source of "now" for this layer. */
function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Resolve the on-disk path for the DB file. When a caller passes an explicit
 * `dbPath` we create just its parent directory; when not, we fall back to the
 * global `~/.kiro-mem/kiro-mem.db`. Tests should always pass an explicit path
 * (use `:memory:` or a tmp file) so `getDataDir()` is never touched.
 */
function resolveDbPath(dbPath?: string): string {
  if (dbPath) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (dir && dir !== '.' && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
    return dbPath;
  }
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'kiro-mem.db');
}

// =============================================================
// MemoryDB
// =============================================================

export class MemoryDB {
  private db: Database;

  constructor(dbPath?: string) {
    const path = resolveDbPath(dbPath);
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(ALL_SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Exposed for tests and ad-hoc maintenance scripts that need raw SQL. */
  get raw(): Database {
    return this.db;
  }

  // ===========================================================
  // session_refs
  // ===========================================================

  /**
   * Idempotent upsert keyed by `session_id`. Touches `last_seen_at` on every
   * call so a session that goes silent for a while still has a sensible
   * recency signal for cleanup / diagnostics (it is NOT used for attribution).
   */
  upsertSessionRef(input: {
    session_id: string;
    cwd: string;
    repo?: string | null;
    branch?: string | null;
    agent_name?: string | null;
  }): SessionRef {
    const now = nowISO();
    this.db.run(
      `INSERT INTO session_refs (
         session_id, cwd, repo, branch, agent_name,
         first_seen_at, last_seen_at, last_turn_seq, state,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         cwd = excluded.cwd,
         repo = COALESCE(excluded.repo, session_refs.repo),
         branch = COALESCE(excluded.branch, session_refs.branch),
         agent_name = COALESCE(excluded.agent_name, session_refs.agent_name),
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      [
        input.session_id,
        input.cwd,
        input.repo ?? null,
        input.branch ?? null,
        input.agent_name ?? null,
        now,
        now,
        now,
        now,
      ],
    );
    return this.getSessionRef(input.session_id)!;
  }

  getSessionRef(session_id: string): SessionRef | null {
    return this.db
      .query('SELECT * FROM session_refs WHERE session_id = ?')
      .get(session_id) as SessionRef | null;
  }

  touchSessionRef(session_id: string) {
    const now = nowISO();
    this.db.run(
      'UPDATE session_refs SET last_seen_at = ?, updated_at = ? WHERE session_id = ?',
      [now, now, session_id],
    );
  }

  setSessionRefState(session_id: string, state: SessionRefState) {
    const now = nowISO();
    this.db.run(
      'UPDATE session_refs SET state = ?, updated_at = ? WHERE session_id = ?',
      [state, now, session_id],
    );
  }

  /**
   * Atomically allocate the next per-session turn seq. Single SQL statement so
   * concurrent HTTP ingest cannot produce duplicate seqs for the same session.
   */
  allocateNextTurnSeq(session_id: string): number {
    const now = nowISO();
    const row = this.db
      .query(
        `UPDATE session_refs
           SET last_turn_seq = last_turn_seq + 1,
               last_seen_at = ?,
               updated_at = ?
         WHERE session_id = ?
         RETURNING last_turn_seq`,
      )
      .get(now, now, session_id) as { last_turn_seq: number } | null;
    if (!row) {
      throw new Error(
        `allocateNextTurnSeq: unknown session_id=${session_id}. Call upsertSessionRef first.`,
      );
    }
    return row.last_turn_seq;
  }

  // ===========================================================
  // turns
  // ===========================================================

  createTurn(input: {
    session_id: string;
    seq: number;
    cwd: string;
    repo?: string | null;
    branch?: string | null;
    prompt_text?: string | null;
    prompt_hash?: string | null;
    started_at?: string;
    legacy_trust?: LegacyTrust;
  }): Turn {
    const now = nowISO();
    const startedAt = input.started_at ?? now;
    const result = this.db.run(
      `INSERT INTO turns (
         session_id, seq, cwd, repo, branch,
         state, summarization_state, memory_id,
         prompt_text, prompt_hash,
         started_at, stopped_at, last_event_at,
         tool_event_count,
         legacy_trust, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'open', 'pending', NULL,
                 ?, ?, ?, NULL, ?,
                 0,
                 ?, ?, ?)`,
      [
        input.session_id,
        input.seq,
        input.cwd,
        input.repo ?? null,
        input.branch ?? null,
        input.prompt_text ?? null,
        input.prompt_hash ?? null,
        startedAt,
        startedAt,
        input.legacy_trust ?? 'trusted',
        now,
        now,
      ],
    );
    return this.getTurn(Number(result.lastInsertRowid))!;
  }

  getTurn(id: number): Turn | null {
    return this.db
      .query('SELECT * FROM turns WHERE id = ?')
      .get(id) as Turn | null;
  }

  /**
   * The only supported way to find an open turn. Attribution MUST go through
   * `session_id`. We deliberately do NOT expose any cwd-based lookup as the
   * main attribution primitive.
   */
  getOpenTurnBySession(session_id: string): Turn | null {
    return this.db
      .query(
        `SELECT * FROM turns
           WHERE session_id = ? AND state = 'open'
           ORDER BY seq DESC
           LIMIT 1`,
      )
      .get(session_id) as Turn | null;
  }

  listTurnsBySession(session_id: string, limit = 50): Turn[] {
    return this.db
      .query(
        `SELECT * FROM turns
           WHERE session_id = ?
           ORDER BY seq DESC
           LIMIT ?`,
      )
      .all(session_id, limit) as Turn[];
  }

  markTurnClosed(turn_id: number, stopped_at?: string) {
    const now = nowISO();
    this.db.run(
      `UPDATE turns
         SET state = 'closed',
             stopped_at = ?,
             last_event_at = ?,
             updated_at = ?
         WHERE id = ?`,
      [stopped_at ?? now, stopped_at ?? now, now, turn_id],
    );
  }

  markTurnQuarantined(turn_id: number, reason?: string) {
    const now = nowISO();
    this.db.run(
      `UPDATE turns
         SET state = 'quarantined',
             legacy_trust = 'quarantined',
             updated_at = ?
         WHERE id = ?`,
      [now, turn_id],
    );
    // reason is currently surfaced only via logs; we do not have a dedicated
    // column for it on `turns`. If future work needs structured quarantine
    // reasons, add a `quarantine_reason` column to the schema.
    void reason;
  }

  markTurnState(turn_id: number, state: TurnState) {
    const now = nowISO();
    this.db.run(
      'UPDATE turns SET state = ?, updated_at = ? WHERE id = ?',
      [state, now, turn_id],
    );
  }

  setTurnSummarizationState(turn_id: number, state: SummarizationState) {
    const now = nowISO();
    this.db.run(
      'UPDATE turns SET summarization_state = ?, updated_at = ? WHERE id = ?',
      [state, now, turn_id],
    );
  }

  /**
   * Update turn counters after an event is appended. Kept atomic against the
   * current row values so concurrent events don't stomp each other.
   */
  incrementTurnCounters(
    turn_id: number,
    delta: {
      tool_events?: number;
      last_event_at?: string;
    },
  ) {
    const now = nowISO();
    this.db.run(
      `UPDATE turns
         SET tool_event_count = tool_event_count + ?,
             last_event_at = COALESCE(?, last_event_at),
             updated_at = ?
         WHERE id = ?`,
      [
        delta.tool_events ?? 0,
        delta.last_event_at ?? null,
        now,
        turn_id,
      ],
    );
  }

  // ===========================================================
  // turn_events (append-only truth layer)
  // ===========================================================

  appendTurnEvent(input: {
    turn_id: number;
    session_id: string;
    hook_event_name: HookEventName | string;
    tool_name?: string | null;
    payload_json: string;
    redaction_state?: RedactionState;
  }): TurnEvent {
    const now = nowISO();
    // Compute the next event_seq inline inside the INSERT to keep it atomic
    // relative to concurrent inserts for the same turn_id.
    const result = this.db.run(
      `INSERT INTO turn_events (
         turn_id, session_id, event_seq, hook_event_name, tool_name,
         payload_json, payload_size, redaction_state, created_at
       ) VALUES (
         ?, ?,
         COALESCE((SELECT MAX(event_seq) FROM turn_events WHERE turn_id = ?), 0) + 1,
         ?, ?, ?, ?, ?, ?
       )`,
      [
        input.turn_id,
        input.session_id,
        input.turn_id,
        input.hook_event_name,
        input.tool_name ?? null,
        input.payload_json,
        Buffer.byteLength(input.payload_json, 'utf-8'),
        input.redaction_state ?? 'redacted',
        now,
      ],
    );
    return this.getTurnEvent(Number(result.lastInsertRowid))!;
  }

  getTurnEvent(id: number): TurnEvent | null {
    return this.db
      .query('SELECT * FROM turn_events WHERE id = ?')
      .get(id) as TurnEvent | null;
  }

  listTurnEvents(turn_id: number): TurnEvent[] {
    return this.db
      .query(
        'SELECT * FROM turn_events WHERE turn_id = ? ORDER BY event_seq ASC',
      )
      .all(turn_id) as TurnEvent[];
  }

  countTurnEvents(turn_id: number): number {
    const row = this.db
      .query('SELECT COUNT(*) AS cnt FROM turn_events WHERE turn_id = ?')
      .get(turn_id) as { cnt: number };
    return row.cnt;
  }

  // ===========================================================
  // turn_artifacts
  // ===========================================================

  upsertTurnArtifacts(turn_id: number, a: Partial<TurnArtifacts>) {
    const now = nowISO();
    this.db.run(
      `INSERT INTO turn_artifacts (
         turn_id, tool_names_json, files_touched_json, commands_json,
         error_signals_json, decision_signals_json, facts_json, stats_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(turn_id) DO UPDATE SET
         tool_names_json      = excluded.tool_names_json,
         files_touched_json   = excluded.files_touched_json,
         commands_json        = excluded.commands_json,
         error_signals_json   = excluded.error_signals_json,
         decision_signals_json = excluded.decision_signals_json,
         facts_json           = excluded.facts_json,
         stats_json           = excluded.stats_json,
         updated_at           = excluded.updated_at`,
      [
        turn_id,
        a.tool_names_json ?? '[]',
        a.files_touched_json ?? '[]',
        a.commands_json ?? '[]',
        a.error_signals_json ?? '[]',
        a.decision_signals_json ?? '[]',
        a.facts_json ?? '[]',
        a.stats_json ?? '{}',
        now,
        now,
      ],
    );
  }

  getTurnArtifacts(turn_id: number): TurnArtifacts | null {
    return this.db
      .query('SELECT * FROM turn_artifacts WHERE turn_id = ?')
      .get(turn_id) as TurnArtifacts | null;
  }

  // ===========================================================
  // topics
  // ===========================================================

  /**
   * Look up a topic by its real uniqueness key. `scope_key` is derived from
   * `(repo, cwd)` via {@link computeScopeKey} — for a git project that will
   * be the repo path, for a non-git workspace it will be `cwd:<cwd>`.
   */
  findTopicByScope(scope_key: string, canonical_label: string): Topic | null {
    return this.db
      .query(
        `SELECT * FROM topics
           WHERE scope_key = ? AND canonical_label = ?
           LIMIT 1`,
      )
      .get(scope_key, canonical_label) as Topic | null;
  }

  getTopic(id: number): Topic | null {
    return this.db
      .query('SELECT * FROM topics WHERE id = ?')
      .get(id) as Topic | null;
  }

  createTopic(input: {
    repo?: string | null;
    cwd?: string | null;
    canonical_label: string;
    aliases?: string[];
    summary?: string | null;
    unresolved_summary?: string | null;
    status?: TopicStatus;
  }): Topic {
    const now = nowISO();
    const scopeKey = computeScopeKey(input.repo ?? null, input.cwd ?? null);
    const result = this.db.run(
      `INSERT INTO topics (
         scope_key, repo, canonical_label, aliases_json, summary, unresolved_summary,
         status, last_active_at, memory_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        scopeKey,
        input.repo ?? null,
        input.canonical_label,
        JSON.stringify(input.aliases ?? []),
        input.summary ?? null,
        input.unresolved_summary ?? null,
        input.status ?? 'active',
        now,
        now,
        now,
      ],
    );
    return this.getTopic(Number(result.lastInsertRowid))!;
  }

  /**
   * Atomic "get-or-create topic and link memory".
   *
   * Inside a single transaction:
   *   1. Idempotency guard — bail out if the memory is already linked to a
   *      topic so crash+retry never inflates memory_count.
   *   2. `INSERT ... ON CONFLICT(scope_key, canonical_label) DO UPDATE` —
   *      creates the topic row or atomically increments memory_count.
   *      On conflict, `aliases_json` is recomputed as the distinct union of
   *      the existing aliases and the ones passed in this call; the union
   *      happens in pure SQL so concurrent alias writes never lose entries.
   *   3. Link `memories.topic_id → topic.id`.
   */
  upsertTopicAndLinkMemory(input: {
    memory_id: number;
    scope_key: string;
    repo: string | null;
    canonical_label: string;
    aliases?: string[];
  }): { topic_id: number; linked: boolean } {
    const aliasesJson = JSON.stringify(
      Array.from(
        new Set(
          (input.aliases ?? []).filter(
            (a): a is string => typeof a === 'string' && !!a,
          ),
        ),
      ),
    );

    const txn = this.db.transaction(() => {
      const memRow = this.db
        .query('SELECT topic_id FROM memories WHERE id = ?')
        .get(input.memory_id) as { topic_id: number | null } | null;
      if (!memRow) {
        throw new Error(`memory ${input.memory_id} not found`);
      }
      if (memRow.topic_id != null) {
        return { topic_id: memRow.topic_id, linked: false };
      }

      const now = nowISO();
      const row = this.db
        .query(
          `INSERT INTO topics (
             scope_key, repo, canonical_label, aliases_json, status,
             last_active_at, memory_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', ?, 1, ?, ?)
           ON CONFLICT(scope_key, canonical_label) DO UPDATE SET
             memory_count = topics.memory_count + 1,
             aliases_json = (
               SELECT json_group_array(value) FROM (
                 SELECT value FROM json_each(topics.aliases_json)
                 UNION
                 SELECT value FROM json_each(excluded.aliases_json)
               )
             ),
             last_active_at = excluded.last_active_at,
             status = CASE WHEN topics.status = 'archived'
                           THEN 'active' ELSE topics.status END,
             updated_at = excluded.updated_at
           RETURNING id`,
        )
        .get(
          input.scope_key,
          input.repo ?? null,
          input.canonical_label,
          aliasesJson,
          now,
          now,
          now,
        ) as { id: number };

      this.db.run(
        `UPDATE memories
           SET topic_id = ?, updated_at = ?
         WHERE id = ? AND topic_id IS NULL`,
        [row.id, now, input.memory_id],
      );

      return { topic_id: row.id, linked: true };
    });
    return txn();
  }

  updateTopic(
    id: number,
    patch: {
      aliases?: string[];
      summary?: string | null;
      unresolved_summary?: string | null;
      status?: TopicStatus;
      last_active_at?: string;
      memory_count_delta?: number;
    },
  ) {
    const now = nowISO();
    this.db.run(
      `UPDATE topics
         SET aliases_json = COALESCE(?, aliases_json),
             summary = COALESCE(?, summary),
             unresolved_summary = COALESCE(?, unresolved_summary),
             status = COALESCE(?, status),
             last_active_at = COALESCE(?, last_active_at),
             memory_count = memory_count + ?,
             updated_at = ?
         WHERE id = ?`,
      [
        patch.aliases != null ? JSON.stringify(patch.aliases) : null,
        patch.summary ?? null,
        patch.unresolved_summary ?? null,
        patch.status ?? null,
        patch.last_active_at ?? null,
        patch.memory_count_delta ?? 0,
        now,
        id,
      ],
    );
  }

  // ===========================================================
  // memories
  // ===========================================================

  insertMemory(input: {
    memory_kind: MemoryKind;
    repo?: string | null;
    cwd_scope?: string | null;
    topic_id?: number | null;
    title: string;
    summary: string;
    request?: string | null;
    investigated?: string | null;
    learned?: string | null;
    completed?: string | null;
    next_steps?: string | null;
    memory_type: MemoryType;
    importance_score?: number;
    confidence_score?: number;
    unresolved_score?: number;
    files_touched?: string[];
    concepts?: string[];
    topic_candidate?: string | null;
    source_turn_count?: number;
    first_turn_at: string;
    last_turn_at: string;
  }): number {
    const now = nowISO();
    const result = this.db.run(
      `INSERT INTO memories (
         memory_kind, repo, cwd_scope, topic_id, topic_candidate,
         title, summary, request, investigated, learned, completed, next_steps,
         memory_type, importance_score, confidence_score, unresolved_score,
         files_touched_json, concepts_json,
         source_turn_count, is_pinned, state,
         first_turn_at, last_turn_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?, ?)`,
      [
        input.memory_kind,
        input.repo ?? null,
        input.cwd_scope ?? null,
        input.topic_id ?? null,
        input.topic_candidate ?? null,
        input.title,
        input.summary,
        input.request ?? null,
        input.investigated ?? null,
        input.learned ?? null,
        input.completed ?? null,
        input.next_steps ?? null,
        input.memory_type,
        input.importance_score ?? 0,
        input.confidence_score ?? 0,
        input.unresolved_score ?? 0,
        JSON.stringify(input.files_touched ?? []),
        JSON.stringify(input.concepts ?? []),
        input.source_turn_count ?? 1,
        input.first_turn_at,
        input.last_turn_at,
        now,
        now,
      ],
    );
    return Number(result.lastInsertRowid);
  }

  getMemory(id: number): Memory | null {
    return this.db
      .query('SELECT * FROM memories WHERE id = ?')
      .get(id) as Memory | null;
  }

  getMemoriesByIds(ids: number[]): Memory[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .query(
        `SELECT * FROM memories WHERE id IN (${placeholders}) ORDER BY last_turn_at DESC`,
      )
      .all(...ids) as Memory[];
  }

  pinMemory(id: number, pinned: boolean) {
    const now = nowISO();
    this.db.run(
      'UPDATE memories SET is_pinned = ?, updated_at = ? WHERE id = ?',
      [pinned ? 1 : 0, now, id],
    );
  }

  setMemoryState(id: number, state: MemoryState) {
    const now = nowISO();
    this.db.run(
      'UPDATE memories SET state = ?, updated_at = ? WHERE id = ?',
      [state, now, id],
    );
  }

  // ---------- memory search ----------

  /** Memory-first FTS search. Returns memories matching the query. */
  searchMemoriesFts(
    query: string,
    opts?: { type?: string; repo?: string; cwd?: string; days?: number; limit?: number },
  ): Memory[] {
    const limit = opts?.limit ?? 20;
    const days = opts?.days ?? 90;
    const dateThreshold = new Date(Date.now() - days * 86400000).toISOString();

    if (query.length < 3) {
      // Short query: LIKE fallback
      const like = `%${query}%`;
      let sql = `SELECT * FROM memories
        WHERE state = 'active' AND last_turn_at > ?
          AND (title LIKE ? OR summary LIKE ? OR learned LIKE ? OR concepts_json LIKE ?)`;
      const params: (string | number)[] = [dateThreshold, like, like, like, like];
      if (opts?.type) { sql += ' AND memory_type = ?'; params.push(opts.type); }
      if (opts?.repo) { sql += ' AND repo = ?'; params.push(opts.repo); }
      else if (opts?.cwd) { sql += ' AND cwd_scope = ?'; params.push(opts.cwd); }
      sql += ' ORDER BY is_pinned DESC, last_turn_at DESC LIMIT ?';
      params.push(limit);
      return this.db.query(sql).all(...params) as Memory[];
    }

    let sql = `SELECT m.* FROM memories_fts fts
      JOIN memories m ON fts.rowid = m.id
      WHERE memories_fts MATCH ? AND m.state = 'active' AND m.last_turn_at > ?`;
    const params: (string | number)[] = [query, dateThreshold];
    if (opts?.type) { sql += ' AND m.memory_type = ?'; params.push(opts.type); }
    if (opts?.repo) { sql += ' AND m.repo = ?'; params.push(opts.repo); }
    else if (opts?.cwd) { sql += ' AND m.cwd_scope = ?'; params.push(opts.cwd); }
    sql += ' ORDER BY m.is_pinned DESC, fts.rank LIMIT ?';
    params.push(limit);
    return this.db.query(sql).all(...params) as Memory[];
  }

  /** Get recent active memories for semantic reranking candidates. */
  getRecentMemoryIds(days: number, limit: number, repo?: string): number[] {
    const dateThreshold = new Date(Date.now() - days * 86400000).toISOString();
    let sql = `SELECT id FROM memories WHERE state = 'active' AND last_turn_at > ?`;
    const params: (string | number)[] = [dateThreshold];
    if (repo) { sql += ' AND repo = ?'; params.push(repo); }
    sql += ' ORDER BY last_turn_at DESC LIMIT ?';
    params.push(limit);
    return (this.db.query(sql).all(...params) as { id: number }[]).map(r => r.id);
  }

  /** Get pinned memories. */
  getPinnedMemories(limit = 20): Memory[] {
    return this.db.query(
      `SELECT * FROM memories WHERE is_pinned = 1 AND state = 'active' ORDER BY last_turn_at DESC LIMIT ?`,
    ).all(limit) as Memory[];
  }

  /** Get active topics for a repo. */
  /**
   * List active topics.
   *
   * - With `repo` or `cwd` specified: narrows to that scope (computed via
   *   {@link computeScopeKey}). Use this for normalize_topic and for any
   *   "topics in my current workspace" browse case.
   * - With neither specified: returns all active topics across every scope.
   *   Used by the MCP `topics` tool when the user wants a global browse.
   */
  getActiveTopics(opts?: {
    repo?: string | null;
    cwd?: string | null;
    limit?: number;
  }): Topic[] {
    const limit = opts?.limit ?? 20;
    const scoped = !!(opts?.repo || opts?.cwd);
    if (scoped) {
      const scopeKey = computeScopeKey(opts?.repo ?? null, opts?.cwd ?? null);
      return this.db
        .query(
          `SELECT * FROM topics
             WHERE status = 'active' AND scope_key = ?
             ORDER BY last_active_at DESC LIMIT ?`,
        )
        .all(scopeKey, limit) as Topic[];
    }
    return this.db
      .query(
        `SELECT * FROM topics
           WHERE status = 'active'
           ORDER BY last_active_at DESC LIMIT ?`,
      )
      .all(limit) as Topic[];
  }

  /** Trace a memory: get its source turns and neighboring memories. */
  traceMemory(memory_id: number, opts?: { before?: number; after?: number }): {
    memory: Memory | null;
    source_turns: Turn[];
    neighbors: Memory[];
  } {
    const memory = this.getMemory(memory_id);
    if (!memory) return { memory: null, source_turns: [], neighbors: [] };

    const links = this.listMemoryTurnLinks(memory_id);
    const turnIds = links.map(l => l.turn_id);
    const source_turns = turnIds.length
      ? (this.db.query(
          `SELECT * FROM turns WHERE id IN (${turnIds.map(() => '?').join(',')}) ORDER BY started_at`,
        ).all(...turnIds) as Turn[])
      : [];

    const before = opts?.before ?? 3;
    const after = opts?.after ?? 3;
    const neighbors = this.db.query(
      `SELECT * FROM (
        SELECT * FROM memories WHERE state = 'active' AND id < ? AND repo IS ? ORDER BY id DESC LIMIT ?
      ) UNION ALL
      SELECT * FROM (
        SELECT * FROM memories WHERE state = 'active' AND id > ? AND repo IS ? ORDER BY id ASC LIMIT ?
      ) ORDER BY id`,
    ).all(memory_id, memory.repo, before, memory_id, memory.repo, after) as Memory[];

    return { memory, source_turns, neighbors };
  }

  // ---------- memory_turn_links ----------

  linkMemoryToTurn(input: {
    memory_id: number;
    turn_id: number;
    ordinal: number;
    role?: MemoryLinkRole;
  }) {
    this.db.run(
      `INSERT OR REPLACE INTO memory_turn_links (memory_id, turn_id, ordinal, role)
       VALUES (?, ?, ?, ?)`,
      [input.memory_id, input.turn_id, input.ordinal, input.role ?? 'source'],
    );
  }

  /** Returns true if a turn-kind memory already exists for this turn_id. */
  hasTurnMemory(turn_id: number): boolean {
    const turn = this.getTurn(turn_id);
    return turn?.memory_id != null;
  }

  /**
   * Atomically claim the canonical turn-memory slot. Returns true if this call
   * set it (i.e. it was NULL before). Returns false if already set — the caller
   * should skip memory creation. This is the idempotency gate for summarize_turn.
   */
  claimTurnMemorySlot(turn_id: number, memory_id: number): boolean {
    const now = nowISO();
    const result = this.db.run(
      `UPDATE turns SET memory_id = ?, updated_at = ?
       WHERE id = ? AND memory_id IS NULL`,
      [memory_id, now, turn_id],
    );
    return result.changes > 0;
  }

  /**
   * Atomically create a turn's canonical memory, claim the slot on the turn,
   * and link them. Uses a SQLite transaction so a crash between steps leaves
   * no orphan memory rows. Returns the memory_id, or null if the turn already
   * has a canonical memory (idempotent).
   */
  createTurnMemoryAtomic(turn_id: number, input: {
    memory_kind: 'turn';
    repo?: string | null;
    cwd_scope?: string | null;
    title: string;
    summary: string;
    request?: string | null;
    investigated?: string | null;
    learned?: string | null;
    completed?: string | null;
    next_steps?: string | null;
    memory_type: MemoryType;
    importance_score?: number;
    confidence_score?: number;
    unresolved_score?: number;
    files_touched?: string[];
    concepts?: string[];
    /**
     * LLM-generated topic candidate from summarize_turn. Persisting it here
     * lets normalize_topic use the strongest available semantic signal
     * instead of re-deriving from concepts[0] / title.
     */
    topic_candidate?: string | null;
    first_turn_at: string;
    last_turn_at: string;
  }): number | null {
    const now = nowISO();

    // Use a transaction — SQLite guarantees all-or-nothing.
    const txn = this.db.transaction(() => {
      // Re-check inside txn (single-writer, so this is authoritative)
      const turn = this.db.query('SELECT memory_id FROM turns WHERE id = ?').get(turn_id) as { memory_id: number | null } | null;
      if (!turn || turn.memory_id != null) return null;

      // Insert memory
      const result = this.db.run(
        `INSERT INTO memories (
           memory_kind, repo, cwd_scope, topic_id, topic_candidate,
           title, summary, request, investigated, learned, completed, next_steps,
           memory_type, importance_score, confidence_score, unresolved_score,
           files_touched_json, concepts_json,
           source_turn_count, is_pinned, state,
           first_turn_at, last_turn_at, created_at, updated_at
         ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'active', ?, ?, ?, ?)`,
        [
          input.memory_kind,
          input.repo ?? null,
          input.cwd_scope ?? null,
          input.topic_candidate ?? null,
          input.title,
          input.summary,
          input.request ?? null,
          input.investigated ?? null,
          input.learned ?? null,
          input.completed ?? null,
          input.next_steps ?? null,
          input.memory_type,
          input.importance_score ?? 0,
          input.confidence_score ?? 0,
          input.unresolved_score ?? 0,
          JSON.stringify(input.files_touched ?? []),
          JSON.stringify(input.concepts ?? []),
          input.first_turn_at,
          input.last_turn_at,
          now,
          now,
        ],
      );
      const memoryId = Number(result.lastInsertRowid);

      // Claim slot on turn
      this.db.run(
        `UPDATE turns SET memory_id = ?, updated_at = ? WHERE id = ?`,
        [memoryId, now, turn_id],
      );

      // Link
      this.db.run(
        `INSERT OR REPLACE INTO memory_turn_links (memory_id, turn_id, ordinal, role)
         VALUES (?, ?, 1, 'source')`,
        [memoryId, turn_id],
      );

      return memoryId;
    });

    return txn();
  }

  listMemoryTurnLinks(memory_id: number): MemoryTurnLink[] {
    return this.db
      .query(
        'SELECT * FROM memory_turn_links WHERE memory_id = ? ORDER BY ordinal ASC',
      )
      .all(memory_id) as MemoryTurnLink[];
  }

  listTurnsByIdsOrdered(turnIds: number[]): Turn[] {
    const uniqueIds = Array.from(new Set(turnIds.filter(Number.isFinite)));
    if (!uniqueIds.length) return [];
    return this.db
      .query(
        `SELECT * FROM turns
          WHERE id IN (${uniqueIds.map(() => '?').join(',')})
          ORDER BY started_at ASC, id ASC`,
      )
      .all(...uniqueIds) as Turn[];
  }

  // ---------- memory_embeddings ----------

  upsertMemoryEmbedding(
    memory_id: number,
    model: string,
    dimensions: number,
    embedding: Buffer,
  ) {
    const now = nowISO();
    this.db.run(
      `INSERT INTO memory_embeddings (memory_id, model, dimensions, embedding, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_id) DO UPDATE SET
         model = excluded.model,
         dimensions = excluded.dimensions,
         embedding = excluded.embedding,
         updated_at = ?`,
      [memory_id, model, dimensions, embedding, now, now, now],
    );
  }

  getMemoryEmbedding(memory_id: number): MemoryEmbeddingRow | null {
    return this.db
      .query('SELECT * FROM memory_embeddings WHERE memory_id = ?')
      .get(memory_id) as MemoryEmbeddingRow | null;
  }

  getMemoryEmbeddingsByIds(
    ids: number[],
  ): { memory_id: number; embedding: Buffer }[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .query(
        `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${placeholders})`,
      )
      .all(...ids) as { memory_id: number; embedding: Buffer }[];
  }

  // ===========================================================
  // jobs
  // ===========================================================

  enqueueJob(input: {
    job_type: string;
    dedupe_key?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    payload_json: string;
    priority?: number;
    max_attempts?: number;
    available_at?: string;
  }): Job | null {
    const now = nowISO();
    try {
      const result = this.db.run(
        `INSERT INTO jobs (
           job_type, dedupe_key, entity_type, entity_id, payload_json,
           state, priority, attempts, max_attempts, available_at,
           leased_at, lease_owner, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, NULL, NULL, NULL, ?, ?)`,
        [
          input.job_type,
          input.dedupe_key ?? null,
          input.entity_type ?? null,
          input.entity_id ?? null,
          input.payload_json,
          input.priority ?? 100,
          input.max_attempts ?? 5,
          input.available_at ?? now,
          now,
          now,
        ],
      );
      return this.getJob(Number(result.lastInsertRowid));
    } catch (err) {
      // Unique-index collision on (job_type, dedupe_key) means the job is
      // already enqueued / inflight; that's by design. Swallow + return null.
      if (String(err).includes('UNIQUE')) return null;
      throw err;
    }
  }

  getJob(id: number): Job | null {
    return this.db.query('SELECT * FROM jobs WHERE id = ?').get(id) as
      | Job
      | null;
  }

  listJobsByState(state: JobState, limit = 50): Job[] {
    return this.db
      .query(
        `SELECT * FROM jobs WHERE state = ? ORDER BY priority ASC, available_at ASC, id ASC LIMIT ?`,
      )
      .all(state, limit) as Job[];
  }
}
