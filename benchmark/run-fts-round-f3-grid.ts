#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F3：网格 runner**（判据 `f1-criteria.md` r3 §5 / §7）。
 *
 * 冻结依据：`f2-freeze-r3.json`（K = 200、装置、四档分层、负例分组口径）。
 * **本脚本只产出读数，不做门判定**——门与选择在 `collect-fts-round-f3.ts` 与
 * `select-fts-round-arm.ts` 里，因为判定必须能在不重跑 1920 次搜索的前提下复算。
 *
 * ## 两个阶段，分开跑
 *
 *   --phase=gates   16 arm × 120 query，**缓存 query 向量**（不影响返回，只省时间），
 *                   出 §5.1–§5.5 的全部读数 + S6 / S7b / S8 的逐 arm 证据
 *   --phase=perf    16 arm × 120 query × REPEAT 次，**真实 embedder、每次冷 df 缓存**，
 *                   出 §5.6 的完整 search p50/p95/p99 与分段耗时
 *
 * 分两阶段的理由：门读数只需要页面内容，缓存向量后 1920 次搜索几分钟能跑完；
 * 性能读数要的是真实一次调用的成本，必须带 embedding 与冷 df 缓存，成本高一个量级。
 * 混在一起跑，要么门读数被拖慢，要么性能读数被缓存污染。
 *
 * ## 三条必须写下来的口径
 *
 * 1. **页面 limit = 10 是继承值**，不是本轮选的：G2 的「≤ 2」由 Phase 2B 在 limit = 10 下
 *    预登记选出，P3 网格同样是 10。已登记在 `f2-freeze-r3.json` 的
 *    `payload.nextPhase.f3.pageLimitInherited`。
 * 2. **门读数阶段跨 arm 复用 df 缓存**。df 只取决于装置，缓存不改变任何返回；
 *    性能阶段每次计时前清空缓存，所以 df 一遍的成本不会被省掉。
 * 3. **分段耗时是三段而不是判据 §5.6 写的四段**：「候选生成」与「候选内归因」合并报。
 *    单独拆开需要在 `fts-round-admission.ts` 内部埋点，而那个文件是 `f2-freeze-r3.json`
 *    的冻结输入，改它会让冻结失效。合并不影响性能门的判定（§6.6 只用完整 search p95），
 *    偏离登记在输出的 `boundaries.segmentGranularity`。
 *
 * 用法：
 *   bun run benchmark/run-fts-round-f3-grid.ts --phase=gates
 *   bun run benchmark/run-fts-round-f3-grid.ts --phase=gates --arms=r0-d1.00,r0.2-d0.10
 *   bun run benchmark/run-fts-round-f3-grid.ts --phase=perf  --arms=r0-d1.00
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { hybridSearchObservations, DEFAULT_RETRIEVAL_POLICY } from '../src/server/observation-search';
import { generateEmbedding } from '../src/embedding';
import { verifyFreezeRecordFile } from './freeze-util';
import { annotationToResult, type Annotation, type DatasetTurn } from './dataset';
import {
  ALL_ARMS, BASELINE_ARM, legExact, surviveUnits, legShapeC,
  type AdmissionContext, type AdmissionPolicy,
} from './fts-round-admission';
import { withAdmissionLeg, INTERNAL_CANDIDATE_LIMIT, type AdmissionReading } from './fts-round-search';

const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const ARM_DIR = join(REPORTS, 'f3-arms');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (m: string): never => { console.error(`[f3] ✗ ${m}`); process.exit(1); };
const r3 = (x: number): number => Number(x.toFixed(3));
const r2n = (x: number): number => Number(x.toFixed(2));

/** 请求级页面条数：继承 P3 / Phase 2B 的口径（见文件头第 1 条）。 */
const PAGE_LIMIT = 10;
/** 性能阶段每条 query 的重复次数（判据 §5.6：≥ 5 次并取该 query 的 min）。 */
const PERF_REPEAT = Number(arg('repeat') ?? 5);
const PHASE = (arg('phase') ?? 'gates') as 'gates' | 'perf';
if (PHASE !== 'gates' && PHASE !== 'perf') die(`--phase 只接受 gates | perf，收到 ${PHASE}`);

