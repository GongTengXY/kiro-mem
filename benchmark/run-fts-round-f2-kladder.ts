#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F2 第三段：S7a 的 K 阶梯选定**（判据 r3 §2.2.1、§7 S7a）。
 *
 * 判定只用**正确性**，不看任何门：
 *
 *   阶梯 [200, 1000, 5000, EXACT]，取**最小**的 K，使得在
 *   16 个 (r, d) 设置 × 全部 120 条 query 上，形状 C 的候选与 EXACT 的候选
 *   **逐 query 差集为 0**。
 *
 * `EXACT` 的差集恒为 0（它就是 K = ∞ 的语义），所以阶梯不会走空；代价是成本，
 * 由 §6.6 的性能资格门在 F3 判定。
 *
 * 这一步是**前置门**：不通过不得进入 F3（r3 §8 的 P0）。它把 r1 的那个未受控第三变量
 * （近似语义）变成结构性消除——要么某个有限 K 与精确语义逐条相同，要么就用精确实现。
 *
 * 另外报三件 F3 会用到的读数：`r = 0` 的恒等性（S6 的锚点）、页面缩水、
 * 以及精确单元豁免命中数（判据 §5.4）。
 *
 * 用法：
 *   bun run benchmark/run-fts-round-f2-kladder.ts --db=$TMPDIR/fts-round-f2-r2.db
 *   bun run benchmark/run-fts-round-f2-kladder.ts --db=... --arms=r0-d1.00,r0.2-d0.10   # 冒烟
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { verifyFreezeRecordFile } from './freeze-util';
import {
  ALL_ARMS, BASELINE_ARM, legExact, legShapeC, type AdmissionContext, type AdmissionPolicy,
} from './fts-round-admission';

const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const DATASET = join(import.meta.dir, 'dataset');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (m: string): never => { console.error(`[k-ladder] ✗ ${m}`); process.exit(1); };
const r2n = (x: number): number => Number(x.toFixed(2));

const SUFFIX = arg('suffix') ?? '-r2';
const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', `fts-round-f2${SUFFIX}.db`);
const LADDER: (number | 'EXACT')[] = [200, 1000, 5000, 'EXACT'];
const PAGE_LIMIT = 50; // FTS 腿返回给内核的条数（V4，冻结不动）

