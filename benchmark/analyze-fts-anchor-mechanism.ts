/**
 * FTS 安全策略轮次 **F0**：词面命中机制的描述性诊断。
 *
 * 回答一个问题：P3 里那 30 条词面锚点 hard-negative 为什么在 floor 0.325 上仍然满页？
 * P3 只测到"页面变成纯 fts"，没测到**是哪个词面单元把它们拉进来的**，而后者决定
 * 下一轮该动哪个变量。
 *
 * ## 纪律（这是一份只读诊断，不选任何参数）
 *
 * - 用的是 P3 **已消耗**的校准集（`turns-safety-round.json` / `queries-safety-round.json`）。
 *   方案 §4 禁止清单第 1 条允许在已消耗集上做**描述性测量**，禁止据此选择阈值。
 *   因此本脚本输出分布与曲线，**不输出任何推荐值**，也不得被后续轮次当作阈值来源。
 * - 不建向量、不跑语义腿、不碰生产策略。只播 FTS 需要的那张表。
 * - 装置与 P3 逐行相同（50,066 行），这样 `ftsCount` 能与 P3 的 arm 文件对齐核对。
 *
 * ## 量什么
 *
 * 1. 每条 query 被 `extractFtsSearchUnits` 切成哪些单元（纯函数，与生产同一份实现）；
 * 2. 每个单元在装置里的**文档频率** df 与 df/N；
 * 3. 真实 `searchObservationsFts` 的 `ftsCount` 与前 10 名，以及每个返回文档
 *    **实际命中了哪几个单元**；
 * 4. 三类 query（词面锚点负例 / 零 FTS 负例 / relevance 正例）的分布对比——
 *    正例那一侧就是"召回保护线"要保护的东西。
 *
 * 用法：bun run benchmark/analyze-fts-anchor-mechanism.ts
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { DATASET_DIR, annotationToResult, type Annotation, type DatasetTurn } from './dataset';

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (m: string): never => { console.error(`[fts-f0] ✗ ${m}`); process.exit(1); };
const r4 = (x: number): number => Number(x.toFixed(4));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const REPORT_DIR = join(import.meta.dir, 'reports', 'fts-round');
const P3_FREEZE = join(import.meta.dir, 'reports', 'safety-round', 'p3-grid-freeze.json');

// --- 0. 输入与冻结校验（读的是 P3 的冻结装置，SHA 必须仍一致）----------------
const p3 = read(P3_FREEZE);
if (sha256(p3.criteria) !== p3.criteriaSha256) die('P3 判据 SHA 不一致，装置定义已漂移');
const fx = p3.fixture;
for (const [name, path, want] of [
  ['newGold', fx.newGold.path, fx.newGold.sha256],
  ['oldPrimary', fx.oldPrimary.path, fx.oldPrimary.sha256],
  ['filler', fx.filler.path, fx.filler.sha256],
  ['queries', fx.queries.path, fx.queries.sha256],
] as const) {
  if (sha256(path) !== want) die(`装置输入 SHA 不一致：${name} (${path})`);
}

interface SafetyRecord { id: string; annotation: Annotation; age_days: number; insertion_index: number }
interface GridQuery {
  id: string; kind: 'relevance' | 'hard-negative'; cohort: string;
  negative_type?: 'near-domain' | 'foreign-domain';
  lexical_anchor?: string;
  query: string; primary_gold?: string[]; acceptable_gold?: string[];
}

const newRecords = (read(fx.newGold.path) as { records: SafetyRecord[] }).records;
const oldTurns = (read(fx.oldPrimary.path) as DatasetTurn[]).filter((t) => t.scope === 'primary');
const filler = read(fx.filler.path) as Array<{
  title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}>;
const queries = (read(fx.queries.path) as { queries: GridQuery[] }).queries;

// --- 1. 播种：与 P3 逐行相同，但**不建向量**（本诊断只用 FTS）----------------
const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', 'fts-f0-mechanism.db');
const CWD = '/safety-round/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const NOW = Date.now();
const FILLER_ROWS = fx.filler.records as number;
const SPREAD_DAYS = fx.filler.spreadDays as number;

if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new MemoryDB(DB_PATH);

const datasetByObs = new Map<number, string>();
const obsByDataset = new Map<string, number>();
const contentKeyByObs = new Map<number, string>();

let minute = 0;
function insert(o: {
  session: string; title: string; summary: string; outcome: string | null; learned: string | null;
  concepts: string[]; files: string[]; memoryType: string; at: string;
}): number {
  if (!db.getSessionRef(o.session)) db.upsertSessionRef({ session_id: o.session, cwd: CWD, repo: CWD });
  const seq = db.allocateNextTurnSeq(o.session);
  const turn = db.createTurn({ session_id: o.session, seq, cwd: CWD, repo: CWD, prompt_text: o.title });
  db.markTurnClosed(turn.id, o.at);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: o.session, turn_seq: seq, repo: CWD, cwd_scope: CWD,
    title: o.title, summary: o.summary, outcome: o.outcome, learned: o.learned,
    memory_type: o.memoryType as never, files_touched: o.files, concepts: o.concepts,
    quality: 'normal', turn_started_at: o.at, turn_stopped_at: o.at,
  });
  if (id == null) throw new Error(`insert failed: ${o.title}`);
  return id;
}

for (const rec of [...newRecords].sort((a, b) => a.insertion_index - b.insertion_index)) {
  const r = annotationToResult(rec.annotation);
  const id = insert({
    session: 'safety-round-new', title: r.title, summary: r.summary, outcome: r.outcome,
    learned: r.learned, concepts: r.concepts, files: r.files_touched, memoryType: r.memory_type,
    at: new Date(NOW - rec.age_days * 86400000).toISOString(),
  });
  datasetByObs.set(id, rec.id); obsByDataset.set(rec.id, id); contentKeyByObs.set(id, rec.id);
}
const oldBase = NOW - (fx.oldPrimary.ageDays as number) * 86400000;
for (const t of oldTurns) {
  const r = annotationToResult(t.annotation);
  const id = insert({
    session: 'gold-old', title: r.title, summary: r.summary, outcome: r.outcome,
    learned: r.learned, concepts: r.concepts, files: r.files_touched, memoryType: r.memory_type,
    at: new Date(oldBase + minute++ * 60_000).toISOString(),
  });
  datasetByObs.set(id, t.id); obsByDataset.set(t.id, id); contentKeyByObs.set(id, t.id);
}
const spreadStart = NOW - SPREAD_DAYS * 86400000;
const spreadStep = (SPREAD_DAYS * 86400000) / (FILLER_ROWS - 1);
for (let i = 0; i < FILLER_ROWS; i++) {
  const srcIndex = i % filler.length;
  const copy = Math.floor(i / filler.length);
  const f = filler[srcIndex]!;
  const id = insert({
    session: 'filler',
    title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
    summary: f.summary, outcome: f.outcome, learned: f.learned,
    concepts: f.concepts, files: f.files, memoryType: 'change',
    at: new Date(spreadStart + Math.round(i * spreadStep)).toISOString(),
  });
  contentKeyByObs.set(id, `filler#${srcIndex}`);
}
const rawDb = (db as unknown as { db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } } }).db;
const corpusSize = (rawDb.query('SELECT count(*) AS n FROM observations WHERE scope_key = ?')
  .all(SCOPE) as { n: number }[])[0]!.n;
console.log(`[fts-f0] 播种完成（无向量）：${corpusSize} 行`);
if (corpusSize !== fx.totalPhysicalRows) die(`行数与 P3 装置不符：${corpusSize} != ${fx.totalPhysicalRows}`);

// --- 2. 单元 df 与逐 query 归因 ---------------------------------------------
const raw = rawDb;
const dfCache = new Map<string, number>();
function unitDf(unit: string): number {
  const hit = dfCache.get(unit);
  if (hit !== undefined) return hit;
  const rows = raw
    .query(`SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o
            ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`)
    .all(`"${unit.replaceAll('"', '""')}"`, SCOPE) as { n: number }[];
  const n = rows[0]?.n ?? 0;
  dfCache.set(unit, n);
  return n;
}
/** 一个文档实际命中了哪些单元。用 FTS 单元探针逐个问，避免猜。 */
function matchedUnits(obsId: number, units: string[]): string[] {
  const out: string[] = [];
  for (const u of units) {
    const rows = raw
      .query(`SELECT 1 AS ok FROM observations_fts WHERE rowid = ? AND observations_fts MATCH ?`)
      .all(obsId, `"${u.replaceAll('"', '""')}"`) as unknown[];
    if (rows.length) out.push(u);
  }
  return out;
}

