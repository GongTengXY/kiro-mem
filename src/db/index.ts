/** kiro-mem database layer. */

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
  TurnEvent,
  HookEventName,
  RedactionState,
  TurnArtifacts,
  MemoryType,
  Job,
  JobState,
  Observation,
  ObservationQuality,
  ObservationEmbeddingRow,
  ObservabilityStats,
} from './types';

// Re-export types
export * from './types';
export { computeScopeKey } from './scope';

// ---------- Helpers ----------

/** Current timestamp in ISO 8601 UTC. Single source of "now" for this layer. */
function nowISO(): string {
  return new Date().toISOString();
}

/** Trigram is the FTS5 tokenizer, so anything shorter can never be indexed. */
const FTS_MIN_UNIT_LEN = 3;
/** Sliding window over an unsegmented CJK run, matching trigram granularity. */
const FTS_CJK_WINDOW = 3;
/** Bounds the OR expression so a pathological query can't explode the scan. */
const FTS_MAX_UNITS = 32;
/** CJK / Japanese / Korean runs, which carry no whitespace word boundaries. */
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{3,}/g;

/**
 * Split a user query into the units that get matched against the trigram FTS
 * index. Each unit is later wrapped in its own FTS5 string literal, so the
 * user's punctuation, code symbols and reserved words stay literal.
 *
 * Two shapes are handled:
 *   - whitespace-delimited segments (identifiers, paths, versions, words) are
 *     kept whole, because a full `src/db/index.ts` match is far more precise
 *     than its fragments;
 *   - unsegmented CJK runs longer than the window are additionally sliced into
 *     overlapping sub-strings, because Chinese queries carry no word
 *     boundaries and a whole-sentence substring match never succeeds.
 *
 * Exported for tests.
 */
