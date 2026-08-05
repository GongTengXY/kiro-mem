/**
 * Phase 3B 测量：最近 200 vs 全 scope 的 recall，以及三档规模的延迟与 RSS。
 *
 * 判据：`benchmark/reports/phase3b-criteria.md`（A0 + B1）。唯一自变量是
 * `semanticCandidatePool`；其余字段全部取 `DEFAULT_RETRIEVAL_POLICY`（含 bigramAux=false，
 * 判据 §2 第 2 条禁止本轮开启 bigram）。
 *
 * 三条隔离，都是被上一轮 Gate 抓过的形状：
 *
 *   1. **不导入 `src/server/worker.ts`。** 它在模块顶层就构造生产单例（`loadConfig()` +
 *      `new MemoryDB()`），ESM 在本脚本第一行执行之前跑完它，于是真实
 *      `~/.kiro-mem/kiro-mem.db` 被打开并迁移——2C 的 Gate C 第一轮就挂在这上面。
 *      本脚本只用 `MemoryDB(tmpPath)` 和纯检索内核。
 *   2. **失败必须退非零。** 播种、断言、测量各自捕获；采不到读数也算失败。
 *   3. **不改真实用户库。** 全程只写 `mkdtemp` 出来的临时目录，结束即删。
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import {
  loadDataset,
  loadAcpEnFixture,
  annotationToResult,
  DATASET_DIR,
  type DatasetQuery,
  type DatasetTurn,
} from './dataset';

const REPORTS_DIR = join(import.meta.dir, 'reports');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
/** 性能档位。默认跑全部；`--sizes=2000` 可只跑 recall 那一档做快速自检。 */
const SIZES = (arg('sizes') ?? '2000,10000,50000').split(',').map(Number);
/** 延迟取样轮数（含被丢弃的首轮）。 */
const ROUNDS = Number(arg('rounds') ?? 4);

let tmpDir: string | null = null;
const die = (msg: string, err?: unknown): never => {
  console.error(`[3b] ✗ ${msg}`);
  if (err) console.error(err);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 装置输入（必须已冻结）
// ---------------------------------------------------------------------------

interface FillerRecord {
  id: string;
  domain: string;
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
  files: string[];
}

const metaRaw = readFileSync(join(DATASET_DIR, 'phase3b-fixture-meta.json'), 'utf-8');
const meta = JSON.parse(metaRaw) as {
  frozen?: boolean;
  recallScale?: { filler?: { sha256?: string; seed?: number } };
  performanceScale?: { seed?: number };
};
if (!meta.frozen) die('装置未冻结（meta.frozen 不为 true）。先跑 build-phase3b-fixture.ts --stage=full');

const fillerRaw = readFileSync(join(DATASET_DIR, 'phase3b-filler.json'), 'utf-8');
if (sha16(fillerRaw) !== meta.recallScale?.filler?.sha256) {
  die(
    `填充语料 checksum 不匹配：文件 ${sha16(fillerRaw)} vs meta ${meta.recallScale?.filler?.sha256}。` +
      '装置被改过，本次测量的输入不是冻结的那份',
  );
}
const filler = JSON.parse(fillerRaw) as FillerRecord[];

const dataset = loadDataset(DATASET_DIR, {
  withValidation: true,
  withPhase2: true,
  withFusion: true,
  withEmptyExt: true,
});
const enFixture = loadAcpEnFixture(DATASET_DIR, {
  withValidation: true,
  withPhase2: true,
  withR2: true,
});

// ---------------------------------------------------------------------------
// 生产模块（在 env 之后动态导入，与 run.ts 同一纪律）
// ---------------------------------------------------------------------------

const { MemoryDB, computeScopeKey } = await import('../src/db');
const { hybridSearchObservations, DEFAULT_RETRIEVAL_POLICY, validateRetrievalPolicy } =
  await import('../src/server/observation-search');
const { embeddingSpaceKey, semanticEnSearchTextFields, SEMANTIC_EN_PROTOCOL } =
  await import('../src/semantic-en');
const {
  generateEmbedding,
  buildObservationSearchText,
  embeddingToBlob,
  DIMENSIONS,
  EMBEDDING_MODEL,
} = await import('../src/embedding');

const SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);

// ---------------------------------------------------------------------------
// 播种
// ---------------------------------------------------------------------------
//
// 时间口径沿用 2D P1-1：当天 UTC 零点往前 30 天为基准，每条 +1 分钟。写死绝对日期会让
// 装置在某一天静默失效（90 天窗口相对墙上时钟算）。
//
// 目标在**最老端**：先播 30 条目标，再播填充。于是「最近 200 条」全是填充——这正是
// 判据 §3.1 断言 A 要验的性质。

const BASE_MS = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 30 * 86400000;
})();
const stoppedAt = (i: number): string => new Date(BASE_MS + i * 60_000).toISOString();

const SCOPE_CWD = { primary: '/proj/kiro-mem', other: '/proj/other-app' } as const;

interface SeededTarget {
  datasetId: string;
  obsId: number;
  scope: 'primary' | 'other';
}

