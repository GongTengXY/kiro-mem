import { Database } from 'bun:sqlite';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { getDataDir } from './config';
import { generateEmbedding, cosineSimilarity, blobToEmbedding } from './embedding';

// --- Types ---

export interface Session {
  id: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  agent_name: string | null;
  started_at: string;
  ended_at: string | null;
  status: 'active' | 'completed' | 'abandoned';
  summary_request: string | null;
  summary_investigated: string | null;
  summary_learned: string | null;
  summary_completed: string | null;
  summary_next_steps: string | null;
  prompts: string; // JSON array
  files_touched: string; // JSON array
  created_at: string;
  updated_at: string;
}

export interface Observation {
  id: number;
  session_id: string;
  tool_name: string | null;
  event_type: string | null;
  title: string | null;
  narrative: string | null;
  facts: string | null; // JSON array
  concepts: string | null; // JSON array
  obs_type: string | null;
  files: string | null; // JSON array
  raw_tokens: number | null;
  compressed_tokens: number | null;
  is_pinned: number;
  created_at: string;
}

export interface SearchResult {
  id: number;
  title: string;
  obs_type: string;
  created_at: string;
  session_id: string;
  rank: number;
  match_source: 'fts' | 'semantic' | 'hybrid';
  semantic_score: number | null;
}

// --- Schema ---

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  cwd           TEXT NOT NULL,
  repo          TEXT,
  branch        TEXT,
  agent_name    TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT DEFAULT 'active',
  summary_request    TEXT,
  summary_investigated TEXT,
  summary_learned    TEXT,
  summary_completed  TEXT,
  summary_next_steps TEXT,
  prompts       TEXT DEFAULT '[]',
  files_touched TEXT DEFAULT '[]',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  tool_name     TEXT,
  event_type    TEXT,
  title         TEXT,
  narrative     TEXT,
  facts         TEXT,
  concepts      TEXT,
  obs_type      TEXT,
  files         TEXT,
  raw_tokens    INTEGER,
  compressed_tokens INTEGER,
  is_pinned     INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_obs_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(obs_type);
CREATE INDEX IF NOT EXISTS idx_obs_pinned ON observations(is_pinned);
CREATE INDEX IF NOT EXISTS idx_obs_created ON observations(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, narrative, facts, concepts,
  content=observations, content_rowid=id,
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  summary_request, summary_investigated, summary_learned,
  summary_completed, summary_next_steps,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS observation_embeddings (
  observation_id   INTEGER PRIMARY KEY REFERENCES observations(id),
  model            TEXT NOT NULL,
  dimensions       INTEGER NOT NULL,
  embedding        BLOB NOT NULL,
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, narrative, facts, concepts)
  VALUES (new.id, new.title, new.narrative, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, narrative, facts, concepts)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.concepts);
