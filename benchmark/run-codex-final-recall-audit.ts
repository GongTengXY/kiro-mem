/**
 * 最终检索召回独立盲审：`days=90` vs 默认无界，双臂 + 8 条 raw 降级控制。
 *
 * 判据：`benchmark/reports/final-recall/codex-blind-audit-criteria.md`
 * 冻结记录：`benchmark/reports/final-recall/codex-blind-audit-freeze.json`
 *
 * 本脚本落在冻结记录 `authorizedAfterFreeze` 允许的范围内：只建仪表、播种契约装置、跑两臂、
 * 出逐 query 结果与逐页差异。它**不修改**冻结输入 / 判据 / 阈值 / 时间位置 / 任何 checksum，
 * 也不据审计结果调参。启动时逐项校验七个冻结 SHA-256，任何不匹配立即退出非零。
 *
 * 门槛 A/B/C/D 是**预登记**的，因此在这里机械计算并如实登记通过与失败；
 * §5 的裁定分支由 Codex 作，本脚本不写"P6 通过"之类的结论。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

import { MemoryDB, computeScopeKey } from '../src/db';
import {
  hybridSearchObservations,
  DEFAULT_RETRIEVAL_POLICY,
  type RetrievalPolicy,
} from '../src/server/observation-search';
import { loadDataset, DATASET_DIR, annotationToResult } from './dataset';
import {
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
  semanticEnSearchTextFields,
  type SemanticEnRecord,
} from '../src/semantic-en';
import {
  generateEmbedding,
  buildObservationSearchText,
  embeddingToBlob,
  DIMENSIONS,
  EMBEDDING_MODEL,
} from '../src/embedding';

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const die = (m: string): never => { console.error(`[final-audit] ✗ ${m}`); process.exit(1); };

const DIR = 'benchmark/reports/final-recall';
const FREEZE = join(DIR, 'codex-blind-audit-freeze.json');

// ---------------------------------------------------------------------------
// 0. 冻结校验。任何一项不匹配即退出——判据 §1.4：冻结后输入任何字节变化都使审计失效。
// ---------------------------------------------------------------------------
const freeze = JSON.parse(readFileSync(FREEZE, 'utf-8')) as {
  frozen: boolean; frozenAt: string;
  input: string; inputSha256: string; criteria: string; criteriaSha256: string;
  precheck: string; precheckSha256: string;
  factSources: { path: string; sha256: string }[];
  oldCorpus: { path: string; sha256: string; meta: string; metaSha256: string;
    sourceRecords: number; copies: number; auditRecords: number; spreadDays: number };
  counts: Record<string, number>;
};
if (!freeze.frozen) die('冻结记录的 frozen 不是 true');
const shaChecks: { name: string; path: string; want: string }[] = [
  { name: 'input', path: freeze.input, want: freeze.inputSha256 },
  { name: 'criteria', path: freeze.criteria, want: freeze.criteriaSha256 },
  { name: 'precheck', path: freeze.precheck, want: freeze.precheckSha256 },
  ...freeze.factSources.map((f) => ({ name: `fact:${f.path}`, path: f.path, want: f.sha256 })),
  { name: 'oldCorpus', path: freeze.oldCorpus.path, want: freeze.oldCorpus.sha256 },
  { name: 'oldCorpusMeta', path: freeze.oldCorpus.meta, want: freeze.oldCorpus.metaSha256 },
];
const shaVerified = shaChecks.map((c) => {
  const got = sha256(c.path);
  if (got !== c.want) die(`冻结 SHA 不匹配：${c.name} (${c.path})\n  want ${c.want}\n  got  ${got}`);
  return { ...c, verified: true };
});
console.log(`[final-audit] 冻结 SHA 校验通过 ${shaVerified.length}/${shaVerified.length}（冻结于 ${freeze.frozenAt}）`);

interface MainQuery {
  id: string; kind: 'relevance' | 'hard-negative'; cohort?: string; negative_type?: string;
  query: string; semantic_query_en: string; gold: string[];
}
interface RawControl {
  id: string; query: string; semantic_input_case: string;
  semantic_query_en: string | null; expected_lexical_gold: string[];
}
const input = JSON.parse(readFileSync(freeze.input, 'utf-8')) as {
  queries: MainQuery[]; raw_controls: RawControl[];
};
if (input.queries.filter((q) => q.kind === 'relevance').length !== freeze.counts.oldRelevance) die('relevance 条数与冻结记录不符');
if (input.queries.filter((q) => q.kind === 'hard-negative').length !== freeze.counts.hardNegative) die('hard-negative 条数与冻结记录不符');
if (input.raw_controls.length !== freeze.counts.rawControls) die('raw 控制条数与冻结记录不符');

// ---------------------------------------------------------------------------
// 1. 装置（判据 §2 与冻结记录 fixtureContract）
// ---------------------------------------------------------------------------
const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', 'final-recall-audit.db');
const CWD = '/final-recall/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const LIMIT = 10;
const GOLD_AGE_DAYS = freeze.oldCorpus.spreadDays === 1095 ? 400 : die('spreadDays 与冻结契约不符');
const SPREAD_DAYS = freeze.oldCorpus.spreadDays;
const AUDIT_RECORDS = freeze.oldCorpus.auditRecords;
const SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);

const dataset = loadDataset(DATASET_DIR);
const enRecords = JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en-acp-records.json'), 'utf-8'))
  .records as Record<string, SemanticEnRecord>;
const filler = JSON.parse(readFileSync(freeze.oldCorpus.path, 'utf-8')) as Array<{
  title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}>;
if (filler.length !== freeze.oldCorpus.sourceRecords) die('filler 条数与冻结记录不符');

const goldByDataset = new Map<string, number>();
const datasetByObservation = new Map<number, string>();
const ageDays = new Map<number, number>();

if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new MemoryDB(DB_PATH);

let clock = 0;
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
  ageDays.set(id, Math.round((Date.now() - Date.parse(o.at)) / 86400000));
  return id;
}

// --- 1a. 26 条 primary gold，全部落在审计基准时刻前 400 天 ---
const goldBase = Date.now() - GOLD_AGE_DAYS * 86400000;
for (const turn of dataset.turns) {
  if (turn.scope !== 'primary') continue;
  const normalized = enRecords[turn.id] ?? die(`缺少冻结英文派生值：${turn.id}`);
  const result = annotationToResult(turn.annotation);
  // 同一天内逐分钟递增，保证 26 条互不同时且全部 = 400 天前那一天。
  const at = new Date(goldBase + clock++ * 60_000).toISOString();
  const id = insert({
    session: 'gold', title: result.title, summary: result.summary, outcome: result.outcome,
    learned: result.learned, concepts: result.concepts, files: result.files_touched,
    memoryType: result.memory_type, at,
  });
  db.upsertObservationSemanticText({
    observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
    payload: normalized, translator: 'codex-final-recall-audit(frozen target)',
  });
  await (async () => {
    const v = await generateEmbedding(buildObservationSearchText(
      semanticEnSearchTextFields(normalized, result.files_touched),
    ));
    db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, embeddingToBlob(v));
  })();
  goldByDataset.set(turn.id, id);
  datasetByObservation.set(id, turn.id);
}
console.log(`[final-audit] gold ${goldByDataset.size} 条，年龄 ${GOLD_AGE_DAYS} 天`);

// --- 1b. 50,000 条老语料：10,000 条真实文本 × 5 份，均匀铺在 1,095 天内 ---
// 真实编码只做 10,000 次（与候选池 / Top-K 轮次同口径）：cosine 分布逐位保留。
const t0 = Date.now();
const vectors: Buffer[] = [];
for (const f of filler) {
  const normalized = {
    title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts,
  };
  const v = await generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(normalized, f.files)));
  vectors.push(embeddingToBlob(v));
}
console.log(`[final-audit] 真实编码 ${vectors.length} 条：${((Date.now() - t0) / 1000).toFixed(1)}s`);

const spreadStart = Date.now() - SPREAD_DAYS * 86400000;
const spreadStep = (SPREAD_DAYS * 86400000) / (AUDIT_RECORDS - 1);
for (let i = 0; i < AUDIT_RECORDS; i++) {
  const f = filler[i % filler.length]!;
  const copy = Math.floor(i / filler.length);
  const at = new Date(spreadStart + Math.round(i * spreadStep)).toISOString();
  const id = insert({
    session: 'filler',
    // 副本编号进标题：Observation 文本不能逐字相同，否则 FTS 命中形状退化成"同一条重复 5 次"。
    title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
    summary: f.summary, outcome: f.outcome, learned: f.learned,
    concepts: f.concepts, files: f.files, memoryType: 'change', at,
  });
  const normalized = {
    title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts,
  };
  db.upsertObservationSemanticText({
    observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
    payload: normalized, translator: 'codex-final-recall-audit(frozen filler)',
  });
  db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, vectors[i % vectors.length]!);
}
const scopeVectorCount = db.countScopeVectors({ scopeKey: SCOPE, model: SPACE_KEY, dimensions: DIMENSIONS });
console.log(`[final-audit] 语料播种完成：${AUDIT_RECORDS} filler + ${goldByDataset.size} gold，scope 向量 ${scopeVectorCount}`);

// ---------------------------------------------------------------------------
// 2. 两臂执行
// ---------------------------------------------------------------------------
const label = (id: number): string => datasetByObservation.get(id) ?? `filler:${id}`;
const CONTROL_DAYS = 90;

interface Row {
  id: string; kind: string; cohort?: string; negativeType?: string;
  gold: string[];
  resultIds: string[]; resultRawIds: number[];
  resultSources: string[]; semanticScores: (number | null)[];
  ftsRanks: (number | null)[]; semanticRanks: (number | null)[];
  ageDays: number[];
  ftsIds: string[]; semanticIds: string[];
  comparableVectors: number; aboveFloorCount: number; scopeVectors: number | null;
  protocol: string; rejectReason: string | null; degraded: boolean; embedCalls: number;
  goldRank: number | null; returned: number; semanticOnly: number;
}

async function runOne(
  q: { id: string; kind: string; cohort?: string; negativeType?: string; query: string; en?: string | null; gold: string[] },
  days: number | undefined,
  policy: RetrievalPolicy,
): Promise<Row> {
  let ftsRank: ReadonlyMap<number, number> = new Map();
  let semRank: ReadonlyMap<number, number> = new Map();
  let comparableVectors = -1;
  let aboveFloorCount = -1;
  let scopeVectors: number | null = null;
  let protocol = '?';
  let rejectReason: string | null = null;
  let degraded = false;
  let embedCalls = 0;
  const results = await hybridSearchObservations(
    db,
    q.query,
    {
      scopeKey: SCOPE, limit: LIMIT,
      ...(q.en ? { semanticQueryEn: q.en } : {}),
      ...(days === undefined ? {} : { days }),
    },
    {
      policy,
      generateEmbedding: async (t) => { embedCalls++; return generateEmbedding(t); },
      onCandidates: (i) => {
        ftsRank = i.ftsRank; semRank = i.semanticRank;
        comparableVectors = i.comparableVectors; aboveFloorCount = i.aboveFloorCount;
        scopeVectors = i.scopeVectors; protocol = i.protocol;
        rejectReason = q.en ? i.semanticQueryRejected : 'missing';
      },
      onDegrade: () => { degraded = true; },
    },
  );
  const goldIds = new Set(q.gold.map((g) => goldByDataset.get(g)!));
  const goldIndex = results.findIndex((r) => goldIds.has(r.id));
  return {
    id: q.id, kind: q.kind, ...(q.cohort ? { cohort: q.cohort } : {}),
    ...(q.negativeType ? { negativeType: q.negativeType } : {}),
    gold: q.gold,
    resultIds: results.map((r) => label(r.id)),
    resultRawIds: results.map((r) => r.id),
    resultSources: results.map((r) => r.match_source),
    semanticScores: results.map((r) => r.semantic_score ?? null),
    ftsRanks: results.map((r) => ftsRank.get(r.id) ?? null),
    semanticRanks: results.map((r) => semRank.get(r.id) ?? null),
    ageDays: results.map((r) => ageDays.get(r.id) ?? -1),
    ftsIds: [...ftsRank.keys()].map(label),
    semanticIds: [...semRank.keys()].map(label),
    comparableVectors, aboveFloorCount, scopeVectors, protocol, rejectReason, degraded, embedCalls,
    goldRank: goldIndex < 0 ? null : goldIndex + 1,
    returned: results.length,
    semanticOnly: results.filter((r) => r.match_source === 'semantic').length,
  };
}

const POLICY: RetrievalPolicy = { ...DEFAULT_RETRIEVAL_POLICY };
const mains = input.queries.map((q) => ({
  id: q.id, kind: q.kind, cohort: q.cohort, negativeType: q.negative_type,
  query: q.query, en: q.semantic_query_en, gold: q.gold,
}));
const raws = input.raw_controls.map((r) => ({
  id: r.id, kind: 'raw-control', cohort: r.semantic_input_case,
  query: r.query, en: r.semantic_query_en, gold: r.expected_lexical_gold,
}));

const arms: Record<string, { main: Row[]; raw: Row[]; ftsOnly: Record<string, string[]> }> = {};
for (const [armName, days] of [['days90', CONTROL_DAYS], ['unbounded', undefined]] as const) {
  const main: Row[] = [];
  for (const q of mains) main.push(await runOne(q, days, POLICY));
  const raw: Row[] = [];
  for (const q of raws) raw.push(await runOne(q, days, POLICY));
  // 判据 §4.D：raw 控制的结果必须逐位等于**同 arm** 的纯 FTS 查询。
  const ftsOnly: Record<string, string[]> = {};
  for (const q of raws) {
    ftsOnly[q.id] = db
      .searchObservationsFts(q.query, { scopeKey: SCOPE, limit: 50, ...(days === undefined ? {} : { days }) })
      .slice(0, LIMIT)
      .map((o) => label(o.id));
  }
  arms[armName] = { main, raw, ftsOnly };
  console.log(`[final-audit] arm ${armName} 完成：${main.length} 主 query + ${raw.length} raw 控制`);
}

// ---------------------------------------------------------------------------
// 3. 逐页差异（判据 §3 最后两条）
// ---------------------------------------------------------------------------
interface PageItem { id: string; source: string; score: number | null; ftsRank: number | null; semanticRank: number | null; ageDays: number }
const render = (r: Row): PageItem[] => r.resultIds.map((id, i) => ({
  id, source: r.resultSources[i]!, score: r.semanticScores[i]!,
  ftsRank: r.ftsRanks[i]!, semanticRank: r.semanticRanks[i]!, ageDays: r.ageDays[i]!,
}));

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));
function diffArms(a: Row[], b: Row[]) {
  const A = byId(a);
  return b.map((u) => {
    const c = A.get(u.id)!;
    const cp = render(c); const up = render(u);
    const cSet = new Set(c.resultIds); const uSet = new Set(u.resultIds);
    const cFull = c.returned === LIMIT;
    return {
      id: u.id, kind: u.kind, cohort: u.cohort, negativeType: u.negativeType, gold: u.gold,
      pageIdentical: JSON.stringify(c.resultIds) === JSON.stringify(u.resultIds),
      sourcesIdentical: JSON.stringify(c.resultSources) === JSON.stringify(u.resultSources),
      returned: [c.returned, u.returned], semanticOnly: [c.semanticOnly, u.semanticOnly],
      goldRank: [c.goldRank, u.goldRank],
      comparableVectors: [c.comparableVectors, u.comparableVectors],
      days90Page: cp, unboundedPage: up,
      added: up.flatMap((x, i) => cSet.has(x.id) ? [] : [{ ...x, position: i + 1 }]),
      removed: cp.flatMap((x, i) => uSet.has(x.id) ? [] : [{ ...x, position: i + 1 }]),
      moved: up.flatMap((x, i) => {
        const from = c.resultIds.indexOf(x.id);
        return from >= 0 && from !== i ? [{ id: x.id, from: from + 1, to: i + 1 }] : [];
      }),
      sourceChanged: up.flatMap((x) => {
        const j = c.resultIds.indexOf(x.id);
        return j >= 0 && c.resultSources[j] !== x.source ? [{ id: x.id, from: c.resultSources[j]!, to: x.source }] : [];
      }),
      /** 满页时被挤出的记录，以及替代它的新增（判据 §3 最后一条）。 */
      displacedWhenFull: cFull
        ? cp.flatMap((x, i) => uSet.has(x.id) ? [] : [{ displaced: { ...x, position: i + 1 }, replacedBy: up[i] ? { ...up[i]!, position: i + 1 } : null }])
        : [],
    };
  });
}
const mainDiffs = diffArms(arms.days90!.main, arms.unbounded!.main);
const rawDiffs = diffArms(arms.days90!.raw, arms.unbounded!.raw);

