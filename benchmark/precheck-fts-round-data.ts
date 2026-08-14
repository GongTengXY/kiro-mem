#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **冻结前数据资格预检**（判据 r4 §16 / §17）。
 *
 * 契约（裁定第 4 项，逐条对应）：
 *
 *  - 装置是**完整 60,066 行纯文本投影**：40 新 gold + 26 旧 gold + 50,000 英文 filler
 *    （10,000 × 5 副本）+ 10,000 中文 filler。因此拉丁标识符、路径、数字与 bm25 排名
 *    都能按正式装置复现；
 *  - **不生成向量、不调 ACP**，成本只有播种（约 30 秒）；
 *  - **复用生产实现**：`annotationToResult`、`extractFtsSearchUnits`、
 *    `searchObservationsFts`（含其 LIKE 回退分支）。不另写近似切分或近似匹配；
 *  - 时间布局与 F2 装置同一套 seed，保证两个装置的词面投影可比（r4 §16.2）。
 *
 * 四道门（r4 §16.1，先写死后跑）：
 *
 *   Q1  40 条词面负例：实测 ftsCount ≥ 1，逐条
 *   Q2  40 条词面负例：锚点必须存在于真实索引投影——至少一个包含锚点的单元 df ≥ 1；
 *       **仅子串存在不算**
 *   Q3  40 条保护线：primary_gold 必须在对应词面分支可达
 *       （short-query 类走 LIKE 回退，其余走 FTS）
 *   Q4  40 条保护线：逐 query 冻结 primary 词面可达性与命中位次，避免基线空门
 *
 * 失败时机械产出**可用替代 token 候选**：从该 gold 的可索引字段里提取真实存在的
 * 专有名词 / 路径 / 数字，并逐个实测 df——不得由撰写者凭印象挑（缺陷 2 的成因）。
 *
 * 用法：
 *   bun run benchmark/precheck-fts-round-data.ts                       # 用 r2 query 集（若存在）否则用原集
 *   bun run benchmark/precheck-fts-round-data.ts --queries=<path>      # 指定 query 集
 *   bun run benchmark/precheck-fts-round-data.ts --reuse               # 复用已播种的临时库
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { annotationToResult, type Annotation, type DatasetTurn } from './dataset';

const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const has = (n: string): boolean => process.argv.includes(`--${n}`);
const die = (m: string): never => { console.error(`[precheck] ✗ ${m}`); process.exit(1); };

const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', 'fts-round-precheck.db');
const CWD = '/fts-round/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const NOW = Date.now();
const SPREAD_DAYS = 1095;
const OLD_AGE_DAYS = 400;
const FILLER_EN_ROWS = 50_000;
/** 与 F2 装置同一个布局 seed（r4 §17「时间布局」）。 */
const LAYOUT_SEED = 0xf2_2026;
const EXPECT_ROWS = 60_066;

const R2_QUERIES = join(DATASET, 'queries-fts-round-r2.json');
const QUERIES_FILE = arg('queries') ?? (existsSync(R2_QUERIES) ? R2_QUERIES : join(DATASET, 'queries-fts-round.json'));
const OUT_FILE = arg('out') ?? join(REPORTS, 'f1-precheck-r2.json');

// --- 输入 --------------------------------------------------------------------
interface Q {
  id: string; kind: string; cohort: string; query: string;
  lexical_anchor?: string; lexical_negative_class?: string; protection_class?: string;
  primary_gold?: string[]; acceptable_gold?: string[];
}
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string; annotation: Annotation }[];
const oldTurns = (read(join(DATASET, 'turns.json')) as DatasetTurn[]).filter((t) => t.scope === 'primary');
const fillerEn = read(join(DATASET, 'pool-policy-filler-10k.json')) as Array<{
  title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}>;
const fillerZh = read(join(DATASET, 'fts-round-filler-zh-10k.json')) as Array<{
  title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}>;