END;
`;

// --- Database class ---

export class MemoryDB {
  private db: Database;

  constructor(dbPath?: string) {
    const dir = getDataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = dbPath || join(dir, 'kiro-mem.db');
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec(SCHEMA);
    this.db.exec(FTS_TRIGGERS);
  }

  close() {
    this.db.close();
  }

  // --- Sessions ---

  createSession(
    id: string,
    cwd: string,
    repo?: string,
    branch?: string,
    agentName?: string,
  ): Session {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO sessions (id, cwd, repo, branch, agent_name, started_at, prompts, files_touched)
       VALUES (?, ?, ?, ?, ?, ?, '[]', '[]')`,
      [id, cwd, repo || null, branch || null, agentName || null, now],
    );
    return this.getSession(id)!;
  }

  getSession(id: string): Session | null {
    return this.db
      .query('SELECT * FROM sessions WHERE id = ?')
      .get(id) as Session | null;
  }

  findActiveSession(cwd: string, timeoutMinutes: number): Session | null {
    return this.db
      .query(
        `SELECT * FROM sessions
       WHERE cwd = ? AND status = 'active'
         AND updated_at > datetime('now', ?)
       ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(cwd, `-${timeoutMinutes} minutes`) as Session | null;
  }

  appendPrompt(sessionId: string, prompt: string) {
    const session = this.getSession(sessionId);
    if (!session) return;
    const prompts = JSON.parse(session.prompts);
    prompts.push(prompt);
    this.db.run(
      "UPDATE sessions SET prompts = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify(prompts), sessionId],
    );
  }

  completeSession(
    sessionId: string,
    summary: {
      request?: string;
      investigated?: string;
      learned?: string;
      completed?: string;
      next_steps?: string;
      files_touched?: string[];
    },
  ) {
    this.db.run(
      `UPDATE sessions SET
        status = 'completed', ended_at = datetime('now'),
        summary_request = ?, summary_investigated = ?, summary_learned = ?,
        summary_completed = ?, summary_next_steps = ?,
        files_touched = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        summary.request || null,
        summary.investigated || null,
        summary.learned || null,
        summary.completed || null,
        summary.next_steps || null,
        summary.files_touched ? JSON.stringify(summary.files_touched) : null,
        sessionId,
      ],
    );
    this.db.run(
      `INSERT INTO sessions_fts(rowid, summary_request, summary_investigated,
        summary_learned, summary_completed, summary_next_steps)
       VALUES ((SELECT rowid FROM sessions WHERE id = ?), ?, ?, ?, ?, ?)`,
      [
        sessionId,
        summary.request || null,
        summary.investigated || null,
        summary.learned || null,
        summary.completed || null,
        summary.next_steps || null,
      ],
    );
  }

  abandonStaleSessions(cwd: string, timeoutMinutes: number) {
    this.db.run(
      `UPDATE sessions SET status = 'abandoned', updated_at = datetime('now')
       WHERE cwd = ? AND status = 'active' AND updated_at <= datetime('now', ?)`,
      [cwd, `-${timeoutMinutes} minutes`],
    );
  }

  touchSession(sessionId: string) {
    this.db.run(
      "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?",
      [sessionId],
    );
  }

  getRecentSessions(
    cwd: string | null,
    repo: string | null,
    limit: number,
  ): Session[] {
    if (repo) {
      return this.db
        .query(
          `SELECT * FROM sessions WHERE status = 'completed' AND (cwd = ? OR repo = ?)
         ORDER BY CASE WHEN cwd = ? THEN 0 ELSE 1 END, started_at DESC LIMIT ?`,
        )
        .all(cwd, repo, cwd, limit) as Session[];
    }
    if (cwd) {
      return this.db
        .query(
          `SELECT * FROM sessions WHERE status = 'completed' AND cwd = ?
         ORDER BY started_at DESC LIMIT ?`,
        )
        .all(cwd, limit) as Session[];
    }
    return this.db
      .query(
        "SELECT * FROM sessions WHERE status = 'completed' ORDER BY started_at DESC LIMIT ?",
      )
      .all(limit) as Session[];
  }

  getRecentObservations(
    cwd: string | null,
    repo: string | null,
    maxSessions: number,
    limit: number,
  ): Observation[] {
    const conditions: string[] = ["s.status = 'completed'", 'o.title IS NOT NULL'];
    const params: (string | number)[] = [];

    if (repo) {
      conditions.push('(s.cwd = ? OR s.repo = ?)');
      params.push(cwd || '', repo);
    } else if (cwd) {
      conditions.push('s.cwd = ?');
      params.push(cwd);
    }

    const where = conditions.join(' AND ');

    // 子查询：限定最近 N 个 session
    const subWhere = repo
      ? "status = 'completed' AND (cwd = ? OR repo = ?)"
      : cwd
        ? "status = 'completed' AND cwd = ?"
        : "status = 'completed'";
    const subParams: (string | number)[] = repo
      ? [cwd || '', repo]
      : cwd
        ? [cwd]
        : [];

    const sql = `
      SELECT o.* FROM observations o
      JOIN sessions s ON o.session_id = s.id
      WHERE ${where}
        AND s.id IN (
          SELECT id FROM sessions WHERE ${subWhere}
          ORDER BY started_at DESC LIMIT ?
        )
      ORDER BY o.created_at DESC LIMIT ?`;

    return this.db
      .query(sql)
      .all(...params, ...subParams, maxSessions, limit) as Observation[];
  }

  // --- Observations ---

  insertObservation(obs: {
    session_id: string;
    tool_name?: string;
    event_type?: string;
    title?: string;
    narrative?: string;
    facts?: string[];
    concepts?: string[];
    obs_type?: string;
    files?: string[];
    raw_tokens?: number;
    compressed_tokens?: number;
  }): number {
    const result = this.db.run(
      `INSERT INTO observations (session_id, tool_name, event_type, title, narrative,
        facts, concepts, obs_type, files, raw_tokens, compressed_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        obs.session_id,
        obs.tool_name || null,
        obs.event_type || null,
        obs.title || null,
        obs.narrative || null,
        obs.facts ? JSON.stringify(obs.facts) : null,
        obs.concepts ? JSON.stringify(obs.concepts) : null,
        obs.obs_type || null,
        obs.files ? JSON.stringify(obs.files) : null,
        obs.raw_tokens || null,
        obs.compressed_tokens || null,
      ],
    );
    this.touchSession(obs.session_id);
    return Number(result.lastInsertRowid);
  }

  getObservation(id: number): Observation | null {
    return this.db
      .query('SELECT * FROM observations WHERE id = ?')
      .get(id) as Observation | null;
  }

  getObservationsByIds(ids: number[]): Observation[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .query(
        `SELECT * FROM observations WHERE id IN (${placeholders}) ORDER BY created_at`,
      )
      .all(...ids) as Observation[];
  }

  getSessionObservations(sessionId: string): Observation[] {
    return this.db
      .query(
        'SELECT * FROM observations WHERE session_id = ? ORDER BY created_at',
      )
      .all(sessionId) as Observation[];
  }

  countPendingObservations(sessionId: string): number {
    const row = this.db
      .query(
        'SELECT COUNT(*) as cnt FROM observations WHERE session_id = ? AND title IS NULL',
      )
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  async searchObservations(
    query: string,
    opts?: {
      type?: string;
      repo?: string;
      days?: number;
      limit?: number;
    },
  ): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;
    const days = opts?.days || 30;
    const dateThreshold = `-${days} days`;
    const RRF_K = 60;

    // --- Step 1: FTS candidates ---
    const ftsResults = this.ftsSearch(query, dateThreshold, opts?.type, opts?.repo, 50);

    // --- Step 2: Time-window candidates for semantic search ---
    const recentIds = this.getRecentObservationIds(days, 200, opts?.repo);
    const ftsIds = new Set(ftsResults.map(r => r.id));
    // Merge: FTS ids + recent ids (deduped)
    const candidateIds = [...new Set([...ftsIds, ...recentIds])];

    // --- Step 3: Semantic rerank on candidates ---
    let semanticRanking = new Map<number, number>(); // id → similarity score
    try {
      const queryEmbedding = await generateEmbedding(query);
      const embeddings = this.getEmbeddingsByIds(candidateIds);
      const scored: { id: number; score: number }[] = [];
      for (const row of embeddings) {
        const vec = blobToEmbedding(row.embedding);
        const score = cosineSimilarity(queryEmbedding, vec);
        if (score > 0.2) scored.push({ id: row.observation_id, score });
      }
      scored.sort((a, b) => b.score - a.score);
      scored.forEach((item, idx) => semanticRanking.set(item.id, idx + 1));
    } catch {
      // Embedding not available — fall back to FTS only
    }

    // --- Step 4: RRF fusion ---
    const allIds = new Set([...ftsIds, ...semanticRanking.keys()]);
    const ftsRankMap = new Map<number, number>();
    ftsResults.forEach((r, idx) => ftsRankMap.set(r.id, idx + 1));

    const ftsLookup = new Map(ftsResults.map(r => [r.id, r]));

    const scored: { id: number; score: number; ftsRank: number | null; semRank: number | null; semScore: number | null }[] = [];
    for (const id of allIds) {
      const ftsRank = ftsRankMap.get(id) ?? null;
      const semRank = semanticRanking.get(id) ?? null;
      let score = 0;
      if (ftsRank !== null) score += 1 / (RRF_K + ftsRank);
      if (semRank !== null) score += 1 / (RRF_K + semRank);
      scored.push({ id, score, ftsRank, semRank, semScore: null });
    }
    scored.sort((a, b) => b.score - a.score);

    // --- Step 5: Build results ---
    const topIds = scored.slice(0, limit);
    // Fetch observation details for ids not already in FTS results
    const missingIds = topIds.filter(s => !ftsLookup.has(s.id)).map(s => s.id);
    const missingObs = this.getObservationsByIds(missingIds);
    const missingMap = new Map(missingObs.map(o => [o.id, o]));

    // Get semantic scores for final results
    let finalEmbeddings: Map<number, number> | null = null;
    try {
      const queryEmbedding = await generateEmbedding(query);
      const embRows = this.getEmbeddingsByIds(topIds.map(s => s.id));
      finalEmbeddings = new Map();
      for (const row of embRows) {
        finalEmbeddings.set(row.observation_id, cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding)));
      }
    } catch {}

    return topIds.map(s => {
      const fts = ftsLookup.get(s.id);
      const obs = fts || missingMap.get(s.id);
      const matchSource: SearchResult['match_source'] =
        s.ftsRank !== null && s.semRank !== null ? 'hybrid'
        : s.ftsRank !== null ? 'fts' : 'semantic';
      return {
        id: s.id,
        title: obs?.title ?? fts?.title ?? '',
        obs_type: obs?.obs_type ?? fts?.obs_type ?? '',
        created_at: obs?.created_at ?? fts?.created_at ?? '',
        session_id: obs?.session_id ?? fts?.session_id ?? '',
        rank: s.score,
        match_source: matchSource,
        semantic_score: finalEmbeddings?.get(s.id) ?? null,
      };
    });
  }

  private ftsSearch(
    query: string,
    dateThreshold: string,
    type?: string,
    repo?: string,
    limit: number = 50,
  ): SearchResult[] {
    if (query.length < 3) {
      let sql = `SELECT o.id, o.title, o.obs_type, o.created_at, o.session_id, 0 as rank
        FROM observations o
        JOIN sessions s ON o.session_id = s.id
        WHERE (o.title LIKE ? OR o.narrative LIKE ? OR o.facts LIKE ? OR o.concepts LIKE ?)
          AND o.created_at > datetime('now', ?)`;
      const like = `%${query}%`;
      const params: (string | number)[] = [like, like, like, like, dateThreshold];
      if (type) { sql += ' AND o.obs_type = ?'; params.push(type); }
      if (repo) { sql += ' AND s.repo = ?'; params.push(repo); }
      sql += ' ORDER BY o.created_at DESC LIMIT ?';
      params.push(limit);
      return (this.db.query(sql).all(...params) as SearchResult[]).map(r => ({
        ...r, match_source: 'fts' as const, semantic_score: null,
      }));
    }

    let sql = `SELECT o.id, o.title, o.obs_type, o.created_at, o.session_id, fts.rank
      FROM observations_fts fts
      JOIN observations o ON fts.rowid = o.id
      JOIN sessions s ON o.session_id = s.id
      WHERE observations_fts MATCH ?
        AND o.created_at > datetime('now', ?)`;
    const params: (string | number)[] = [query, dateThreshold];
    if (type) { sql += ' AND o.obs_type = ?'; params.push(type); }
    if (repo) { sql += ' AND s.repo = ?'; params.push(repo); }
    sql += ' ORDER BY fts.rank LIMIT ?';
    params.push(limit);
    return (this.db.query(sql).all(...params) as SearchResult[]).map(r => ({
      ...r, match_source: 'fts' as const, semantic_score: null,
    }));
  }

  getPinnedObservations(limit: number = 20): Observation[] {
    return this.db
      .query(
        'SELECT * FROM observations WHERE is_pinned = 1 ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit) as Observation[];
  }

  pinObservation(id: number, pinned: boolean) {
    this.db.run('UPDATE observations SET is_pinned = ? WHERE id = ?', [
      pinned ? 1 : 0,
      id,
    ]);
  }

  getTimeline(observationId: number, before: number, after: number): Observation[] {
    const obs = this.getObservation(observationId);
    if (!obs) return [];
    return this.db
      .query(
        `SELECT * FROM (
          SELECT * FROM observations WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?
        ) UNION ALL
        SELECT * FROM observations WHERE id = ?
        UNION ALL
        SELECT * FROM (
          SELECT * FROM observations WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?
        ) ORDER BY id ASC`,
      )
      .all(obs.session_id, observationId, before, observationId, obs.session_id, observationId, after) as Observation[];
  }

  // --- Embeddings ---

  upsertEmbedding(observationId: number, model: string, dimensions: number, embedding: Buffer) {
    this.db.run(
      `INSERT INTO observation_embeddings (observation_id, model, dimensions, embedding)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(observation_id) DO UPDATE SET
         model = excluded.model, dimensions = excluded.dimensions,
         embedding = excluded.embedding, updated_at = datetime('now')`,
      [observationId, model, dimensions, embedding],
    );
  }

  getEmbeddingsByIds(ids: number[]): { observation_id: number; embedding: Buffer }[] {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .query(`SELECT observation_id, embedding FROM observation_embeddings WHERE observation_id IN (${placeholders})`)
      .all(...ids) as { observation_id: number; embedding: Buffer }[];
  }

  getRecentObservationIds(days: number, limit: number, repo?: string): number[] {
    const dateThreshold = `-${days} days`;
    let sql = `SELECT o.id FROM observations o
      JOIN sessions s ON o.session_id = s.id
      WHERE o.title IS NOT NULL AND o.created_at > datetime('now', ?)`;
    const params: (string | number)[] = [dateThreshold];
    if (repo) {
      sql += ' AND s.repo = ?';
      params.push(repo);
    }
    sql += ' ORDER BY o.created_at DESC LIMIT ?';
    params.push(limit);
    return (this.db.query(sql).all(...params) as { id: number }[]).map(r => r.id);
  }

  hasEmbedding(observationId: number): boolean {
    const row = this.db
      .query('SELECT 1 FROM observation_embeddings WHERE observation_id = ?')
      .get(observationId);
    return !!row;
  }
}