// ---------------------------------------------------------------------------
// 4. 预登记门槛 A/B/C/D（机械计算；§5 的分支裁定由 Codex 作）
// ---------------------------------------------------------------------------
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const round = (x: number) => Math.round(x * 1000) / 1000;
const rel = (arm: string) => arms[arm]!.main.filter((r) => r.kind === 'relevance');
const neg = (arm: string) => arms[arm]!.main.filter((r) => r.kind === 'hard-negative');
const hitAt5 = (rows: Row[]) => mean(rows.map((r) => (r.goldRank != null && r.goldRank <= 5 ? 1 : 0)));
const mrr = (rows: Row[]) => mean(rows.map((r) => (r.goldRank != null ? 1 / r.goldRank : 0)));

const goldOutsideWindow = [...goldByDataset.values()].filter((id) => (ageDays.get(id) ?? 0) > CONTROL_DAYS).length;
const corpusOutside = [...ageDays.entries()].filter(([, d]) => d > CONTROL_DAYS).length;

const prechecked = JSON.parse(readFileSync(FREEZE, 'utf-8')).textOnlyPrecheck as Record<string, unknown>;

const A1 = { name: 'A1 26 正例 + 30 负例纯文本预检 ftsCount=0', pass: prechecked.zeroFtsRelevance === 26 && prechecked.zeroFtsHardNegative === 30, reading: `预检记录 relevance ${prechecked.zeroFtsRelevance}/26、hard-negative ${prechecked.zeroFtsHardNegative}/30`, note: '来自冻结记录 textOnlyPrecheck（冻结前完成，本轮只校验其 SHA）' };
const A2 = { name: 'A2 26 gold 全在 90 天窗外；语料 ≥90% 在窗外', pass: goldOutsideWindow === 26 && corpusOutside / (AUDIT_RECORDS + 26) >= 0.9, reading: `gold ${goldOutsideWindow}/26（年龄 ${GOLD_AGE_DAYS}d）；语料窗外 ${corpusOutside}/${AUDIT_RECORDS + 26} = ${round((corpusOutside / (AUDIT_RECORDS + 26)) * 100)}%` };
const leaks = [...arms.days90!.main, ...arms.unbounded!.main, ...arms.days90!.raw, ...arms.unbounded!.raw]
  .flatMap((r) => r.resultRawIds.filter((id) => !ageDays.has(id)));
