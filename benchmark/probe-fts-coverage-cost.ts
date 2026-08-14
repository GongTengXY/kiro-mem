#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F1 实现探针**：单元覆盖度（V1）与单元 df 上限（V2）的
 * **实现形状与成本**测量。
 *
 * 存在的理由：plan §2 的 V1 一行写着"FTS5 的 `OR` 表达式本身表达不了'至少 N 个'，
 * 要么逐单元探针后过滤，要么改成组合表达式。**成本必须实测**"。判据里 V1 的形式
 * 必须是**可实现且已知成本**的形式，否则 F3 会扫一个跑不动的网格。
 *
 * ## 纪律（这是实现探针，不是 arm）
 *
 * - **不产出任何阈值、不选任何参数。** 输出的是三种实现形状的延迟与等价性，
 *   `minUnits` 在本探针里只是一个**固定刻度**（1 与 2），用来让三种形状跑起来；
 *   V1 的取值刻度由判据在新集上定，本探针的任何数字不得作为取值来源
 *   （与 plan §3 禁止清单第 7 条同一条纪律）。
 * - **不是 arm**：不计算任何门（G1–G4）、不算召回、不算误召回、不碰语义腿、不建向量。
 *   因此不受 plan §3 第 6 条"没有中文语料不得跑 arm"的约束——它约束的是 arm。
 * - **成本与语言无关，这一点是本探针能在当前装置上成立的关键。** F0-1 已登记该装置
 *   中文竞争池只有 66 行，所以**中文 query 的匹配行数**不可外推；但三种形状的成本由
 *   **匹配行数 × 单元数**决定，与那些行是什么语言无关。因此本探针**另造一组高 df 的
 *   拉丁单元 query**（英文 filler 提供 df ≈ 全表的单元），把真实中文语料建好之后才会
 *   出现的匹配行数**现在就量出来**。
 * - 装置与 P3 / F0 逐行相同（50,066 行），SHA 逐项校验；不建向量。
 *
 * ## 量什么
 *
 * 1. **三种实现形状**在同一批 query 上的延迟（p50 / p95）与返回页：
 *    - **A：SQL 内联覆盖度** —— `MATCH` 的 OR 表达式 + `instr()` 求和 `>= N` 进 WHERE。
 *      语义精确（`LIMIT` 作用在过滤之后），代价是每个**匹配行**都要算 `单元数 × 列数` 次 `instr`。
 *    - **B：逐单元全量探针 + JS 聚合** —— 每个单元一次 MATCH，取全部命中 rowid 在 JS 里计数。
 *      代价是 `Σ df`。
 *    - **C：放大候选窗口 + 候选内归因** —— 先按今天的 OR + bm25 取前 K 条，只在这 K 行上归因、
 *      过滤，再取前 `limit`。最便宜，但**语义不精确**：排在 K 之后、本该通过覆盖度的记录会丢。
 *      丢多少是本探针要量的东西之一。
 * 2. **等价性**：
 *    - `minUnits = 1` 时三种形状必须与**生产 `searchObservationsFts` 逐条相同**（恒等锚点）；
 *    - `minUnits = 2` 时 A 与 B 必须逐条相同；C 必须是 A 的前缀子集，差集逐 query 记录。
 *    - `instr()` 归因与 FTS `MATCH` 归因必须在抽样行上一致（trigram 是子串语义，
 *      但大小写折叠实现不同，分歧必须被测到而不是被假设不存在）。
 * 3. **V2 的 df 一遍成本**：逐单元 MATCH `count(*)`（plan 说"成本低"，这里量出来）。
 *
 * 用法：bun run benchmark/probe-fts-coverage-cost.ts
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { annotationToResult, type Annotation, type DatasetTurn } from './dataset';

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (m: string): never => { console.error(`[fts-f1-probe] ✗ ${m}`); process.exit(1); };
const r2 = (x: number): number => Number(x.toFixed(2));
const r4 = (x: number): number => Number(x.toFixed(4));
const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