const label = (id: number): string => datasetByObs.get(id) ?? `filler:${id}`;

/**
 * 单元来源分类：**整词** vs **滑窗**。
 *
 * `extractFtsSearchUnits` 有两趟：pass 1 推整段 / 整个 CJK 连续串 / 混排段里的拉丁串
 * （精确），pass 2 用 3 字滑窗切长 CJK 串（不精确——`相似度门槛` 会切出 `度门槛` 这种
 * 跨词边界的碎片）。生产函数返回的是一个扁平列表，看不出哪个是哪个，而这两类的
 * 精确度差一个量级。这里按生产实现原样重算 pass 1 集合，其余即 pass 2 滑窗。
 *
 * 为什么值得单独量：如果锚点负例主要靠滑窗碎片命中、正例主要靠整词命中，
 * 那"单元来源"就是比"命中几个单元"或"df 多高"更强的判别信号。
 */
function pass1Units(query: string): Set<string> {
  const out = new Set<string>();
  const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{3,}/g;
  const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  const LATIN_RUN = /[A-Za-z0-9_]{3,}/g;
  for (const segment of query.trim().split(/\s+/)) {
    if (!segment) continue;
    if (segment.length >= 3) out.add(segment);
    for (const run of segment.match(CJK_RUN) ?? []) out.add(run);
    if (CJK_CHAR.test(segment)) for (const run of segment.match(LATIN_RUN) ?? []) out.add(run);
  }
  return out;
}
const isLatinUnit = (u: string): boolean => /^[A-Za-z0-9_./-]+$/.test(u);