const protocolsSeen = [...new Set([...arms.days90!.main, ...arms.unbounded!.main].map((r) => r.protocol))];
const A3 = { name: 'A3 两臂 degrade=0 / 跨 scope 泄漏=0 / 协议混排=0', pass: [...arms.days90!.main, ...arms.unbounded!.main, ...arms.days90!.raw, ...arms.unbounded!.raw].every((r) => !r.degraded) && leaks.length === 0 && protocolsSeen.length === 1 && protocolsSeen[0] === SEMANTIC_EN_PROTOCOL, reading: `degrade ${[...arms.days90!.main, ...arms.unbounded!.main, ...arms.days90!.raw, ...arms.unbounded!.raw].filter((r) => r.degraded).length}；泄漏 ${leaks.length}；主 query 协议 ${JSON.stringify(protocolsSeen)}` };
const capViolations = [...arms.days90!.main, ...arms.unbounded!.main].filter((r) => r.semanticOnly > POLICY.semanticOnlyLimit);
const badSemSources = [...arms.days90!.main, ...arms.unbounded!.main].flatMap((r) => r.resultSources.filter((s) => s !== 'fts' && s !== 'hybrid' && s !== 'semantic' && s !== 'bigram'));
const A4 = { name: 'A4 semantic-only ≤2 且来源均为 semantic', pass: capViolations.length === 0 && badSemSources.length === 0, reading: `cap 越界 ${capViolations.length} 条；非法来源枚举 ${badSemSources.length}` };