const REPORT_DIR = join(import.meta.dir, 'reports', 'fts-round');
const P3_FREEZE = join(import.meta.dir, 'reports', 'safety-round', 'p3-grid-freeze.json');

/**
 * `observations_fts` 索引的 9 列，与生产 `FTS_INDEXED_COLUMNS` 同序。
 *
 * 生产里那份常量没有导出，这里按 `src/db/schema.ts` 的表定义**重新声明**——与 F0 的
 * `pass1Units()` 同一条边界：若生产列表改动，本探针的归因会失效，必须同步。
 */
const FTS_COLUMNS = [
  'title', 'summary', 'request', 'outcome', 'learned',
  'next_steps', 'concepts_json', 'files_touched_json', 'evidence_json',
] as const;

/** 本探针的固定刻度，**不是候选取值**（见文件头纪律第 1 条）。 */
const MIN_UNITS_SCALE = [1, 2] as const;
/** 形状 C 的候选窗口。50 是生产内部候选上限（V4），200 是"放大四倍"的固定刻度。 */
const WINDOW_SCALE = [50, 200] as const;
/** 生产 MCP 页面大小。所有形状都按它截断，读数才可比。 */
const PAGE_LIMIT = 10;
/** 每个 (query, 形状) 的计时重复次数；另有 1 次不计时的预热。 */
const REPEATS = 11;

// --- 0. 输入与冻结校验（读 P3 冻结装置，SHA 必须仍一致）----------------------
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

// --- 1. 播种：与 F0 逐行相同（不建向量）-------------------------------------
const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', 'fts-f1-impl-probe.db');
const CWD = '/safety-round/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const NOW = Date.now();
const FILLER_ROWS = fx.filler.records as number;
const SPREAD_DAYS = fx.filler.spreadDays as number;

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB_PATH + suffix)) rmSync(DB_PATH + suffix, { force: true });
}
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new MemoryDB(DB_PATH);

const datasetByObs = new Map<number, string>();
const obsByDataset = new Map<string, number>();

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

const t0Seed = Date.now();
for (const rec of [...newRecords].sort((a, b) => a.insertion_index - b.insertion_index)) {
  const r = annotationToResult(rec.annotation);
  const id = insert({
    session: 'safety-round-new', title: r.title, summary: r.summary, outcome: r.outcome,
    learned: r.learned, concepts: r.concepts, files: r.files_touched, memoryType: r.memory_type,
    at: new Date(NOW - rec.age_days * 86400000).toISOString(),
  });
  datasetByObs.set(id, rec.id); obsByDataset.set(rec.id, id);
}
const oldBase = NOW - (fx.oldPrimary.ageDays as number) * 86400000;
for (const t of oldTurns) {
  const r = annotationToResult(t.annotation);
  const id = insert({
    session: 'gold-old', title: r.title, summary: r.summary, outcome: r.outcome,
    learned: r.learned, concepts: r.concepts, files: r.files_touched, memoryType: r.memory_type,
    at: new Date(oldBase + minute++ * 60_000).toISOString(),
  });
  datasetByObs.set(id, t.id); obsByDataset.set(t.id, id);
}
const spreadStart = NOW - SPREAD_DAYS * 86400000;
const spreadStep = (SPREAD_DAYS * 86400000) / (FILLER_ROWS - 1);
for (let i = 0; i < FILLER_ROWS; i++) {
  const srcIndex = i % filler.length;
  const copy = Math.floor(i / filler.length);
  const f = filler[srcIndex]!;
  insert({
    session: 'filler',
    title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
    summary: f.summary, outcome: f.outcome, learned: f.learned,
    concepts: f.concepts, files: f.files, memoryType: 'change',
    at: new Date(spreadStart + Math.round(i * spreadStep)).toISOString(),
  });
}
const raw = (db as unknown as {
  db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } };
}).db;
const corpusSize = (raw.query('SELECT count(*) AS n FROM observations WHERE scope_key = ?')
  .all(SCOPE) as { n: number }[])[0]!.n;
