/**
 * 时间窗双臂审计：同一个库上跑 `days=90` 与默认无界，产出**逐页差异**。
 *
 * 存在的理由（裁定认定的证据缺口）：`benchmark/probe-3c-empty-oldcorpus.ts` 只记录
 * `returned` 与 `semanticOnly` 两个**计数**，于是"总返回不变但页面被替换"这件事看不见。
 * 实测有 7 条 query 落在这个形状里（q21 / q23 / f02 / f07 / n08 / n27 / n29，后者还是反方向），
 * 所以"净贡献 ≈ 0"不足以证明安全。
 *
 * 本脚本是**纯仪表**，按裁定的边界执行：
 *   - 不修改输入：三个 empty 集与它们的英文派生值按冻结状态读取，一个字不改；
 *   - 不修改判据、不修改任何冻结时间与 checksum；
 *   - 不做通过 / 不通过判定：只出读数，裁定由 Codex 作。
 *
 * 记录的四项（裁定指定）：有序 `resultIds`、逐项 `match_source`、逐项 semantic score、
 * 页面新增 / 被挤出。外加一项归因用的读数：**每条新增记录的年龄**——它直接回答
 * "无界窗口引入的到底是不是旧记录"。
 *
 * 语料是与全部 query 无关的合成 filler，因此**任何返回都是误召回**，无需标注。
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
const die = (m: string): never => { console.error(`[tw-audit] ✗ ${m}`); process.exit(1); };

const DB_PATH = arg('db') ?? die('必须指定 --db=（由 run-pool-perf-recheck.ts --phase=seed --spread-days=1095 建）');
const CWD = '/pool-recheck/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const LIMIT = 10;
/** 对照臂的窗口。90 = 改动之前的默认；无界 = 现在的默认。 */
const CONTROL_DAYS = 90;

interface Query { id: string; kind: string; query: string }
const load = (f: string): Query[] => {
  const raw = JSON.parse(readFileSync(join(DATASET_DIR, f), 'utf-8'));
  return Array.isArray(raw) ? raw : raw.queries;
};
const EN = loadAcpEnFixture(DATASET_DIR, { withValidation: true, withPhase2: true, withR2: true }).queries;

const SETS: { name: string; file: string; queries: Query[] }[] = [
  { name: 'expected-empty', file: 'queries.json', queries: load('queries.json').filter((q) => q.kind === 'empty') },
  { name: 'phase2-empty', file: 'queries-phase2.json', queries: load('queries-phase2.json').filter((q) => q.kind === 'empty') },
  { name: 'empty-ext', file: 'queries-empty-ext.json', queries: load('queries-empty-ext.json').filter((q) => q.kind === 'empty') },
];

const db = new MemoryDB(DB_PATH);

// 记录年龄：归因用。SQL 只读，一次取全，避免逐条查询。
const raw = (db as unknown as { db: { query: (s: string) => { all: (...a: unknown[]) => unknown } } }).db;
const ageRows = raw
  .query(`SELECT id, turn_stopped_at FROM observations WHERE scope_key = ?`)
  .all(SCOPE) as { id: number; turn_stopped_at: string }[];
const ageDays = new Map<number, number>();
for (const r of ageRows) {
  ageDays.set(r.id, Math.round((Date.now() - Date.parse(r.turn_stopped_at)) / 86400000));
}
const outsideControl = (id: number): boolean => (ageDays.get(id) ?? 0) > CONTROL_DAYS;

interface Page {
  id: string;
  set: string;
  hasEn: boolean;
  resultIds: number[];
  sources: string[];
  semanticScores: (number | null)[];
  /** 逐项 FTS 名次与语义名次。没有它无法判断页面替换是"更好的词面匹配此前被窗口挡住"
   *  还是"候选面扩大后平局次序漂移"——两者的产品含义完全不同。 */
  ftsRanks: (number | null)[];
  semanticRanks: (number | null)[];
  returned: number;
  semanticOnly: number;
  comparableVectors: number;
  aboveFloorCount: number;
  protocol: string;
  degraded: boolean;
}

async function runArm(days: number | undefined): Promise<Page[]> {
  const pages: Page[] = [];
  for (const set of SETS) {
    for (const q of set.queries) {
      const en = EN[q.id];
      let comparableVectors = -1;
      let aboveFloorCount = -1;
      let protocol = '?';
      let degraded = false;
      let ftsRank: ReadonlyMap<number, number> = new Map();
      let semanticRankMap: ReadonlyMap<number, number> = new Map();
      const results = await hybridSearchObservations(
        db,
        q.query,
        {
          scopeKey: SCOPE, limit: LIMIT,
          ...(en ? { semanticQueryEn: en } : {}),
          ...(days === undefined ? {} : { days }),
        },
        {
          policy: { ...DEFAULT_RETRIEVAL_POLICY },
          onCandidates: (i) => {
            comparableVectors = i.comparableVectors;
            aboveFloorCount = i.aboveFloorCount;
            protocol = i.protocol;
            ftsRank = i.ftsRank;
            semanticRankMap = i.semanticRank;
          },
          onDegrade: () => { degraded = true; },
        },
      );
      pages.push({
        id: q.id,
        set: set.name,
        hasEn: Boolean(en),
        resultIds: results.map((r) => r.id),
        sources: results.map((r) => r.match_source),
        semanticScores: results.map((r) => r.semantic_score ?? null),
        ftsRanks: results.map((r) => ftsRank.get(r.id) ?? null),
        semanticRanks: results.map((r) => semanticRankMap.get(r.id) ?? null),
        returned: results.length,
        semanticOnly: results.filter((r) => r.match_source === 'semantic').length,
        comparableVectors,
        aboveFloorCount,
        protocol,
        degraded,
      });
    }
  }
  return pages;
}