const B1 = { name: 'B1 无界 hit@5 与 MRR 均严格 > days=90', pass: hitAt5(rel('unbounded')) > hitAt5(rel('days90')) && mrr(rel('unbounded')) > mrr(rel('days90')), reading: `hit@5 ${round(hitAt5(rel('days90')) * 100)}% → ${round(hitAt5(rel('unbounded')) * 100)}%；MRR ${round(mrr(rel('days90')))} → ${round(mrr(rel('unbounded')))}` };
const recoveredTop5 = mainDiffs.filter((d) => d.kind === 'relevance' && !(d.goldRank[0] != null && d.goldRank[0] <= 5) && d.goldRank[1] != null && d.goldRank[1]! <= 5);
const B2 = { name: 'B2 无界至少找回 1 条此前被挡住的 gold 到 Top-5', pass: recoveredTop5.length >= 1, reading: `${recoveredTop5.length} 条：${JSON.stringify(recoveredTop5.map((d) => d.id))}` };
const regressed = mainDiffs.filter((d) => d.kind === 'relevance' && d.goldRank[0] != null && (d.goldRank[1] == null || d.goldRank[1]! > d.goldRank[0]!));
const B3 = { name: 'B3 改善与失败逐条登记', pass: true, reading: `改善 ${recoveredTop5.length} 条；退化 ${regressed.length} 条：${JSON.stringify(regressed.map((d) => d.id))}；全部逐 query 明细见 perQuery` };