async function seedRecallFixture(db: InstanceType<typeof MemoryDB>): Promise<SeededTarget[]> {
  const targets: SeededTarget[] = [];
  let clock = 0;

  const insert = (opts: {
    session: string;
    cwd: string;
    title: string;
    summary: string;
    outcome: string | null;
    learned: string | null;
    concepts: string[];
    files: string[];
    memoryType: string;
    prompt: string;
  }): number => {
    if (!db.getSessionRef(opts.session)) {
      db.upsertSessionRef({ session_id: opts.session, cwd: opts.cwd, repo: opts.cwd });
    }
    const seq = db.allocateNextTurnSeq(opts.session);
    const turn = db.createTurn({
      session_id: opts.session,
      seq,
      cwd: opts.cwd,
      repo: opts.cwd,
      prompt_text: opts.prompt,
    });
    const ts = stoppedAt(clock++);
    db.markTurnClosed(turn.id, ts);
    const id = db.insertObservation({
      turn_id: turn.id,
      session_id: opts.session,
      turn_seq: seq,
      repo: opts.cwd,
      cwd_scope: opts.cwd,
      title: opts.title,
      summary: opts.summary,
      outcome: opts.outcome,
      learned: opts.learned,
      memory_type: opts.memoryType as never,
      files_touched: opts.files,
      concepts: opts.concepts,
      quality: 'normal',
      turn_started_at: ts,
      turn_stopped_at: ts,
    });
    if (id == null) throw new Error(`insertObservation 返回 null（turn_id 冲突）: ${opts.title}`);
    return id;
  };

  const embed = async (obsId: number, text: string): Promise<void> => {
    const vec = await generateEmbedding(text);
    db.upsertObservationEmbedding(obsId, SPACE_KEY, DIMENSIONS, embeddingToBlob(vec));
  };

  // --- 1. 30 条目标（最老端），英文派生值取既有 ACP 产出，不重译 ---
  for (const t of dataset.turns as DatasetTurn[]) {
    const en = enFixture.records[t.id];
    if (!en) throw new Error(`记录 ${t.id} 缺英文派生值——装置不能用回落译文`);
    const r = annotationToResult(t.annotation);
    const cwd = SCOPE_CWD[t.scope];
    const obsId = insert({
      session: `s-${t.scope}`,
      cwd,
      title: r.title,
      summary: r.summary,
      outcome: r.outcome,
      learned: r.learned,
      concepts: r.concepts,
      files: r.files_touched,
      memoryType: r.memory_type,
      prompt: t.prompt,
    });
    db.upsertObservationSemanticText({
      observation_id: obsId,
      protocol: SEMANTIC_EN_PROTOCOL,
      status: 'ready',
      payload: en,
      translator: 'phase3b-fixture(frozen acp output)',
    });
    await embed(obsId, buildObservationSearchText(semanticEnSearchTextFields(en, r.files_touched)));
    targets.push({ datasetId: t.id, obsId, scope: t.scope });
  }

  // --- 2. 1,970 条填充（全部更新），本身即英文，payload 就是它自己 ---
  for (const f of filler) {
    const obsId = insert({
      session: 's-primary',
      cwd: SCOPE_CWD.primary,
      title: f.title,
      summary: f.summary,
      outcome: f.outcome,
      learned: f.learned,
      concepts: f.concepts,
      files: f.files,
      memoryType: 'change',
      prompt: f.title,
    });
    const en = {
      title: f.title,
      summary: f.summary,
      outcome: f.outcome,
      learned: f.learned,
      concepts: f.concepts,
    };
    db.upsertObservationSemanticText({
      observation_id: obsId,
      protocol: SEMANTIC_EN_PROTOCOL,
      status: 'ready',
      payload: en,
      translator: 'phase3b-fixture(generated filler)',
    });
    await embed(obsId, buildObservationSearchText(semanticEnSearchTextFields(en, f.files)));
  }

  return targets;
}

// ---------------------------------------------------------------------------
// 判据 §3.1 的两条断言
// ---------------------------------------------------------------------------

function assertFixtureProperties(
  db: InstanceType<typeof MemoryDB>,
  targets: SeededTarget[],
): { newest200: number[]; targetsInWindow: number[]; vectorCoverage: number } {
  const primaryScope = computeScopeKey(SCOPE_CWD.primary, SCOPE_CWD.primary);
  const newest200 = db.getRecentObservationIds({
    scopeKey: primaryScope,
    days: 90,
    limit: 200,
  });
  const targetIds = new Set(targets.map((t) => t.obsId));
  const targetsInWindow = newest200.filter((id) => targetIds.has(id));

  const withVector = db.getObservationEmbeddingsByIds([...targetIds], {
    model: SPACE_KEY,
    dimensions: DIMENSIONS,
  });

  if (newest200.length !== 200) {
    die(`断言 A 前提不成立：最近 200 条只取到 ${newest200.length} 条`);
  }
  if (targetsInWindow.length !== 0) {
    die(`断言 A 失败：最近 200 条里有 ${targetsInWindow.length} 条目标，装置无效`);
  }
  if (withVector.length !== targets.length) {
    die(`断言 B 失败：目标向量覆盖 ${withVector.length}/${targets.length}`);
  }
  console.log(
    `[3b] 断言 A 通过：最近 200 条与 30 条目标交集为 0\n` +
      `[3b] 断言 B 通过：目标 semantic-en-v1 向量覆盖 ${withVector.length}/${targets.length}`,
  );
  return { newest200, targetsInWindow, vectorCoverage: withVector.length };
}

// ---------------------------------------------------------------------------
// 单次搜索 + 打分
// ---------------------------------------------------------------------------

interface QueryRow {
  id: string;
  origin: string;
  kind: string;
  scope: string;
  expect: string[];
  /** 语义腿是否给 gold 打了分（比 hit@5 更直接：区分"没排上"与"没被打分"）。 */
  semanticReachedGold: boolean;
  goldRank: number | null;
  returned: number;
  resultIds: string[];
  matchSources: string[];
  /**
   * `match_source` of EVERY returned record, positionally aligned with
   * `resultIds` (`matchSources` above is the de-duplicated set for the gold hit).
   *
   * Required by the pool round's structural bound S1 (`pool-policy-criteria.md`
   * §4.2 / G5): every record that a larger pool ADDS to the page must be
   * `semantic`, because FTS hits are candidates regardless of pool. Verifying that
   * needs the source of each individual id, not a set.
   */
  resultSources: string[];
  /**
   * Ids the trigram FTS leg matched (candidate set, not the page).
   *
   * The pool round needs it to tell two mechanisms apart when a bigger pool
   * changes page membership: a record that was ALREADY a candidate here and got
   * promoted by fusion (bound S2) is a different event from a record the larger
   * pool newly made comparable (bound S1). Without this set, both look like
   * "a new result appeared".
   */
  ftsIds: string[];
  semanticOnly: number;
  leaked: number;
  comparableVectors: number;
  /**
   * Whether the semantic leg failed for this query (embedding timeout, Worker
   * failure — or the SQLite bound-parameter ceiling at 65,533 candidates, see
   * criteria §4.1). The kernel swallows all three into one `onDegrade` callback,
   * so a non-zero count at scale is a capability failure, not a policy choice.
   */
  degraded: boolean;
  latencyMs: number;
}

const LIMIT = 10;

