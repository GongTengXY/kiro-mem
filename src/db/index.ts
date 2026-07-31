/** kiro-mem database layer. */

import { Database } from 'bun:sqlite';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getDataDir } from '../config';
import { ALL_SCHEMA, migrateSchema } from './schema';
import {
  NORMALIZATION_PROTOCOLS,
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
} from '../semantic-en';
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
  ObservationSemanticTextRow,
  SemanticEnPayload,
  SemanticTextStatus,
  ObservabilityStats,
} from './types';

// Re-export types
export * from './types';
export { computeScopeKey, detectRepo } from './scope';

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
/** Any CJK character, used only to detect a mixed-script segment. */
const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
/** Latin/digit runs, extracted only out of mixed-script segments (see below). */
const LATIN_RUN_RE = /[A-Za-z0-9_]{3,}/g;

/**
 * Pick `take` indices spread across `[0, count-1]`, always including both ends.
 *
 * This is what keeps the tail of a long query reachable: sampling the window
 * positions evenly means the LAST window is always in the set, whereas walking
 * from the head and stopping at the budget never reaches it.
 */
function evenIndices(count: number, take: number): number[] {
  if (take >= count) return Array.from({ length: count }, (_, i) => i);
  if (take <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < take; i++) out.push(Math.round((i * (count - 1)) / (take - 1)));
  return [...new Set(out)];
}

// ---------- Truth Layer size bounds (§6) ----------

/**
 * Per-string cap inside a raw event payload.
 *
 * The realistic overflow is ONE huge string leaf — a tool's stdout holding a
 * full build log or test run. Capping leaves rather than the whole payload
 * keeps the surrounding object shape intact, so `extractArtifacts` still finds
 * `tool_input.command`, error signals and file paths.
 */
const MAX_PAYLOAD_STRING_BYTES = 32 * 1024;
/** Hard per-event cap, applied after string capping. */
const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
/**
 * Cumulative per-turn cap. `turn_events` is append-only and — until a retention
 * policy exists — never pruned, so a single pathological turn must not be able
 * to grow the database without bound. Past this point only metadata stubs are
 * stored for the remaining events of that turn.
 */
const MAX_TURN_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Marker appended to any value this layer shortened. Never silent. */
const TRUNCATION_MARK = (droppedBytes: number) =>
  `…[kiro-mem: truncated ${droppedBytes} bytes]`;

/** Cut a string to a byte budget on a character boundary. */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxBytes) return s;
  let out = buf.subarray(0, maxBytes).toString('utf-8');
  // A cut landing mid-sequence decodes to a trailing replacement char.
  if (out.endsWith('\uFFFD')) out = out.slice(0, -1);
  return out;
}

/** Recursively cap every string leaf, marking the ones that were shortened. */
function capStringLeaves(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') {
    const size = Buffer.byteLength(value, 'utf-8');
    if (size <= maxBytes) return value;
    return truncateUtf8(value, maxBytes) + TRUNCATION_MARK(size - maxBytes);
  }
  if (Array.isArray(value)) return value.map((v) => capStringLeaves(v, maxBytes));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capStringLeaves(v, maxBytes);
    return out;
  }
  return value;
}

/**
 * Bound what one raw event can commit to the append-only Truth Layer.
 *
 * Anything accepted here is accepted forever: the layer is never rewritten and
 * currently has no retention policy, so an unbounded payload is an unbounded
 * disk and extraction cost. Returns the payload to store plus the ORIGINAL byte
 * size, which is what `payload_size` records — the truth about how big the
 * event really was must survive the truncation.
 *
 * Exported for tests.
 */