interface Row {
  id: string; kind: string; cohort: string; negativeType?: string; lexicalAnchor?: string;
  query: string;
  units: { unit: string; df: number; dfRatio: number; whole: boolean; latin: boolean }[];
  ftsCount: number;
  page: {
    id: string; matchedUnits: string[];
    maxDfRatioOfMatched: number; minDfRatioOfMatched: number;
    /** 命中项里有没有整词单元（pass 1）；没有则该行完全由滑窗碎片带进来 */
    matchedWhole: number; matchedWindowOnly: boolean; matchedLatin: number;
  }[];
  /** 页面上每条记录命中的单元数（正例侧用来判断"覆盖度门"会不会打坏召回） */
  matchedUnitCounts: number[];
  goldMatchedUnitCount: number | null;
  goldMatchedWhole: number | null;
  goldRank: number | null;
}

const rows: Row[] = [];
for (const q of queries) {
  const whole = pass1Units(q.query);
  const units = extractFtsSearchUnits(q.query).map((u) => {
    const df = unitDf(u);
    return { unit: u, df, dfRatio: r4(df / corpusSize), whole: whole.has(u), latin: isLatinUnit(u) };
  });
  const hits = db.searchObservationsFts(q.query, { scopeKey: SCOPE, limit: 50 });
  const unitList = units.map((u) => u.unit);
  const page = hits.slice(0, 10).map((o) => {
    const m = matchedUnits(o.id, unitList);
    const meta = m.map((u) => units.find((x) => x.unit === u)!);
    const ratios = meta.map((x) => x.dfRatio);
    const matchedWhole = meta.filter((x) => x.whole).length;
    return {
      id: label(o.id), matchedUnits: m,
      maxDfRatioOfMatched: ratios.length ? Math.max(...ratios) : 0,
      minDfRatioOfMatched: ratios.length ? Math.min(...ratios) : 0,
      matchedWhole, matchedWindowOnly: m.length > 0 && matchedWhole === 0,
      matchedLatin: meta.filter((x) => x.latin).length,
    };
  });
  const primary = (q.primary_gold ?? []).map((g) => obsByDataset.get(g)!);
  const goldIdx = hits.findIndex((o) => primary.includes(o.id));
  const goldMatched = goldIdx >= 0 ? matchedUnits(hits[goldIdx]!.id, unitList) : null;
  rows.push({
    id: q.id, kind: q.kind, cohort: q.cohort,
    ...(q.negative_type ? { negativeType: q.negative_type } : {}),
    ...(q.lexical_anchor ? { lexicalAnchor: q.lexical_anchor } : {}),
    query: q.query, units, ftsCount: hits.length, page,
    matchedUnitCounts: page.map((p) => p.matchedUnits.length),
    goldMatchedUnitCount: goldMatched?.length ?? null,
    goldMatchedWhole: goldMatched ? goldMatched.filter((u) => whole.has(u)).length : null,
    goldRank: goldIdx < 0 ? null : goldIdx + 1,
  });
}