const negU = neg('unbounded'); const negC = neg('days90');
const C1 = { name: 'C1 无界 arm 平均返回 ≤1', pass: mean(negU.map((r) => r.returned)) <= 1, reading: `无界 ${round(mean(negU.map((r) => r.returned)))}（days=90 ${round(mean(negC.map((r) => r.returned)))}）` };
const C2 = { name: 'C2 无界 arm 单条最坏返回 ≤3', pass: Math.max(0, ...negU.map((r) => r.returned)) <= 3, reading: `无界 ${Math.max(0, ...negU.map((r) => r.returned))}（days=90 ${Math.max(0, ...negC.map((r) => r.returned))}）` };
const C3 = { name: 'C3 无界 arm semanticOnlyMax ≤2', pass: Math.max(0, ...negU.map((r) => r.semanticOnly)) <= 2, reading: `无界 ${Math.max(0, ...negU.map((r) => r.semanticOnly))}（days=90 ${Math.max(0, ...negC.map((r) => r.semanticOnly))}）` };
const C4 = { name: 'C4 同时报告两臂绝对值与逐页替换', pass: true, reading: `见 perSet 与 perQuery：负例页面变化 ${mainDiffs.filter((d) => d.kind === 'hard-negative' && !d.pageIdentical).length}/${negU.length}` };