const queries = read(QUERIES_FILE).queries as Q[];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const layoutRnd = mulberry32(LAYOUT_SEED);
const ageOf = new Map(records.map((r) => [r.id, 30 + Math.floor(layoutRnd() * 871)]));
const insertionOrder = [...records.map((r) => r.id)];
for (let i = insertionOrder.length - 1; i > 0; i--) {
  const j = Math.floor(layoutRnd() * (i + 1));
  [insertionOrder[i], insertionOrder[j]] = [insertionOrder[j]!, insertionOrder[i]!];
}

// --- 播种（纯文本，无向量）----------------------------------------------------
if (!has('reuse')) for (const s of ['', '-wal', '-shm']) if (existsSync(DB_PATH + s)) rmSync(DB_PATH + s, { force: true });
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new MemoryDB(DB_PATH);
const raw = (db as unknown as { db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } } }).db;

const obsByDataset = new Map<string, number>();
const datasetByObs = new Map<number, string>();
let minute = 0;
function insert(o: {
  session: string; title: string; summary: string; outcome: string | null; learned: string | null;
  concepts: string[]; files: string[]; at: string;
}): number {
  if (!db.getSessionRef(o.session)) db.upsertSessionRef({ session_id: o.session, cwd: CWD, repo: CWD });
  const seq = db.allocateNextTurnSeq(o.session);
  const turn = db.createTurn({ session_id: o.session, seq, cwd: CWD, repo: CWD, prompt_text: o.title });
  db.markTurnClosed(turn.id, o.at);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: o.session, turn_seq: seq, repo: CWD, cwd_scope: CWD,
    title: o.title, summary: o.summary, outcome: o.outcome, learned: o.learned,
    memory_type: 'change', files_touched: o.files, concepts: o.concepts,
    quality: 'normal', turn_started_at: o.at, turn_stopped_at: o.at,
  });
  if (id == null) throw new Error(`insert failed: ${o.title}`);
  return id;
}

if (!has('reuse')) {
  const t0 = Date.now();
  for (const id of insertionOrder) {
    const rec = records.find((r) => r.id === id)!;
    const res = annotationToResult(rec.annotation);
    const obsId = insert({
      session: 'fts-round-new', title: res.title, summary: res.summary, outcome: res.outcome,
      learned: res.learned, concepts: res.concepts, files: res.files_touched,
      at: new Date(NOW - ageOf.get(id)! * 86400000).toISOString(),
    });
    obsByDataset.set(id, obsId); datasetByObs.set(obsId, id);
  }
  const oldBase = NOW - OLD_AGE_DAYS * 86400000;
  for (const t of oldTurns) {
    const res = annotationToResult(t.annotation);
    const obsId = insert({
      session: 'gold-old', title: res.title, summary: res.summary, outcome: res.outcome,
      learned: res.learned, concepts: res.concepts, files: res.files_touched,
      at: new Date(oldBase + minute++ * 60_000).toISOString(),
    });
    obsByDataset.set(t.id, obsId); datasetByObs.set(obsId, t.id);
  }
  const startEn = NOW - SPREAD_DAYS * 86400000;
  const stepEn = (SPREAD_DAYS * 86400000) / (FILLER_EN_ROWS - 1);
  for (let i = 0; i < FILLER_EN_ROWS; i++) {
    const src = i % fillerEn.length;
    const copy = Math.floor(i / fillerEn.length);
    const f = fillerEn[src]!;
    insert({
      session: 'filler-en', title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
      summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts, files: f.files,
      at: new Date(startEn + Math.round(i * stepEn)).toISOString(),
    });
  }
  const startZh = NOW - SPREAD_DAYS * 86400000;
  const stepZh = (SPREAD_DAYS * 86400000) / (fillerZh.length - 1);
  for (let i = 0; i < fillerZh.length; i++) {
    const f = fillerZh[i]!;
    insert({
      session: 'filler-zh', title: f.title, summary: f.summary, outcome: f.outcome,
      learned: f.learned, concepts: f.concepts, files: f.files,
      at: new Date(startZh + Math.round(i * stepZh)).toISOString(),
    });
  }
  console.log(`[precheck] 播种完成（无向量）：${((Date.now() - t0) / 1000).toFixed(1)}s`);
} else {
  // 复用时重建 id 映射：按 session + 标题回查。
  for (const rec of records) {
    const res = annotationToResult(rec.annotation);
    const row = (raw.query('SELECT id FROM observations WHERE scope_key = ? AND title = ? LIMIT 1').all(SCOPE, res.title) as { id: number }[])[0];
    if (row) { obsByDataset.set(rec.id, row.id); datasetByObs.set(row.id, rec.id); }
  }
  for (const t of oldTurns) {
    const res = annotationToResult(t.annotation);
    const row = (raw.query('SELECT id FROM observations WHERE scope_key = ? AND title = ? LIMIT 1').all(SCOPE, res.title) as { id: number }[])[0];
    if (row) { obsByDataset.set(t.id, row.id); datasetByObs.set(row.id, t.id); }
  }
}