// --- 3.0 装置有效性：中文 query 的词面竞争池到底有多大 ---------------------
//
// 这一项不是附加统计，而是判断上面所有 FTS 读数**在多大范围内成立**的前提。
// `pool-policy-filler-10k.json` 当初是为语义腿的余弦分布造的（meta.purpose），
// 它的 10,000 条全是英文；中文 query 的 3 字窗口因此只可能命中中文记录。
const CJK_CHAR_TEST = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const cjkRows = (rawDb
  .query(`SELECT session_id AS s, count(*) AS n FROM observations WHERE scope_key = ?
          AND (title GLOB '*[一-龥]*' OR summary GLOB '*[一-龥]*') GROUP BY session_id`)
  .all(SCOPE) as { s: string; n: number }[]);
const fillerCjk = filler.filter((f) => CJK_CHAR_TEST.test(`${f.title}${f.summary}${f.outcome}${f.learned}`)).length;
const deviceValidity = {
  totalRows: corpusSize,
  cjkRowsBySession: Object.fromEntries(cjkRows.map((r) => [r.s, r.n])),
  fillerSourceRecordsWithCjk: fillerCjk,
  fillerLanguage: fillerCjk === 0 ? 'pure-latin' : 'mixed',
  chineseLexicalCompetitionPool: cjkRows.reduce((n, r) => n + r.n, 0),
  note:
    'filler 是纯英文，因此中文 query 的 3 字窗口只能命中中文记录：词面竞争池 = 上面那个数，' +
    '不是 50,066。df / bm25 / top-50 截断在这个装置上都不是生产规模下的读数。',
  resultOrigin: {} as Record<string, { fromFiller: number; fromGold: number; rows: number }>,
};
const anchors = rows.filter((r) => r.cohort === 'lexical-anchor');
const empties = rows.filter((r) => r.cohort === 'empty-zero-fts');
const rel = rows.filter((r) => r.kind === 'relevance');
const relWithFts = rel.filter((r) => r.ftsCount > 0);

for (const [name, rs] of [['lexical-anchor', anchors], ['relevance', rel]] as const) {
  const pages = rs.flatMap((r) => r.page);
  deviceValidity.resultOrigin[name] = {
    fromFiller: pages.filter((p) => p.id.startsWith('filler:')).length,
    fromGold: pages.filter((p) => !p.id.startsWith('filler:')).length,
    rows: pages.length,
  };
}

// --- 3. 三类对比 ------------------------------------------------------------
const cohortStats = (name: string, rs: Row[]) => {
  const perPageMatched = rs.flatMap((r) => r.matchedUnitCounts);
  const maxRatios = rs.flatMap((r) => r.page.map((p) => p.maxDfRatioOfMatched));
  const pages = rs.flatMap((r) => r.page);
  return {
    cohort: name, n: rs.length,
    ftsCount: { mean: r4(mean(rs.map((r) => r.ftsCount))), median: median(rs.map((r) => r.ftsCount)), max: Math.max(0, ...rs.map((r) => r.ftsCount)) },
    unitsPerQuery: { mean: r4(mean(rs.map((r) => r.units.length))), max: Math.max(0, ...rs.map((r) => r.units.length)) },
    matchedUnitsPerResult: { mean: r4(mean(perPageMatched)), median: median(perPageMatched), max: Math.max(0, ...perPageMatched), onlyOne: perPageMatched.filter((x) => x === 1).length, total: perPageMatched.length },
    dfRatioOfMatchedUnit: { mean: r4(mean(maxRatios)), median: r4(median(maxRatios)), max: r4(Math.max(0, ...maxRatios)) },
    unitProvenance: {
      rowsMatchedByWindowOnly: pages.filter((p) => p.matchedWindowOnly).length,
      rowsWithAnyWholeUnit: pages.filter((p) => p.matchedWhole > 0).length,
      rowsWithLatinUnit: pages.filter((p) => p.matchedLatin > 0).length,
      rows: pages.length,
    },
  };
};

/**
 * 两条**只描述曲线、不推荐取值**的模拟。
 *
 * 阶梯是固定十进制刻度，不是从数据里挑出来的；任何真实取值必须在新集上选
 * （P3 复核裁定 §5：不得在已消耗数据上试新参数）。
 */