// --- S1：冻结校验 -------------------------------------------------------------
const freezePath = join(REPORTS, 'f2-freeze-r3.json');
const v = verifyFreezeRecordFile(freezePath);
console.log(`[f3] S1 冻结校验 f2-freeze-r3.json：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) { for (const f of v.failures) console.error(`  - ${f.name} expected=${f.expected.slice(0, 12)} actual=${(f.actual ?? 'null').slice(0, 12)}`); die('冻结物已漂移'); }
const freeze = read(freezePath);
const K = freeze.payload.selectedK as number | 'EXACT';
const DB_PATH = arg('db') ?? (freeze.payload.fixture.dbPath as string);
const EXPECT_ROWS = freeze.payload.fixture.rows as number;
const INHERITED_LIMIT = freeze.payload.nextPhase.f3.pageLimitInherited.value as number;
if (INHERITED_LIMIT !== PAGE_LIMIT) die(`页面 limit 与冻结登记不符：${PAGE_LIMIT} vs ${INHERITED_LIMIT}`);
console.log(`[f3] K = ${K}；页面 limit = ${PAGE_LIMIT}（继承）；装置 ${DB_PATH}`);

// --- 装置 --------------------------------------------------------------------
if (!existsSync(DB_PATH)) die(`装置不存在：${DB_PATH}（先跑 run-fts-round-f2-fixture.ts）`);
const db = new MemoryDB(DB_PATH);
const raw = (db as unknown as { db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } } }).db;
const CWD = '/fts-round/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const scopeSize = (raw.query('SELECT count(*) AS n FROM observations WHERE scope_key = ?').all(SCOPE) as { n: number }[])[0]!.n;
if (scopeSize !== EXPECT_ROWS) die(`装置行数 ${scopeSize} ≠ 冻结值 ${EXPECT_ROWS}`);

// --- 数据集与 id 映射 ---------------------------------------------------------
interface GridQuery {
  id: string; kind: string; cohort: string; query: string;
  primary_gold?: string[]; acceptable_gold?: string[];
  negative_type?: string; lexical_negative_class?: string; protection_class?: string;
  repair?: string;
}
const queries = read(join(DATASET, 'queries-fts-round-r2.json')).queries as GridQuery[];
if (queries.length !== 120) die(`query 应为 120 条，实际 ${queries.length}`);
const mirror = read(join(DATASET, 'mirror-en-acp-queries-fts-round-r2.json')).queries as Record<string, string>;
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string; annotation: Annotation }[];
const oldTurns = (read(join(DATASET, 'turns.json')) as DatasetTurn[]).filter((t) => t.scope === 'primary');

/** 数据集 id ↔ Observation id：按标题回查（装置里标题唯一，由语料自证保证）。 */
const obsByDataset = new Map<string, number>();
const datasetByObs = new Map<number, string>();
for (const r of [...records, ...oldTurns] as { id: string; annotation: Annotation }[]) {
  const title = annotationToResult(r.annotation).title;
  const row = (raw.query('SELECT id FROM observations WHERE scope_key = ? AND title = ? LIMIT 1').all(SCOPE, title) as { id: number }[])[0]
    ?? die(`装置里找不到记录：${r.id}（${title.slice(0, 24)}…）`);
  obsByDataset.set(r.id, row.id); datasetByObs.set(row.id, r.id);
}
console.log(`[f3] id 映射：${obsByDataset.size} 条（新 ${records.length} + 旧 ${oldTurns.length}）`);

/** 内容折叠键（§5.2 的 distinctContent）：gold 各自独立，filler 按源行折叠。 */
const contentKeyByObs = new Map<number, string>();
{
  const rows = raw.query('SELECT id, session_id AS s, title FROM observations WHERE scope_key = ?').all(SCOPE) as { id: number; s: string; title: string }[];
  for (const r of rows) {
    const ds = datasetByObs.get(r.id);
    if (ds) { contentKeyByObs.set(r.id, ds); continue; }
    // 英文 filler 的 5 份副本共享内容，标题后缀 ` [copy N]` 是唯一差别。
    contentKeyByObs.set(r.id, `${r.s}#${r.title.replace(/ \[copy \d+\]$/, '')}`);
  }
}

/** 四档分层：逐 query band 取自冻结后复现报告（与预冻结逐条一致，两份都被冻结）。 */
const bandByQuery = new Map<string, string>(
  (read(join(REPORTS, 'f2-strata-verify-r3.json')).rows as { id: string; band: string }[]).map((r) => [r.id, r.band]),
);

