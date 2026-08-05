/**
 * L1160 修法候选对比。判据 `fix-fts-limit-criteria.md` §4 登记的 A/B/C/D + 组合。
 *
 * 每个候选都要回答三件事，缺一件就不能进选择：
 *   1. 计划变了没有（EXPLAIN QUERY PLAN）
 *   2. 耗时（预热后取中位数）
 *   3. **返回结果是否与当前生产逐条相同**——不只是行集合，是有序的行序列
 *
 * 第 3 件事因为一个实测发现变得关键：当前生产形式（`LIMIT ?`）与字面量形式返回**相同的行**，
 * 但在 bm25 rank 精确平局处顺序不同（实测 8 个平局组 / 20 行）。SQLite 不保证平局顺序，
 * 而这个顺序会变成喂给 RRF 的 ftsRank。所以"改计划"天然带有"扰动平局顺序"的风险，
 * 每个候选都必须把这件事测出来，并区分「行集合变了」（严重）与「只有平局顺序变了」（另一类问题）。
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const DATASET_DIR = join(import.meta.dir, 'dataset');
const REPORTS_DIR = join(import.meta.dir, 'reports');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

let tmpDir: string | null = null;
const die = (msg: string, err?: unknown): never => {
  console.error(`[cand] ✗ ${msg}`);
  if (err) console.error(err);
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
};

const metaRaw = readFileSync(join(DATASET_DIR, 'phase3b-fixture-meta.json'), 'utf-8');
const meta = JSON.parse(metaRaw) as { frozen?: boolean; recallScale?: { filler?: { sha256?: string } } };
const fillerRaw = readFileSync(join(DATASET_DIR, 'phase3b-filler.json'), 'utf-8');
if (!meta.frozen || sha16(fillerRaw) !== meta.recallScale?.filler?.sha256) die('3B 装置未冻结或 checksum 不匹配');
interface Filler {
  title: string; summary: string; outcome: string; learned: string;
  concepts: string[]; files: string[];
}
const filler = JSON.parse(fillerRaw) as Filler[];

const { MemoryDB, computeScopeKey, extractFtsSearchUnits } = await import('../src/db');
const { Database } = await import('bun:sqlite');

tmpDir = mkdtempSync(join(tmpdir(), 'kiro-cand-'));
const dbPath = join(tmpDir, 'c.db');
const db = new MemoryDB(dbPath);

const CWD = '/proj/kiro-mem';
db.upsertSessionRef({ session_id: 's', cwd: CWD, repo: CWD });
const BASE = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - 30 * 86400000;
for (const [i, f] of filler.entries()) {
  const seq = db.allocateNextTurnSeq('s');
  const turn = db.createTurn({ session_id: 's', seq, cwd: CWD, repo: CWD, prompt_text: f.title });
  const ts = new Date(BASE + i * 60_000).toISOString();
  db.markTurnClosed(turn.id, ts);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: 's', turn_seq: seq, repo: CWD, cwd_scope: CWD,
    title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned,
    memory_type: 'change', files_touched: f.files, concepts: f.concepts,
    quality: 'normal', turn_started_at: ts, turn_stopped_at: ts,
  });
  if (id == null) die(`播种失败 at ${i}`);
}
console.log(`[cand] 播种 ${filler.length} 条（3B 冻结语料）`);

const SCOPE = computeScopeKey(CWD, CWD);
const THR = new Date(Date.now() - 90 * 86400000).toISOString();
const LIMIT = 50;

/** 多条 query，避免单条 query 的平局分布决定结论。 */
const QUERIES = [
  '当前安装流程里 Worker 是不是在运行中就被替换了',
  '压缩失败之后会不会写出一条编造的记忆',
  'FTS 检索为什么一条都召回不到',
  '跨 workspace 的记忆会不会串到一起',
  'token 认证是怎么做的',
];

const raw = new Database(dbPath, { readonly: true });
const exprOf = (q: string): string =>
  extractFtsSearchUnits(q.trim()).map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');

interface Candidate {
  key: string;
  label: string;
  /** `%EXPR%` / `%THR%` / `%SCOPE%` / `%LIMIT%` 占位。 */
  sql: string;
  /** limit 是否作为绑定参数传（false = 已内联为字面量）。 */
  limitAsParam: boolean;
  /** 需要先跑 ANALYZE。 */
  needsAnalyze?: boolean;
  /** 预登记为诊断项，不参与选择。 */
  diagnostic?: boolean;
  note?: string;
}

const JOIN_BODY = `FROM observations_fts fts
      JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ?
        AND o.scope_key = ?
      ORDER BY fts.rank`;

