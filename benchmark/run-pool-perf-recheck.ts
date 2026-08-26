/**
 * 候选池轮次性能门补证：真实 cosine 分布 + 确定性回放到 50,000 候选。
 *
 * 判据：`benchmark/reports/pool-policy-criteria.md` §12（B2，checksum `14da3013bccf8559`），
 * 裁定预先固定门槛 P1–P6 与分支 A / B-2。
 *
 * 为什么必须是两个进程（§12.3）：`perf-floor-worst` 的 1235MB 全局峰值里混着播种 50,000 条
 * 的代价。同一个进程里先播种再检索，无法区分"搜索要这么多内存"与"刚写完 5 万行的堆还没被
 * 回收"。所以：
 *
 *   --phase=seed     建库、写真实向量、打印读数、退出
 *   --phase=measure  重新打开同一个库，只做检索，报告自己的 RSS
 *
 * 三条隔离与 3B 相同：不导入 `src/server/worker.ts`（它在模块顶层就打开真实用户库）、
 * 失败必须退非零、只写 `--db` 指定的路径。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import { loadDataset, loadAcpEnFixture, DATASET_DIR } from './dataset';

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (msg: string, err?: unknown): never => {
  console.error(`[recheck] ✗ ${msg}`);
  if (err) console.error(err);
  process.exit(1);
};

const PHASE = arg('phase') ?? die('必须指定 --phase=seed|measure');
const SIZE = Number(arg('size') ?? 50000);
const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', `pool-recheck-${SIZE}.db`);
const ROUNDS = Number(arg('rounds') ?? 11);
/** 有界 Top-K（阶段二自变量）。不传 = 生产默认。 */
const TOPK = arg("semantic-topk") === undefined
  ? undefined
  : (arg("semantic-topk") === "inf" || arg("semantic-topk") === "full"
      ? Number.POSITIVE_INFINITY
      : Number(arg("semantic-topk")));
const LIMIT = 10;
/**
 * Phase 3C：把这批记录铺开到多少天（老语料装置）。
 *
 * 不传 = 沿用历史口径（每条 +1 分钟，全部落在 90 天窗内），因此候选池轮次与 Top-K 轮次的
 * 读数可以逐位复现。传 `--spread-days=1095` 则把同一批记录均匀铺到最近 3 年，于是绝大多数
 * 记录落在**旧的 90 天窗口之外**——这是 3C 判据 §6.3 唯一关心的形状：时间窗不再过滤之后，
 * 那些原本被挡住的记录进入工作集要花多少钱。
 *
 * 只改时间戳，不改文本、不改向量，所以 cosine 分布逐位不变，唯一自变量是"有多少条在旧窗外"。
 */
const SPREAD_DAYS = arg('spread-days') === undefined ? undefined : Number(arg('spread-days'));
if (SPREAD_DAYS !== undefined && (!Number.isFinite(SPREAD_DAYS) || SPREAD_DAYS <= 0)) {
  die(`--spread-days 必须是正数，实际 ${arg('spread-days')}`);
}
/** 冻结的 10,000 条真实文本。重复 5 份到 50,000 时，向量分布逐位保留（§12.1）。 */
const FILLER_FILE = join(DATASET_DIR, 'pool-policy-filler-10k.json');
const META_FILE = join(DATASET_DIR, 'pool-policy-filler-10k-meta.json');

const fillerRaw = readFileSync(FILLER_FILE, 'utf-8');
const meta = JSON.parse(readFileSync(META_FILE, 'utf-8')) as { frozen?: boolean; fillerSha256?: string };
if (!meta.frozen) die('补证装置未冻结');
if (sha16(fillerRaw) !== meta.fillerSha256) {
  die(`填充 checksum 不匹配：文件 ${sha16(fillerRaw)} vs meta ${meta.fillerSha256}`);
}
interface Filler {
  id: string; domain: string; title: string; summary: string;
  outcome: string; learned: string; concepts: string[]; files: string[];
}
const filler = JSON.parse(fillerRaw) as Filler[];

const { MemoryDB, computeScopeKey } = await import('../src/db');
const { hybridSearchObservations, DEFAULT_RETRIEVAL_POLICY } =
  await import('../src/server/observation-search');
const { embeddingSpaceKey, SEMANTIC_EN_PROTOCOL } = await import('../src/semantic-en');
const { generateEmbedding, buildObservationSearchText, embeddingToBlob, DIMENSIONS, EMBEDDING_MODEL } =
  await import('../src/embedding');

const SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const CWD = '/pool-recheck/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const rssMb = (): number => Math.round(process.memoryUsage().rss / 1048576);