const rowCount = (raw.query('SELECT count(*) AS n FROM observations WHERE scope_key = ?').all(SCOPE) as { n: number }[])[0]!.n;
if (rowCount !== EXPECT_ROWS) die(`行数 ${rowCount} ≠ 期望 ${EXPECT_ROWS}`);

// --- 词面测量（全部走生产实现）------------------------------------------------
const dfCache = new Map<string, number>();
function unitDf(unit: string): number {
  const hit = dfCache.get(unit);
  if (hit !== undefined) return hit;
  const n = (raw.query(
    `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o ON fts.rowid = o.id
       WHERE observations_fts MATCH ? AND o.scope_key = ?`,
  ).all(`"${unit.replaceAll('"', '""')}"`, SCOPE) as { n: number }[])[0]!.n;
  dfCache.set(unit, n);
  return n;
}
/** 生产检索分支（含 LIKE 回退）。limit 放大只为判定"可达"，不改变分支选择。 */
const lexicalHits = (q: string, limit = 2000): number[] =>
  db.searchObservationsFts(q, { scopeKey: SCOPE, limit }).map((o) => o.id);
const substringRows = (s: string): number => (raw.query(
  `SELECT count(*) AS n FROM observations WHERE scope_key = ?
     AND (title LIKE ? OR summary LIKE ? OR outcome LIKE ? OR learned LIKE ?
          OR concepts_json LIKE ? OR files_touched_json LIKE ?)`,
).all(SCOPE, ...Array(6).fill(`%${s}%`)) as { n: number }[])[0]!.n;

/**
 * 机械产出可用替代 token 候选：从该 gold 的**可索引字段**里提取，并逐个实测 df。
 *
 * 只提三类，与保护线的类别对齐：路径（含斜杠或点号的串）、拉丁标识符（≥3 字符）、
 * 数字形态（含小数点 / 斜杠 / 百分号的数字串）。中文短语不在候选里——保护线的五类里
 * 只有历史状态类用中文问句，那一类不靠单 token 命中。
 */