export function extractFtsSearchUnits(query: string): string[] {
  const units: string[] = [];
  const push = (raw: string): void => {
    const unit = raw.trim();
    if (unit.length < FTS_MIN_UNIT_LEN) return;
    if (units.includes(unit)) return;
    units.push(unit);
  };

  for (const segment of query.trim().split(/\s+/)) {
    if (!segment) continue;
    push(segment);
    for (const run of segment.match(CJK_RUN_RE) ?? []) {
      push(run);
      for (let i = 0; i + FTS_CJK_WINDOW <= run.length; i++) {
        push(run.slice(i, i + FTS_CJK_WINDOW));
        if (units.length >= FTS_MAX_UNITS) break;
      }
      if (units.length >= FTS_MAX_UNITS) break;
    }
    if (units.length >= FTS_MAX_UNITS) break;
  }

  return units.slice(0, FTS_MAX_UNITS);
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
  }): Turn {
    const now = nowISO();
    const startedAt = input.started_at ?? now;
    const result = this.db.run(
      `INSERT INTO turns (
         session_id, seq, cwd, repo, branch,
         state, prompt_text, prompt_hash,
         started_at, stopped_at, last_event_at,
         tool_event_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'open',
                 ?, ?, ?, NULL, ?,
                 0, ?, ?)`,
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
  // observations (immutable atomic projection)
  // ===========================================================

  /**
   * Insert the Observation for a closed turn. `turn_id` is UNIQUE, so this is
   * the single idempotency gate: a retry or concurrent run returns `null`
   * instead of creating a second row. `scope_key` is frozen here via
   * {@link computeScopeKey} so retrieval never disambiguates NULL repo.
   *
   * Text fields are write-once — there is deliberately no `updateObservation`.
   */
  insertObservation(input: {
    turn_id: number;
    session_id: string;
    turn_seq: number;
    repo?: string | null;
    cwd_scope: string;
    title: string;
    summary: string;
    request?: string | null;
    outcome?: string | null;
    learned?: string | null;
    next_steps?: string | null;
    memory_type: MemoryType;
    files_touched?: string[];
    concepts?: string[];
    evidence?: string[];
    importance_score?: number;
    confidence_score?: number;
    unresolved_score?: number;
    quality: ObservationQuality;
    turn_started_at: string;
    turn_stopped_at: string;
  }): number | null {
    const now = nowISO();
    const scopeKey = computeScopeKey(input.repo ?? null, input.cwd_scope);
    try {
      const result = this.db.run(
        `INSERT INTO observations (
           turn_id, scope_key, session_id, turn_seq, repo, cwd_scope,
           title, summary, request, outcome, learned, next_steps, memory_type,
           files_touched_json, concepts_json, evidence_json,
           importance_score, confidence_score, unresolved_score,
           is_pinned, quality, turn_started_at, turn_stopped_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          input.turn_id,
          scopeKey,
          input.session_id,
          input.turn_seq,
          input.repo ?? null,
          input.cwd_scope,
          input.title,
          input.summary,
          input.request ?? null,
          input.outcome ?? null,
          input.learned ?? null,
          input.next_steps ?? null,
          input.memory_type,
          JSON.stringify(input.files_touched ?? []),
          JSON.stringify(input.concepts ?? []),
          JSON.stringify(input.evidence ?? []),
          input.importance_score ?? 0,
          input.confidence_score ?? 0,
          input.unresolved_score ?? 0,
          input.quality,
          input.turn_started_at,
          input.turn_stopped_at,
          now,
        ],
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      // UNIQUE(turn_id) collision means an Observation already exists for this
      // turn — a concurrent run or retry won the race. That's the idempotent
      // outcome, not an error.
      if (String(err).includes('UNIQUE')) return null;
      throw err;
    }
  }

  getObservation(id: number): Observation | null {
    return this.db
      .query('SELECT * FROM observations WHERE id = ?')
      .get(id) as Observation | null;
  }

  getObservationByTurnId(turn_id: number): Observation | null {
    return this.db
      .query('SELECT * FROM observations WHERE turn_id = ?')
      .get(turn_id) as Observation | null;
  }

  getObservationsByIds(ids: number[]): Observation[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .query(
        `SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY turn_stopped_at DESC`,
      )
      .all(...ids) as Observation[];
  }

  pinObservation(id: number, pinned: boolean) {
    this.db.run('UPDATE observations SET is_pinned = ? WHERE id = ?', [
      pinned ? 1 : 0,
      id,
    ]);
  }

  // ---------- observation_embeddings ----------

  upsertObservationEmbedding(
    observation_id: number,
    model: string,
    dimensions: number,
    embedding: Buffer,
  ) {
    const now = nowISO();
    this.db.run(
      `INSERT INTO observation_embeddings (observation_id, model, dimensions, embedding, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(observation_id) DO UPDATE SET
         model = excluded.model,
         dimensions = excluded.dimensions,
         embedding = excluded.embedding`,
      [observation_id, model, dimensions, embedding, now],
    );
  }

  getObservationEmbedding(observation_id: number): ObservationEmbeddingRow | null {
    return this.db
      .query('SELECT * FROM observation_embeddings WHERE observation_id = ?')
      .get(observation_id) as ObservationEmbeddingRow | null;
  }

  getObservationEmbeddingsByIds(
    ids: number[],
  ): { observation_id: number; embedding: Buffer }[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .query(
        `SELECT observation_id, embedding FROM observation_embeddings WHERE observation_id IN (${placeholders})`,
      )
      .all(...ids) as { observation_id: number; embedding: Buffer }[];
  }

  // ---------- observation search / timeline ----------

  /**
   * FTS search over Observations, hard-scoped by `scope_key` when provided.
   *
   * There is no `state` filter — Observations are
   * immutable and never superseded/archived, so every row is a valid hit.
   * Scope isolation is enforced on `scope_key` (frozen at write time), so a
   * caller passing a scope never sees another workspace's Observations.
   * Queries with no usable search unit (e.g. shorter than the trigram floor)
   * fall back to LIKE.
   */
  searchObservationsFts(
    query: string,
    opts?: { scopeKey?: string; type?: string; days?: number; limit?: number },
  ): Observation[] {
    const literalQuery = query.trim();
    if (!literalQuery) return [];

    const limit = opts?.limit ?? 20;
    const days = opts?.days ?? 90;
    const dateThreshold = new Date(Date.now() - days * 86400000).toISOString();

    const units = extractFtsSearchUnits(literalQuery);
    if (units.length === 0) {
      // Below the trigram floor (or punctuation-only): LIKE is the only option.
      const like = `%${literalQuery}%`;
      let sql = `SELECT * FROM observations
        WHERE turn_stopped_at > ?
          AND (title LIKE ? OR summary LIKE ? OR outcome LIKE ? OR learned LIKE ? OR concepts_json LIKE ?)`;
      const params: (string | number)[] = [dateThreshold, like, like, like, like, like];
      if (opts?.scopeKey) { sql += ' AND scope_key = ?'; params.push(opts.scopeKey); }
      if (opts?.type) { sql += ' AND memory_type = ?'; params.push(opts.type); }
      sql += ' ORDER BY is_pinned DESC, turn_stopped_at DESC, id DESC LIMIT ?';
      params.push(limit);
      return this.db.query(sql).all(...params) as Observation[];
    }

    // Each search unit becomes its own FTS5 string literal, OR-joined. Doubling
    // an embedded quote is FTS5's quoted-string escape, so punctuation and
    // reserved words inside a unit keep their literal meaning instead of
    // becoming query operators or column selectors. OR (not phrase) matching is
    // what makes multi-word and natural-language queries recall anything at
    // all: under the trigram tokenizer a single quoted string is an exact
    // substring match, which a whole user sentence essentially never satisfies.
    // bm25 then ranks documents matching more units higher.
    const ftsExpr = units.map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');
    let sql = `SELECT o.* FROM observations_fts fts
      JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ?`;
    const params: (string | number)[] = [ftsExpr, dateThreshold];
    if (opts?.scopeKey) { sql += ' AND o.scope_key = ?'; params.push(opts.scopeKey); }
    if (opts?.type) { sql += ' AND o.memory_type = ?'; params.push(opts.type); }
    sql += ' ORDER BY o.is_pinned DESC, fts.rank LIMIT ?';
    params.push(limit);
    return this.db.query(sql).all(...params) as Observation[];
  }

  /** Recent Observation ids for the semantic candidate pool, scoped and typed. */
  getRecentObservationIds(opts: { scopeKey?: string; type?: string; days: number; limit: number }): number[] {
    const dateThreshold = new Date(Date.now() - opts.days * 86400000).toISOString();
    let sql = `SELECT id FROM observations WHERE turn_stopped_at > ?`;
    const params: (string | number)[] = [dateThreshold];
    if (opts.scopeKey) { sql += ' AND scope_key = ?'; params.push(opts.scopeKey); }
    if (opts.type) { sql += ' AND memory_type = ?'; params.push(opts.type); }
    sql += ' ORDER BY turn_stopped_at DESC LIMIT ?';
    params.push(opts.limit);
    return (this.db.query(sql).all(...params) as { id: number }[]).map((r) => r.id);
  }

  /**
   * Timeline anchored on an Observation's SOURCE TURN, not on the Observation's
   * auto-increment id. Ordering key is (turn_stopped_at, turn_seq, id) so the
   * result reflects the real work timeline even when Observations were written
   * out of turn order (retries, async compression).
   *
   * - mode='scope' (default): neighbors within the same workspace scope_key —
   *   good for cross-session continuous work.
   * - mode='session': neighbors within the same session only.
   *
   * `before` is returned oldest→anchor; `after` is anchor→newest.
   */
  observationTimeline(
    observation_id: number,
    opts?: { before?: number; after?: number; mode?: 'scope' | 'session' },
  ): { anchor: Observation | null; before: Observation[]; after: Observation[] } {
    const anchor = this.getObservation(observation_id);
    if (!anchor) return { anchor: null, before: [], after: [] };

    const before = opts?.before ?? 3;
    const after = opts?.after ?? 3;
    const mode = opts?.mode ?? 'scope';
    const scopeCol = mode === 'session' ? 'session_id' : 'scope_key';
    const scopeVal = mode === 'session' ? anchor.session_id : anchor.scope_key;

    const olderDesc = this.db
      .query(
        `SELECT * FROM observations
           WHERE ${scopeCol} = ?
             AND ( turn_stopped_at < ?
                OR (turn_stopped_at = ? AND turn_seq < ?)
                OR (turn_stopped_at = ? AND turn_seq = ? AND id < ?) )
           ORDER BY turn_stopped_at DESC, turn_seq DESC, id DESC
           LIMIT ?`,
      )
      .all(scopeVal, anchor.turn_stopped_at, anchor.turn_stopped_at, anchor.turn_seq, anchor.turn_stopped_at, anchor.turn_seq, anchor.id, before) as Observation[];

    const newerAsc = this.db
      .query(
        `SELECT * FROM observations
           WHERE ${scopeCol} = ?
             AND ( turn_stopped_at > ?
                OR (turn_stopped_at = ? AND turn_seq > ?)
                OR (turn_stopped_at = ? AND turn_seq = ? AND id > ?) )
           ORDER BY turn_stopped_at ASC, turn_seq ASC, id ASC
           LIMIT ?`,
      )
      .all(scopeVal, anchor.turn_stopped_at, anchor.turn_stopped_at, anchor.turn_seq, anchor.turn_stopped_at, anchor.turn_seq, anchor.id, after) as Observation[];

    return { anchor, before: olderDesc.reverse(), after: newerAsc };
  }

  /**
   * Pinned Observations for the AgentSpawn bootstrap index, hard-scoped.
   * Ordered by recency. Independent of session.
   */
  getPinnedObservations(opts: { scopeKey?: string; limit: number }): Observation[] {
    let sql = `SELECT * FROM observations WHERE is_pinned = 1`;
    const params: (string | number)[] = [];
    if (opts.scopeKey) { sql += ' AND scope_key = ?'; params.push(opts.scopeKey); }
    sql += ' ORDER BY turn_stopped_at DESC, id DESC LIMIT ?';
    params.push(opts.limit);
    return this.db.query(sql).all(...params) as Observation[];
  }

  /**
   * Most recent Observations in a scope, ordered by turn_stopped_at desc.
   * "Recent N" for the bootstrap index is independent of session_id (session
   * is only for event attribution/isolation, not index selection).
   */
  getRecentObservations(opts: { scopeKey?: string; limit: number }): Observation[] {
    let sql = `SELECT * FROM observations`;
    const params: (string | number)[] = [];
    if (opts.scopeKey) { sql += ' WHERE scope_key = ?'; params.push(opts.scopeKey); }
    sql += ' ORDER BY turn_stopped_at DESC, id DESC LIMIT ?';
    params.push(opts.limit);
    return this.db.query(sql).all(...params) as Observation[];
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

  // ===========================================================
  // observability (design §12.4)
  // ===========================================================

  /**
   * Record one MCP search request. `degraded` marks an FTS-only fallback (query
   * embedding unavailable). Written from the MCP server process. Never throws
   * out — metric recording must not break search.
   */
  recordSearchMetric(opts: { latencyMs: number; degraded: boolean }): void {
    try {
      const r = this.db.run(
        `INSERT INTO metric_events (kind, degraded, latency_ms, created_at)
         VALUES ('search', ?, ?, ?)`,
        [opts.degraded ? 1 : 0, Math.max(0, Math.round(opts.latencyMs)), nowISO()],
      );
      this.maybePruneMetrics(Number(r.lastInsertRowid));
    } catch {
      /* metrics are best-effort */
    }
  }

  /**
   * Record one ACP runtime event (JSON-repair attempt or contamination recycle).
   * Written from the worker process. Best-effort.
   */
  recordAcpEvent(kind: 'repair' | 'contamination'): void {
    try {
      const r = this.db.run(
        `INSERT INTO metric_events (kind, created_at) VALUES (?, ?)`,
        [`acp_${kind}`, nowISO()],
      );
      this.maybePruneMetrics(Number(r.lastInsertRowid));
    } catch {
      /* best-effort */
    }
  }

  /**
   * Record one Worker request rejected by local token auth. Written from the
   * worker process so an otherwise invisible failure (Hooks never surface a
   * 401) shows up in /health and diagnose. Best-effort.
   */
  recordAuthEvent(kind: 'unauthorized'): void {
    try {
      const r = this.db.run(
        `INSERT INTO metric_events (kind, created_at) VALUES (?, ?)`,
        [`auth_${kind}`, nowISO()],
      );
      this.maybePruneMetrics(Number(r.lastInsertRowid));
    } catch {
      /* best-effort */
    }
  }

  /**
   * Opportunistic retention cap on metric_events (~every 256 inserts). We only
   * ever report a trailing 24h window; 7 days of retention gives ample buffer
   * without an unbounded ops table.
   */
  private maybePruneMetrics(rowid: number): void {
    if (rowid % 256 !== 0) return;
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.run('DELETE FROM metric_events WHERE created_at < ?', [cutoff]);
  }

  /**
   * DB-derived observability snapshot for `/health` and `kiro-mem diagnose`.
   * Pure counts — never returns observation text. Cheap enough to call per
   * health check on a normal-sized DB.
   */
  getObservabilityStats(): ObservabilityStats {
    const scalar = (sql: string, ...params: (string | number)[]): number => {
      const row = this.db.query(sql).get(...params) as { c: number } | null;
      return row?.c ?? 0;
    };

    const total = scalar('SELECT COUNT(*) AS c FROM observations');
    const fallback = scalar(
      "SELECT COUNT(*) AS c FROM observations WHERE quality = 'fallback'",
    );
    const pinned = scalar('SELECT COUNT(*) AS c FROM observations WHERE is_pinned = 1');
    const embedded = scalar('SELECT COUNT(*) AS c FROM observation_embeddings');
    const normal = Math.max(0, total - fallback);
    const coverage = total > 0 ? Number((embedded / total).toFixed(3)) : 0;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // --- MCP search (24h) from metric_events ---
    const searchAgg = this.db
      .query(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(degraded), 0) AS ftsOnly,
                COALESCE(AVG(latency_ms), 0) AS avgMs
           FROM metric_events
          WHERE kind = 'search' AND created_at > ?`,
      )
      .get(since) as { requests: number; ftsOnly: number; avgMs: number };

    let latencyMsP95 = 0;
    if (searchAgg.requests > 0) {
      const offset = Math.min(
        searchAgg.requests - 1,
        Math.floor(searchAgg.requests * 0.95),
      );
      const p95Row = this.db
        .query(
          `SELECT latency_ms AS v FROM metric_events
            WHERE kind = 'search' AND latency_ms IS NOT NULL AND created_at > ?
            ORDER BY latency_ms ASC
            LIMIT 1 OFFSET ?`,
        )
        .get(since, offset) as { v: number } | null;
      latencyMsP95 = p95Row?.v ?? 0;
    }

    return {
      observations: { total, normal, fallback, pinned },
      embeddings: { ready: embedded, coverage },
      jobs: {
        pending: scalar("SELECT COUNT(*) AS c FROM jobs WHERE state = 'pending'"),
        leased: scalar("SELECT COUNT(*) AS c FROM jobs WHERE state = 'leased'"),
        dead: scalar("SELECT COUNT(*) AS c FROM jobs WHERE state = 'dead'"),
      },
      jobs24h: {
        succeeded: scalar(
          "SELECT COUNT(*) AS c FROM jobs WHERE state = 'succeeded' AND updated_at > ?",
          since,
        ),
        dead: scalar(
          "SELECT COUNT(*) AS c FROM jobs WHERE state = 'dead' AND updated_at > ?",
          since,
        ),
      },
      search24h: {
        requests: searchAgg.requests,
        ftsOnly: searchAgg.ftsOnly,
        degradeRate:
          searchAgg.requests > 0
            ? Number((searchAgg.ftsOnly / searchAgg.requests).toFixed(3))
            : 0,
        latencyMsAvg: Math.round(searchAgg.avgMs),
        latencyMsP95,
      },
      acp24h: {
        repairs: scalar(
          "SELECT COUNT(*) AS c FROM metric_events WHERE kind = 'acp_repair' AND created_at > ?",
          since,
        ),
        contaminations: scalar(
          "SELECT COUNT(*) AS c FROM metric_events WHERE kind = 'acp_contamination' AND created_at > ?",
          since,
        ),
      },
      auth24h: {
        unauthorized: scalar(
          "SELECT COUNT(*) AS c FROM metric_events WHERE kind = 'auth_unauthorized' AND created_at > ?",
          since,
        ),
      },
    };
  }
}
