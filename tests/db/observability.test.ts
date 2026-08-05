import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob, DIMENSIONS } from '../../src/embedding';
import { embeddingSpaceKey, RAW_PROTOCOL } from '../../src/semantic-en';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

function seedObs(
  quality: 'normal' | 'fallback',
  opts?: { pinned?: boolean; embedded?: boolean },
): number {
  const sid = 's';
  if (!db.getSessionRef(sid)) db.upsertSessionRef({ session_id: sid, cwd: '/x', repo: '/x' });
  const seq = db.allocateNextTurnSeq(sid);
  const turn = db.createTurn({ session_id: sid, seq, cwd: '/x', repo: '/x' });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: sid, turn_seq: seq, repo: '/x', cwd_scope: '/x',
    title: 't', summary: 's', memory_type: 'change', quality,
    turn_started_at: '2026-07-14T00:00:00Z', turn_stopped_at: '2026-07-14T00:00:00Z',
  })!;
  if (opts?.pinned) db.pinObservation(id, true);
  if (opts?.embedded) {
    // The stats query only counts vectors in a CURRENT space, so the fixture has
    // to name one: a row under an arbitrary model string is exactly the
    // uncomparable leftover that coverage is supposed to exclude.
    db.upsertObservationEmbedding(
      id,
      embeddingSpaceKey(RAW_PROTOCOL),
      DIMENSIONS,
      embeddingToBlob(new Float32Array(DIMENSIONS)),
    );
  }
  return id;
}

describe('getObservabilityStats (§12.4)', () => {
  test('empty DB returns zeros with coverage 0', () => {
    const s = db.getObservabilityStats();
    expect(s.observations).toEqual({ total: 0, normal: 0, fallback: 0, pinned: 0 });
    expect(s.embeddings.ready).toBe(0);
    expect(s.embeddings.coverage).toBe(0);
    expect(s.embeddings.semanticEn).toEqual({ ready: 0, pending: 0, failed: 0 });
    expect(s.jobs).toEqual({ pending: 0, leased: 0, dead: 0 });
    expect(s.jobs24h).toEqual({ succeeded: 0, dead: 0 });
  });

  test('counts normal / fallback / pinned and embedding coverage', () => {
    seedObs('normal', { embedded: true });
    seedObs('normal', { pinned: true });
    seedObs('fallback');
    seedObs('fallback', { embedded: true });
    const s = db.getObservabilityStats();
    expect(s.observations.total).toBe(4);
    expect(s.observations.normal).toBe(2);
    expect(s.observations.fallback).toBe(2);
    expect(s.observations.pinned).toBe(1);
    expect(s.embeddings.ready).toBe(2);
    expect(s.embeddings.coverage).toBe(0.5); // 2/4
  });

  test('jobs are counted by live state', () => {
    db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'a', payload_json: '{}' });
    db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'b', payload_json: '{}' });
    db.raw.run("UPDATE jobs SET state = 'dead' WHERE dedupe_key = 'b'");
    const s = db.getObservabilityStats();
    expect(s.jobs.pending).toBe(1);
    expect(s.jobs.dead).toBe(1);
  });

  test('jobs24h counts only outcomes within the last 24h', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const ins = (state: string, updated: string, key: string) =>
      db.raw.run(
        `INSERT INTO jobs (job_type, dedupe_key, payload_json, state, priority, attempts, max_attempts, available_at, created_at, updated_at)
         VALUES ('summarize_turn', ?, '{}', ?, 100, 1, 5, ?, ?, ?)`,
        [key, state, now, now, updated],
      );
    ins('succeeded', now, 'r1');
    ins('succeeded', old, 'r2');
    ins('dead', now, 'r3');
    ins('dead', old, 'r4');
    const s = db.getObservabilityStats();
    expect(s.jobs24h.succeeded).toBe(1);
    expect(s.jobs24h.dead).toBe(1);
    // Live dead count is time-independent: both dead rows counted.
    expect(s.jobs.dead).toBe(2);
  });
});