function tokenCandidates(datasetId: string): { token: string; kind: string; df: number; unitDf: number }[] {
  const obsId = obsByDataset.get(datasetId);
  if (!obsId) return [];
  const row = (raw.query(
    `SELECT title, summary, outcome, learned, concepts_json, files_touched_json
       FROM observations WHERE id = ?`,
  ).all(obsId) as Record<string, string>[])[0];
  if (!row) return [];
  const text = Object.values(row).filter(Boolean).join('\n');
  const out = new Map<string, string>();
  for (const m of text.match(/[A-Za-z0-9_.\-\/]*[\/][A-Za-z0-9_.\-\/]+/g) ?? []) out.set(m.replace(/[",\[\]]/g, ''), 'path');
  for (const m of text.match(/[A-Za-z_][A-Za-z0-9_\-]{2,}/g) ?? []) if (!out.has(m)) out.set(m, 'identifier');
  for (const m of text.match(/[0-9]+(?:[.\/][0-9]+)+%?|[0-9]{4,}/g) ?? []) if (!out.has(m)) out.set(m, 'number');
  return [...out.entries()]
    .map(([token, kind]) => ({ token, kind, df: substringRows(token), unitDf: extractFtsSearchUnits(token).length ? Math.min(...extractFtsSearchUnits(token).map(unitDf)) : 0 }))
    .filter((c) => c.df >= 1)
    .sort((a, b) => a.df - b.df);
}

// --- Q1 / Q2：词面负例 --------------------------------------------------------
const negatives = queries.filter((q) => q.cohort === 'lexical-anchor');
const negRows = negatives.map((q) => {
  const units = extractFtsSearchUnits(q.query);
  const unitInfo = units.map((u) => ({ unit: u, df: unitDf(u) }));
  const anchor = q.lexical_anchor ?? '';
  /**
   * Q2：锚点必须是**命中的原因**（r4 §16.1，实现更正见 §16.1.1）。
   *
   * 判定是"单元与锚点**有重叠**且该单元 df ≥ 1"，而不是"单元包含锚点"——
   * 后者在锚点长于三字时恒假，因为单元就是三字窗。两个方向都要认：
   *   - `u ⊆ anchor`：四字以上锚点被切成若干三字窗，窗口落在锚点内部；
   *   - `anchor ⊆ u`：三字以内锚点被某个窗口覆盖。
   * 仅"锚点作为子串出现在语料里"不算（那是缺陷 1 的 7 条：子串在、单元不可达）。
   */
  const anchorUnits = anchor
    ? unitInfo.filter((u) => u.df >= 1 && (anchor.includes(u.unit) || u.unit.includes(anchor)))
    : [];
  const hits = units.length ? lexicalHits(q.query) : [];
  return {
    id: q.id, cls: q.lexical_negative_class, anchor,
    anchorLength: anchor.length,
    anchorSubstringRows: substringRows(anchor),
    anchorReachableUnits: anchorUnits.map((u) => `${u.unit}:${u.df}`),
    units: units.length, unitDfMax: unitInfo.reduce((m, u) => Math.max(m, u.df), 0),
    ftsCount: hits.length,
    q1: hits.length >= 1,
    q2: anchorUnits.length >= 1,
  };
});
const q1Fail = negRows.filter((r) => !r.q1);
const q2Fail = negRows.filter((r) => !r.q2);

// --- Q3 / Q4：保护线 ----------------------------------------------------------
const protections = queries.filter((q) => q.cohort === 'protection');
const protRows = protections.map((q) => {
  const units = extractFtsSearchUnits(q.query);
  const branch = units.length === 0 ? 'like' : 'fts';
  const expectedBranch = q.protection_class === 'short-query' ? 'like' : 'fts';
  const hits = lexicalHits(q.query);
  const goldIds = (q.primary_gold ?? []).map((g) => obsByDataset.get(g) ?? -1);
  const rank = goldIds.map((id) => hits.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const reachable = rank !== undefined;
  return {
    id: q.id, cls: q.protection_class, query: q.query,
    branch, expectedBranch, branchOk: branch === expectedBranch,
    units: units.length, ftsCount: hits.length,
    primary: q.primary_gold ?? [],
    primaryLexicalReachable: reachable,
    primaryLexicalRank: reachable ? rank! + 1 : null,
    ...(reachable ? {} : { candidates: (q.primary_gold ?? []).flatMap((g) => tokenCandidates(g).slice(0, 12).map((c) => ({ gold: g, ...c }))) }),
  };
});
const q3Fail = protRows.filter((r) => !r.primaryLexicalReachable || !r.branchOk);
const q4Fail = q3Fail; // Q4 与 Q3 同一判定源：不可达即空门（r4 §16.1）

// --- 输出 --------------------------------------------------------------------
/**
 * `--suggest`：为每条新记录机械产出**实测可用**的锚点材料。
 *
 * 存在的理由（裁定第 4 项 + r4 §17 末段）：缺陷 2 正是凭印象断言某个词在语料里。
 * 这里输出的每一个候选都带实测 df，且分成两类：
 *
 *  - **中文短语**（3–5 字）：`extractFtsSearchUnits` 会把它整段切成三字窗，
 *    只要短语在记录里逐字出现，窗口 df 必然 ≥ 1。这是词面负例锚点的唯一可靠形态；
 *  - **拉丁 / 路径 / 数字**：保护线的 token，必须来自**可索引字段**。
 *
 * 候选按 df 升序排（越低越有判别力），并标出它属于哪条记录。
 */
if (has('suggest')) {
  const zhPhrases = (obsId: number): { token: string; df: number }[] => {
    const row = (raw.query(
      `SELECT title, summary, outcome, learned, concepts_json FROM observations WHERE id = ?`,
    ).all(obsId) as Record<string, string>[])[0];
    if (!row) return [];
    const text = Object.values(row).filter(Boolean).join('\n');
    const seen = new Set<string>();
    const out: { token: string; df: number }[] = [];
    for (const run of text.match(/[\u4e00-\u9fff]{4,}/g) ?? []) {
      for (let len = 4; len <= 5; len++) {
        for (let i = 0; i + len <= run.length; i++) {
          const p = run.slice(i, i + len);
          if (seen.has(p)) continue;
          seen.add(p);
          const windows = extractFtsSearchUnits(p);
          if (!windows.length) continue;
          const minDf = Math.min(...windows.map(unitDf));
          if (minDf >= 1) out.push({ token: p, df: minDf });
        }
      }
    }
    return out.sort((a, b) => a.df - b.df).slice(0, 14);
  };
  const suggestions = records.map((r) => {
    const obsId = obsByDataset.get(r.id)!;
    return { id: r.id, title: annotationToResult(r.annotation).title, zh: zhPhrases(obsId), tokens: tokenCandidates(r.id).slice(0, 14) };
  });
  const p = arg('suggest-out') ?? '/tmp/fts-round-token-suggestions.json';
  writeFileSync(p, `${JSON.stringify(suggestions, null, 2)}\n`);
  console.log(`[precheck] token 建议 → ${p}`);
}

const gates = [
  { gate: 'Q1 负例词面命中 ≥1', total: negRows.length, fail: q1Fail.length, pass: q1Fail.length === 0, failedIds: q1Fail.map((r) => r.id) },
  { gate: 'Q2 锚点索引可达', total: negRows.length, fail: q2Fail.length, pass: q2Fail.length === 0, failedIds: q2Fail.map((r) => r.id) },
  { gate: 'Q3 保护线 gold 词面可达', total: protRows.length, fail: q3Fail.length, pass: q3Fail.length === 0, failedIds: q3Fail.map((r) => r.id) },
  { gate: 'Q4 基线非空门', total: protRows.length, fail: q4Fail.length, pass: q4Fail.length === 0, failedIds: q4Fail.map((r) => r.id) },
];

mkdirSync(REPORTS, { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify({
  purpose: '冻结前数据资格预检（判据 r4 §16 / §17）。纯文本投影，无向量、无 ACP。',
  round: 'fts-safety-round-2026-08-12-r2',
  generatedAt: new Date().toISOString(),
  criteria: 'benchmark/reports/fts-round/f1-criteria-r4.md',
  baselineCriteria: 'benchmark/reports/fts-round/f1-criteria.md',
  queriesFile: QUERIES_FILE,
  fixture: { dbPath: DB_PATH, rows: rowCount, layoutSeed: LAYOUT_SEED, vectors: 'none', acp: 'none' },
  gates,
  pass: gates.every((g) => g.pass),
  negatives: negRows,
  protections: protRows,
}, null, 2)}\n`);

console.log(`[precheck] 装置 ${rowCount} 行（纯文本投影）；query 集 ${QUERIES_FILE.split('/').pop()}`);
for (const g of gates) console.log(`  ${g.pass ? '✓' : '✗'} ${g.gate.padEnd(22)} 失败 ${g.fail}/${g.total}${g.fail ? `：${g.failedIds.join(' ')}` : ''}`);
console.log(`[precheck] → ${OUT_FILE}`);
db.close();
if (!gates.every((g) => g.pass)) process.exit(1);