const candidates: Candidate[] = [
  {
    key: 'current', label: '当前生产形式（LIMIT ? 绑定参数）',
    sql: `SELECT o.* ${JOIN_BODY} LIMIT ?`, limitAsParam: true,
  },
  {
    key: 'A-literal', label: 'A 整数校验后内联为字面量',
    sql: `SELECT o.* ${JOIN_BODY} LIMIT ${LIMIT}`, limitAsParam: false,
  },
  {
    key: 'B-crossjoin', label: 'B CROSS JOIN 固定连接顺序（limit 仍为参数）',
    sql: `SELECT o.* FROM observations_fts fts
      CROSS JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ?
        AND o.scope_key = ?
      ORDER BY fts.rank LIMIT ?`,
    limitAsParam: true,
  },
  {
    key: 'C-subquery', label: 'C 子查询先取 FTS rowid 再 join（limit 在过滤之前）',
    sql: `SELECT o.* FROM (
        SELECT rowid AS rid, rank FROM observations_fts
         WHERE observations_fts MATCH ? ORDER BY rank LIMIT ?
      ) f JOIN observations o ON o.id = f.rid
      WHERE o.turn_stopped_at = o.turn_stopped_at AND o.scope_key = ?
      ORDER BY f.rank`,
    limitAsParam: false,   // limit 位置不同，单独处理
    note: 'limit 在 scope/days 过滤之前生效——预期会少召回，判据 §4 要求专门验证',
  },
  {
    key: 'D-analyze', label: 'D ANALYZE 后保持原 SQL',
    sql: `SELECT o.* ${JOIN_BODY} LIMIT ?`, limitAsParam: true, needsAnalyze: true,
  },
  {
    key: 'BD-combo', label: 'B + D 组合',
    sql: `SELECT o.* FROM observations_fts fts
      CROSS JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ?
        AND o.scope_key = ?
      ORDER BY fts.rank LIMIT ?`,
    limitAsParam: true, needsAnalyze: true,
  },
  {
    key: 'diag-tiebreak', label: '诊断：字面量 + 显式平局序 (rank, o.id)',
    sql: `SELECT o.* FROM observations_fts fts
      JOIN observations o ON fts.rowid = o.id
      WHERE observations_fts MATCH ? AND o.turn_stopped_at > ?
        AND o.scope_key = ?
      ORDER BY fts.rank, o.id LIMIT ${LIMIT}`,
    limitAsParam: false, diagnostic: true,
    note: '本身会改变当前平局顺序，只用于刻画平局问题，不参与选择',
  },
];

const REPEAT = 5;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.floor(s.length / 2)] ?? 0) * 1000) / 1000;
};

let analyzed = false;
const ensureAnalyze = (): void => {
  if (analyzed) return;
  const w = new Database(dbPath);
  w.exec('ANALYZE');
  w.close();
  analyzed = true;
  console.log('[cand] 已执行 ANALYZE（sqlite_stat1 建立）');
};

interface Result {
  key: string;
  label: string;
  diagnostic: boolean;
  msMedian: number;
  plan: string[];
  /** 与 current 的对比，逐 query。 */
  perQuery: {
    query: string;
    rows: number;
    sameSet: boolean;
    sameOrder: boolean;
    tieConfined: boolean | null;
  }[];
  allSameSet: boolean;
  allSameOrder: boolean;
  allTieConfined: boolean;
  note?: string;
}

/** 取一个候选在一条 query 上的 (id, rank) 序列。 */
function run(c: Candidate, q: string): { ids: number[]; ranks: number[] } {
  const expr = exprOf(q);
  const sel = c.sql.replace('SELECT o.*', 'SELECT o.id AS __id, fts.rank AS __rank')
    .replace('SELECT o.* FROM (', 'SELECT o.id AS __id, f.rank AS __rank FROM (');
  // C 的投影不同，单独处理
  const sql = c.key === 'C-subquery'
    ? c.sql.replace('SELECT o.*', 'SELECT o.id AS __id, f.rank AS __rank')
    : sel;
  const params: unknown[] =
    c.key === 'C-subquery'
      ? [expr, LIMIT, SCOPE]
      : c.limitAsParam
        ? [expr, THR, SCOPE, LIMIT]
        : [expr, THR, SCOPE];
  const rows = raw.query(sql).all(...(params as never[])) as { __id: number; __rank: number }[];
  return { ids: rows.map((r) => r.__id), ranks: rows.map((r) => r.__rank) };
}

const baseline = new Map<string, { ids: number[]; ranks: number[] }>();
const results: Result[] = [];