async function runQuery(
  db: InstanceType<typeof MemoryDB>,
  q: DatasetQuery,
  pool: number,
  idToDataset: Map<number, string>,
  targetByDatasetId: Map<string, number>,
): Promise<QueryRow> {
  const cwd = SCOPE_CWD[q.scope];
  const scopeKey = computeScopeKey(cwd, cwd);
  const semanticQueryEn = enFixture.queries[q.id];
  if (!semanticQueryEn) throw new Error(`query ${q.id} 缺英文形式`);

  const goldObsIds = new Set(
    q.expect.map((d) => targetByDatasetId.get(d)).filter((x): x is number => x != null),
  );

  let semanticRankKeys: number[] = [];
  let ftsRankKeys: number[] = [];
  let comparableVectors = 0;
  let degraded = false;
  const t0 = performance.now();
  const results = await hybridSearchObservations(
    db,
    q.query,
    { scopeKey, semanticQueryEn, limit: LIMIT },
    {
      policy: { ...DEFAULT_RETRIEVAL_POLICY, semanticCandidatePool: pool },
      onCandidates: (i) => {
        semanticRankKeys = [...i.semanticRank.keys()];
        ftsRankKeys = [...i.ftsRank.keys()];
        comparableVectors = i.comparableVectors;
      },
      onDegrade: () => { degraded = true; },
    },
  );
  const latencyMs = performance.now() - t0;

  const resultIds = results.map((r) => idToDataset.get(r.id) ?? `db:${r.id}`);
  let goldRank: number | null = null;
  for (const [idx, r] of results.entries()) {
    if (goldObsIds.has(r.id)) { goldRank = idx + 1; break; }
  }
  // 泄漏口径用 3A-R2 §2.4 修正后的定义：返回了不属于本 query 所搜 scope 的记录。
  const leaked = results.filter((r) => r.scope_key !== scopeKey).length;

  return {
    id: q.id,
    origin: q.origin ?? '-',
    kind: q.kind,
    scope: q.scope,
    expect: q.expect,
    semanticReachedGold: semanticRankKeys.some((id) => goldObsIds.has(id)),
    goldRank,
    returned: results.length,
    resultIds,
    matchSources: [...new Set(results.map((r) => r.match_source))],
    resultSources: results.map((r) => r.match_source),
    ftsIds: ftsRankKeys.map((id) => idToDataset.get(id) ?? `db:${id}`),
    semanticOnly: results.filter((r) => r.match_source === 'semantic').length,
    leaked,
    comparableVectors,
    degraded,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// 指标聚合
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return Math.round(s[i]! * 100) / 100;
};

interface ArmMetrics {
  pool: string;
  relevance: {
    n: number;
    semanticReachedGold: number;
    semanticReachRate: number;
    hitAt5: number;
    mrr: number;
    byOrigin: Record<string, { n: number; reached: number; hitAt5: number; mrr: number }>;
  };
  emptyLike: {
    n: number;
    meanReturned: number;
    worstReturned: number;
    /**
     * Empty-query returns that ONLY the semantic leg found (pool round G10).
     *
     * `meanReturned` on a 2,000-record corpus is dominated by FTS: the fillers get
     * literal hits, which is why the baseline reads 3.56 and the worst case is a
     * saturated page of 10. Neither number can move much, so neither can show what
     * the POOL contributed. Semantic-only can: by structural bound S1 it is the
     * only channel a larger pool has.
     */
    semanticOnlyMean: number;
    semanticOnlyMax: number;
  };
  semanticOnlyMax: number;
  leakTotal: number;
  comparableVectorsAvg: number;
  /** Queries whose semantic leg failed (pool round G4 — must be 0). */
  degradedCount: number;
  latency: { p50: number; p95: number; p99: number; max: number };
}

function aggregate(rows: QueryRow[], pool: string): ArmMetrics {
  const rel = rows.filter((r) => r.kind === 'relevance' && r.expect.length > 0);
  const emptyLike = rows.filter((r) => r.kind === 'empty');
  const hits5 = rel.filter((r) => r.goldRank !== null && r.goldRank <= 5).length;
  const mrr =
    rel.reduce((s, r) => s + (r.goldRank !== null && r.goldRank <= LIMIT ? 1 / r.goldRank : 0), 0) /
    Math.max(1, rel.length);

  const byOrigin: ArmMetrics['relevance']['byOrigin'] = {};
  for (const r of rel) {
    const b = (byOrigin[r.origin] ??= { n: 0, reached: 0, hitAt5: 0, mrr: 0 });
    b.n++;
    if (r.semanticReachedGold) b.reached++;
    if (r.goldRank !== null && r.goldRank <= 5) b.hitAt5++;
    b.mrr += r.goldRank !== null && r.goldRank <= LIMIT ? 1 / r.goldRank : 0;
  }
  for (const b of Object.values(byOrigin)) {
    b.hitAt5 = pct(b.hitAt5, b.n);
    b.mrr = Math.round((b.mrr / Math.max(1, b.n)) * 1000) / 1000;
  }

  const lat = rows.map((r) => r.latencyMs);
  return {
    pool,
    relevance: {
      n: rel.length,
      semanticReachedGold: rel.filter((r) => r.semanticReachedGold).length,
      semanticReachRate: pct(rel.filter((r) => r.semanticReachedGold).length, rel.length),
      hitAt5: pct(hits5, rel.length),
      mrr: Math.round(mrr * 1000) / 1000,
      byOrigin,
    },
    emptyLike: {
      n: emptyLike.length,
      meanReturned:
        Math.round((emptyLike.reduce((s, r) => s + r.returned, 0) / Math.max(1, emptyLike.length)) * 100) / 100,
      worstReturned: emptyLike.reduce((m, r) => Math.max(m, r.returned), 0),
      semanticOnlyMean:
        Math.round((emptyLike.reduce((s, r) => s + r.semanticOnly, 0) / Math.max(1, emptyLike.length)) * 100) / 100,
      semanticOnlyMax: emptyLike.reduce((m, r) => Math.max(m, r.semanticOnly), 0),
    },
    semanticOnlyMax: rows.reduce((m, r) => Math.max(m, r.semanticOnly), 0),
    leakTotal: rows.reduce((s, r) => s + r.leaked, 0),
    comparableVectorsAvg: Math.round(
      rows.reduce((s, r) => s + r.comparableVectors, 0) / Math.max(1, rows.length),
    ),
    degradedCount: rows.filter((r) => r.degraded).length,
    latency: {
      p50: quantile(lat, 0.5),
      p95: quantile(lat, 0.95),
      p99: quantile(lat, 0.99),
      max: Math.round(Math.max(...lat) * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// 执行：recall 对比
// ---------------------------------------------------------------------------

const policyErrors = validateRetrievalPolicy({
  ...DEFAULT_RETRIEVAL_POLICY,
  semanticCandidatePool: Number.POSITIVE_INFINITY,
});
if (policyErrors.length) die(`pool-full 策略非法：${policyErrors.join('; ')}`);

tmpDir = mkdtempSync(join(tmpdir(), 'kiro-mem-3b-'));
const rssMb = (): number => Math.round(process.memoryUsage().rss / 1048576);
const rss = { start: rssMb(), afterSeed: 0, afterRecall: 0, peak: 0 };
const trackPeak = (): void => { rss.peak = Math.max(rss.peak, rssMb()); };

console.log(`[3b] 临时库：${tmpDir}（结束即删，真实用户库不被打开）`);
const RECALL_DB_PATH = join(tmpDir, 'recall-scale.db');
const db = new MemoryDB(RECALL_DB_PATH);

let targets: SeededTarget[] = [];
const seedT0 = Date.now();
try {
  targets = await seedRecallFixture(db);
} catch (err) {
  die('播种 recall-scale 失败', err);
}
if (!targets.length) die('播种没有产出任何目标记录');
const seedMs = Date.now() - seedT0;
rss.afterSeed = rssMb();
trackPeak();
console.log(
  `[3b] recall-scale 已播种：${targets.length} 目标 + ${filler.length} 填充 = ` +
    `${targets.length + filler.length} 条，耗时 ${(seedMs / 1000).toFixed(1)}s`,
);

const fixtureAssertions = assertFixtureProperties(db, targets);

const targetByDatasetId = new Map(targets.map((t) => [t.datasetId, t.obsId]));
const idToDataset = new Map(targets.map((t) => [t.obsId, t.datasetId]));

/** 参与 recall 对比的 query：有英文形式的 relevance + empty。 */
const measurableQueries = (dataset.queries as DatasetQuery[]).filter(
  (q) => enFixture.queries[q.id] && (q.kind === 'relevance' || q.kind === 'empty'),
);
console.log(`[3b] 可测 query ${measurableQueries.length} 条（relevance + empty，均有英文派生值）`);

// --- 播种后必须 checkpoint，且这不是"顺手优化" ---
//
// 实测：不 checkpoint 时，同一条生产 SQL 在这个连接上要 544ms；用一个播种后新开的
// 只读连接跑**完全相同**的语句只要 0.96ms。原因是 WAL：4,000 次写之后 WAL 文件很大，
// 而写连接的每次读都要在 WAL index 里找页。生产里写（Worker）与读（MCP server）是两个
// 进程、两个连接，且 WAL 会被周期性 checkpoint——所以那 544ms 是**播种装置的产物，
// 不是检索的代价**。
//
// 不 checkpoint 就报告，会把一个 harness 假象写成"FTS 在 2,000 条语料上要 500ms"，
// 下一轮就会去优化一个根本不存在的瓶颈。两个读数都留档（§见报告 latency.walArtifact）。
const walProbe = async (): Promise<number> => {
  const scopeKey = computeScopeKey(SCOPE_CWD.primary, SCOPE_CWD.primary);
  const t: number[] = [];
  for (const q of measurableQueries.slice(0, 20)) {
    const t0 = performance.now();
    db.searchObservationsFts(q.query, { scopeKey, days: 90, limit: 50 });
    t.push(performance.now() - t0);
  }
  return quantile(t, 0.5);
};
const ftsBeforeCheckpoint = await walProbe();
{
  // checkpoint 走旁路连接，不给 MemoryDB 加一个只有基准脚本用的方法。
  const { Database } = await import('bun:sqlite');
  const ck = new Database(RECALL_DB_PATH);
  ck.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  ck.close();
}
const ftsAfterCheckpoint = await walProbe();
console.log(
  `[3b] WAL checkpoint：FTS p50 ${ftsBeforeCheckpoint}ms → ${ftsAfterCheckpoint}ms ` +
    `（前者是播种装置的产物，不是检索代价）`,
);

/**
 * Recall arms. Default = phase 3B's two, so a bare run still reproduces 3B.
 *
 * `--pools=200,500,1000,1970,1971,full` is the pool round's matrix
 * (`pool-policy-criteria.md` §5.1). `full` / `inf` mean `Infinity`; every other
 * value must be a positive integer, and an unparsable value is a hard failure
 * rather than a silent skip — an arm nobody ran must not look like an arm that
 * passed.
 */
const arms: { name: string; pool: number }[] = (arg('pools') ?? '200,full')
  .split(',')
  .map((raw) => {
    const s = raw.trim();
    if (s === 'full' || s === 'inf' || s === 'Infinity') {
      return { name: 'pool-full', pool: Number.POSITIVE_INFINITY };
    }
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) die(`--pools 里的 "${s}" 不是 ≥1 的整数，也不是 full`);
    return { name: `pool-${n}`, pool: n };
  });
if (!arms.length) die('--pools 解析出 0 个 arm');

const armRows: Record<string, QueryRow[]> = {};
for (const arm of arms) {
  const rows: QueryRow[] = [];
  for (const q of measurableQueries) {
    try {
      rows.push(await runQuery(db, q, arm.pool, idToDataset, targetByDatasetId));
    } catch (err) {
      die(`arm ${arm.name} 在 query ${q.id} 上失败`, err);
    }
  }
  armRows[arm.name] = rows;
  trackPeak();
  const m = aggregate(rows, arm.name);
  console.log(
    `[3b] ${arm.name}: 语义触达 gold ${m.relevance.semanticReachedGold}/${m.relevance.n} ` +
      `(${m.relevance.semanticReachRate}%) hit@5 ${m.relevance.hitAt5}% MRR ${m.relevance.mrr} | ` +
      `empty 均 ${m.emptyLike.meanReturned}/坏 ${m.emptyLike.worstReturned} | ` +
      `可比向量均 ${m.comparableVectorsAvg} | p95 ${m.latency.p95}ms`,
  );
}
rss.afterRecall = rssMb();
for (const arm of arms) {
  if (!armRows[arm.name]?.length) die(`arm ${arm.name} 没有采到任何读数`);
}

// ---------------------------------------------------------------------------
// 分阶段延迟归因
// ---------------------------------------------------------------------------
//
// 一个总延迟数字回答不了 3B 必须回答的问题："超预算是因为全量扫描太贵，还是因为别的
// 环节？"如果不分阶段就去评估分页 / 向量扩展 / ANN，很可能在优化一个不是瓶颈的环节。
//
// 分四段，与内核里的顺序一致：
//   embed  — query 向量（生产里由 Worker 做，仍计入 search 延迟）
//   fts    — trigram FTS 候选
//   fetch  — 按候选 id 取向量 blob
//   cosine — 打分 + 排序

/** 分阶段归因与性能档共用的固定 query 子集：逐档相同，变量只有语料规模。 */
const PERF_QUERIES = measurableQueries.slice(0, 20);

interface StageBreakdown {
  pool: string;
  n: number;
  embedMs: { p50: number; p95: number };
  ftsMs: { p50: number; p95: number };
  fetchMs: { p50: number; p95: number };
  cosineMs: { p50: number; p95: number };
  candidateCount: number;
  /** FTS 归因：单元数与 MATCH 实际命中的行数（不受 limit 截断）。 */
  ftsUnits: { p50: number; max: number };
  ftsMatchedRows: { p50: number; max: number };
  /** 同一 MATCH 表达式只做 COUNT（无 JOIN、无 ORDER BY fts.rank）。 */
  ftsMatchOnlyMs: { p50: number; p95: number };
  /** 最慢 query 上的子句级拆解与查询计划。 */
  sqlVariants: { name: string; ms: number; rows: number }[];
  queryPlan: string[];
  ftsSlowest: {
    id: string;
    ms: number;
    units: number;
    matchedRows: number;
    maxUnitDf: number;
    perUnitDf: { unit: string; df: number }[];
  } | null;
}

async function profileStages(
  targetDb: InstanceType<typeof MemoryDB>,
  dbPath: string,
  pool: number,
  label: string,
): Promise<StageBreakdown> {
  const { cosineSimilarity, blobToEmbedding } = await import('../src/embedding');
  const { extractFtsSearchUnits } = await import('../src/db');
  // 只读旁路连接，专门做归因用的 COUNT。不给 MemoryDB 加方法：那会为了一次探针
  // 在生产 API 上留一个只有探针用的洞。
  const { Database } = await import('bun:sqlite');
  const raw = new Database(dbPath, { readonly: true });
  const countStmt = raw.query<{ c: number }, [string]>(
    `SELECT COUNT(*) AS c FROM observations_fts WHERE observations_fts MATCH ?`,
  );
  const scopeKey = computeScopeKey(SCOPE_CWD.primary, SCOPE_CWD.primary);
  const embed: number[] = [];
  const fts: number[] = [];
  const fetch: number[] = [];
  const cosine: number[] = [];
  const unitCounts: number[] = [];
  const matchedRows: number[] = [];
  const matchOnly: number[] = [];
  let slowest: StageBreakdown['ftsSlowest'] = null;
  let candidateCount = 0;

  for (const q of PERF_QUERIES) {
    const t0 = performance.now();
    const qv = await generateEmbedding(enFixture.queries[q.id]!);
    embed.push(performance.now() - t0);

    const t1 = performance.now();
    const ftsHits = targetDb.searchObservationsFts(q.query, { scopeKey, days: 90, limit: 50 });
    const ftsMs = performance.now() - t1;
    fts.push(ftsMs);

    // 归因：`searchObservationsFts` 只返回 limit 行，但 bm25 要给**全部**命中行打分。
    // 所以"慢不慢"取决于命中行数，不取决于返回行数——这两个数字必须分开报。
    const units = extractFtsSearchUnits(q.query.trim());
    unitCounts.push(units.length);
    let matched = 0;
    let matchOnlyMs = 0;
    if (units.length) {
      const expr = units.map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');
      // 同一个 MATCH 表达式，只数行、不 JOIN、不 ORDER BY fts.rank。
      // 与上面的完整查询相减即可定位代价在"匹配"还是在"排序/JOIN"。
      const tc = performance.now();
      matched = countStmt.get(expr)?.c ?? 0;
      matchOnlyMs = performance.now() - tc;
    }
    matchOnly.push(matchOnlyMs);
    matchedRows.push(matched);
    if (!slowest || ftsMs > slowest.ms) {
      // 逐单元 DF：整个 OR 表达式只命中 3 行却要 500ms，说明代价不在"给命中行打分"，
      // 而在遍历 postings。单元自己的 DF 才能证实这一点。
      const perUnitDf = units.map((u) => ({
        unit: u,
        df: countStmt.get(`"${u.replaceAll('"', '""')}"`)?.c ?? 0,
      }));
      slowest = {
        id: q.id,
        ms: Math.round(ftsMs * 100) / 100,
        units: units.length,
        matchedRows: matched,
        maxUnitDf: perUnitDf.reduce((m, x) => Math.max(m, x.df), 0),
        perUnitDf: perUnitDf.sort((a, b) => b.df - a.df).slice(0, 6),
      };
    }

    const t2 = performance.now();
    const recentIds = targetDb.getRecentObservationIds({ scopeKey, days: 90, limit: pool });
    const ids = [...new Set([...ftsHits.map((h) => h.id), ...recentIds])];
    const blobs = targetDb.getObservationEmbeddingsByIds(ids, {
      model: SPACE_KEY,
      dimensions: DIMENSIONS,
    });
    fetch.push(performance.now() - t2);
    candidateCount = Math.max(candidateCount, ids.length);

    const t3 = performance.now();
    const scored: { id: number; score: number }[] = [];
    for (const row of blobs) {
      const s = cosineSimilarity(qv, blobToEmbedding(row.embedding));
      if (s > DEFAULT_RETRIEVAL_POLICY.semanticFloor) scored.push({ id: row.observation_id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    cosine.push(performance.now() - t3);
  }
  const q2 = (xs: number[]) => ({ p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) });
  const q2max = (xs: number[]) => ({ p50: quantile(xs, 0.5), max: Math.max(...xs) });

  // --- 子句级归因 ---
  //
  // 纯 MATCH 0.3ms 对完整查询 500ms，说明代价不在匹配。剩下的嫌疑只有三处：JOIN、
  // `ORDER BY fts.rank`（bm25）、`SELECT o.*`。逐个拆掉再计时，并抓一次查询计划。
  // 不猜：一个"看起来合理"的结论会把下一轮引到错误的优化对象上。
  const variants: { name: string; ms: number; rows: number }[] = [];
  let queryPlan: string[] = [];
  if (slowest) {
    const sq = PERF_QUERIES.find((x) => x.id === slowest!.id)!;
    const units = extractFtsSearchUnits(sq.query.trim());
    const expr = units.map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');
    const threshold = new Date(Date.now() - 90 * 86400000).toISOString();
    const time = (name: string, sql: string, params: unknown[]): void => {
      const stmt = raw.query(sql);
      stmt.all(...(params as never[])); // 预热：第一次含 prepare，不计入
      const t = performance.now();
      const rows = stmt.all(...(params as never[])) as unknown[];
      variants.push({ name, ms: Math.round((performance.now() - t) * 100) / 100, rows: rows.length });
    };
    time(
      'A 完整（JOIN + ORDER BY fts.rank + SELECT o.*）',
      `SELECT o.* FROM observations_fts fts JOIN observations o ON fts.rowid = o.id
        WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
        ORDER BY fts.rank LIMIT 50`,
      [expr, threshold, scopeKey],
    );
    time(
      'B 去掉 ORDER BY fts.rank',
      `SELECT o.* FROM observations_fts fts JOIN observations o ON fts.rowid = o.id
        WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
        LIMIT 50`,
      [expr, threshold, scopeKey],
    );
    time(
      'C 只取 id（保留 ORDER BY）',
      `SELECT o.id FROM observations_fts fts JOIN observations o ON fts.rowid = o.id
        WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
        ORDER BY fts.rank LIMIT 50`,
      [expr, threshold, scopeKey],
    );
    time(
      'D 不 JOIN，只 rank',
      `SELECT rowid FROM observations_fts WHERE observations_fts MATCH ? ORDER BY rank LIMIT 50`,
      [expr],
    );
    // E 是**生产实际使用的形式**：`LIMIT ?` 绑定参数。A 与 E 只差 LIMIT 是字面量还是
    // 参数，其余逐字相同，返回行数也相同——所以两者的差值就是这一处的代价。
    {
      const sql = `SELECT o.* FROM observations_fts fts JOIN observations o ON fts.rowid = o.id
        WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
        ORDER BY fts.rank LIMIT ?`;
      const stmt = raw.query(sql);
      stmt.all(expr, threshold, scopeKey, 50);
      const t = performance.now();
      const rows = stmt.all(expr, threshold, scopeKey, 50) as unknown[];
      variants.push({
        name: 'E 生产形式（LIMIT ? 绑定参数）',
        ms: Math.round((performance.now() - t) * 100) / 100,
        rows: rows.length,
      });
    }
    const planOf = (sql: string, params: unknown[]): string[] =>
      (raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]).map(
        (r) => r.detail,
      );
    const joined = `FROM observations_fts fts JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ? ORDER BY fts.rank`;
    queryPlan = [
      'LIMIT 50（字面量）:',
      ...planOf(`SELECT o.* ${joined} LIMIT 50`, [expr, threshold, scopeKey]),
      'LIMIT ?（生产形式）:',
      ...planOf(`SELECT o.* ${joined} LIMIT ?`, [expr, threshold, scopeKey, 50]),
    ];
  }

  raw.close();
  return {
    pool: label,
    n: PERF_QUERIES.length,
    embedMs: q2(embed),
    ftsMs: q2(fts),
    fetchMs: q2(fetch),
    cosineMs: q2(cosine),
    candidateCount,
    ftsUnits: q2max(unitCounts),
    ftsMatchedRows: q2max(matchedRows),
    ftsMatchOnlyMs: q2(matchOnly),
    sqlVariants: variants,
    queryPlan,
    ftsSlowest: slowest,
  };
}

const breakdowns: StageBreakdown[] = [];
for (const arm of arms) {
  const b = await profileStages(db, RECALL_DB_PATH, arm.pool, arm.name);
  breakdowns.push(b);
  console.log(
    `[3b] ${arm.name} 分阶段 p50/p95 (ms): embed ${b.embedMs.p50}/${b.embedMs.p95} | ` +
      `fts ${b.ftsMs.p50}/${b.ftsMs.p95} | fetch ${b.fetchMs.p50}/${b.fetchMs.p95} | ` +
      `cosine ${b.cosineMs.p50}/${b.cosineMs.p95} | 候选上限 ${b.candidateCount}`,
  );
  console.log(
    `[3b]   └ FTS 归因：单元数 p50 ${b.ftsUnits.p50}/max ${b.ftsUnits.max}，` +
      `MATCH 命中行 p50 ${b.ftsMatchedRows.p50}/max ${b.ftsMatchedRows.max}，` +
      `纯 MATCH p50 ${b.ftsMatchOnlyMs.p50}/p95 ${b.ftsMatchOnlyMs.p95}ms` +
      (b.ftsSlowest
        ? `；最慢 ${b.ftsSlowest.id} ${b.ftsSlowest.ms}ms（${b.ftsSlowest.units} 单元 / ` +
          `${b.ftsSlowest.matchedRows} 命中行 / 单元最大 DF ${b.ftsSlowest.maxUnitDf}）`
        : ''),
  );
  if (b.ftsSlowest?.perUnitDf.length) {
    console.log(
      `[3b]   └ 最慢 query 的高 DF 单元：` +
        b.ftsSlowest.perUnitDf.map((x) => `${x.unit}=${x.df}`).join(' '),
    );
  }
  for (const v of b.sqlVariants) {
    console.log(`[3b]   └ 子句拆解 ${v.name}: ${v.ms}ms (${v.rows} 行)`);
  }
  for (const line of b.queryPlan) console.log(`[3b]   └ plan: ${line}`);
}

// ---------------------------------------------------------------------------
// 执行：performance-scale
// ---------------------------------------------------------------------------
//
// 随机单位向量，不做相关性标注。判据 §4：非单位向量不会报错，但会让分数分布失真。

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomUnitVector(rnd: () => number): Float32Array {
  const v = new Float32Array(DIMENSIONS);
  let norm = 0;
  for (let i = 0; i < DIMENSIONS; i++) {
    // Box-Muller：均匀分布取方向会集中在超立方体的角上，不是球面均匀。
    const u1 = Math.max(rnd(), 1e-12);
    const u2 = rnd();
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    v[i] = g;
    norm += g * g;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < DIMENSIONS; i++) v[i] = v[i]! / norm;
  return v;
}

interface PerfResult {
  size: number;
  /** `"200"` … `"full"`. Phase 3B measured `full` only; the pool round adds the rest. */
  pool: string;
  seededRecords: number;
  scopeVectors: number;
  comparableVectorsAvg: number;
  /** Post-warmup sample count. Pool round G14 requires ≥200 before p99 means anything. */
  samples: number;
  latency: { p50: number; p95: number; p99: number; max: number };
  firstRound: { p50: number; p95: number };
  rssAfterSeedMb: number;
  rssPeakMb: number;
  rssPerRoundMb: number[];
  /**
   * RSS attributable to the SEARCH loop: reading before the first search and the
   * peak during it (pool round G15).
   *
   * `rssPeakMb` above is the whole-script global peak, which includes seeding
   * 50,000 rows and the model. Using it to answer "what does full-scope scoring
   * cost in memory" would charge search for the fixture's own footprint.
   */
  rssLoop: { beforeMb: number; peakMb: number; deltaMb: number };
  /** Queries whose semantic leg failed (G4 — must be 0; see criteria §4.1). */
  degradedCount: number;
  /** 向量路径单独计时（取 blob + 打分排序），不含 FTS 与 query embedding。 */
  vectorPath?: { fetchMs: { p50: number; p95: number }; cosineMs: { p50: number; p95: number } };
}

/**
 * Pools measured on the performance fixtures. Default = phase 3B's single arm.
 *
 * The pool round measures several pools against ONE seeded database per size
 * (`pool-policy-criteria.md` §5.2): re-seeding per pool would make each pool's
 * readings come from a different SQLite file, and page-cache state would then be
 * part of the comparison.
 */
const PERF_POOLS: { name: string; pool: number }[] = (arg('perf-pools') ?? 'full')
  .split(',')
  .map((raw) => {
    const s = raw.trim();
    if (s === 'full' || s === 'inf' || s === 'Infinity') return { name: 'full', pool: Number.POSITIVE_INFINITY };
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) die(`--perf-pools 里的 "${s}" 不是 ≥1 的整数，也不是 full`);
    return { name: String(n), pool: n };
  });

/**
 * Diagnostic floor override (`pool-policy-criteria.md` §5.3, `perf-floor-worst`).
 *
 * The performance fixtures use random unit vectors, whose cosines cluster near 0,
 * so almost nothing passes `semanticFloor` and the post-floor sort is measured on a
 * nearly empty array — 3B registered that as an UNDERESTIMATE of that stage.
 * Setting the floor to −1 makes all 50,000 candidates pass, which measures the
 * stage's upper bound instead of extrapolating it.
 *
 * Diagnostic only: its relevance and false-recall readings must never be cited,
 * because a floor of −1 is not a policy anyone would ship.
 */
const PERF_FLOOR = arg('perf-floor') === undefined ? undefined : Number(arg('perf-floor'));
if (PERF_FLOOR !== undefined && !Number.isFinite(PERF_FLOOR)) die('--perf-floor 必须是数字');

interface LoopResult {
  samples: number;
  latency: { p50: number; p95: number; p99: number; max: number };
  firstRound: { p50: number; p95: number };
  rssPerRoundMb: number[];
  rssLoop: { beforeMb: number; peakMb: number; deltaMb: number };
  comparableVectorsAvg: number;
  degradedCount: number;
}

/**
 * Time `ROUNDS` passes of the fixed query set at one pool value.
 *
 * First round is dropped (model cold start and SQLite page-cache warmup are not
 * steady-state cost) and reported separately, same as phase 3B.
 */
async function measureLatencyLoop(
  targetDb: InstanceType<typeof MemoryDB>,
  scopeKey: string,
  pool: number,
): Promise<LoopResult> {
  const lat: number[] = [];
  const firstRoundLat: number[] = [];
  const rssPerRound: number[] = [];
  let comparableSum = 0;
  let comparableN = 0;
  let degradedCount = 0;
  const rssBefore = rssMb();
  let rssLoopPeak = rssBefore;
  for (let round = 0; round < ROUNDS; round++) {
    for (const q of PERF_QUERIES) {
      const t0 = performance.now();
      await hybridSearchObservations(
        targetDb,
        q.query,
        { scopeKey, semanticQueryEn: enFixture.queries[q.id]!, limit: LIMIT },
        {
          policy: {
            ...DEFAULT_RETRIEVAL_POLICY,
            semanticCandidatePool: pool,
            ...(PERF_FLOOR === undefined ? {} : { semanticFloor: PERF_FLOOR }),
          },
          onCandidates: (i) => { comparableSum += i.comparableVectors; comparableN++; },
          onDegrade: () => { degradedCount++; },
        },
      );
      const dt = performance.now() - t0;
      if (round === 0) firstRoundLat.push(dt);
      else lat.push(dt);
      const now = rssMb();
      if (now > rssLoopPeak) rssLoopPeak = now;
    }
    rssPerRound.push(rssMb());
    trackPeak();
  }
  return {
    samples: lat.length,
    latency: {
      p50: quantile(lat, 0.5),
      p95: quantile(lat, 0.95),
      p99: quantile(lat, 0.99),
      max: Math.round(Math.max(...lat) * 100) / 100,
    },
    firstRound: { p50: quantile(firstRoundLat, 0.5), p95: quantile(firstRoundLat, 0.95) },
    rssPerRoundMb: rssPerRound,
    rssLoop: { beforeMb: rssBefore, peakMb: rssLoopPeak, deltaMb: rssLoopPeak - rssBefore },
    comparableVectorsAvg: Math.round(comparableSum / Math.max(1, comparableN)),
    degradedCount,
  };
}

async function measurePerformance(size: number): Promise<PerfResult[]> {
  const perfDb = new MemoryDB(join(tmpDir!, `perf-${size}.db`));
  const rnd = mulberry32((meta.performanceScale?.seed ?? 0x3b1000) + size);
  const cwd = SCOPE_CWD.primary;
  const session = 's-perf';
  perfDb.upsertSessionRef({ session_id: session, cwd, repo: cwd });

  let clock = 0;
  for (let i = 0; i < size; i++) {
    const seq = perfDb.allocateNextTurnSeq(session);
    const turn = perfDb.createTurn({ session_id: session, seq, cwd, repo: cwd, prompt_text: `p${i}` });
    const ts = stoppedAt(clock++);
    perfDb.markTurnClosed(turn.id, ts);
    const obsId = perfDb.insertObservation({
      turn_id: turn.id,
      session_id: session,
      turn_seq: seq,
      repo: cwd,
      cwd_scope: cwd,
      title: `perf record ${i}`,
      summary: `synthetic performance record ${i}`,
      memory_type: 'change',
      quality: 'normal',
      turn_started_at: ts,
      turn_stopped_at: ts,
    });
    if (obsId == null) throw new Error(`perf 播种 insertObservation 返回 null at ${i}`);
    perfDb.upsertObservationEmbedding(
      obsId,
      SPACE_KEY,
      DIMENSIONS,
      embeddingToBlob(randomUnitVector(rnd)),
    );
  }
  const rssAfterSeed = rssMb();
  const scopeKey = computeScopeKey(cwd, cwd);
  const scopeVectors = perfDb.countScopeVectors({
    scopeKey,
    model: SPACE_KEY,
    dimensions: DIMENSIONS,
  });

  // --- 向量路径单独计时 ---
  //
  // 总延迟里混着 `LIMIT ?` 那个与规模无关的计划翻转缺陷（见 §报告），所以"全量
  // brute-force 付得起吗"这个问题不能用总延迟回答。这里只测真正的两步：
  // 取 blob + 打分排序。这才是引入分页 / 向量扩展 / ANN 的判据。
  const { cosineSimilarity: cos, blobToEmbedding: toVec } = await import('../src/embedding');
  const vecFetch: number[] = [];
  const vecCosine: number[] = [];
  const probeVec = await generateEmbedding('scale probe query');
  for (let r = 0; r < ROUNDS; r++) {
    const ids = perfDb.getRecentObservationIds({
      scopeKey,
      days: 90,
      limit: Number.POSITIVE_INFINITY,
    });
    const t0 = performance.now();
    const blobs = perfDb.getObservationEmbeddingsByIds(ids, {
      model: SPACE_KEY,
      dimensions: DIMENSIONS,
    });
    const fetchMs = performance.now() - t0;
    const t1 = performance.now();
    const scored: { id: number; score: number }[] = [];
    for (const row of blobs) {
      const s = cos(probeVec, toVec(row.embedding));
      if (s > DEFAULT_RETRIEVAL_POLICY.semanticFloor) scored.push({ id: row.observation_id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const cosineMs = performance.now() - t1;
    if (r > 0) { vecFetch.push(fetchMs); vecCosine.push(cosineMs); }
  }

  const perfPoolResults: PerfResult[] = [];
  for (const p of PERF_POOLS) {
    const loop = await measureLatencyLoop(perfDb, scopeKey, p.pool);
    perfPoolResults.push({
      size,
      pool: p.name,
      seededRecords: size,
      scopeVectors,
      comparableVectorsAvg: loop.comparableVectorsAvg,
      samples: loop.samples,
      latency: loop.latency,
      firstRound: loop.firstRound,
      rssAfterSeedMb: rssAfterSeed,
      rssPeakMb: rss.peak,
      rssPerRoundMb: loop.rssPerRoundMb,
      rssLoop: loop.rssLoop,
      degradedCount: loop.degradedCount,
      ...(p.pool === Number.POSITIVE_INFINITY
        ? {
            vectorPath: {
              fetchMs: { p50: quantile(vecFetch, 0.5), p95: quantile(vecFetch, 0.95) },
              cosineMs: { p50: quantile(vecCosine, 0.5), p95: quantile(vecCosine, 0.95) },
            },
          }
        : {}),
    });
  }
  perfDb.close();
  return perfPoolResults;
}

const perfResults: PerfResult[] = [];
for (const size of SIZES) {
  // `--sizes=0`：只跑 recall arm，不建 performance 装置。候选池轮次用两条命令分开跑
  // 召回与成本（判据 §12），因为成本档要 11 轮 ×20 query，与召回矩阵的耗时量级不同。
  if (size === 0) continue;
  if (size === 2000) {
    // 2,000 档直接用 recall 装置本身，不重复播一份随机向量的 2,000 条——
    // 那会让"这一档"与另两档的语料性质不同，却挂同一个规模标签。
    const scopeKey = computeScopeKey(SCOPE_CWD.primary, SCOPE_CWD.primary);
    for (const p of PERF_POOLS) {
      const loop = await measureLatencyLoop(db, scopeKey, p.pool);
      perfResults.push({
        size: 2000,
        pool: p.name,
        seededRecords: targets.length + filler.length,
        scopeVectors: db.countScopeVectors({ scopeKey, model: SPACE_KEY, dimensions: DIMENSIONS }),
        comparableVectorsAvg: loop.comparableVectorsAvg,
        samples: loop.samples,
        latency: loop.latency,
        firstRound: loop.firstRound,
        rssAfterSeedMb: rss.afterSeed,
        rssPeakMb: rss.peak,
        rssPerRoundMb: loop.rssPerRoundMb,
        rssLoop: loop.rssLoop,
        degradedCount: loop.degradedCount,
      });
      const r = perfResults.at(-1)!;
      console.log(
        `[3b] perf 2000（真实语料）pool=${p.name}: p50 ${r.latency.p50}ms p95 ${r.latency.p95}ms ` +
          `p99 ${r.latency.p99}ms（${r.samples} 样本）RSS 循环内 +${r.rssLoop.deltaMb}MB degrade ${r.degradedCount}`,
      );
    }
    continue;
  }
  try {
    for (const r of await measurePerformance(size)) {
      perfResults.push(r);
      console.log(
        `[3b] perf ${size}（随机单位向量）pool=${r.pool}: p50 ${r.latency.p50}ms p95 ${r.latency.p95}ms ` +
          `p99 ${r.latency.p99}ms（${r.samples} 样本）| 可比向量均 ${r.comparableVectorsAvg} | ` +
          `RSS 循环内 +${r.rssLoop.deltaMb}MB（峰 ${r.rssLoop.peakMb}MB）| degrade ${r.degradedCount}`,
      );
      if (r.vectorPath) {
        console.log(
          `[3b]   └ 向量路径单独计时 p50/p95: fetch ${r.vectorPath.fetchMs.p50}/${r.vectorPath.fetchMs.p95}ms ` +
            `cosine ${r.vectorPath.cosineMs.p50}/${r.vectorPath.cosineMs.p95}ms`,
        );
      }
    }
  } catch (err) {
    die(`performance-scale ${size} 失败`, err);
  }
}
// `--sizes=0` 只跑 recall arm（候选池轮次把召回与成本分成两条命令，见判据 §12）。
// 其余情况采不到读数仍然是失败：判据 §2 第 2 条「失败必须退非零」。
if (!perfResults.length && !(SIZES.length === 1 && SIZES[0] === 0)) {
  die('performance-scale 没有采到任何读数');
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

const gitRev = (await Bun.$`git rev-parse --short HEAD`.quiet().nothrow()).stdout.toString().trim();
const gitDirty =
  (await Bun.$`git status --porcelain`.quiet().nothrow()).stdout.toString().trim().length > 0;

const report = {
  generatedAt: new Date().toISOString(),
  provenance: {
    commit: gitRev,
    dirty: gitDirty,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    criteria: 'benchmark/reports/phase3b-criteria.md',
    criteriaSha256: sha16(readFileSync(join(REPORTS_DIR, 'phase3b-criteria.md'), 'utf-8')),
    // The pool round reuses this harness under its own frozen criteria, so BOTH
    // hashes go into every report: the fixture rules come from 3B, the arm matrix
    // and the gates come from the pool round.
    poolPolicyCriteria: 'benchmark/reports/pool-policy-criteria.md',
    poolPolicyCriteriaSha256: sha16(readFileSync(join(REPORTS_DIR, 'pool-policy-criteria.md'), 'utf-8')),
    recallPools: arms.map((a) => a.name),
    perfPools: PERF_POOLS.map((p) => p.name),
    fixtureMetaSha256: sha16(metaRaw),
    fillerSha256: sha16(fillerRaw),
    harnessSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    spaceKey: SPACE_KEY,
    embeddingModel: EMBEDDING_MODEL,
    dimensions: DIMENSIONS,
    basePolicy: {
      ...DEFAULT_RETRIEVAL_POLICY,
      semanticOnlyLimit: DEFAULT_RETRIEVAL_POLICY.semanticOnlyLimit,
    },
    rounds: ROUNDS,
    limit: LIMIT,
  },
  fixture: {
    recallScale: {
      targets: targets.length,
      filler: filler.length,
      total: targets.length + filler.length,
      assertionA: {
        newest200Count: fixtureAssertions.newest200.length,
        targetsInWindow: fixtureAssertions.targetsInWindow.length,
        passed: fixtureAssertions.targetsInWindow.length === 0,
      },
      assertionB: {
        targetVectorCoverage: `${fixtureAssertions.vectorCoverage}/${targets.length}`,
        passed: fixtureAssertions.vectorCoverage === targets.length,
      },
      seedSeconds: Math.round(seedMs / 100) / 10,
    },
  },
  arms: Object.fromEntries(
    Object.entries(armRows).map(([name, rows]) => [name, aggregate(rows, name)]),
  ),
  perQuery: Object.fromEntries(Object.entries(armRows)),
  stageBreakdown: breakdowns,
  performance: perfResults,
  rss,
};

// `--json=` lets the pool round write its own files instead of overwriting 3B's.
// Default is unchanged, so a bare run still lands on `phase3b-scale.json`.
const jsonPath = arg('json') ?? join(REPORTS_DIR, 'phase3b-scale.json');
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[3b] 报告：${jsonPath}`);

db.close();
rmSync(tmpDir, { recursive: true, force: true });
tmpDir = null;
console.log('[3b] 临时库已删除');
