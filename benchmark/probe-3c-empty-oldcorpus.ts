/**
 * Phase 3C P6：老语料下的误召回读数。
 *
 * 判据：`benchmark/reports/phase3c-criteria.md` A0 `366ce756b0d6ebd0` §6.2 P6。
 *
 * 为什么必须单独跑这一条：现有 empty 集全部落在 90 天窗内（判据 §5.1），所以在那些装置上
 * 「放宽窗口」按构造不可能改变任何返回——N1–N5 的零差异证明了这一点，但那是**连续性**，
 * 不是"三年语料不会灌满空页"的正面证据。
 *
 * 这个探针把冻结的 empty / hard-negative query 跑在 50,000 条、跨 1,095 天、91.8% 落在旧窗
 * 之外的语料上。语料是合成 filler，与这些 query 全部无关，因此**任何返回都是误召回**，
 * 返回条数就是直接读数，不需要标注。
 *
 * 只读一个已存在的库（由 `run-pool-perf-recheck.ts --phase=seed --spread-days=1095` 建），
 * 不建库、不改库、不碰真实用户库。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import { MemoryDB, computeScopeKey } from '../src/db';
import { hybridSearchObservations, DEFAULT_RETRIEVAL_POLICY } from '../src/server/observation-search';
import { DATASET_DIR, loadAcpEnFixture } from './dataset';

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (m: string): never => { console.error(`[3c-p6] ✗ ${m}`); process.exit(1); };

const DB_PATH = arg('db') ?? die('必须指定 --db=');
/**
 * 对照臂。不传 = 生产默认（无界）；`--days=90` = 改动之前的窗口。
 *
 * 这个开关是归因的全部依据：同一个库、同一批 query、同一个策略，唯一自变量是时间窗。
 * 少了它就只能看到"老语料上返回了 N 条"，无法判断 N 是时间窗造成的还是语料本身就吵。
 */
const DAYS = arg('days') === undefined ? undefined : Number(arg('days'));
const CWD = '/pool-recheck/primary';
const SCOPE = computeScopeKey(CWD, CWD);

interface Query { id: string; kind: string; query: string; scope?: string }
const load = (f: string): Query[] => {
  const raw = JSON.parse(readFileSync(join(DATASET_DIR, f), 'utf-8'));
  return Array.isArray(raw) ? raw : raw.queries;
};
// 英文派生值只从一个入口取：harness 用的就是这个合并结果，手挑文件会挑错（实测挑错过一次，
// expected-empty 的 q19–q24 在 `-empty.json` 里，不在主文件里）。
const EN = loadAcpEnFixture(DATASET_DIR, { withValidation: true, withPhase2: true, withR2: true }).queries;

// 三个冻结 empty 集，逐集分开报告——它们的历史门槛不同，混成一个平均值会掩盖单集越界。
const SETS: { name: string; queries: Query[] }[] = [
  {
    name: 'expected-empty（既有 5 条）',
    queries: load('queries.json').filter((q) => q.kind === 'empty'),
  },
  {
    name: 'phase2 empty（49 条）',
    queries: load('queries-phase2.json').filter((q) => q.kind === 'empty'),
  },
  {
    name: 'empty-ext（32 条 hard negative）',
    queries: load('queries-empty-ext.json').filter((q) => q.kind === 'empty'),
  },
];

const db = new MemoryDB(DB_PATH);
const results: unknown[] = [];

for (const set of SETS) {
  const rows: { id: string; returned: number; semanticOnly: number; hasEn: boolean }[] = [];
  for (const q of set.queries) {
    const en = EN[q.id];
    const res = await hybridSearchObservations(
      db,
      q.query,
      {
        scopeKey: SCOPE, limit: 10,
        ...(en ? { semanticQueryEn: en } : {}),
        ...(DAYS === undefined ? {} : { days: DAYS }),
      },
      { policy: { ...DEFAULT_RETRIEVAL_POLICY } },
    );
    rows.push({
      id: q.id,
      returned: res.length,
      semanticOnly: res.filter((r) => r.match_source === 'semantic').length,
      hasEn: Boolean(en),
    });
  }
  const returned = rows.map((r) => r.returned);
  const semOnly = rows.map((r) => r.semanticOnly);
  const mean = returned.reduce((a, b) => a + b, 0) / (returned.length || 1);
  const row = {
    set: set.name,
    queries: rows.length,
    withEnglishForm: rows.filter((r) => r.hasEn).length,
    returnedMean: Math.round(mean * 1000) / 1000,
    returnedWorst: Math.max(0, ...returned),
    semanticOnlyMean: Math.round((semOnly.reduce((a, b) => a + b, 0) / (semOnly.length || 1)) * 1000) / 1000,
    semanticOnlyMax: Math.max(0, ...semOnly),
    perQuery: rows,
  };
  results.push(row);
  console.log(
    `[3c-p6] ${row.set}: 返回 均 ${row.returnedMean} / 坏 ${row.returnedWorst} | ` +
      `semantic-only 均 ${row.semanticOnlyMean} / 最大 ${row.semanticOnlyMax} | 英文形式 ${row.withEnglishForm}/${row.queries}`,
  );
}

// 语料形状：让报告能自证这批 query 确实跑在"绝大多数记录在旧窗之外"的语料上。
const raw = (db as unknown as { db: { query: (s: string) => { get: (...a: unknown[]) => unknown } } }).db;
const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
const shape = raw.query(
  `SELECT COUNT(*) AS total, MIN(turn_stopped_at) AS oldest, MAX(turn_stopped_at) AS newest,
          SUM(CASE WHEN turn_stopped_at <= ? THEN 1 ELSE 0 END) AS outside90
     FROM observations WHERE scope_key = ?`,
).get(cutoff, SCOPE) as { total: number; oldest: string; newest: string; outside90: number };
db.close();

const out = {
  generatedAt: new Date().toISOString(),
  provenance: {
    criteria: 'benchmark/reports/phase3c-criteria.md §6.2 P6',
    criteriaSha256: '366ce756b0d6ebd0',
    harnessSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    dbPath: DB_PATH,
    days: DAYS === undefined ? 'unbounded（生产默认，Phase 3C 之后）' : DAYS,
    policy: { ...DEFAULT_RETRIEVAL_POLICY },
    corpus: {
      ...shape,
      spanDays: Math.round((Date.parse(shape.newest) - Date.parse(shape.oldest)) / 86400000),
      outsideOld90dWindowPct: Math.round((shape.outside90 / shape.total) * 1000) / 10,
    },
  },
  note:
    '语料是与全部 query 无关的合成 filler，因此任何返回都是误召回；返回条数即读数，无需标注。',
  results,
};
const jsonPath = arg('json') ?? 'benchmark/reports/phase3c/p6-oldcorpus-empty.json';
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `[3c-p6] 语料：${shape.total} 条，跨度 ${out.provenance.corpus.spanDays} 天，` +
    `旧窗外 ${shape.outside90} (${out.provenance.corpus.outsideOld90dWindowPct}%)`,
);
console.log(`[3c-p6] 报告：${jsonPath}`);