// --- S1 --------------------------------------------------------------------
const v = verifyFreezeRecordFile(join(REPORTS, `f1-freeze${SUFFIX}.json`));
console.log(`[k-ladder] S1 冻结校验：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) die('冻结物已漂移');

if (!existsSync(DB_PATH)) die(`装置不存在：${DB_PATH}（先跑 run-fts-round-f2-fixture.ts）`);
const db = new MemoryDB(DB_PATH);
const raw = (db as unknown as { db: any }).db;
const CWD = '/fts-round/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const scopeSize = (raw.query('SELECT count(*) AS n FROM observations WHERE scope_key = ?').all(SCOPE) as { n: number }[])[0]!.n;
if (scopeSize !== 60_066) die(`装置行数 ${scopeSize} ≠ 60066`);

const queries = read(join(DATASET, `queries-fts-round${SUFFIX}.json`)).queries as { id: string; cohort: string; query: string }[];
const armFilter = (arg('arms') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const arms = armFilter.length ? ALL_ARMS.filter((a) => armFilter.includes(a.id)) : ALL_ARMS;

const ctx: AdmissionContext = { raw, scopeKey: SCOPE, scopeSize, dfCache: new Map() };
const unitsOf = new Map(queries.map((q) => [q.id, extractFtsSearchUnits(q.query)]));
const same = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

// --- 逐 K 逐 arm 逐 query 比对 ------------------------------------------------
interface KResult {
  k: number | 'EXACT';
  comparisons: number;
  mismatches: { arm: string; query: string; shapeC: number; exact: number; missing: number; extra: number }[];
  pass: boolean;
  wallMs: number;
}
const results: KResult[] = [];
/** EXACT 的返回按 (arm, query) 缓存：阶梯每一档都要和它比，重算是纯浪费。 */
const exactCache = new Map<string, number[]>();
const exactMeta = new Map<string, { branch: string; candidates: number; W: number; required: number; dropped: number; exempt: number }>();

for (const arm of arms) {
  for (const q of queries) {
    const key = `${arm.id}|${q.id}`;
    const r = legExact(ctx, db, q.query, unitsOf.get(q.id)!, arm.policy, PAGE_LIMIT);
    exactCache.set(key, r.ids);
    exactMeta.set(key, {
      branch: r.branch, candidates: r.candidates, W: r.units.W, required: r.units.required,
      dropped: r.units.dropped.length, exempt: r.exemptHits,
    });
  }
}
console.log(`[k-ladder] EXACT 基准完成：${arms.length} arm × ${queries.length} query`);

let selected: number | 'EXACT' | null = null;
for (const k of LADDER) {
  if (k === 'EXACT') {
    results.push({ k, comparisons: arms.length * queries.length, mismatches: [], pass: true, wallMs: 0 });
    if (selected === null) selected = 'EXACT';
    break;
  }
  const t0 = Date.now();
  const mismatches: KResult['mismatches'] = [];
  for (const arm of arms) {
    for (const q of queries) {
      const c = legShapeC(ctx, db, q.query, unitsOf.get(q.id)!, arm.policy, k, PAGE_LIMIT);
      const e = exactCache.get(`${arm.id}|${q.id}`)!;
      if (!same(c.ids, e)) {
        const cs = new Set(c.ids);
        const es = new Set(e);
        mismatches.push({
          arm: arm.id, query: q.id, shapeC: c.ids.length, exact: e.length,
          missing: e.filter((x) => !cs.has(x)).length,
          extra: c.ids.filter((x) => !es.has(x)).length,
        });
      }
    }
  }
  const res: KResult = { k, comparisons: arms.length * queries.length, mismatches, pass: mismatches.length === 0, wallMs: Date.now() - t0 };
  results.push(res);
  console.log(`[k-ladder] K=${k}：比对 ${res.comparisons} 组，差异 ${mismatches.length} 组，${(res.wallMs / 1000).toFixed(1)}s${res.pass ? ' ✓' : ''}`);
  if (res.pass) { selected = k; break; }
}
if (selected === null) die('阶梯走空——不可能发生（EXACT 由构造通过）');

// --- 附带读数：恒等锚点 / 页面缩水 / 豁免命中 ---------------------------------
const baseline = arms.find((a) => a.id === BASELINE_ARM);
let identity: { checked: number; mismatches: string[] } | null = null;
if (baseline) {
  const mism: string[] = [];
  for (const q of queries) {
    const prod = db.searchObservationsFts(q.query, { scopeKey: SCOPE, limit: PAGE_LIMIT }).map((o) => o.id);
    const got = exactCache.get(`${BASELINE_ARM}|${q.id}`)!;
    if (!same(prod, got)) mism.push(q.id);
  }
  identity = { checked: queries.length, mismatches: mism };
  console.log(`[k-ladder] S6 恒等锚点（${BASELINE_ARM} vs 生产）：${mism.length === 0 ? '✓ 120/120 一致' : `✗ ${mism.length} 条不一致：${mism.slice(0, 8).join(' ')}`}`);
}

const perArm = arms.map((a) => {
  const rows = queries.map((q) => ({ q: q.id, ...exactMeta.get(`${a.id}|${q.id}`)!, returned: exactCache.get(`${a.id}|${q.id}`)!.length }));
  const fts = rows.filter((r) => r.branch === 'fts');
  return {
    arm: a.id, policy: a.policy,
    emptyBranch: rows.filter((r) => r.branch === 'empty').length,
    likeBranch: rows.filter((r) => r.branch === 'like').length,
    shrunkPages: fts.filter((r) => r.returned < Math.min(PAGE_LIMIT, r.candidates)).length,
    zeroReturn: rows.filter((r) => r.returned === 0).length,
    exemptTotal: rows.reduce((s, r) => s + r.exempt, 0),
    droppedUnitsTotal: rows.reduce((s, r) => s + r.dropped, 0),
    returnedMean: r2n(rows.reduce((s, r) => s + r.returned, 0) / rows.length),
  };
});

mkdirSync(REPORTS, { recursive: true });
const outPath = join(REPORTS, `f2-kladder${SUFFIX}.json`);
writeFileSync(outPath, `${JSON.stringify({
  purpose: 'F2 第三段：S7a 的 K 阶梯选定（判据 r3 §2.2.1、§7 S7a）。判定只用正确性，不看任何门。',
  round: 'fts-safety-round-2026-08-12-r2',
  generatedAt: new Date().toISOString(),
  freeze: { path: join(REPORTS, `f1-freeze${SUFFIX}.json`), verify: v.label },
  fixture: { dbPath: DB_PATH, scopeSize },
  ladder: LADDER,
  pageLimit: PAGE_LIMIT,
  arms: arms.map((a) => a.id),
  queries: queries.length,
  results,
  selectedK: selected,
  s7aPass: true,
  s6Identity: identity,
  perArm,
  boundaries: {
    exactByConstruction: 'EXACT 的差集恒为 0，因此阶梯不会走空；它的成本由 §6.6 的性能门在 F3 判定。',
    attribution: '形状 C 用 instr 归因，EXACT 用 FTS MATCH 归因；两者在 F1 实现探针的 139 条 query 上逐条一致。',
    notAGate: '本段不产出任何 G1–G4 读数；perArm 只是准入机制自身的读数（判据 §5.4）。',
  },
}, null, 2)}\n`);

console.log(`[k-ladder] 选定 K = ${selected}`);
console.log(`[k-ladder] → ${outPath}`);
db.close();