if (corpusSize !== fx.totalPhysicalRows) die(`行数与 P3 装置不符：${corpusSize} != ${fx.totalPhysicalRows}`);
console.log(`[fts-f1-probe] 播种完成（无向量）：${corpusSize} 行，${((Date.now() - t0Seed) / 1000).toFixed(1)}s`);

// --- 2. 三种实现形状 --------------------------------------------------------
const quote = (u: string): string => `"${u.replaceAll('"', '""')}"`;
const orExpr = (units: string[]): string => units.map(quote).join(' OR ');

/** OR 表达式的**全部**匹配行数。成本的自变量，不是读数目标。 */
function matchedRows(units: string[]): number {
  const rows = raw.query(
    `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o
       ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`,
  ).all(orExpr(units), SCOPE) as { n: number }[];
  return rows[0]?.n ?? 0;
}

/** 生产实现，恒等锚点。 */
function production(query: string, limit: number): number[] {
  return db.searchObservationsFts(query, { scopeKey: SCOPE, limit }).map((o) => o.id);
}

/**
 * 形状 A：SQL 内联覆盖度。
 *
 * 每个单元展开成 9 列的 `instr()` OR，外面套 `CASE WHEN … THEN 1 ELSE 0 END` 求和。
 * `LIMIT` 作用在过滤**之后**，所以语义与"先按覆盖度准入、再按 bm25 排前 N"完全一致。
 */
function shapeA(units: string[], minUnits: number, limit: number): number[] {
  if (units.length === 0) return [];
  const params: (string | number)[] = [orExpr(units), SCOPE];
  const terms = units.map((u) => {
    const ors = FTS_COLUMNS.map((c) => `instr(lower(o.${c}), ?) > 0`).join(' OR ');
    for (const _ of FTS_COLUMNS) params.push(u.toLowerCase());
    return `(CASE WHEN ${ors} THEN 1 ELSE 0 END)`;
  });
  params.push(minUnits, limit);
  const sql = `SELECT o.id AS id FROM observations_fts fts
    CROSS JOIN observations o ON fts.rowid = o.id
    WHERE observations_fts MATCH ? AND o.scope_key = ?
      AND (${terms.join(' + ')}) >= ?
    ORDER BY fts.rank, o.id ASC LIMIT ?`;
  return (raw.query(sql).all(...params) as { id: number }[]).map((r) => r.id);
}

/**
 * 形状 B：逐单元全量 MATCH 探针 + JS 聚合，再按今天的 bm25 顺序取前 `limit` 个存活者。
 *
 * 归因用的是 FTS 自己的语义（不是 `instr`），所以它同时是形状 A 的语义对照。
 */