const DF_LADDER = [0.001, 0.005, 0.01, 0.05, 0.1, 0.2];
const dfCeilingCurve = DF_LADDER.map((ceiling) => {
  const survive = (r: Row) => r.units.filter((u) => u.dfRatio <= ceiling).map((u) => u.unit);
  const stillHits = (r: Row) => {
    const kept = new Set(survive(r));
    return r.page.filter((p) => p.matchedUnits.some((u) => kept.has(u))).length;
  };
  return {
    ceiling,
    anchorQueriesWithAnyHit: anchors.filter((r) => stillHits(r) > 0).length,
    anchorPageRowsKept: anchors.reduce((n, r) => n + stillHits(r), 0),
    anchorPageRowsTotal: anchors.reduce((n, r) => n + r.page.length, 0),
    relevanceQueriesLosingAllFtsUnits: relWithFts.filter((r) => survive(r).length === 0).length,
    relevanceGoldRowsKept: relWithFts.filter((r) => {
      if (r.goldRank == null || r.goldRank > 10) return false;
      const kept = new Set(survive(r));
      const goldRow = r.page[r.goldRank - 1];
      return !!goldRow && goldRow.matchedUnits.some((u) => kept.has(u));
    }).length,
    relevanceGoldRowsInPage: relWithFts.filter((r) => r.goldRank != null && r.goldRank <= 10).length,
  };
});

const MIN_MATCH_LADDER = [1, 2, 3, 4];
const minMatchCurve = MIN_MATCH_LADDER.map((minMatch) => ({
  minMatch,
  anchorPageRowsKept: anchors.reduce((n, r) => n + r.matchedUnitCounts.filter((c) => c >= minMatch).length, 0),
  anchorPageRowsTotal: anchors.reduce((n, r) => n + r.page.length, 0),
  relevanceGoldRowsKept: relWithFts.filter((r) => (r.goldMatchedUnitCount ?? 0) >= minMatch && r.goldRank != null && r.goldRank <= 10).length,
  relevanceGoldRowsInPage: relWithFts.filter((r) => r.goldRank != null && r.goldRank <= 10).length,
}));

/**
 * 第三条曲线：**只承认整词单元（pass 1）的命中**，滑窗碎片不算命中。
 * 与前两条同样只描述，不推荐取值。
 */
const wholeUnitOnly = {
  rule: '一条记录必须至少命中 1 个整词单元（pass 1）才算 FTS 候选；滑窗碎片不算',
  anchorQueriesWithAnyHit: anchors.filter((r) => r.page.some((p) => p.matchedWhole > 0)).length,
  anchorQueriesTotal: anchors.length,
  anchorPageRowsKept: anchors.reduce((n, r) => n + r.page.filter((p) => p.matchedWhole > 0).length, 0),
  anchorPageRowsTotal: anchors.reduce((n, r) => n + r.page.length, 0),
  relevanceGoldRowsKept: relWithFts.filter((r) => (r.goldMatchedWhole ?? 0) > 0 && r.goldRank != null && r.goldRank <= 10).length,
  relevanceGoldRowsInPage: relWithFts.filter((r) => r.goldRank != null && r.goldRank <= 10).length,
};

// --- 4. 输出 ---------------------------------------------------------------
mkdirSync(REPORT_DIR, { recursive: true });
const out = {
  generatedAt: new Date().toISOString(),
  role: '描述性诊断（F0）。只测量机制，不选择任何阈值，不裁定任何门。',
  discipline: {
    dataset: 'P3 已消耗的校准集；方案 §4 禁止清单第 1 条只允许描述性测量',
    forbidden: '本报告的任何数字都不得作为下一轮阈值的来源；阶梯是固定十进制刻度，不是从数据里挑的',
    ladderProvenance: { dfRatio: DF_LADDER, minMatchedUnits: MIN_MATCH_LADDER, rule: '固定十进制刻度 / 自然数序列，先写后跑' },
  },
  provenance: {
    scriptSha256: createHash('sha256').update(readFileSync(import.meta.path)).digest('hex').slice(0, 16),
    p3Freeze: { path: P3_FREEZE, criteriaSha256: p3.criteriaSha256 },
    fixture: { rows: corpusSize, vectors: 'none（本诊断不跑语义腿）', scopeKey: SCOPE },
    ftsConstants: { FTS_MIN_UNIT_LEN: 3, FTS_CJK_WINDOW: 3, FTS_MAX_UNITS: 32, internalCandidateLimit: 50, ordering: 'ORDER BY fts.rank, o.id ASC' },
  },
  deviceValidity,
  cohorts: [
    cohortStats('lexical-anchor（30 条词面锚点负例）', anchors),
    cohortStats('empty-zero-fts（40 条零 FTS 负例）', empties),
    cohortStats('relevance（61 条正例）', rel),
    cohortStats('relevance-with-fts（正例中有词面命中的）', relWithFts),
  ],
  curves: { dfCeiling: dfCeilingCurve, minMatchedUnits: minMatchCurve, wholeUnitOnly },
  perQuery: rows,
};
const jsonPath = arg('json') ?? join(REPORT_DIR, 'f0-anchor-mechanism.json');
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
db.close();
if (!process.argv.includes('--keep-db')) rmSync(DB_PATH, { force: true });