/** 冻结的 query 子集：既有 query 集里前 20 条有英文派生值的，逐档相同。 */
const dataset = loadDataset(DATASET_DIR, { withValidation: true, withPhase2: true, withFusion: true });
const enFixture = loadAcpEnFixture(DATASET_DIR, { withValidation: true, withPhase2: true, withR2: true });
const QUERIES = dataset.queries.filter((q) => enFixture.queries[q.id]).slice(0, 20);
if (QUERIES.length < 20) die(`只找到 ${QUERIES.length} 条带英文派生值的 query，需要 20 条`);

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

if (PHASE === 'seed') {
  if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new MemoryDB(DB_PATH);
  const session = 's-recheck';
  db.upsertSessionRef({ session_id: session, cwd: CWD, repo: CWD });

  // 真实编码只做 10,000 次（裁定允许）：50,000 档把同一批向量以不同 Observation ID 重复
  // 5 份。重复不改变 cosine 分布，因此"过 floor 的比例"逐位保留——这正是回放成立的前提。
  const t0 = Date.now();
  const vectors: Buffer[] = [];
  for (const f of filler) {
    const text = buildObservationSearchText({
      title: f.title, summary: f.summary, outcome: f.outcome,
      learned: f.learned, concepts: f.concepts, files: f.files,
    });
    vectors.push(embeddingToBlob(await generateEmbedding(text)));
  }
  const encodeMs = Date.now() - t0;
  console.log(`[recheck] 真实编码 ${vectors.length} 条：${(encodeMs / 1000).toFixed(1)}s`);

  // 时间轴：当天 UTC 零点往前 30 天为基准，每条 +1 分钟（口径同 3B / 2D P1-1，写死绝对
  // 日期会让装置在某一天静默滑出 90 天窗口）。
  //
  // Phase 3C 的老语料装置走另一支：`--spread-days=N` 把这批记录**均匀铺到最近 N 天**，
  // 最旧的一条在 N 天前、最新的一条在今天。于是 50,000 条铺 1,095 天时只有约
  // 90/1095 ≈ 8.2% 落在旧的 90 天窗内，其余 91.8% 是"改动之前搜不到、现在要进工作集"的记录。
  const base = new Date(new Date().toISOString().slice(0, 10)).getTime() - 30 * 86400000;
  const spreadStart = Date.now() - (SPREAD_DAYS ?? 0) * 86400000;
  const spreadStep = SIZE > 1 ? ((SPREAD_DAYS ?? 0) * 86400000) / (SIZE - 1) : 0;
  const stoppedAt = (i: number): string =>
    SPREAD_DAYS === undefined
      ? new Date(base + i * 60000).toISOString()
      : new Date(spreadStart + Math.round(i * spreadStep)).toISOString();

  const t1 = Date.now();
  for (let i = 0; i < SIZE; i++) {
    const f = filler[i % filler.length]!;
    const seq = db.allocateNextTurnSeq(session);
    const turn = db.createTurn({ session_id: session, seq, cwd: CWD, repo: CWD, prompt_text: f.title });
    const ts = stoppedAt(i);
    db.markTurnClosed(turn.id, ts);
    const copy = Math.floor(i / filler.length);
    const id = db.insertObservation({
      turn_id: turn.id, session_id: session, turn_seq: seq, repo: CWD, cwd_scope: CWD,
      // 副本编号进标题：Observation ID 必须互不相同，文本也不能逐字相同，否则 FTS 的
      // 命中行数会退化成"同一条重复 5 次"，与 50,000 条各自独立的记录不是一回事。
      title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
      summary: f.summary, outcome: f.outcome, learned: f.learned,
      concepts: f.concepts, files_touched: f.files,
      memory_type: 'change', quality: 'normal',
      turn_started_at: ts, turn_stopped_at: ts,
    })!;
    db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, vectors[i % vectors.length]!);
  }
  const seedMs = Date.now() - t1;
  const scopeVectors = db.countScopeVectors({ scopeKey: SCOPE, model: SPACE_KEY, dimensions: DIMENSIONS });
  db.close();
  console.log(
    `[recheck] 播种完成：${SIZE} 条 / ${(seedMs / 1000).toFixed(1)}s，scope 向量 ${scopeVectors}，` +
      `播种进程 RSS 峰值约 ${rssMb()}MB（**不计入搜索预算**），库 ${DB_PATH}`,
  );
  if (scopeVectors !== SIZE) die(`向量数 ${scopeVectors} ≠ ${SIZE}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// measure（独立进程，只读那个库）
// ---------------------------------------------------------------------------

if (PHASE !== 'measure') die(`未知 --phase=${PHASE}`);
if (!existsSync(DB_PATH)) die(`库不存在：${DB_PATH}，先跑 --phase=seed`);

const db = new MemoryDB(DB_PATH);
const scopeVectors = db.countScopeVectors({ scopeKey: SCOPE, model: SPACE_KEY, dimensions: DIMENSIONS });
if (scopeVectors !== SIZE) die(`库里向量 ${scopeVectors} ≠ --size=${SIZE}`);

/**
 * Phase 3C：实测库里的时间形状，而不是相信 `--spread-days` 这个参数。
 *
 * seed 与 measure 是两个进程，所以 measure 侧必须自己确认"这批记录到底有多少落在旧的 90 天
 * 窗口之外"。这个比例就是本轮性能读数的全部意义所在：0% 意味着这次测量与 Top-K 轮次的读数
 * 等价（什么都没多测），接近 100% 才说明测到了"原本被窗口挡住的记录进入工作集"的成本。
 */
const corpusAge = (() => {
  const raw = (db as unknown as { db: { query: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const r = raw.query(
    `SELECT MIN(turn_stopped_at) AS oldest, MAX(turn_stopped_at) AS newest,
            SUM(CASE WHEN turn_stopped_at <= ? THEN 1 ELSE 0 END) AS outside90
       FROM observations WHERE scope_key = ?`,
  ).get(cutoff, SCOPE) as { oldest: string; newest: string; outside90: number };
  const spanDays = Math.round((Date.parse(r.newest) - Date.parse(r.oldest)) / 86400000);
  return {
    oldest: r.oldest, newest: r.newest, spanDays,
    outsideOld90dWindow: r.outside90,
    outsideOld90dWindowPct: Math.round((r.outside90 / SIZE) * 1000) / 10,
  };
})();
console.log(
  `[recheck] 语料时间形状：跨度 ${corpusAge.spanDays} 天（${corpusAge.oldest.slice(0, 10)} → ` +
    `${corpusAge.newest.slice(0, 10)}），落在旧 90 天窗外 ${corpusAge.outsideOld90dWindow}/${SIZE} ` +
    `(${corpusAge.outsideOld90dWindowPct}%)`,
);

const POOLS: { name: string; pool: number }[] = (arg('pools') ?? 'full')
  .split(',')
  .map((raw) => {
    const s = raw.trim();
    if (s === 'full' || s === 'inf') return { name: 'full', pool: Number.POSITIVE_INFINITY };
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) die(`--pools 里的 "${s}" 非法`);
    return { name: String(n), pool: n };
  });

const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]! * 100) / 100;
};

const results: unknown[] = [];
for (const p of POOLS) {
  const lat: number[] = [];
  const firstRound: number[] = [];
  const passRates: number[] = [];
  const passCounts: number[] = [];
  const comparable: number[] = [];
  let degraded = 0;
  const rssBefore = rssMb();
  let rssPeak = rssBefore;
  const rssPerRound: number[] = [];
  const pages: { id: string; resultIds: number[]; sources: string[] }[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    for (const q of QUERIES) {
      let passed = 0;
      let cmp = 0;
      const t0 = performance.now();
      const res = await hybridSearchObservations(
        db,
        q.query,
        { scopeKey: SCOPE, semanticQueryEn: enFixture.queries[q.id]!, limit: LIMIT },
        {
          policy: { ...DEFAULT_RETRIEVAL_POLICY, semanticCandidatePool: p.pool, ...(TOPK === undefined ? {} : { semanticTopK: TOPK }) },
          onCandidates: (i) => {
            // 必须用 `aboveFloorCount` 而不是 `semanticRank.size`：Top-K 轮次引入截断后，
            // 后者变成**保留集**的大小，于是"过 floor 的比例"会随 K 一起缩水，测的就不再是
            // 语料性质而是 K。实测过这个坑：K=200 时 semanticRank.size 只有 163，
            // 而真实过 floor 是 4,618 条。
            passed = i.aboveFloorCount;
            cmp = i.comparableVectors;
          },
          onDegrade: () => { degraded++; },
        },
      );
      const dt = performance.now() - t0;
      // 只记最后一轮：K 的截断效果与轮次无关，但逐轮存 200 页会让 JSON 膨胀。
      // 这一份是阶段二 S1 在**真正会截断的规模上**的唯一凭据——2,000 条装置里
      // above-floor ≤ ~600，K≥1000 压根不截断，在那里比对等于什么都没比。
      if (round === ROUNDS - 1) pages.push({ id: q.id, resultIds: res.map((r) => r.id), sources: res.map((r) => r.match_source) });
      if (round === 0) firstRound.push(dt);
      else {
        lat.push(dt);
        passCounts.push(passed);
        comparable.push(cmp);
        passRates.push(cmp === 0 ? 0 : passed / cmp);
      }
      const now = rssMb();
      if (now > rssPeak) rssPeak = now;
    }
    rssPerRound.push(rssMb());
  }

  const row = {
    size: SIZE,
    pool: p.name,
    scopeVectors,
    samples: lat.length,
    latency: {
      p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), p99: quantile(lat, 0.99),
      max: Math.round(Math.max(...lat) * 100) / 100,
    },
    firstRound: { p50: quantile(firstRound, 0.5), p95: quantile(firstRound, 0.95) },
    floorPass: {
      // 裁定要的"分布"，不是一个均值：过 floor 的比例逐 query 差别很大。
      rateMean: Math.round((passRates.reduce((s, x) => s + x, 0) / Math.max(1, passRates.length)) * 10000) / 10000,
      rateP50: quantile(passRates, 0.5),
      rateP95: quantile(passRates, 0.95),
      rateMax: Math.round(Math.max(...passRates) * 10000) / 10000,
      countMean: Math.round(passCounts.reduce((s, x) => s + x, 0) / Math.max(1, passCounts.length)),
      countP95: quantile(passCounts, 0.95),
      countMax: Math.max(...passCounts),
      comparableMean: Math.round(comparable.reduce((s, x) => s + x, 0) / Math.max(1, comparable.length)),
    },
    rssLoop: { beforeMb: rssBefore, peakMb: rssPeak, deltaMb: rssPeak - rssBefore },
    rssProcessPeakMb: rssPeak,
    rssPerRoundMb: rssPerRound,
    degradedCount: degraded,
    pages,
  };
  results.push(row);
  console.log(
    `[recheck] size=${SIZE} pool=${p.name}: p50 ${row.latency.p50} / p95 ${row.latency.p95} / ` +
      `p99 ${row.latency.p99}ms（${row.samples} 样本）| 过 floor 比例 均 ` +
      `${(row.floorPass.rateMean * 100).toFixed(1)}% p95 ${(row.floorPass.rateP95 * 100).toFixed(1)}% ` +
      `max ${(row.floorPass.rateMax * 100).toFixed(1)}%（均 ${row.floorPass.countMean} / ` +
      `max ${row.floorPass.countMax} 条，可比 ${row.floorPass.comparableMean}）| ` +
      `检索进程 RSS ${rssBefore}→峰 ${rssPeak}MB（+${row.rssLoop.deltaMb}）| degrade ${degraded}`,
  );
}
db.close();

const gitRev = (await Bun.$`git rev-parse --short HEAD`.quiet().nothrow()).stdout.toString().trim();
const out = {
  generatedAt: new Date().toISOString(),
  provenance: {
    commit: gitRev,
    bun: Bun.version,
    platform: `${process.platform}-${process.arch}`,
    criteria: 'benchmark/reports/pool-policy-criteria.md §12（B2）',
    criteriaSha256: sha16(readFileSync(join(import.meta.dir, 'reports/pool-policy-criteria.md'), 'utf-8')),
    fillerSha256: sha16(fillerRaw),
    fillerMeta: meta,
    harnessSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    spaceKey: SPACE_KEY,
    embeddingModel: EMBEDDING_MODEL,
    dimensions: DIMENSIONS,
    queryIds: QUERIES.map((q) => q.id),
    rounds: ROUNDS,
    semanticTopK: TOPK === undefined ? 'default' : String(TOPK),
    // Phase 3C：`undefined` = 历史口径（全部落在 90 天窗内，可复现候选池 / Top-K 读数）；
    // 数字 = 老语料装置，记录均匀铺到最近 N 天。measure 阶段从库里实测真实跨度并回写，
    // 因为 seed 与 measure 是两个进程，光记录参数无法证明库里真的是那个形状。
    spreadDays: SPREAD_DAYS ?? null,
    corpusAgeDays: corpusAge,
    limit: LIMIT,
    twoProcess: true,
    dbPath: DB_PATH,
    basePolicy: { ...DEFAULT_RETRIEVAL_POLICY },
  },
  gates: {
    P1: 'p95 < 300ms', P2: 'p99 < 500ms', P3: '循环内 RSS 增量 ≤ 512MB',
    P4: '检索进程绝对峰值 ≤ 1024MB', P5: '样本 ≥ 200', P6: 'degrade = 0',
  },
  results,
};
const jsonPath = arg('json') ?? join(import.meta.dir, `reports/pool-policy/perf-recheck-${SIZE}.json`);
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`[recheck] 报告：${jsonPath}`);