describe('search / ACP metrics (§12.4, metric_events)', () => {
  /** The zero state of every search counter. Named so each test asserts a diff. */
  const EMPTY_SEARCH_WINDOW = {
    requests: 0,
    ftsOnly: 0,
    degradeRate: 0,
    latencyMsAvg: 0,
    latencyMsP50: 0,
    latencyMsP95: 0,
    protocolSemanticEn: 0,
    protocolRaw: 0,
    semanticEnRate: 0,
    semanticQueryIssues: {},
    discoveryEffective: 0,
    zeroFts: 0,
    zeroFtsRecalled: 0,
    semanticOnlyTotal: 0,
    semanticOnlyPerRequest: 0,
    semanticOnlyMax: 0,
    comparableVectorsAvg: 0,
    scopeVectorsAvg: 0,
    scopeVectorsMin: 0,
    scopeVectorsMeasured: 0,
    emptyScopeRequests: 0,
  };

  test('empty window yields zero rate, latency and acp counts', () => {
    const s = db.getObservabilityStats();
    expect(s.search24h).toEqual(EMPTY_SEARCH_WINDOW);
    expect(s.acp24h).toEqual({ repairs: 0, contaminations: 0 });
  });

  test('recordSearchMetric aggregates requests, FTS-only rate and latency', () => {
    db.recordSearchMetric({ latencyMs: 10, degraded: false });
    db.recordSearchMetric({ latencyMs: 20, degraded: true });
    db.recordSearchMetric({ latencyMs: 30, degraded: false });
    db.recordSearchMetric({ latencyMs: 40, degraded: true });
    const s = db.getObservabilityStats();
    expect(s.search24h.requests).toBe(4);
    expect(s.search24h.ftsOnly).toBe(2);
    expect(s.search24h.degradeRate).toBe(0.5);
    expect(s.search24h.latencyMsAvg).toBe(25); // (10+20+30+40)/4
    expect(s.search24h.latencyMsP50).toBe(30); // nearest-rank index 2
    expect(s.search24h.latencyMsP95).toBe(40); // p95 index → max here
  });

  test('recordAcpEvent counts repair vs contamination separately', () => {
    db.recordAcpEvent('repair');
    db.recordAcpEvent('repair');
    db.recordAcpEvent('contamination');
    const s = db.getObservabilityStats();
    expect(s.acp24h.repairs).toBe(2);
    expect(s.acp24h.contaminations).toBe(1);
  });

  test('events older than 24h are excluded from the window', () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.raw.run(
      "INSERT INTO metric_events (kind, degraded, latency_ms, created_at) VALUES ('search', 1, 999, ?)",
      [old],
    );
    db.raw.run(
      "INSERT INTO metric_events (kind, created_at) VALUES ('acp_repair', ?)",
      [old],
    );
    db.recordSearchMetric({ latencyMs: 5, degraded: false });
    const s = db.getObservabilityStats();
    expect(s.search24h.requests).toBe(1); // only the recent search
    expect(s.acp24h.repairs).toBe(0); // the old repair is outside the window
  });
});

/**
 * 阶段 2C 的检索观测（方案 §8.2）。
 *
 * 这些计数器是灰度的全部依据：拆门之后，"召回是不是真的可达"和"误召回有没有越界"
 * 在返回页面上是看不出来的——一次返回空可能是没有相关记录，也可能是这个 scope 的
 * `semantic-en-v1` 向量还没建好；一次返回两条可能是 cap 正常生效，也可能是 cap 根本
 * 没被写进指标。所以这里逐字段钉住聚合语义，而不是只测"字段存在"。
 */