const control = await runArm(CONTROL_DAYS);
const unbounded = await runArm(undefined);

const byId = (ps: Page[]) => new Map(ps.map((p) => [p.id, p]));
const c = byId(control);

interface PageItem {
  id: number;
  source: string;
  score: number | null;
  ftsRank: number | null;
  semanticRank: number | null;
  ageDays: number;
}

interface Diff {
  id: string;
  set: string;
  hasEnglishForm: boolean;
  pageIdentical: boolean;
  returned: [number, number];
  semanticOnly: [number, number];
  comparableVectors: [number, number];
  /** 有序页面，逐项带来源与 semantic score。 */
  controlPage: PageItem[];
  unboundedPage: PageItem[];
  /** 无界臂新增（days=90 页面里没有）。 */
  added: (PageItem & { position: number; outsideControlWindow: boolean })[];
  /** 被挤出（days=90 页面里有、无界臂没有）。 */
  displaced: (PageItem & { position: number })[];
  /** 两臂都在、但位置变了。 */
  moved: { id: number; from: number; to: number }[];
}

const diffs: Diff[] = [];
for (const u of unbounded) {
  const b = c.get(u.id)!;
  const render = (p: Page): PageItem[] => p.resultIds.map((id, i) => ({
    id, source: p.sources[i]!, score: p.semanticScores[i]!,
    ftsRank: p.ftsRanks[i]!, semanticRank: p.semanticRanks[i]!,
    ageDays: ageDays.get(id) ?? -1,
  }));
  const bSet = new Set(b.resultIds);
  const uSet = new Set(u.resultIds);
  diffs.push({
    id: u.id,
    set: u.set,
    hasEnglishForm: u.hasEn,
    pageIdentical: JSON.stringify(b.resultIds) === JSON.stringify(u.resultIds)
      && JSON.stringify(b.sources) === JSON.stringify(u.sources),
    returned: [b.returned, u.returned],
    semanticOnly: [b.semanticOnly, u.semanticOnly],
    comparableVectors: [b.comparableVectors, u.comparableVectors],
    controlPage: render(b),
    unboundedPage: render(u),
    added: u.resultIds.flatMap((id, i) => bSet.has(id) ? [] : [{
      id, source: u.sources[i]!, score: u.semanticScores[i]!,
      ftsRank: u.ftsRanks[i]!, semanticRank: u.semanticRanks[i]!,
      ageDays: ageDays.get(id) ?? -1, position: i + 1, outsideControlWindow: outsideControl(id),
    }]),
    displaced: b.resultIds.flatMap((id, i) => uSet.has(id) ? [] : [{
      id, source: b.sources[i]!, score: b.semanticScores[i]!,
      ftsRank: b.ftsRanks[i]!, semanticRank: b.semanticRanks[i]!,
      ageDays: ageDays.get(id) ?? -1, position: i + 1,
    }]),
    moved: u.resultIds.flatMap((id, i) => {
      const from = b.resultIds.indexOf(id);
      return from >= 0 && from !== i ? [{ id, from: from + 1, to: i + 1 }] : [];
    }),
  });
}