export function capEventPayload(
  payloadJson: string,
  turnBytesSoFar: number,
): { payload: string; originalSize: number; truncated: boolean } {
  const originalSize = Buffer.byteLength(payloadJson, 'utf-8');

  // Turn budget spent: keep the event row (it is evidence that the event
  // happened) but stop storing bodies.
  if (turnBytesSoFar >= MAX_TURN_PAYLOAD_BYTES) {
    return {
      payload: JSON.stringify({
        _kiro_mem_dropped: 'turn payload budget exceeded',
        _kiro_mem_turn_budget_bytes: MAX_TURN_PAYLOAD_BYTES,
        _kiro_mem_original_bytes: originalSize,
      }),
      originalSize,
      truncated: true,
    };
  }

  if (originalSize <= MAX_PAYLOAD_STRING_BYTES) {
    return { payload: payloadJson, originalSize, truncated: false };
  }

  let capped: string;
  try {
    capped = JSON.stringify(capStringLeaves(JSON.parse(payloadJson), MAX_PAYLOAD_STRING_BYTES));
  } catch {
    // Not valid JSON (no current caller does this, but the column is TEXT).
    capped = truncateUtf8(payloadJson, MAX_EVENT_PAYLOAD_BYTES);
  }

  // Structure-preserving capping can still leave a payload too large (many
  // fields, or a huge object graph). Collapse to a stub rather than store it.
  if (Buffer.byteLength(capped, 'utf-8') > MAX_EVENT_PAYLOAD_BYTES) {
    capped = JSON.stringify({
      _kiro_mem_dropped: 'event payload exceeded the per-event cap',
      _kiro_mem_event_cap_bytes: MAX_EVENT_PAYLOAD_BYTES,
      _kiro_mem_original_bytes: originalSize,
    });
  }

  return { payload: capped, originalSize, truncated: capped !== payloadJson };
}

/**
 * Split a user query into the units that get matched against the trigram FTS
 * index. Each unit is later wrapped in its own FTS5 string literal, so the
 * user's punctuation, code symbols and reserved words stay literal.
 *
 * Three shapes are handled:
 *   - whitespace-delimited segments (identifiers, paths, versions, words) are
 *     kept whole, because a full `src/db/index.ts` match is far more precise
 *     than its fragments;
 *   - unsegmented CJK runs longer than the window are additionally sliced into
 *     overlapping sub-strings, because Chinese queries carry no word
 *     boundaries and a whole-sentence substring match never succeeds;
 *   - mixed-script segments (`修复bug`) additionally surface their latin/digit
 *     runs, because the CJK half is usually too short to window and the whole
 *     segment is an exact-substring match nothing satisfies.
 *
 * The window budget is sampled ACROSS each run rather than consumed from its
 * head. Head-first consumption meant a long unsegmented Chinese question spent
 * the entire budget on its opening words and silently dropped the terms that
 * actually distinguish it — which is the whole point of asking in a sentence.
 * When the budget is not binding the result is unchanged (head-to-tail, every
 * window).
 *
 * Exported for tests.
 */