for (const c of candidates) {
  if (c.needsAnalyze) ensureAnalyze();

  const expr0 = exprOf(QUERIES[0]!);
  const timedSql = c.sql;
  const timedParams: unknown[] =
    c.key === 'C-subquery' ? [expr0, LIMIT, SCOPE]
      : c.limitAsParam ? [expr0, THR, SCOPE, LIMIT] : [expr0, THR, SCOPE];
  const stmt = raw.query(timedSql);
  stmt.all(...(timedParams as never[]));
  const samples: number[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const t = performance.now();
    stmt.all(...(timedParams as never[]));
    samples.push(performance.now() - t);
  }
  const plan = (raw.query(`EXPLAIN QUERY PLAN ${timedSql}`).all(...(timedParams as never[])) as { detail: string }[])
    .map((r) => r.detail);

  const perQuery: Result['perQuery'] = [];
  for (const q of QUERIES) {
    const got = run(c, q);
    if (c.key === 'current') {
      baseline.set(q, got);
      perQuery.push({ query: q, rows: got.ids.length, sameSet: true, sameOrder: true, tieConfined: null });
      continue;
    }
    const base = baseline.get(q)!;
    const sameSet =
      base.ids.length === got.ids.length &&
      new Set(base.ids).size === new Set([...base.ids, ...got.ids]).size;
    const sameOrder = base.ids.length === got.ids.length && base.ids.every((v, i) => v === got.ids[i]);
    // 差异是否只落在 rank 平局上：按 (rank, id) 归一化后是否相同。
    const norm = (r: { ids: number[]; ranks: number[] }): string =>
      r.ids.map((id, i) => ({ id, rank: r.ranks[i]! }))
        .sort((a, b) => a.rank - b.rank || a.id - b.id).map((x) => x.id).join(',');
    perQuery.push({
      query: q, rows: got.ids.length, sameSet, sameOrder,
      tieConfined: sameOrder ? true : norm(base) === norm(got),
    });
  }

  const r: Result = {
    key: c.key, label: c.label, diagnostic: c.diagnostic ?? false,
    msMedian: median(samples), plan, perQuery,
    allSameSet: perQuery.every((p) => p.sameSet),
    allSameOrder: perQuery.every((p) => p.sameOrder),
    allTieConfined: perQuery.every((p) => p.tieConfined !== false),
    ...(c.note ? { note: c.note } : {}),
  };
  results.push(r);

  console.log(
    `${c.key.padEnd(14)} ${String(r.msMedian).padStart(10)}ms  ` +
      `行集合${r.allSameSet ? '同' : '异'} 顺序${r.allSameOrder ? '同' : '异'} ` +
      `${r.allSameOrder ? '' : r.allTieConfined ? '(差异仅平局)' : '(差异超出平局!)'} ` +
      `${r.diagnostic ? '[诊断]' : ''}`,
  );
  console.log(`  plan: ${plan.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 判据 §4 选择规则，机械执行
// ---------------------------------------------------------------------------

const cur = results.find((r) => r.key === 'current')!;
const eligible = results.filter((r) => !r.diagnostic && r.key !== 'current');
const semanticsOk = eligible.filter((r) => r.allSameSet);
const excluded = eligible.filter((r) => !r.allSameSet);

console.log('\n=== 选择（判据 §4）===');
for (const r of excluded) console.log(`  排除 ${r.key}：改变了行集合`);
const best = [...semanticsOk].sort((a, b) => a.msMedian - b.msMedian)[0];
const within2x = semanticsOk.filter((r) => best && r.msMedian <= best.msMedian * 2);
console.log(`  语义不变的候选：${semanticsOk.map((r) => r.key).join(', ') || '（无）'}`);
console.log(`  最快：${best?.key ?? '—'}（${best?.msMedian}ms）`);
console.log(`  2 倍内并列：${within2x.map((r) => r.key).join(', ')}`);
console.log(`  当前生产：${cur.msMedian}ms`);

writeFileSync(
  join(REPORTS_DIR, 'fix-fts-limit-candidates.json'),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      provenance: {
        criteria: 'benchmark/reports/fix-fts-limit-criteria.md',
        criteriaSha256: sha16(readFileSync(join(REPORTS_DIR, 'fix-fts-limit-criteria.md'), 'utf-8')),
        fillerSha256: sha16(fillerRaw),
        scriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
        bun: Bun.version,
        seededRecords: filler.length,
        queries: QUERIES.length,
        repeatPerMeasurement: REPEAT,
        limit: LIMIT,
      },
      results,
    },
    null,
    2,
  )}\n`,
);
console.log('\n[cand] 报告：benchmark/reports/fix-fts-limit-candidates.json');

raw.close();
db.close();
rmSync(tmpDir, { recursive: true, force: true });
tmpDir = null;