describe('检索观测（阶段 2C，plan §8.2）', () => {
  test('协议分布与 semantic_query_en 覆盖率分开计数', () => {
    db.recordSearchMetric({ latencyMs: 5, degraded: false, protocol: 'semantic-en-v1', discoveryEffective: true });
    db.recordSearchMetric({ latencyMs: 5, degraded: false, protocol: 'semantic-en-v1', discoveryEffective: true });
    db.recordSearchMetric({ latencyMs: 5, degraded: false, protocol: 'raw-v1', rejectReason: 'missing', discoveryEffective: false });
    db.recordSearchMetric({ latencyMs: 5, degraded: false, protocol: 'raw-v1', rejectReason: 'placeholder', discoveryEffective: false });
    const s = db.getObservabilityStats();
    expect(s.search24h.protocolSemanticEn).toBe(2);
    expect(s.search24h.protocolRaw).toBe(2);
    expect(s.search24h.semanticEnRate).toBe(0.5);
    // 缺失与被拒是两件事：一个是调用方没传，一个是传了但护栏不认。
    expect(s.search24h.semanticQueryIssues).toEqual({ missing: 1, placeholder: 1 });
    expect(s.search24h.discoveryEffective).toBe(2);
  });

  test('zero-FTS 与"零锚点靠语义找回"分开计数', () => {
    // FTS 有命中：既不算 zero-FTS，也不算被语义找回。
    db.recordSearchMetric({ latencyMs: 5, degraded: false, ftsCount: 3, semanticOnly: 1 });
    // zero-FTS 且语义找回了。
    db.recordSearchMetric({ latencyMs: 5, degraded: false, ftsCount: 0, semanticOnly: 2 });
    // zero-FTS 但两路都没候选——这才是"真的没有"。
    db.recordSearchMetric({ latencyMs: 5, degraded: false, ftsCount: 0, semanticOnly: 0 });
    const s = db.getObservabilityStats();
    expect(s.search24h.zeroFts).toBe(2);
    expect(s.search24h.zeroFtsRecalled).toBe(1);
    expect(s.search24h.semanticOnlyTotal).toBe(3);
    expect(s.search24h.semanticOnlyPerRequest).toBe(1);
    // cap 不变量的运行侧读数：任何一次请求都不该超过冻结的 cap。
    expect(s.search24h.semanticOnlyMax).toBe(2);
  });

  test('comparableVectors 均值报出"有没有向量可比"', () => {
    db.recordSearchMetric({ latencyMs: 5, degraded: false, comparableVectors: 10 });
    db.recordSearchMetric({ latencyMs: 5, degraded: false, comparableVectors: 0 });
    const s = db.getObservabilityStats();
    expect(s.search24h.comparableVectorsAvg).toBe(5);
  });

  /**
   * scope 内向量数量（方案 §8.2，Gate C 第二轮整改）。
   *
   * 为什么 `comparableVectors` 顶不上这个位置：它被 200 条候选池夹住，workspace 一大就
   * 饱和，于是"这个 scope 到底建过向量吗"永远读不出来。而"没建向量"与"没有相关记录"
   * 在返回页面上完全一样——这个字段就是为了把这两件事分开。
   */
  test('scopeVectors：未测量（null）与真的为 0 分开', () => {
    // 语义步骤没跑到（回滚 profile / 非英文空间的零锚点提前返回）→ null。
    db.recordSearchMetric({ latencyMs: 5, degraded: false, scopeVectors: null });
    // 语义步骤跑了，scope 里确实一条向量都没有 → 0。
    db.recordSearchMetric({ latencyMs: 5, degraded: false, scopeVectors: 0 });
    db.recordSearchMetric({ latencyMs: 5, degraded: false, scopeVectors: 40 });
    const s = db.getObservabilityStats().search24h;
    // 只有被测量过的两条参与统计，null 不被算成 0。
    expect(s.scopeVectorsMeasured).toBe(2);
    expect(s.scopeVectorsAvg).toBe(20); // (0 + 40) / 2
    expect(s.scopeVectorsMin).toBe(0);
    // 语义召回在这条请求上结构性不可能——是重建/积压问题，不是相关性问题。
    expect(s.emptyScopeRequests).toBe(1);
  });

  test('countScopeVectors 只数指定 scope + 指定空间键', () => {
    const spaceA = 'space-a';
    const spaceB = 'space-b';
    const mk = (session: string, cwd: string, space?: string): number => {
      if (!db.getSessionRef(session)) db.upsertSessionRef({ session_id: session, cwd, repo: cwd });
      const seq = db.allocateNextTurnSeq(session);
      const turn = db.createTurn({ session_id: session, seq, cwd, repo: cwd });
      db.markTurnClosed(turn.id);
      const now = new Date().toISOString();
      const id = db.insertObservation({
        turn_id: turn.id, session_id: session, turn_seq: seq, repo: cwd, cwd_scope: cwd,
        title: 'x', summary: 'x', memory_type: 'change', quality: 'normal',
        turn_started_at: now, turn_stopped_at: now,
      })!;
      if (space) db.upsertObservationEmbedding(id, space, 4, embeddingToBlob(new Float32Array([1, 0, 0, 0])));
      return id;
    };
    const here = computeScopeKey('/here', '/here');
    const there = computeScopeKey('/there', '/there');
    mk('s-here-1', '/here', spaceA);
    mk('s-here-2', '/here', spaceA);
    mk('s-here-3', '/here', spaceB);   // 另一个空间键：不该被数进来
    mk('s-here-4', '/here');           // 没有向量
    mk('s-there-1', '/there', spaceA); // 另一个 scope

    expect(db.countScopeVectors({ scopeKey: here, model: spaceA, dimensions: 4 })).toBe(2);
    expect(db.countScopeVectors({ scopeKey: here, model: spaceB, dimensions: 4 })).toBe(1);
    expect(db.countScopeVectors({ scopeKey: there, model: spaceA, dimensions: 4 })).toBe(1);
    // 维度不符（协议隔离的另一半）：一条都不算。
    expect(db.countScopeVectors({ scopeKey: here, model: spaceA, dimensions: 384 })).toBe(0);
    // 省略 scopeKey = 全 dataDir，这正是显式 all-scopes 搜索真正搜的范围。
    expect(db.countScopeVectors({ model: spaceA, dimensions: 4 })).toBe(3);
  });

  test('2C 之前写入的行按"未知"计，不被算成 raw / zero-FTS', () => {
    // 旧 Worker / 旧 MCP server 写的行：新列全是 NULL。
    db.raw.run(
      "INSERT INTO metric_events (kind, degraded, latency_ms, created_at) VALUES ('search', 0, 7, ?)",
      [new Date().toISOString()],
    );
    const s = db.getObservabilityStats();
    expect(s.search24h.requests).toBe(1);
    // 把 NULL 读成 0 会凭空造出一条"零关键词命中"的记录，也会让 raw 协议看起来
    // 比实际多——这两个数字恰好是 Gate C 要判的那两个。
    expect(s.search24h.zeroFts).toBe(0);
    expect(s.search24h.protocolRaw).toBe(0);
    expect(s.search24h.protocolSemanticEn).toBe(0);
    expect(s.search24h.semanticQueryIssues).toEqual({});
  });

  test('指标行只有计数与枚举，没有 query 正文', () => {
    db.recordSearchMetric({
      latencyMs: 5,
      degraded: false,
      protocol: 'semantic-en-v1',
      rejectReason: null,
      ftsCount: 0,
      semanticCount: 3,
      comparableVectors: 12,
      scopeVectors: 40,
      semanticOnly: 2,
      discoveryEffective: true,
    });
    const row = db.raw.query("SELECT * FROM metric_events WHERE kind = 'search'").get() as Record<string, unknown>;
    // 表结构就是隐私边界：没有任何可以放文本的列。scope 只以**计数**出现，
    // scope key 与 workspace 路径都不落盘。
    expect(Object.keys(row).sort()).toEqual([
      'comparable_vectors', 'created_at', 'degraded', 'discovery', 'fts_count',
      'id', 'kind', 'latency_ms', 'protocol', 'reject_reason', 'scope_vectors',
      'semantic_count', 'semantic_only',
    ]);
    expect(row.scope_vectors).toBe(40);
  });
});