export function extractFtsSearchUnits(query: string): string[] {
  const units: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const unit = raw.trim();
    if (unit.length < FTS_MIN_UNIT_LEN) return;
    if (seen.has(unit)) return;
    if (units.length >= FTS_MAX_UNITS) return;
    seen.add(unit);
    units.push(unit);
  };

  // --- Pass 1: whole units. Most precise, so they get the budget first. ---
  const windowRuns: string[] = [];
  for (const segment of query.trim().split(/\s+/)) {
    if (!segment) continue;
    push(segment);
    for (const run of segment.match(CJK_RUN_RE) ?? []) {
      push(run);
      if (run.length > FTS_CJK_WINDOW) windowRuns.push(run);
    }
    // Only for mixed-script segments. Splitting a pure-latin path such as
    // `src/db/index.ts` into `src` / `index` would OR in units that match
    // almost every document, trading a real precision loss for no recall gain.
    if (CJK_CHAR_RE.test(segment)) {
      for (const run of segment.match(LATIN_RUN_RE) ?? []) push(run);
    }
  }

  // --- Pass 2: window the CJK runs with whatever budget is left. ---
  const remaining = FTS_MAX_UNITS - units.length;
  if (remaining > 0 && windowRuns.length > 0) {
    const positions = windowRuns.map((r) => r.length - FTS_CJK_WINDOW + 1);
    const totalPositions = positions.reduce((a, b) => a + b, 0);
    windowRuns.forEach((run, i) => {
      const count = positions[i]!;
      // Under budget pressure every run still keeps its head and tail window.
      const quota =
        totalPositions <= remaining
          ? count
          : Math.max(2, Math.floor((count / totalPositions) * remaining));
      for (const idx of evenIndices(count, quota)) {
        push(run.slice(idx, idx + FTS_CJK_WINDOW));
      }
    });
  }

  return units;
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
    // The Worker and the MCP server are two separate writer processes (jobs +
    // Observations vs. pin + search metrics). Without a busy timeout a
    // concurrent write fails immediately with SQLITE_BUSY, which surfaces as a
    // thrown MCP tool call or a silently dropped metric. This is a mitigation,
    // not a substitute for the transactional writes in the ingest path.
    this.db.exec('PRAGMA busy_timeout=3000');
    this.db.exec(ALL_SCHEMA);
    // Shape changes that `CREATE TABLE IF NOT EXISTS` cannot express. Runs after
    // the declarative schema so a fresh database short-circuits.
    migrateSchema(this.db);
  }

  close() {
    this.db.close();
  }

  /** Exposed for tests and ad-hoc maintenance scripts that need raw SQL. */
  get raw(): Database {
    return this.db;
  }

  /**
   * Run `fn` inside a single SQLite transaction.
   *
   * Used by the ingest path where several statements express ONE fact (close a
   * turn and enqueue its summarize job; write an Observation and enqueue its
   * embedding). Without this, a crash or SQLITE_BUSY between statements leaves
   * an orphan that no later step notices — see `findOrphans()` / `kiro-mem
   * repair` for the recovery side.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)() as T;
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
    started_at?: string;
  }): Turn {
    const now = nowISO();
    const startedAt = input.started_at ?? now;
    const result = this.db.run(
      `INSERT INTO turns (
         session_id, seq, cwd, repo, branch,
         state, prompt_text,
         started_at, stopped_at, last_event_at,
         tool_event_count, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'open',
                 ?, ?, NULL, ?,
                 0, ?, ?)`,
      [
        input.session_id,
        input.seq,
        input.cwd,
        input.repo ?? null,
        input.branch ?? null,
        input.prompt_text ?? null,
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
    // §6: bound what enters the append-only layer. `payload_size` keeps the
    // ORIGINAL size so the truncation does not also erase the record of how big
    // the event was.
    const turnBytesSoFar = this.turnPayloadBytes(input.turn_id);
    const { payload, originalSize } = capEventPayload(input.payload_json, turnBytesSoFar);
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
        payload,
        originalSize,
        input.redaction_state ?? 'redacted',
        now,
      ],
    );
    return this.getTurnEvent(Number(result.lastInsertRowid))!;
  }

  /** Bytes already committed for this turn, used to enforce the per-turn cap. */
  turnPayloadBytes(turn_id: number): number {
    const row = this.db
      .query('SELECT COALESCE(SUM(payload_size), 0) AS total FROM turn_events WHERE turn_id = ?')
      .get(turn_id) as { total: number };
    return row.total;
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

  /**
   * Fetch Observations by ID.
   *
   * `scopeKey` is NOT optional in spirit: every ID-addressed MCP tool must pass
   * the caller's authorized scope, otherwise knowing (or guessing) an ID leaks
   * another workspace's Observation body. `undefined` means "no filter" and is
   * reserved for the explicit all-scopes browse and for internal callers that
   * already resolved authorization (e.g. bootstrap, which selects by scope).
   */
  getObservationsByIds(ids: number[], opts?: { scopeKey?: string }): Observation[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    let sql = `SELECT * FROM observations WHERE id IN (${placeholders})`;
    const params: (string | number)[] = [...ids];
    if (opts?.scopeKey) { sql += ' AND scope_key = ?'; params.push(opts.scopeKey); }
    sql += ' ORDER BY turn_stopped_at DESC';
    return this.db.query(sql).all(...params) as Observation[];
  }

  pinObservation(id: number, pinned: boolean) {
    this.db.run('UPDATE observations SET is_pinned = ? WHERE id = ?', [
      pinned ? 1 : 0,
      id,
    ]);
  }

  // ---------- observation_embeddings ----------

  /**
   * Store one vector for one (observation, vector space) pair.
   *
   * `model` is the full space key from `embeddingSpaceKey()`, so the same
   * Observation can carry a `raw-v1` and a `semantic-en-v1` vector at once. The
   * conflict target is the composite key: re-embedding under one protocol must
   * not touch the other protocol's row.
   */
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
       ON CONFLICT(observation_id, model) DO UPDATE SET
         dimensions = excluded.dimensions,
         embedding = excluded.embedding`,
      [observation_id, model, dimensions, embedding, now],
    );
  }

  getObservationEmbedding(
    observation_id: number,
    model?: string,
  ): ObservationEmbeddingRow | null {
    if (model) {
      return this.db
        .query('SELECT * FROM observation_embeddings WHERE observation_id = ? AND model = ?')
        .get(observation_id, model) as ObservationEmbeddingRow | null;
    }
    return this.db
      .query('SELECT * FROM observation_embeddings WHERE observation_id = ? ORDER BY model')
      .get(observation_id) as ObservationEmbeddingRow | null;
  }

  /**
   * Fetch stored vectors for a candidate set.
   *
   * `model` / `dimensions` are filter arguments, not decoration: a stored blob
   * from a different embedding model is not comparable to the current query
   * vector, and comparing them anyway produces a *plausible but wrong* ranking
   * rather than an error. Rows written by another model version are skipped so
   * they fall back to keyword matching, which is honest, instead of being
   * silently misranked.
   */
  getObservationEmbeddingsByIds(
    ids: number[],
    opts?: { model?: string; dimensions?: number },
  ): { observation_id: number; embedding: Buffer }[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    let sql = `SELECT observation_id, embedding, dimensions
                 FROM observation_embeddings
                WHERE observation_id IN (${placeholders})`;
    const params: (string | number)[] = [...ids];
    if (opts?.model) { sql += ' AND model = ?'; params.push(opts.model); }
    if (opts?.dimensions) { sql += ' AND dimensions = ?'; params.push(opts.dimensions); }
    const rows = this.db.query(sql).all(...params) as {
      observation_id: number; embedding: Buffer; dimensions: number;
    }[];

    // Length check: `dimensions` is metadata, the blob is the payload, and a
    // truncated or corrupted blob would otherwise be read as a shorter vector
    // and score against a partial dot product.
    return rows
      .filter((r) => r.embedding.byteLength === r.dimensions * 4)
      .map((r) => ({ observation_id: r.observation_id, embedding: r.embedding }));
  }

  // ---------- observation_semantic_texts ----------

  /**
   * Record (or update) the English derived value for one Observation under one
   * protocol.
   *
   * By default the conflict clause refuses to downgrade a `ready` row: a later
   * attempt that fails must not erase a translation that already validated, or a
   * transient translator hiccup would silently remove an Observation from the
   * `semantic-en-v1` space and the only symptom would be slightly lower coverage.
   *
   * `allowDowngrade` is the one exception, and it exists because the two rules
   * collide: the embed-time gate re-validates the stored payload, so when it
   * refuses one it holds proof that `ready` is wrong — leaving the row alone
   * would make the table claim a compliant value that the current guardrails
   * reject. Only a caller that just re-ran the guardrails may pass it.
   */
  upsertObservationSemanticText(input: {
    observation_id: number;
    protocol: string;
    status: SemanticTextStatus;
    /** Derived value; must be null unless `status === 'ready'`. */
    payload?: SemanticEnPayload | null;
    translator: string;
    translator_version?: string | null;
    attempts?: number;
    failure_reason?: string | null;
    /** Permit overwriting a `ready` row with a non-ready status. */
    allowDowngrade?: boolean;
  }): void {
    const now = nowISO();
    const payloadJson =
      input.status === 'ready' && input.payload ? JSON.stringify(input.payload) : null;
    const guard = input.allowDowngrade
      ? ''
      : `\n       WHERE excluded.status = 'ready' OR observation_semantic_texts.status <> 'ready'`;
    this.db.run(
      `INSERT INTO observation_semantic_texts (
         observation_id, protocol, status, payload_json, translator,
         translator_version, attempts, failure_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(observation_id, protocol) DO UPDATE SET
         status = excluded.status,
         payload_json = excluded.payload_json,
         translator = excluded.translator,
         translator_version = excluded.translator_version,
         attempts = excluded.attempts,
         failure_reason = excluded.failure_reason,
         updated_at = excluded.updated_at${guard}`,
      [
        input.observation_id,
        input.protocol,
        input.status,
        payloadJson,
        input.translator,
        input.translator_version ?? null,
        input.attempts ?? 0,
        input.failure_reason ?? null,
        now,
        now,
      ],
    );
  }

  getObservationSemanticText(
    observation_id: number,
    protocol: string,
  ): ObservationSemanticTextRow | null {
    return this.db
      .query(
        `SELECT * FROM observation_semantic_texts
          WHERE observation_id = ? AND protocol = ?`,
      )
      .get(observation_id, protocol) as ObservationSemanticTextRow | null;
  }

  /** Status histogram for one protocol — the rebuild-progress read (§5.8). */
  countObservationSemanticTexts(protocol: string): {
    ready: number;
    pending: number;
    failed: number;
  } {    const rows = this.db
      .query(
        `SELECT status AS status, COUNT(*) AS c
           FROM observation_semantic_texts
          WHERE protocol = ?
          GROUP BY status`,
      )
      .all(protocol) as { status: string; c: number }[];
    const out = { ready: 0, pending: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === 'ready') out.ready = row.c;
      else if (row.status === 'pending') out.pending = row.c;
      else if (row.status === 'failed') out.failed = row.c;
    }
    return out;
  }

  /**
   * Observations that still owe a `ready` derived value under `protocol`.
   *
   * This is the entry point a protocol or translator upgrade needs: without it,
   * "we changed the normalization protocol" has no path to "the corpus was
   * rebuilt", and the only symptom would be a permanently partial
   * `semantic-en-v1` coverage that looks like a queue backlog.
   *
   * Excluded on purpose:
   *   - `quality = 'fallback'` Observations — their prose is a generated
   *     placeholder, so there is nothing faithful to mirror.
   *   - rows already `failed` — the guardrails refused that content twice; a
   *     third identical attempt costs an ACP call and changes nothing. They are
   *     visible in `countObservationSemanticTexts()` and need a protocol/prompt
   *     change, not a retry.
   *   - anything with an in-flight job, so a second call is idempotent.
   */
  findObservationsMissingSemanticText(opts: {
    protocol: string;
    limit?: number;
  }): number[] {
    const limit = opts.limit ?? 500;
    return (
      this.db
        .query(
          `SELECT o.id AS id FROM observations o
             LEFT JOIN observation_semantic_texts s
               ON s.observation_id = o.id AND s.protocol = ?
            WHERE o.quality = 'normal'
              AND (s.observation_id IS NULL OR s.status = 'pending')
              AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.job_type = 'renormalize_observation'
                   AND j.dedupe_key = 'renorm:obs:' || o.id
                   AND j.state IN ('pending', 'leased')
              )
            ORDER BY o.id ASC LIMIT ?`,
        )
        .all(opts.protocol, limit) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Enqueue the rebuild jobs found by {@link findObservationsMissingSemanticText}. */
  requeueSemanticTextRebuild(opts: { protocol: string; limit?: number }): number {
    const ids = this.findObservationsMissingSemanticText(opts);
    let queued = 0;
    this.transaction(() => {
      for (const id of ids) {
        const job = this.enqueueJob({
          job_type: 'renormalize_observation',
          dedupe_key: `renorm:obs:${id}`,
          entity_type: 'observation',
          entity_id: String(id),
          payload_json: JSON.stringify({ observation_id: id }),
        });
        if (job) queued++;
      }
    });
    return queued;
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
      // The column list must mirror `observations_fts` exactly — when it covered
      // only 5 of the 9 indexed columns, a 2-char query could not reach a term
      // that appears solely in `request` or `evidence_json`, so the same word
      // was findable at 3 chars and invisible at 2.
      const like = `%${literalQuery}%`;
      let sql = `SELECT * FROM observations
        WHERE turn_stopped_at > ?
          AND (title LIKE ? OR summary LIKE ? OR request LIKE ? OR outcome LIKE ?
               OR learned LIKE ? OR next_steps LIKE ? OR concepts_json LIKE ?
               OR evidence_json LIKE ? OR files_touched_json LIKE ?)`;
      const params: (string | number)[] = [
        dateThreshold, like, like, like, like, like, like, like, like, like,
      ];
      if (opts?.scopeKey) { sql += ' AND scope_key = ?'; params.push(opts.scopeKey); }
      if (opts?.type) { sql += ' AND memory_type = ?'; params.push(opts.type); }
      // Same reasoning as the FTS branch: no pin ordering, recency only.
      sql += ' ORDER BY turn_stopped_at DESC, id DESC LIMIT ?';
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
    // Ranking is bm25 only. `is_pinned` deliberately does NOT participate: the
    // hybrid layer turns this row order into the FTS rank it feeds into RRF
    // (see observation-search.ts), so ordering pinned rows first would let a
    // weakly-matching pinned Observation steal rank 1 from a strong match. Pin
    // affects bootstrap injection, not search relevance.
    sql += ' ORDER BY fts.rank LIMIT ?';
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

  // ---------- reconciliation (P0-5) ----------

  /**
   * Find projection work that was lost rather than merely failed.
   *
   * Two orphan classes, both invisible in normal operation:
   *   - a CLOSED turn with no Observation and no active summarize job. Either
   *     the enqueue never landed (crash between close and enqueue, pre-
   *     transaction data) or the job reached a terminal state without producing
   *     anything. A dropped raw event cannot be recovered, but a missing
   *     projection can — the Truth Layer still holds the events.
   *   - an Observation whose stored vector is missing **or unusable**: written
   *     by a different embedding model, a different dimensionality, or with a
   *     blob whose byte length does not match. The retrieval layer skips such
   *     rows (§7.1), so they degrade to keyword-only reachability silently —
   *     and the first version of this check only looked for a *missing row*,
   *     which meant an embedding-model upgrade left every historical vector
   *     permanently dark with no command able to rebuild it.
   *
   * The vector identity is a **required** argument rather than an optional
   * filter: a lenient default is exactly how the stale-vector class went
   * unnoticed. Callers must state which vector space they consider current.
   *
   * `succeeded` counts as active for turns: a succeeded summarize job that left
   * no Observation is a real bug, but re-running it is safe (the handler
   * short-circuits) and surfacing it is more useful than hiding it — so it is
   * deliberately NOT filtered out here.
   */
  findOrphans(opts: {
    embeddingModel: string;
    embeddingDimensions: number;
    limit?: number;
  }): { turnsWithoutObservation: number[]; observationsWithoutEmbedding: number[] } {
    const limit = opts.limit ?? 500;
    const turnsWithoutObservation = (
      this.db
        .query(
          `SELECT t.id AS id FROM turns t
             LEFT JOIN observations o ON o.turn_id = t.id
            WHERE t.state = 'closed'
              AND o.id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.job_type = 'summarize_turn'
                   AND j.dedupe_key = 'turn:' || t.id
                   AND j.state IN ('pending', 'leased')
              )
            ORDER BY t.id ASC LIMIT ?`,
        )
        .all(limit) as { id: number }[]
    ).map((r) => r.id);

    const observationsWithoutEmbedding = (
      this.db
        .query(
          `SELECT o.id AS id FROM observations o
             LEFT JOIN observation_embeddings e
               ON e.observation_id = o.id
              AND e.model = ?
              AND e.dimensions = ?
              AND length(e.embedding) = ?
            WHERE e.observation_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM jobs j
                 WHERE j.job_type = 'embed_observation'
                   AND j.dedupe_key = 'embed:obs:' || o.id
                   AND j.state IN ('pending', 'leased')
              )
            ORDER BY o.id ASC LIMIT ?`,
        )
        .all(
          opts.embeddingModel,
          opts.embeddingDimensions,
          opts.embeddingDimensions * 4, // float32 blob; same check the read path makes
          limit,
        ) as { id: number }[]
    ).map((r) => r.id);

    return { turnsWithoutObservation, observationsWithoutEmbedding };
  }

  /**
   * Re-enqueue the orphans found by `findOrphans()`.
   *
   * Idempotent by construction: the active-only dedupe index means a second run
   * while the first is still pending is swallowed, and terminal rows are left in
   * place so the original `last_error` stays available for diagnosis.
   */
  requeueOrphans(opts: {
    embeddingModel: string;
    embeddingDimensions: number;
    limit?: number;
  }): { summarize: number; embed: number } {
    const orphans = this.findOrphans(opts);
    let summarize = 0;
    let embed = 0;

    this.transaction(() => {
      for (const turnId of orphans.turnsWithoutObservation) {
        const job = this.enqueueJob({
          job_type: 'summarize_turn',
          dedupe_key: `turn:${turnId}`,
          entity_type: 'turn',
          entity_id: String(turnId),
          payload_json: JSON.stringify({ turn_id: turnId }),
        });
        if (job) summarize++;
      }
      for (const observationId of orphans.observationsWithoutEmbedding) {
        const job = this.enqueueJob({
          job_type: 'embed_observation',
          dedupe_key: `embed:obs:${observationId}`,
          entity_type: 'observation',
          entity_id: String(observationId),
          payload_json: JSON.stringify({ observation_id: observationId }),
        });
        if (job) embed++;
      }
    });

    return { summarize, embed };
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
    // Per-space counts. `model` is the full space key, so a row written under an
    // older key (or a bare model name from before protocol isolation) counts for
    // no protocol — which is the honest reading: it cannot be compared against
    // anything the current code produces.
    const spaceKeys = NORMALIZATION_PROTOCOLS.map((protocol) => ({
      protocol,
      spaceKey: embeddingSpaceKey(protocol),
    }));
    const byProtocol = spaceKeys.map(({ protocol, spaceKey }) => {
      const ready = scalar(
        'SELECT COUNT(*) AS c FROM observation_embeddings WHERE model = ?',
        spaceKey,
      );
      return {
        protocol: protocol as string,
        spaceKey,
        ready,
        coverage: total > 0 ? Number((ready / total).toFixed(3)) : 0,
      };
    });
    const placeholders = spaceKeys.map(() => '?').join(',');
    const embedded = scalar(
      `SELECT COUNT(DISTINCT observation_id) AS c FROM observation_embeddings
        WHERE model IN (${placeholders})`,
      ...spaceKeys.map((s) => s.spaceKey),
    );
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
      embeddings: {
        ready: embedded,
        coverage,
        byProtocol,
        semanticEn: this.countObservationSemanticTexts(SEMANTIC_EN_PROTOCOL),
      },
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