function shapeB(units: string[], minUnits: number, limit: number): number[] {
  if (units.length === 0) return [];
  const counts = new Map<number, number>();
  for (const u of units) {
    const rows = raw.query(
      `SELECT fts.rowid AS id FROM observations_fts fts CROSS JOIN observations o
         ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`,
    ).all(quote(u), SCOPE) as { id: number }[];
    for (const r of rows) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  }
  const ranked = raw.query(
    `SELECT o.id AS id FROM observations_fts fts CROSS JOIN observations o
       ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?
     ORDER BY fts.rank, o.id ASC`,
  ).all(orExpr(units), SCOPE) as { id: number }[];
  const out: number[] = [];
  for (const r of ranked) {
    if ((counts.get(r.id) ?? 0) >= minUnits) {
      out.push(r.id);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * 形状 C：先取前 `window` 个候选（今天的 OR + bm25），只在候选行上归因后过滤。
 *
 * 归因是一次 `instr` 扫描，但只扫 `window` 行，所以成本与语料规模脱钩。
 * 代价是准入被**排名截断**限制：排在 `window` 之后、本该通过覆盖度的记录进不了页面。
 */
function shapeC(units: string[], minUnits: number, limit: number, window: number): number[] {
  if (units.length === 0) return [];
  const cand = raw.query(
    `SELECT o.id AS id FROM observations_fts fts CROSS JOIN observations o
       ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?
     ORDER BY fts.rank, o.id ASC LIMIT ?`,
  ).all(orExpr(units), SCOPE, window) as { id: number }[];
  if (!cand.length) return [];
  const ids = cand.map((c) => c.id);
  const params: (string | number)[] = [];
  const terms = units.map((u) => {
    const ors = FTS_COLUMNS.map((c) => `instr(lower(o.${c}), ?) > 0`).join(' OR ');
    for (const _ of FTS_COLUMNS) params.push(u.toLowerCase());
    return `(CASE WHEN ${ors} THEN 1 ELSE 0 END)`;
  });
  const hits = new Map<number, number>(
    (raw.query(
      `SELECT o.id AS id, (${terms.join(' + ')}) AS hits FROM observations o
         WHERE o.id IN (${ids.map(() => '?').join(',')})`,
    ).all(...params, ...ids) as { id: number; hits: number }[]).map((r) => [r.id, r.hits]),
  );
  const out: number[] = [];
  for (const id of ids) {
    if ((hits.get(id) ?? 0) >= minUnits) {
      out.push(id);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** V2 的一遍 df：逐单元 MATCH `count(*)`。plan 说成本低，这里量。 */
function dfPass(units: string[]): { unit: string; df: number }[] {
  return units.map((u) => {
    const rows = raw.query(
      `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o
         ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`,
    ).all(quote(u), SCOPE) as { n: number }[];
    return { unit: u, df: rows[0]?.n ?? 0 };
  });
}

/** 单行归因的 FTS 语义（F0 的 `matchedUnits`），用于校验 `instr` 归因。 */
function matchedUnitsByFts(obsId: number, units: string[]): string[] {
  return units.filter((u) => raw
    .query('SELECT 1 AS ok FROM observations_fts WHERE rowid = ? AND observations_fts MATCH ?')
    .all(obsId, quote(u)).length > 0);
}
function matchedUnitsByInstr(obsId: number, units: string[]): string[] {
  const row = (raw.query(
    `SELECT ${FTS_COLUMNS.map((c) => `lower(coalesce(o.${c}, '')) AS ${c}`).join(', ')}
       FROM observations o WHERE o.id = ?`,
  ).all(obsId) as Record<string, string>[])[0];
  if (!row) return [];
  return units.filter((u) => FTS_COLUMNS.some((c) => (row[c] ?? '').includes(u.toLowerCase())));
}

// --- 3. query 集：真实 131 条 + 高 df 合成组 --------------------------------
//
// 合成组的唯一目的：把"真实中文语料建好之后才会出现的匹配行数"现在就量出来。
// 它由**英文 filler 词表**里 df 落在固定目标附近的拉丁单元构成，因此这些数字是
// 装置里真实存在的 df，不是编出来的。
const LATIN_CANDIDATES = [
  'case', 'the', 'dark', 'theme', 'colors', 'layout', 'Android', 'ConstraintLayout',
  'test', 'build', 'fix', 'error', 'config', 'cache', 'null', 'timeout', 'retry',
  'index', 'query', 'schema', 'token', 'worker', 'client', 'server', 'button',
];
const latinDf = dfPass(LATIN_CANDIDATES.filter((u) => u.length >= 3))
  .sort((a, b) => b.df - a.df);
const DF_TARGETS = [50000, 25000, 10000, 2000, 200];
const pickedAnchors = DF_TARGETS.map((target) => {
  let best = latinDf[0]!;
  for (const c of latinDf) if (Math.abs(c.df - target) < Math.abs(best.df - target)) best = c;
  return { target, ...best };
});

/** 合成 query 的中文外壳：取一条真实锚点 query，保证单元数落在真实量级（F0：均 18.5）。 */
const SHELL = queries.find((q) => q.id === 'sr-a01')?.query
  ?? die('找不到 sr-a01，装置与 F0 不一致');
const synthetic = pickedAnchors.map((a) => ({
  id: `syn-df${a.df}`,
  cohort: 'synthetic-high-df',
  query: `${SHELL} ${a.unit}`,
  note: `拉丁单元 ${a.unit}（df=${a.df}，目标 ${a.target}）`,
}));

/**
 * 第二层合成组：**同时**含 k 个高 df 单元。
 *
 * 这一层是 B 与 C 之间的判据。形状 B 的成本是 `Σ df`，而单高 df 合成组只提供一个
 * 大加数——真实中文语料里 `能不能` / `有没有` / `的模型` 这类功能词窗口会**同时**高 df，
 * 于是 `Σ df` 随单元数线性涨。形状 C 的新增成本只作用在 `window` 行上，与 df 无关，
 * 所以这一层能把两者的伸缩性分开。
 *
 * 注意：`FTS_MAX_UNITS = 32` 会在单元预算耗尽时丢掉部分滑窗，因此实际单元数记在读数里，
 * 不假设等于"外壳单元数 + k"。
 */
const highDf = latinDf.filter((d) => d.df >= 1000);
const SYN_MULTI_K = [3, 6, 12] as const;
const syntheticMulti = SYN_MULTI_K.filter((k) => highDf.length >= k).map((k) => {
  const picked = highDf.slice(0, k);
  return {
    id: `syn-multi${k}`,
    cohort: 'synthetic-multi-high-df',
    query: `${SHELL} ${picked.map((p) => p.unit).join(' ')}`,
    note: `${k} 个高 df 拉丁单元，Σdf=${picked.reduce((a, p) => a + p.df, 0)}：${picked.map((p) => `${p.unit}=${p.df}`).join(' / ')}`,
  };
});

const allQueries: { id: string; cohort: string; query: string; note?: string }[] = [
  ...queries.map((q) => ({ id: q.id, cohort: q.cohort, query: q.query })),
  ...synthetic,
  ...syntheticMulti,
];

// --- 4. 测量 ---------------------------------------------------------------
function timed<T>(fn: () => T): { ms: number[]; value: T } {
  fn(); // 预热，不计时
  const ms: number[] = [];
  let value!: T;
  for (let i = 0; i < REPEATS; i++) {
    const t = performance.now();
    value = fn();
    ms.push(performance.now() - t);
  }
  return { ms, value };
}
const sameList = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

interface ShapeReading { shape: string; minUnits: number; window?: number; msMin: number; msP50: number; msP95: number; rows: number }
interface QueryReading {
  id: string; cohort: string; note?: string;
  units: number; matchedRows: number;
  dfPassMs: number; dfMax: number; dfMaxRatio: number; sumDf: number;
  production: number[];
  shapes: ShapeReading[];
  identityAtMinUnits1: { A: boolean; B: boolean; C50: boolean; C200: boolean };
  abEqual: Record<string, boolean>;
  cLoss: Record<string, { missing: number; missingIds: string[] }>;
}

const label = (id: number): string => datasetByObs.get(id) ?? `filler:${id}`;
const rows: QueryReading[] = [];
const allMs = new Map<string, number[]>();
const pushMs = (key: string, ms: number[]): void => {
  const cur = allMs.get(key) ?? [];
  cur.push(...ms);
  allMs.set(key, cur);
};

for (const q of allQueries) {
  const units = extractFtsSearchUnits(q.query);
  const mr = matchedRows(units);
  const dfT = performance.now();
  const dfs = dfPass(units);
  const dfPassMs = performance.now() - dfT;
  const dfMax = dfs.reduce((m, d) => Math.max(m, d.df), 0);

  const prod = production(q.query, PAGE_LIMIT);
  const shapes: ShapeReading[] = [];
  const identity = { A: false, B: false, C50: false, C200: false };
  const abEqual: Record<string, boolean> = {};
  const cLoss: Record<string, { missing: number; missingIds: string[] }> = {};

  // 基线臂：今天的生产实现。它与三种形状的差就是**覆盖度机制新增的成本**——
  // 不分开量会把 OR 候选生成与 bm25 排名的既有开销记到 V1 头上。
  const base = timed(() => production(q.query, PAGE_LIMIT));
  pushMs('P(baseline)', base.ms);
  shapes.push({ shape: 'P', minUnits: 0, msMin: r2(Math.min(...base.ms)), msP50: r2(pct(base.ms, 50)), msP95: r2(pct(base.ms, 95)), rows: base.value.length });

  for (const minUnits of MIN_UNITS_SCALE) {
    const a = timed(() => shapeA(units, minUnits, PAGE_LIMIT));
    pushMs(`A@${minUnits}`, a.ms);
    shapes.push({ shape: 'A', minUnits, msMin: r2(Math.min(...a.ms)), msP50: r2(pct(a.ms, 50)), msP95: r2(pct(a.ms, 95)), rows: a.value.length });

    const b = timed(() => shapeB(units, minUnits, PAGE_LIMIT));
    pushMs(`B@${minUnits}`, b.ms);
    shapes.push({ shape: 'B', minUnits, msMin: r2(Math.min(...b.ms)), msP50: r2(pct(b.ms, 50)), msP95: r2(pct(b.ms, 95)), rows: b.value.length });
    abEqual[`minUnits=${minUnits}`] = sameList(a.value, b.value);

    for (const window of WINDOW_SCALE) {
      const c = timed(() => shapeC(units, minUnits, PAGE_LIMIT, window));
      pushMs(`C${window}@${minUnits}`, c.ms);
      shapes.push({
        shape: `C${window}`, minUnits, window,
        msMin: r2(Math.min(...c.ms)), msP50: r2(pct(c.ms, 50)), msP95: r2(pct(c.ms, 95)), rows: c.value.length,
      });
      if (minUnits === 1) identity[window === 50 ? 'C50' : 'C200'] = sameList(c.value, prod);
      else {
        const missing = a.value.filter((id) => !c.value.includes(id));
        cLoss[`C${window}@${minUnits}`] = { missing: missing.length, missingIds: missing.map(label) };
      }
    }
    if (minUnits === 1) {
      identity.A = sameList(a.value, prod);
      identity.B = sameList(b.value, prod);
    }
  }

  rows.push({
    id: q.id, cohort: q.cohort, ...(q.note ? { note: q.note } : {}),
    units: units.length, matchedRows: mr,
    dfPassMs: r2(dfPassMs), dfMax, dfMaxRatio: r4(dfMax / corpusSize),
    sumDf: dfs.reduce((a, d) => a + d.df, 0),
    production: prod.map((id) => 0), // 占位，下面用 label 版本覆盖
    shapes, identityAtMinUnits1: identity, abEqual, cLoss,
  });
  rows[rows.length - 1]!.production = prod;
}

// --- 5. instr 归因 vs FTS 归因（抽样，固定规则）------------------------------
//
// 抽样规则先写死：每个 cohort 取前 3 条 query，每条取生产页面的前 3 行。
const attributionChecks: { query: string; obs: string; ftsOnly: string[]; instrOnly: string[] }[] = [];
const perCohort = new Map<string, number>();
for (const q of allQueries) {
  const n = perCohort.get(q.cohort) ?? 0;
  if (n >= 3) continue;
  perCohort.set(q.cohort, n + 1);
  const units = extractFtsSearchUnits(q.query);
  for (const id of production(q.query, 3)) {
    const byFts = matchedUnitsByFts(id, units);
    const byInstr = matchedUnitsByInstr(id, units);
    const ftsOnly = byFts.filter((u) => !byInstr.includes(u));
    const instrOnly = byInstr.filter((u) => !byFts.includes(u));
    if (ftsOnly.length || instrOnly.length) {
      attributionChecks.push({ query: q.id, obs: label(id), ftsOnly, instrOnly });
    }
  }
}

// --- 6. 汇总 ---------------------------------------------------------------
const identityFailures = rows.filter(
  (r) => !r.identityAtMinUnits1.A || !r.identityAtMinUnits1.B
    || !r.identityAtMinUnits1.C50 || !r.identityAtMinUnits1.C200,
);
const abFailures = rows.filter((r) => Object.values(r.abEqual).some((v) => !v));
const cLossQueries = rows.filter((r) => Object.values(r.cLoss).some((v) => v.missing > 0));

const shapeSummary = [...allMs.entries()].map(([key, ms]) => ({
  key, msMin: r2(Math.min(...ms)), msP50: r2(pct(ms, 50)), msP95: r2(pct(ms, 95)),
  msMax: r2(Math.max(...ms)), samples: ms.length,
})).sort((a, b) => a.key.localeCompare(b.key));

const byCohort = [...new Set(allQueries.map((q) => q.cohort))].map((cohort) => {
  const rs = rows.filter((r) => r.cohort === cohort);
  /**
   * 每个形状取"**最坏 query 的最好一次**"：先在 query 内取 `msMin`（重复 11 次的最小值，
   * 对机器噪声最稳健），再在 cohort 内取最大值（最坏 query）。
   * 这样得到的是**下界形态的上界**——它不会因为一次调度抖动而虚高，也不会掩盖最坏 query。
   */
  const worstMin = (shape: string, minUnits: number): number => Math.max(
    ...rs.flatMap((r) => r.shapes.filter((s) => s.shape === shape && s.minUnits === minUnits).map((s) => s.msMin)),
  );
  const worstP95 = (shape: string, minUnits: number): number => Math.max(
    ...rs.flatMap((r) => r.shapes.filter((s) => s.shape === shape && s.minUnits === minUnits).map((s) => s.msP95)),
  );
  return {
    cohort, queries: rs.length,
    matchedRowsMedian: pct(rs.map((r) => r.matchedRows), 50),
    matchedRowsMax: Math.max(...rs.map((r) => r.matchedRows)),
    sumDfMax: Math.max(...rs.map((r) => r.sumDf)),
    unitsMean: r2(rs.reduce((a, r) => a + r.units, 0) / (rs.length || 1)),
    baseMinMax: r2(worstMin('P', 0)),
    aMinMax: r2(worstMin('A', 2)),
    bMinMax: r2(worstMin('B', 2)),
    c50MinMax: r2(worstMin('C50', 2)),
    c200MinMax: r2(worstMin('C200', 2)),
    baseP95Max: r2(worstP95('P', 0)),
    aP95Max: r2(worstP95('A', 2)),
    bP95Max: r2(worstP95('B', 2)),
    c50P95Max: r2(worstP95('C50', 2)),
    c200P95Max: r2(worstP95('C200', 2)),
    dfPassMsMax: r2(Math.max(...rs.map((r) => r.dfPassMs))),
  };
});

mkdirSync(REPORT_DIR, { recursive: true });
const out = {
  purpose: 'F1 实现探针：V1 覆盖度与 V2 df 上限的实现形状与成本。描述性，不产出任何阈值。',
  generatedAt: new Date().toISOString(),
  discipline: {
    notAnArm: '不计算任何门、不算召回/误召回、不碰语义腿、不建向量。',
    noThresholds: 'minUnits ∈ {1,2} 与 window ∈ {50,200} 是固定刻度，不是候选取值；V1/V2 的取值刻度由 F1 判据在新集上定。',
    costIsLanguageIndependent: '成本由匹配行数 × 单元数决定，与语言无关，因此高 df 合成组可在中文语料建好之前给出上界。',
    fixtureCaveat: 'F0-1 已登记该装置中文竞争池仅 66 行，中文 query 的匹配行数不可外推。',
  },
  fixture: {
    dbPath: DB_PATH, corpusSize, totalPhysicalRowsExpected: fx.totalPhysicalRows,
    p3Freeze: P3_FREEZE, p3FreezeSha256: sha256(P3_FREEZE),
    ftsColumns: FTS_COLUMNS,
  },
  scale: { minUnits: MIN_UNITS_SCALE, window: WINDOW_SCALE, pageLimit: PAGE_LIMIT, repeats: REPEATS },
  syntheticAnchors: pickedAnchors,
  shapeSummary,
  byCohort,
  equivalence: {
    identityAtMinUnits1: {
      description: 'minUnits=1 时四种形状必须与生产 searchObservationsFts 逐条相同',
      failures: identityFailures.map((r) => ({ id: r.id, ...r.identityAtMinUnits1 })),
      pass: identityFailures.length === 0,
    },
    aVsB: {
      description: 'minUnits=2 时 SQL 内联（instr 归因）与逐单元 MATCH 探针必须逐条相同',
      failures: abFailures.map((r) => ({ id: r.id, abEqual: r.abEqual })),
      pass: abFailures.length === 0,
    },
    attribution: {
      description: 'instr 归因 vs FTS MATCH 归因（抽样：每 cohort 前 3 条 query × 页面前 3 行）',
      mismatches: attributionChecks,
      pass: attributionChecks.length === 0,
    },
    cWindowLoss: {
      description: '形状 C 相对形状 A 丢掉的记录（排名截断导致的准入损失）',
      queries: cLossQueries.map((r) => ({ id: r.id, cohort: r.cohort, cLoss: r.cLoss })),
      queriesAffected: cLossQueries.length,
    },
  },
  rows,
};
const jsonPath = join(REPORT_DIR, 'f1-impl-probe.json');
writeFileSync(jsonPath, JSON.stringify(out, null, 2));

console.log(`\n[fts-f1-probe] 形状延迟（全 query 汇总，ms）`);
for (const s of shapeSummary) console.log(`  ${s.key.padEnd(11)} min ${String(s.msMin).padStart(7)}  p50 ${String(s.msP50).padStart(8)}  p95 ${String(s.msP95).padStart(8)}  max ${String(s.msMax).padStart(8)}`);
console.log(`\n[fts-f1-probe] 按 cohort：最坏 query 的 msMin（minUnits=2；括号内为同一格的 p95）`);
for (const c of byCohort) {
  const f = (mn: number, p95: number): string => `${String(mn).padStart(7)}(${String(p95).padStart(7)})`;
  console.log(`  ${c.cohort.padEnd(24)} n=${String(c.queries).padStart(3)} 匹配行中位 ${String(c.matchedRowsMedian).padStart(6)} 最大 ${String(c.matchedRowsMax).padStart(6)} Σdf最大 ${String(c.sumDfMax).padStart(7)}  基线 ${f(c.baseMinMax, c.baseP95Max)}  A ${f(c.aMinMax, c.aP95Max)}  B ${f(c.bMinMax, c.bP95Max)}  C50 ${f(c.c50MinMax, c.c50P95Max)}  C200 ${f(c.c200MinMax, c.c200P95Max)}  df一遍 ${String(c.dfPassMsMax).padStart(7)}`);
}
console.log(`\n[fts-f1-probe] 等价性`);
console.log(`  minUnits=1 恒等：${identityFailures.length === 0 ? '✓ 全部一致' : `✗ ${identityFailures.length} 条不一致`}`);
console.log(`  A vs B：${abFailures.length === 0 ? '✓ 全部一致' : `✗ ${abFailures.length} 条不一致`}`);
console.log(`  instr vs MATCH 归因：${attributionChecks.length === 0 ? '✓ 抽样无分歧' : `✗ ${attributionChecks.length} 处分歧`}`);
console.log(`  C 窗口截断损失：${cLossQueries.length} 条 query 受影响`);
console.log(`\n[fts-f1-probe] → ${jsonPath}`);
db.close();