describe('metric_events 迁移（阶段 2C）', () => {
  test('4 列旧表被就地补列，且旧行保留', () => {
    // 复刻 2C 之前的表形状，然后让 MemoryDB 打开它。
    const path = join(mkdtempSync(join(tmpdir(), 'kiro-mem-metrics-migrate-')), 'old.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE metric_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      degraded INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      created_at TEXT NOT NULL
    );`);
    raw.run("INSERT INTO metric_events (kind, degraded, latency_ms, created_at) VALUES ('search', 1, 42, ?)", [
      new Date().toISOString(),
    ]);
    raw.close();

    const migrated = new MemoryDB(path);
    // 迁移是增量的：旧行还在，历史窗口不会因为一次升级归零。
    expect(migrated.getObservabilityStats().search24h.requests).toBe(1);
    expect(migrated.getObservabilityStats().search24h.ftsOnly).toBe(1);
    // 新列可写——不补列的话这次 INSERT 会静默失败（指标写入是 best-effort），
    // 于是整个灰度都建立在永远为空的计数器上。
    migrated.recordSearchMetric({ latencyMs: 8, degraded: false, protocol: 'semantic-en-v1', ftsCount: 0, semanticOnly: 2, scopeVectors: 12 });
    const s = migrated.getObservabilityStats();
    expect(s.search24h.requests).toBe(2);
    expect(s.search24h.protocolSemanticEn).toBe(1);
    expect(s.search24h.zeroFtsRecalled).toBe(1);
    // 新加的 scope 观测列也必须补上——漏一列就是这一列永远为空。
    expect(s.search24h.scopeVectorsMeasured).toBe(1);
    expect(s.search24h.scopeVectorsAvg).toBe(12);
    migrated.close();

    // 幂等：再开一次不重复 ALTER，也不抛错。
    const again = new MemoryDB(path);
    expect(again.getObservabilityStats().search24h.requests).toBe(2);
    again.close();
  });
});