const rawFail: string[] = [];
for (const armName of ['days90', 'unbounded'] as const) {
  for (const r of arms[armName]!.raw) {
    const expectFts = arms[armName]!.ftsOnly[r.id]!;
    if (r.embedCalls !== 0) rawFail.push(`${armName}/${r.id}: embedCalls=${r.embedCalls}`);
    if (r.comparableVectors !== 0) rawFail.push(`${armName}/${r.id}: comparableVectors=${r.comparableVectors}`);
    if (r.semanticIds.length !== 0) rawFail.push(`${armName}/${r.id}: semanticCount=${r.semanticIds.length}`);
    if (r.aboveFloorCount !== 0) rawFail.push(`${armName}/${r.id}: aboveFloorCount=${r.aboveFloorCount}`);
    if (JSON.stringify(r.resultIds) !== JSON.stringify(expectFts)) rawFail.push(`${armName}/${r.id}: 结果与纯 FTS 不一致`);
    const bad = r.resultSources.filter((s) => s !== 'fts');
    if (bad.length) rawFail.push(`${armName}/${r.id}: 来源含 ${JSON.stringify(bad)}`);
  }
}
const D = { name: 'D 8 条 raw 控制在两臂均为严格 FTS-only', pass: rawFail.length === 0, reading: rawFail.length ? JSON.stringify(rawFail.slice(0, 8)) : '两臂 8/8 全部满足：embedCalls/comparable/semanticCount/aboveFloor 均 0、结果逐位等于纯 FTS、来源只有 fts' };