console.log(`\n[fts-f0] 装置有效性：物理行 ${deviceValidity.totalRows}，` +
  `中文词面竞争池 **${deviceValidity.chineseLexicalCompetitionPool}** 行（filler 语言 ${deviceValidity.fillerLanguage}，` +
  `含中文的 filler 原文 ${deviceValidity.fillerSourceRecordsWithCjk}/10000）`);
for (const [k, v] of Object.entries(deviceValidity.resultOrigin)) {
  console.log(`  ${k} 返回行来源：filler ${v.fromFiller} / gold ${v.fromGold}（共 ${v.rows}）`);
}

for (const c of out.cohorts) {
  console.log(`\n[fts-f0] ${c.cohort}`);
  console.log(`  ftsCount 均 ${c.ftsCount.mean} / 中位 ${c.ftsCount.median} / 最大 ${c.ftsCount.max}`);
  console.log(`  每 query 单元数 均 ${c.unitsPerQuery.mean} / 最大 ${c.unitsPerQuery.max}`);
  console.log(`  每条返回命中的单元数 均 ${c.matchedUnitsPerResult.mean} / 中位 ${c.matchedUnitsPerResult.median}；` +
    `只命中 1 个单元的返回 ${c.matchedUnitsPerResult.onlyOne}/${c.matchedUnitsPerResult.total}`);
  console.log(`  命中单元的 df/N（取每条返回的最大值）均 ${c.dfRatioOfMatchedUnit.mean} / 中位 ${c.dfRatioOfMatchedUnit.median} / 最大 ${c.dfRatioOfMatchedUnit.max}`);
  console.log(`  返回行的命中来源：只靠滑窗碎片 ${c.unitProvenance.rowsMatchedByWindowOnly}/${c.unitProvenance.rows}；` +
    `含整词 ${c.unitProvenance.rowsWithAnyWholeUnit}/${c.unitProvenance.rows}；` +
    `含拉丁/数字 ${c.unitProvenance.rowsWithLatinUnit}/${c.unitProvenance.rows}`);
}
console.log('\n[fts-f0] df 上限曲线（描述性，不是推荐值）：');
for (const c of dfCeilingCurve) {
  console.log(`  df/N <= ${String(c.ceiling).padEnd(6)} 锚点仍有命中的 query ${c.anchorQueriesWithAnyHit}/${anchors.length}；` +
    `锚点页面行 ${c.anchorPageRowsKept}/${c.anchorPageRowsTotal}；` +
    `正例失去全部单元 ${c.relevanceQueriesLosingAllFtsUnits}/${relWithFts.length}；` +
    `正例 gold 行保住 ${c.relevanceGoldRowsKept}/${c.relevanceGoldRowsInPage}`);
}
console.log('\n[fts-f0] 最少命中单元数曲线（描述性，不是推荐值）：');
for (const c of minMatchCurve) {
  console.log(`  >= ${c.minMatch} 个单元：锚点页面行 ${c.anchorPageRowsKept}/${c.anchorPageRowsTotal}；` +
    `正例 gold 行保住 ${c.relevanceGoldRowsKept}/${c.relevanceGoldRowsInPage}`);
}
console.log(`\n[fts-f0] 只认整词单元（描述性，不是推荐值）：`);
console.log(`  锚点仍有命中的 query ${wholeUnitOnly.anchorQueriesWithAnyHit}/${wholeUnitOnly.anchorQueriesTotal}；` +
  `锚点页面行 ${wholeUnitOnly.anchorPageRowsKept}/${wholeUnitOnly.anchorPageRowsTotal}；` +
  `正例 gold 行保住 ${wholeUnitOnly.relevanceGoldRowsKept}/${wholeUnitOnly.relevanceGoldRowsInPage}`);
console.log(`\n[fts-f0] 报告：${jsonPath}`);