// --- 汇总（按集分开；混成一个平均值会掩盖单集越界）---
const perSet = SETS.map((s) => {
  const rows = diffs.filter((d) => d.set === s.name);
  const added = rows.flatMap((r) => r.added);
  const displaced = rows.flatMap((r) => r.displaced);
  const mean = (xs: number[]) => xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0;
  return {
    set: s.name,
    sourceFile: s.file,
    queries: rows.length,
    withEnglishForm: rows.filter((r) => r.hasEnglishForm).length,
    pagesIdentical: rows.filter((r) => r.pageIdentical).length,
    pagesChanged: rows.filter((r) => !r.pageIdentical).length,
    /** 裁定点破的形状：总返回不变、但页面组成变了。 */
    returnedUnchangedButPageChanged: rows.filter(
      (r) => r.returned[0] === r.returned[1] && !r.pageIdentical,
    ).map((r) => r.id),
    returnedMean: [mean(rows.map((r) => r.returned[0])), mean(rows.map((r) => r.returned[1]))],
    returnedWorst: [Math.max(0, ...rows.map((r) => r.returned[0])), Math.max(0, ...rows.map((r) => r.returned[1]))],
    semanticOnlyMean: [mean(rows.map((r) => r.semanticOnly[0])), mean(rows.map((r) => r.semanticOnly[1]))],
    semanticOnlyMax: [Math.max(0, ...rows.map((r) => r.semanticOnly[0])), Math.max(0, ...rows.map((r) => r.semanticOnly[1]))],
    addedTotal: added.length,
    addedOutsideControlWindow: added.filter((a) => a.outsideControlWindow).length,
    addedBySource: added.reduce<Record<string, number>>((m, a) => { m[a.source] = (m[a.source] ?? 0) + 1; return m; }, {}),
    addedAgeDays: { min: Math.min(...added.map((a) => a.ageDays), Infinity), max: Math.max(...added.map((a) => a.ageDays), -Infinity) },
    addedScoreRange: (() => {
      const xs = added.map((a) => a.score).filter((x): x is number => x != null);
      return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
    })(),
    displacedTotal: displaced.length,
    displacedBySource: displaced.reduce<Record<string, number>>((m, d) => { m[d.source] = (m[d.source] ?? 0) + 1; return m; }, {}),
  };
});

const shapeRow = raw
  .query(`SELECT COUNT(*) AS total, MIN(turn_stopped_at) AS oldest, MAX(turn_stopped_at) AS newest,
                 SUM(CASE WHEN turn_stopped_at <= ? THEN 1 ELSE 0 END) AS outside
            FROM observations WHERE scope_key = ?`)
  .all(new Date(Date.now() - CONTROL_DAYS * 86400000).toISOString(), SCOPE) as
  { total: number; oldest: string; newest: string; outside: number }[];
const shape = shapeRow[0]!;
db.close();

const out = {
  generatedAt: new Date().toISOString(),
  purpose:
    '时间窗双臂逐页差异。纯仪表：不修改输入 / 判据 / 冻结时间 / checksum，不做通过判定。',
  provenance: {
    harnessSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    dbPath: DB_PATH,
    controlArm: `days=${CONTROL_DAYS}（改动之前的默认）`,
    treatmentArm: '默认无界（Phase 3C 之后）',
    policy: { ...DEFAULT_RETRIEVAL_POLICY },
    limit: LIMIT,
    inputsUnmodified: SETS.map((s) => ({
      set: s.name, file: s.file, sha16: sha16(readFileSync(join(DATASET_DIR, s.file), 'utf-8')), queries: s.queries.length,
    })),
    englishFormSource: 'loadAcpEnFixture（harness 用的同一个合并入口）',
    corpus: {
      total: shape.total, oldest: shape.oldest, newest: shape.newest,
      spanDays: Math.round((Date.parse(shape.newest) - Date.parse(shape.oldest)) / 86400000),
      outsideControlWindow: shape.outside,
      outsideControlWindowPct: Math.round((shape.outside / shape.total) * 1000) / 10,
    },
  },
  note:
    '语料是与全部 query 无关的合成 filler，因此任何返回都是误召回；返回条数即读数，无需标注。',
  perSet,
  perQuery: diffs,
};

const jsonPath = arg('json') ?? 'benchmark/reports/phase3c/timewindow-audit.json';
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);

// --- 控制台摘要 ---
console.log(
  `[tw-audit] 语料 ${shape.total} 条，跨度 ${out.provenance.corpus.spanDays} 天，` +
    `旧窗（days=${CONTROL_DAYS}）外 ${shape.outside} (${out.provenance.corpus.outsideControlWindowPct}%)`,
);
for (const s of perSet) {
  console.log(`\n[${s.set}] ${s.queries} 条 query（英文形式 ${s.withEnglishForm}/${s.queries}）`);
  console.log(`   页面相同 ${s.pagesIdentical} / 变化 ${s.pagesChanged}`);
  console.log(`   总返回不变但页面变了：${s.returnedUnchangedButPageChanged.length} 条 ${JSON.stringify(s.returnedUnchangedButPageChanged)}`);
  console.log(`   返回 均 ${s.returnedMean[0]}→${s.returnedMean[1]} | 坏 ${s.returnedWorst[0]}→${s.returnedWorst[1]}`);
  console.log(`   semantic-only 均 ${s.semanticOnlyMean[0]}→${s.semanticOnlyMean[1]} | 最大 ${s.semanticOnlyMax[0]}→${s.semanticOnlyMax[1]}`);
  console.log(`   新增 ${s.addedTotal} 条（其中旧窗外 ${s.addedOutsideControlWindow}），来源 ${JSON.stringify(s.addedBySource)}`);
  if (s.addedTotal) {
    console.log(`     新增记录年龄 ${s.addedAgeDays.min}–${s.addedAgeDays.max} 天；semantic score ${JSON.stringify(s.addedScoreRange)}`);
  }
  console.log(`   被挤出 ${s.displacedTotal} 条，来源 ${JSON.stringify(s.displacedBySource)}`);
}
console.log(`\n[tw-audit] 报告：${jsonPath}`);