const gates = [A1, A2, A3, A4, B1, B2, B3, C1, C2, C3, C4, D];

// ---------------------------------------------------------------------------
// 5. 输出
// ---------------------------------------------------------------------------
const summary = {
  relevance: {
    days90: { hitAt5: round(hitAt5(rel('days90'))), mrr: round(mrr(rel('days90'))), reached: rel('days90').filter((r) => r.goldRank != null).length, n: rel('days90').length },
    unbounded: { hitAt5: round(hitAt5(rel('unbounded'))), mrr: round(mrr(rel('unbounded'))), reached: rel('unbounded').filter((r) => r.goldRank != null).length, n: rel('unbounded').length },
  },
  hardNegative: {
    days90: { returnedMean: round(mean(negC.map((r) => r.returned))), returnedWorst: Math.max(0, ...negC.map((r) => r.returned)), semanticOnlyMean: round(mean(negC.map((r) => r.semanticOnly))), semanticOnlyMax: Math.max(0, ...negC.map((r) => r.semanticOnly)) },
    unbounded: { returnedMean: round(mean(negU.map((r) => r.returned))), returnedWorst: Math.max(0, ...negU.map((r) => r.returned)), semanticOnlyMean: round(mean(negU.map((r) => r.semanticOnly))), semanticOnlyMax: Math.max(0, ...negU.map((r) => r.semanticOnly)) },
  },
  pageChurn: {
    mainPagesChanged: mainDiffs.filter((d) => !d.pageIdentical).length,
    mainQueries: mainDiffs.length,
    addedTotal: mainDiffs.reduce((n, d) => n + d.added.length, 0),
    removedTotal: mainDiffs.reduce((n, d) => n + d.removed.length, 0),
    sourceChangedTotal: mainDiffs.reduce((n, d) => n + d.sourceChanged.length, 0),
    addedBySource: mainDiffs.flatMap((d) => d.added).reduce<Record<string, number>>((m, a) => { m[a.source] = (m[a.source] ?? 0) + 1; return m; }, {}),
  },
};

const out = {
  generatedAt: new Date().toISOString(),
  role: '机械仪表输出。门槛 A/B/C/D 为预登记，机械计算；§5 裁定分支由 Codex 作。',
  freeze: { file: FREEZE, frozenAt: freeze.frozenAt, shaVerified: shaVerified.map((c) => ({ name: c.name, path: c.path, sha256: c.want })) },
  provenance: {
    harnessSha256: createHash('sha256').update(readFileSync(import.meta.path)).digest('hex').slice(0, 16),
    dbPath: DB_PATH, scopeKey: SCOPE, spaceKey: SPACE_KEY, embeddingModel: EMBEDDING_MODEL, dimensions: DIMENSIONS,
    policy: POLICY, limit: LIMIT, arms: { control: `days=${CONTROL_DAYS}`, treatment: 'unbounded（省略 days）' },
    fixture: { goldRecords: goldByDataset.size, goldAgeDays: GOLD_AGE_DAYS, fillerRecords: AUDIT_RECORDS, spreadDays: SPREAD_DAYS, scopeVectors: scopeVectorCount },
  },
  gates, summary,
  perQuery: { main: mainDiffs, rawControls: rawDiffs },
  armsRaw: arms,
};
const jsonPath = arg('json') ?? join(DIR, 'codex-blind-audit-result.json');
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);
db.close();
if (!arg('keep-db')) rmSync(DB_PATH, { force: true });

console.log('\n[final-audit] 预登记门槛：');
for (const g of gates) console.log(`  ${g.pass ? '✅' : '❌'} ${g.name}\n       ${g.reading}`);
console.log(`\n[final-audit] 正例 hit@5 ${summary.relevance.days90.hitAt5 * 100}% → ${summary.relevance.unbounded.hitAt5 * 100}%；MRR ${summary.relevance.days90.mrr} → ${summary.relevance.unbounded.mrr}`);
console.log(`[final-audit] 负例 返回均 ${summary.hardNegative.days90.returnedMean} → ${summary.hardNegative.unbounded.returnedMean}；最坏 ${summary.hardNegative.days90.returnedWorst} → ${summary.hardNegative.unbounded.returnedWorst}`);
console.log(`[final-audit] 报告：${jsonPath}`);