const ageDays = new Map<number, number>();
{
  const now = Date.now();
  for (const r of raw.query('SELECT id, turn_stopped_at AS t FROM observations WHERE scope_key = ?').all(SCOPE) as { id: number; t: string }[]) {
    ageDays.set(r.id, Math.round((now - new Date(r.t).getTime()) / 86400000));
  }
}

// --- 单元切分与向量缓存 -------------------------------------------------------
const unitCache = new Map<string, string[]>();
const unitsOf = (q: string): string[] => {
  let u = unitCache.get(q);
  if (!u) { u = extractFtsSearchUnits(q); unitCache.set(q, u); }
  return u;
};
const enOf = (q: GridQuery): string => mirror[q.id] ?? q.query;
/** 门读数阶段用：同一段文本的向量恒定，缓存不改变任何返回。 */
const vecCache = new Map<string, Float32Array>();
const cachedEmbedding = async (text: string): Promise<Float32Array> => {
  let hit = vecCache.get(text);
  if (!hit) { hit = await generateEmbedding(text); vecCache.set(text, hit); }
  return hit;
};

const armFilter = (arg('arms') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const arms = armFilter.length ? ALL_ARMS.filter((a) => armFilter.includes(a.id)) : ALL_ARMS;
if (!arms.length) die(`--arms 没有匹配任何 arm；可选：${ALL_ARMS.map((a) => a.id).join(', ')}`);
mkdirSync(ARM_DIR, { recursive: true });

// ============================================================================
// 门读数阶段
// ============================================================================
interface Row {
  id: string; kind: string; cohort: string;
  negativeType?: string; lexicalNegativeClass?: string; protectionClass?: string;
  patched?: boolean; band?: string;
  primaryGold: string[]; acceptableGold: string[];
  resultIds: string[]; resultRawIds: number[]; resultSources: string[];
  semanticScores: (number | null)[]; ftsRanks: (number | null)[]; semanticRanks: (number | null)[];
  ageDays: number[];
  ftsCount: number; semanticCount: number; aboveFloorCount: number;
  comparableVectors: number; scopeVectors: number | null;
  protocol: string; rejectReason: string | null; degraded: boolean;
  semanticOnly: number; semanticOnlyDropped: number;
  physicalRows: number; distinctContent: number;
  primaryRank: number | null; acceptableRank: number | null;
  nonAcceptable: number; nonAcceptableBeforePrimary: number;
  admission: AdmissionReading;
  /** 因准入过滤而少于 min(limit, 候选) 的返回（§2.2 第 4 条）。 */
  pageShrink: number;
  /** S7b：形状 C 与 EXACT 的候选差集大小，必须为 0。 */
  s7bMissing: number; s7bExtra: number;
  /** G3：按 ftsRank / semanticRank 重算的 match_source 与返回值不一致的条数。 */
  sourceRecomputeMismatch: number;
}

const label = (id: number): string => datasetByObs.get(id) ?? `filler:${id}`;

async function runGates(arm: { id: string; policy: AdmissionPolicy }): Promise<void> {
  const started = Date.now();
  const dfCache = new Map<string, number>();
  const handle = withAdmissionLeg(db, { policy: arm.policy, k: K, scopeKey: SCOPE, scopeSize, dfCache, unitsOf });
  const ctx: AdmissionContext = { raw: raw as any, scopeKey: SCOPE, scopeSize, dfCache };
  const rows: Row[] = [];

  for (const q of queries) {
    let ftsRank: ReadonlyMap<number, number> = new Map();
    let semRank: ReadonlyMap<number, number> = new Map();
    let ftsCount = -1, semanticCount = -1, aboveFloorCount = -1, comparableVectors = -1;
    let scopeVectors: number | null = null;
    let protocol = '?';
    let rejectReason: string | null = null;
    let degraded = false;
    let semanticOnlyDropped = -1;

    const results = await hybridSearchObservations(
      handle.db, q.query,
      { scopeKey: SCOPE, limit: PAGE_LIMIT, semanticQueryEn: enOf(q) },
      {
        policy: DEFAULT_RETRIEVAL_POLICY,
        generateEmbedding: cachedEmbedding,
        onCandidates: (i) => {
          ftsRank = i.ftsRank; semRank = i.semanticRank;
          ftsCount = i.ftsCount; semanticCount = i.semanticCount;
          aboveFloorCount = i.aboveFloorCount; comparableVectors = i.comparableVectors;
          scopeVectors = i.scopeVectors; protocol = i.protocol; rejectReason = i.semanticQueryRejected;
        },
        onFusion: (i) => { semanticOnlyDropped = i.semanticOnlyDropped; },
        onDegrade: () => { degraded = true; },
      },
    );
    const adm = handle.last() ?? die(`${q.id}: FTS 腿未被调用，代理失效`);

    // --- S7b：形状 C 的候选与 EXACT 逐 query 比对 ---
    const exact = legExact(ctx, db, q.query, unitsOf(q.query), arm.policy, INTERNAL_CANDIDATE_LIMIT).ids;
    const shapeIds = K === 'EXACT' ? exact
      : legShapeC(ctx, db, q.query, unitsOf(q.query), arm.policy, K, INTERNAL_CANDIDATE_LIMIT).ids;
    const exactSet = new Set(exact);
    const shapeSet = new Set(shapeIds);

    // --- G3：match_source 机械重算（bigramAux = false，本轮无 bigram 腿）---
    const recompute = (id: number): string => {
      const inFts = ftsRank.has(id);
      const inSem = semRank.has(id);
      return inFts && inSem ? 'hybrid' : inFts ? 'fts' : 'semantic';
    };

    const primaryGold = q.primary_gold ?? [];
    const acceptableGold = q.acceptable_gold ?? [];
    const primaryObs = new Set(primaryGold.map((g) => obsByDataset.get(g) ?? die(`${q.id} 的 primary_gold ${g} 未播种`)));
    const acceptableObs = new Set(acceptableGold.map((g) => obsByDataset.get(g) ?? die(`${q.id} 的 acceptable_gold ${g} 未播种`)));
    const pIdx = results.findIndex((r) => primaryObs.has(r.id));
    const aIdx = results.findIndex((r) => acceptableObs.has(r.id));

    rows.push({
      id: q.id, kind: q.kind, cohort: q.cohort,
      ...(q.negative_type ? { negativeType: q.negative_type } : {}),
      ...(q.lexical_negative_class ? { lexicalNegativeClass: q.lexical_negative_class } : {}),
      ...(q.protection_class ? { protectionClass: q.protection_class } : {}),
      ...(q.cohort === 'lexical-anchor' ? { patched: q.repair !== undefined } : {}),
      ...(bandByQuery.has(q.id) ? { band: bandByQuery.get(q.id)! } : {}),
      primaryGold, acceptableGold,
      resultIds: results.map((r) => label(r.id)),
      resultRawIds: results.map((r) => r.id),
      resultSources: results.map((r) => r.match_source),
      semanticScores: results.map((r) => (r.semantic_score == null ? null : r3(r.semantic_score))),
      ftsRanks: results.map((r) => ftsRank.get(r.id) ?? null),
      semanticRanks: results.map((r) => semRank.get(r.id) ?? null),
      ageDays: results.map((r) => ageDays.get(r.id) ?? -1),
      ftsCount, semanticCount, aboveFloorCount, comparableVectors, scopeVectors,
      protocol, rejectReason, degraded,
      semanticOnly: results.filter((r) => r.match_source === 'semantic').length,
      semanticOnlyDropped,
      physicalRows: results.length,
      distinctContent: new Set(results.map((r) => contentKeyByObs.get(r.id) ?? `?${r.id}`)).size,
      primaryRank: pIdx < 0 ? null : pIdx + 1,
      acceptableRank: aIdx < 0 ? null : aIdx + 1,
      nonAcceptable: results.filter((r) => !acceptableObs.has(r.id)).length,
      // G1 的口径：primary_gold 不在页面时记 0（判据 §6.1），退化解由 G4 与保护线拦。
      nonAcceptableBeforePrimary: pIdx < 0 ? 0 : results.slice(0, pIdx).filter((r) => !acceptableObs.has(r.id)).length,
      admission: adm,
      pageShrink: adm.branch === 'fts' ? Math.max(0, Math.min(INTERNAL_CANDIDATE_LIMIT, adm.candidates) - adm.admitted) : 0,
      s7bMissing: exact.filter((x) => !shapeSet.has(x)).length,
      s7bExtra: shapeIds.filter((x) => !exactSet.has(x)).length,
      sourceRecomputeMismatch: results.filter((r) => recompute(r.id) !== r.match_source).length,
    });
  }

  // --- S6：基线臂必须与生产实现逐条相同（完整检索链口径）---
  let s6: { checked: number; mismatches: string[] } | null = null;
  if (arm.id === BASELINE_ARM) {
    const mism: string[] = [];
    for (const q of queries) {
      const prod = await hybridSearchObservations(
        db, q.query, { scopeKey: SCOPE, limit: PAGE_LIMIT, semanticQueryEn: enOf(q) },
        { policy: DEFAULT_RETRIEVAL_POLICY, generateEmbedding: cachedEmbedding },
      );
      const got = rows.find((r) => r.id === q.id)!;
      const same = prod.length === got.resultRawIds.length
        && prod.every((r, i) => r.id === got.resultRawIds[i] && r.match_source === got.resultSources[i]);
      if (!same) mism.push(q.id);
    }
    s6 = { checked: queries.length, mismatches: mism };
    console.log(`[f3] S6 恒等锚点（${BASELINE_ARM} vs 生产）：${mism.length === 0 ? `✓ ${queries.length}/${queries.length} 一致` : `✗ ${mism.length} 条不一致：${mism.slice(0, 8).join(' ')}`}`);
  }

  const out = {
    purpose: 'F3 门读数（判据 r3 §5.1–§5.5、§7 S5–S8）。门判定在 collect-fts-round-f3.ts。',
    round: freeze.round,
    phase: 'F3-gates',
    arm: arm.id,
    policy: arm.policy,
    generatedAt: new Date().toISOString(),
    freeze: { path: 'benchmark/reports/fts-round/f2-freeze-r3.json', verify: v.label, selectedK: K },
    fixture: { dbPath: DB_PATH, rows: scopeSize },
    pageLimit: PAGE_LIMIT,
    internalCandidateLimit: INTERNAL_CANDIDATE_LIMIT,
    ftsLegCalls: handle.calls(),
    s6Identity: s6,
    wallMs: Date.now() - started,
    rows,
  };
  writeFileSync(join(ARM_DIR, `arm-${arm.id}.json`), `${JSON.stringify(out, null, 2)}\n`);
  const zeroReturn = rows.filter((r) => r.physicalRows === 0).length;
  const s7bBad = rows.filter((r) => r.s7bMissing || r.s7bExtra).length;
  console.log(`[f3] ${arm.id.padEnd(11)} 均返回 ${r2n(rows.reduce((s, r) => s + r.physicalRows, 0) / rows.length)}`
    + ` 空页 ${zeroReturn} 缩水 ${rows.filter((r) => r.pageShrink > 0).length}`
    + ` 豁免 ${rows.reduce((s, r) => s + r.admission.exemptHits, 0)}`
    + ` S7b差集 ${s7bBad} 源不一致 ${rows.reduce((s, r) => s + r.sourceRecomputeMismatch, 0)}`
    + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

// ============================================================================
// 性能阶段（判据 §5.6）
// ============================================================================
interface PerfRow {
  id: string; cohort: string;
  /** 该 query 的完整 search 最小耗时（min 对调度抖动稳健，判据 §5.6）。 */
  totalMs: number;
  /** V2 的 df 一遍（冷缓存下 surviveUnits 的耗时）。 */
  dfPassMs: number;
  /** 候选生成 + 候选内归因 + 准入判定（合并段，见文件头第 3 条）。 */
  ftsLegRestMs: number;
  /** 端到端减去 FTS 腿：query 向量、语义腿、融合、行取回。 */
  fusionAndSemanticMs: number;
  repeats: number;
}
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return r2n(s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!);
};

async function runPerf(arm: { id: string; policy: AdmissionPolicy }): Promise<void> {
  const started = Date.now();
  const perf: PerfRow[] = [];
  for (const q of queries) {
    const totals: number[] = [];
    const dfs: number[] = [];
    const legs: number[] = [];
    for (let i = 0; i < PERF_REPEAT; i++) {
      // 每次重复都用**新的** df 缓存：生产的一次搜索没有跨请求缓存可用。
      const dfCache = new Map<string, number>();
      const handle = withAdmissionLeg(db, { policy: arm.policy, k: K, scopeKey: SCOPE, scopeSize, dfCache, unitsOf });
      const t0 = performance.now();
      await hybridSearchObservations(
        handle.db, q.query,
        { scopeKey: SCOPE, limit: PAGE_LIMIT, semanticQueryEn: enOf(q) },
        // 真实 embedder：query 向量的成本属于一次真实搜索。
        { policy: DEFAULT_RETRIEVAL_POLICY },
      );
      totals.push(performance.now() - t0);

      // 分段：同一策略下分别计时 df 一遍与整条 FTS 腿（都用冷缓存）。
      const ctxCold: AdmissionContext = { raw: raw as any, scopeKey: SCOPE, scopeSize, dfCache: new Map() };
      const units = unitsOf(q.query);
      const t1 = performance.now();
      if (units.length) surviveUnits(ctxCold, q.query, units, arm.policy);
      dfs.push(performance.now() - t1);

      const ctxLeg: AdmissionContext = { raw: raw as any, scopeKey: SCOPE, scopeSize, dfCache: new Map() };
      const t2 = performance.now();
      if (K === 'EXACT') legExact(ctxLeg, db, q.query, units, arm.policy, INTERNAL_CANDIDATE_LIMIT);
      else legShapeC(ctxLeg, db, q.query, units, arm.policy, K, INTERNAL_CANDIDATE_LIMIT);
      legs.push(performance.now() - t2);
    }
    const totalMs = r2n(Math.min(...totals));
    const dfPassMs = r2n(Math.min(...dfs));
    const legAll = r2n(Math.min(...legs));
    perf.push({
      id: q.id, cohort: q.cohort, totalMs, dfPassMs,
      ftsLegRestMs: r2n(Math.max(0, legAll - dfPassMs)),
      fusionAndSemanticMs: r2n(Math.max(0, totalMs - legAll)),
      repeats: PERF_REPEAT,
    });
  }

  const totals = perf.map((p) => p.totalMs);
  const out = {
    purpose: 'F3 性能读数（判据 r3 §5.6、§7 S9）。判定在 collect-fts-round-f3.ts（§6.6）。',
    round: freeze.round,
    phase: 'F3-perf',
    arm: arm.id,
    policy: arm.policy,
    generatedAt: new Date().toISOString(),
    freeze: { path: 'benchmark/reports/fts-round/f2-freeze-r3.json', verify: v.label, selectedK: K },
    fixture: { dbPath: DB_PATH, rows: scopeSize },
    pageLimit: PAGE_LIMIT,
    repeats: PERF_REPEAT,
    method: '每条 query 重复 ' + PERF_REPEAT + ' 次取该 query 的 min，再在 120 条 query 间取分位；'
      + '真实 embedder，每次重复前 df 缓存清空（判据 §5.6）。',
    latency: { p50: quantile(totals, 0.5), p95: quantile(totals, 0.95), p99: quantile(totals, 0.99), max: r2n(Math.max(...totals)) },
    segments: {
      dfPassP95: quantile(perf.map((p) => p.dfPassMs), 0.95),
      ftsLegRestP95: quantile(perf.map((p) => p.ftsLegRestMs), 0.95),
      fusionAndSemanticP95: quantile(perf.map((p) => p.fusionAndSemanticMs), 0.95),
    },
    boundaries: {
      segmentGranularity: '判据 §5.6 写「候选生成 / 候选内归因」两段，本报告合并为 ftsLegRest：'
        + '拆开需要在 fts-round-admission.ts 内部埋点，而它是 f2-freeze-r3.json 的冻结输入，改它会让冻结失效。'
        + '性能门（§6.6）只用完整 search p95 判定，合并不影响判定。',
      segmentsAreSeparateCalls: '分段耗时来自对同一策略的**额外**调用，不是端到端那次调用的内部埋点；'
        + '因此 dfPass + ftsLegRest + fusionAndSemantic 只是量级归因，不构成端到端时间的精确分解。',
    },
    wallMs: Date.now() - started,
    rows: perf,
  };
  writeFileSync(join(ARM_DIR, `perf-${arm.id}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[f3] ${arm.id.padEnd(11)} p50 ${out.latency.p50} / p95 ${out.latency.p95} / p99 ${out.latency.p99} ms`
    + ` | df ${out.segments.dfPassP95} + 腿 ${out.segments.ftsLegRestP95} + 融合语义 ${out.segments.fusionAndSemanticP95}`
    + ` (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

// --- 主循环 -------------------------------------------------------------------
console.log(`[f3] 阶段 ${PHASE}；arm ${arms.length} 个：${arms.map((a) => a.id).join(' ')}`);
for (const arm of arms) {
  if (PHASE === 'gates') await runGates(arm);
  else await runPerf(arm);
}
db.close();
console.log(`[f3] → ${ARM_DIR}`);
