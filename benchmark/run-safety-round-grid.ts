/**
 * 安全策略轮次 P3：floor × cap 网格 runner（12 个 arm）。
 *
 * 判据：`benchmark/reports/safety-round/p3-grid-criteria.md`
 * 冻结：`benchmark/reports/safety-round/p3-grid-freeze.json`（含 P2 冻结的引用）
 *
 * 本脚本是**机械仪表**：播种冻结装置、跑 12 个 arm、按判据 §5 机械计算 F1 / N1 / N2 / N3
 * 与 §6 的 S1–S6 自证，逐 arm 出报告。它**不选 arm**（那是 `select-safety-round-arm.ts` 的事，
 * 判据 §7 要求选择由脚本计算且与仪表分离），**不写任何裁定结论**，也不修改任何冻结物。
 *
 * 三件容易做错、这里刻意做对的事：
 *
 *  1. **12 个 arm 只差两个值。** 策略对象由 `DEFAULT_RETRIEVAL_POLICY` 展开后只覆盖
 *     `semanticFloor` / `semanticOnlyLimit`，其余字段永不出现在本文件里——写死第三个值
 *     就等于偷偷引入第三个变量（判据 §8 第 5 条）。S6 把这件事变成断言。
 *  2. **语料播一次，向量编一次。** 10,000 次真实编码 + 131 次 query 编码，12 个 arm 复用。
 *     策略参数不进编码器，所以缓存与重复编码逐位等价（判据 §3.4）。
 *  3. **误召回两套口径。** `physicalRows` 是 C1 的口径，`distinctContent` 按原文折叠后才是
 *     真实的不同假线索数量，N2 判定用后者（判据 §4.3）。折叠键在播种时逐行登记，
 *     不靠 `id mod 10000` 这类算术推断。
 *
 * 用法：
 *   bun run benchmark/run-safety-round-grid.ts
 *   bun run benchmark/run-safety-round-grid.ts --arms=f0.197-c2,f0.325-c1   # 只跑子集（调试用）
 *   bun run benchmark/run-safety-round-grid.ts --keep-db
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
import { DATASET_DIR, annotationToResult, type Annotation, type DatasetTurn } from './dataset';
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

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const has = (n: string): boolean => process.argv.includes(`--${n}`);
const die = (m: string): never => { console.error(`[p3] ✗ ${m}`); process.exit(1); };
const r3 = (x: number): number => Number(x.toFixed(3));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const REPORT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const ARM_DIR = join(REPORT_DIR, 'p3-arms');
const FREEZE = join(REPORT_DIR, 'p3-grid-freeze.json');

// ---------------------------------------------------------------------------
// 0. 冻结校验（判据 §6 的 S1）
//    P3 判据 + P2 冻结记录的 14 项，任何一项不匹配立即退出非零。
// ---------------------------------------------------------------------------
const freeze = read(FREEZE);
if (freeze.frozen !== true) die('p3-grid-freeze.json 的 frozen 不是 true');
if (sha256(freeze.criteria) !== freeze.criteriaSha256) die('P3 判据已被改动，冻结失效');

const p2 = read(freeze.upstream.p2Freeze);
if (p2.frozen !== true) die('p2-calibration-freeze.json 的 frozen 不是 true');
const p2Checks: { name: string; path: string; want: string }[] = [
  { name: 'p2.criteria', path: p2.criteria, want: p2.criteriaSha256 },
  { name: 'p2.turns', path: p2.turns.path, want: p2.turns.sha256 },
  { name: 'p2.queries', path: p2.queries.path, want: p2.queries.sha256 },
  { name: 'p2.semanticEn.records', path: p2.semanticEn.records.path, want: p2.semanticEn.records.sha256 },
  { name: 'p2.semanticEn.queries', path: p2.semanticEn.queries.path, want: p2.semanticEn.queries.sha256 },
  { name: 'p2.semanticEn.generator', path: p2.semanticEn.generator.path, want: p2.semanticEn.generator.sha256 },
  { name: 'p2.verify.zeroFts', path: p2.verification.zeroFts.path, want: p2.verification.zeroFts.sha256 },
  { name: 'p2.verify.lowScoreStrata', path: p2.verification.lowScoreStrata.path, want: p2.verification.lowScoreStrata.sha256 },
  { name: 'p2.verify.ageAssignment', path: p2.verification.ageAssignment.path, want: p2.verification.ageAssignment.sha256 },
  { name: 'p2.verify.ageScript', path: p2.verification.ageAssignment.script, want: p2.verification.ageAssignment.scriptSha256 },
  { name: 'p2.ftsZero.oldPrimary', path: p2.ftsZeroCorpus.oldPrimary, want: p2.ftsZeroCorpus.oldPrimarySha256 },
  { name: 'p2.ftsZero.filler', path: p2.ftsZeroCorpus.filler, want: p2.ftsZeroCorpus.fillerSha256 },
  { name: 'p2.overlap.screen', path: p2.overlapReview.screen.path, want: p2.overlapReview.screen.sha256 },
  { name: 'p2.overlap.adjudication', path: p2.overlapReview.adjudication.path, want: p2.overlapReview.adjudication.sha256 },
];
// 旧 26 条的英文镜像不在 P2 冻结清单里（它属于最终盲审的冻结物），因此从 P3 冻结记录校验。
p2Checks.push({
  name: 'p3.semanticEn.oldRecords',
  path: freeze.fixture.semanticEnRecords.old,
  want: freeze.fixture.semanticEnRecords.oldSha256,
});
for (const c of p2Checks) {
  const got = existsSync(c.path) ? sha256(c.path) : 'MISSING';
  if (got !== c.want) die(`冻结 SHA 不匹配：${c.name} (${c.path})\n  want ${c.want}\n  got  ${got}`);
}
console.log(`[p3] S1 冻结校验通过 ${p2Checks.length}/${p2Checks.length}（P2 冻结于 ${p2.frozenAt}）`);

// ---------------------------------------------------------------------------
// 1. 输入
// ---------------------------------------------------------------------------
interface SafetyRecord {
  id: string; annotation: Annotation; age_days: number; insertion_index: number;
}
interface GridQuery {
  id: string; kind: 'relevance' | 'hard-negative'; cohort: string;
  negative_type?: 'near-domain' | 'foreign-domain';
  query: string; semantic_query_en: string;
  primary_gold?: string[]; acceptable_gold?: string[]; gold?: string[];
}

const newRecords = (read(freeze.fixture.newGold.path) as { records: SafetyRecord[] }).records;
if (newRecords.length !== freeze.fixture.newGold.records) die('新 gold 条数与冻结记录不符');
const oldTurns = (read(freeze.fixture.oldPrimary.path) as DatasetTurn[]).filter((t) => t.scope === 'primary');
if (oldTurns.length !== freeze.fixture.oldPrimary.records) die('旧 primary 条数与冻结记录不符');
const filler = read(freeze.fixture.filler.path) as Array<{
  title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}>;
if (filler.length !== freeze.fixture.filler.sourceRecords) die('filler 条数与冻结记录不符');

const newEn = read(freeze.fixture.semanticEnRecords.new).records as Record<string, SemanticEnRecord>;
const oldEn = read(freeze.fixture.semanticEnRecords.old).records as Record<string, SemanticEnRecord>;
const queries = (read(freeze.fixture.queries.path) as { queries: GridQuery[] }).queries;
if (queries.length !== freeze.fixture.queries.total) die('query 条数与冻结记录不符');

const relevance = queries.filter((q) => q.kind === 'relevance');
const negatives = queries.filter((q) => q.kind === 'hard-negative');
const nearDomain = negatives.filter((q) => q.negative_type === 'near-domain');
const foreignDomain = negatives.filter((q) => q.negative_type === 'foreign-domain');
if (nearDomain.length !== freeze.gates.layers.nearDomain.total) die('near-domain 条数与冻结记录不符');
if (foreignDomain.length !== freeze.gates.layers.foreignDomain.total) die('foreign-domain 条数与冻结记录不符');

// ---------------------------------------------------------------------------
// 2. 装置（判据 §3）：播种一次，12 个 arm 复用
// ---------------------------------------------------------------------------
const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', 'p3-safety-grid.db');
const CWD = '/safety-round/primary';
const SCOPE = computeScopeKey(CWD, CWD);
const LIMIT = freeze.frozenPolicyFields.limit as number;
const SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const OLD_AGE_DAYS = freeze.fixture.oldPrimary.ageDays as number;
const SPREAD_DAYS = freeze.fixture.filler.spreadDays as number;
const FILLER_ROWS = freeze.fixture.filler.records as number;
const NOW = Date.now();

if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true });
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new MemoryDB(DB_PATH);

/** dataset id ↔ observation id，以及每行的同源折叠键与年龄。 */
const obsByDataset = new Map<string, number>();
const datasetByObs = new Map<number, string>();
const contentKeyByObs = new Map<number, string>();
const ageDays = new Map<number, number>();

let minuteClock = 0;
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
  ageDays.set(id, Math.round((NOW - Date.parse(o.at)) / 86400000));
  return id;
}

/** 记录侧的英文向量文本：与生产 `embed_observation` 同一条路径。 */
async function embedRecord(en: SemanticEnRecord, files: string[]): Promise<Float32Array> {
  return generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(en, files)));
}

// --- 2a. 新 40 条：按 insertion_index 升序插入，时间戳按各自的 age_days ---------
// 插入顺序与年龄刻意解耦（判据 §3.2）：`id ASC` 在本装置上不再编码 oldest-first。
const newVec = new Map<string, Float32Array>();
for (const rec of [...newRecords].sort((a, b) => a.insertion_index - b.insertion_index)) {
  const en = newEn[rec.id] ?? die(`新记录缺英文派生值：${rec.id}`);
  const result = annotationToResult(rec.annotation);
  const at = new Date(NOW - rec.age_days * 86400000).toISOString();
  const id = insert({
    session: 'safety-round-new', title: result.title, summary: result.summary, outcome: result.outcome,
    learned: result.learned, concepts: result.concepts, files: result.files_touched,
    memoryType: result.memory_type, at,
  });
  db.upsertObservationSemanticText({
    observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
    payload: en, translator: 'p3-safety-grid(frozen new gold)',
  });
  const v = await embedRecord(en, result.files_touched);
  db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, embeddingToBlob(v));
  newVec.set(rec.id, v);
  obsByDataset.set(rec.id, id);
  datasetByObs.set(id, rec.id);
  contentKeyByObs.set(id, rec.id);
}

// --- 2b. 旧 26 条 primary：全部 400 天前，与已消耗审计装置同一位置 -------------
const oldBase = NOW - OLD_AGE_DAYS * 86400000;
for (const turn of oldTurns) {
  const en = oldEn[turn.id] ?? die(`旧记录缺英文派生值：${turn.id}`);
  const result = annotationToResult(turn.annotation);
  const at = new Date(oldBase + minuteClock++ * 60_000).toISOString();
  const id = insert({
    session: 'gold-old', title: result.title, summary: result.summary, outcome: result.outcome,
    learned: result.learned, concepts: result.concepts, files: result.files_touched,
    memoryType: result.memory_type, at,
  });
  db.upsertObservationSemanticText({
    observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
    payload: en, translator: 'p3-safety-grid(frozen old gold)',
  });
  db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, embeddingToBlob(await embedRecord(en, result.files_touched)));
  obsByDataset.set(turn.id, id);
  datasetByObs.set(id, turn.id);
  contentKeyByObs.set(id, turn.id);
}
console.log(`[p3] gold 播种完成：新 ${newRecords.length} 条（年龄 ${freeze.fixture.newGold.ageDaysRange.join('…')} 天）+ 旧 ${oldTurns.length} 条（${OLD_AGE_DAYS} 天）`);

// --- 2c. 50,000 条 filler：10,000 条真实编码 × 5 份副本，铺在 1,095 天内 -------
const t0 = Date.now();
const fillerVec: Buffer[] = [];
for (const f of filler) {
  const en = { title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts };
  fillerVec.push(embeddingToBlob(await embedRecord(en, f.files)));
}
console.log(`[p3] filler 真实编码 ${fillerVec.length} 条：${((Date.now() - t0) / 1000).toFixed(1)}s`);

const spreadStart = NOW - SPREAD_DAYS * 86400000;
const spreadStep = (SPREAD_DAYS * 86400000) / (FILLER_ROWS - 1);
for (let i = 0; i < FILLER_ROWS; i++) {
  const srcIndex = i % filler.length;
  const copy = Math.floor(i / filler.length);
  const f = filler[srcIndex]!;
  const at = new Date(spreadStart + Math.round(i * spreadStep)).toISOString();
  const id = insert({
    session: 'filler',
    // 副本编号进标题：Observation 文本逐字相同会让 FTS 命中形状退化成"同一条重复 5 次"。
    title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
    summary: f.summary, outcome: f.outcome, learned: f.learned,
    concepts: f.concepts, files: f.files, memoryType: 'change', at,
  });
  db.upsertObservationSemanticText({
    observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
    payload: { title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts },
    translator: 'p3-safety-grid(frozen filler)',
  });
  db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, fillerVec[srcIndex]!);
  // 折叠键在播种时登记：同一条原文的 5 份副本共享 `filler#<srcIndex>`。
  // 等价于审计的 `id mod 10000`，但不依赖 id 连续这个隐含前提。
  contentKeyByObs.set(id, `filler#${srcIndex}`);
}
const scopeVectorCount = db.countScopeVectors({ scopeKey: SCOPE, model: SPACE_KEY, dimensions: DIMENSIONS });
console.log(`[p3] 装置播种完成：物理行 ${ageDays.size}，scope 向量 ${scopeVectorCount}`);

// ---------------------------------------------------------------------------
// 3. query 向量缓存 + 低分正例四档（判据 §4.2、§6 的 S5）
// ---------------------------------------------------------------------------
const embedCache = new Map<string, Float32Array>();
let embedCalls = 0;
let embedHits = 0;
async function cachedEmbedding(text: string): Promise<Float32Array> {
  const hit = embedCache.get(text);
  if (hit) { embedHits++; return hit; }
  embedCalls++;
  const v = await generateEmbedding(text);
  embedCache.set(text, v);
  return v;
}

const BANDS = [
  { key: '<0.200', lo: -Infinity, hi: 0.2 },
  { key: '0.200-0.310', lo: 0.2, hi: 0.31 },
  { key: '0.310-0.400', lo: 0.31, hi: 0.4 },
  { key: '>=0.400', lo: 0.4, hi: Infinity },
] as const;
type BandKey = (typeof BANDS)[number]['key'];

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};

const bandByQuery = new Map<string, BandKey>();
const cosineByQuery = new Map<string, number>();
for (const q of relevance) {
  const qv = await cachedEmbedding(q.semantic_query_en);
  const best = Math.max(...q.primary_gold!.map((g) => dot(qv, newVec.get(g) ?? die(`${q.id} 的 primary_gold ${g} 不在新记录集里`))));
  bandByQuery.set(q.id, BANDS.find((b) => best >= b.lo && best < b.hi)!.key);
  cosineByQuery.set(q.id, r3(best));
}
const bandCounts = Object.fromEntries(
  BANDS.map((b) => [b.key, relevance.filter((q) => bandByQuery.get(q.id) === b.key).length]),
) as Record<BandKey, number>;

// S5：四档条数复现 P2 冻结值，并逐条比对冻结分层（比只比总数强）。
const frozenStrata = read(p2.verification.lowScoreStrata.path) as {
  perQuery: { id: string; band: string; cosine: number }[];
};
const bandMismatch = frozenStrata.perQuery.filter((r) => bandByQuery.get(r.id) !== r.band);
const maxCosineDelta = Math.max(
  ...frozenStrata.perQuery.map((r) => Math.abs((cosineByQuery.get(r.id) ?? NaN) - r.cosine)),
);
const S5 = {
  name: 'S5 低分正例四档复现 P2 冻结值',
  pass: bandMismatch.length === 0 &&
    BANDS.every((b) => bandCounts[b.key] === (p2.queries.lowScorePositiveBands as Record<string, number>)[b.key]),
  reading: `四档 ${BANDS.map((b) => `${b.key}=${bandCounts[b.key]}`).join(' / ')}；` +
    `逐条分层不一致 ${bandMismatch.length} 条；|Δcosine| 最大 ${r3(maxCosineDelta)}`,
};

// ---------------------------------------------------------------------------
// 4. 12 个 arm
// ---------------------------------------------------------------------------
const armId = (floor: number, cap: number): string => `f${floor}-c${cap}`;
const allArms = (freeze.grid.semanticFloor as number[]).flatMap((floor) =>
  (freeze.grid.semanticOnlyLimit as number[]).map((cap) => ({ id: armId(floor, cap), floor, cap })),
);
if (allArms.length !== freeze.grid.arms) die('网格 arm 数与冻结记录不符');
const only = arg('arms')?.split(',');
const arms = only ? allArms.filter((a) => only.includes(a.id)) : allArms;
if (!arms.length) die(`--arms 没有匹配任何 arm；可选：${allArms.map((a) => a.id).join(', ')}`);

// S6：基线 arm 的策略必须与生产逐字段相等。写死第三个值会在这里被抓住。
const policyFor = (floor: number, cap: number): RetrievalPolicy => ({
  ...DEFAULT_RETRIEVAL_POLICY,
  semanticFloor: floor,
  semanticOnlyLimit: cap,
});
const baselineId = freeze.grid.baselineArm as string;
const baselinePolicy = policyFor(
  Number(baselineId.slice(1).split('-c')[0]),
  Number(baselineId.split('-c')[1]),
);
const policyDiff = (Object.keys(DEFAULT_RETRIEVAL_POLICY) as (keyof RetrievalPolicy)[])
  .filter((k) => baselinePolicy[k] !== DEFAULT_RETRIEVAL_POLICY[k]);
const S6 = {
  name: `S6 基线 arm ${baselineId} 的策略与 DEFAULT_RETRIEVAL_POLICY 逐字段相等`,
  pass: policyDiff.length === 0,
  reading: policyDiff.length ? `不相等字段 ${JSON.stringify(policyDiff)}` : `${Object.keys(DEFAULT_RETRIEVAL_POLICY).length} 个字段全部相等`,
};

interface Row {
  id: string; kind: string; cohort: string; negativeType?: string; band?: BandKey;
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
}

const label = (id: number): string => datasetByObs.get(id) ?? `filler:${id}`;

async function runQuery(q: GridQuery, policy: RetrievalPolicy): Promise<Row> {
  let ftsRank: ReadonlyMap<number, number> = new Map();
  let semRank: ReadonlyMap<number, number> = new Map();
  let ftsCount = -1, semanticCount = -1, aboveFloorCount = -1, comparableVectors = -1;
  let scopeVectors: number | null = null;
  let protocol = '?';
  let rejectReason: string | null = null;
  let degraded = false;
  let semanticOnlyDropped = -1;

  const results = await hybridSearchObservations(
    db,
    q.query,
    { scopeKey: SCOPE, limit: LIMIT, semanticQueryEn: q.semantic_query_en },
    {
      policy,
      generateEmbedding: cachedEmbedding,
      onCandidates: (i) => {
        ftsRank = i.ftsRank; semRank = i.semanticRank;
        ftsCount = i.ftsCount; semanticCount = i.semanticCount;
        aboveFloorCount = i.aboveFloorCount; comparableVectors = i.comparableVectors;
        scopeVectors = i.scopeVectors; protocol = i.protocol;
        rejectReason = i.semanticQueryRejected;
      },
      onFusion: (i) => { semanticOnlyDropped = i.semanticOnlyDropped; },
      onDegrade: () => { degraded = true; },
    },
  );

  const primaryGold = q.primary_gold ?? [];
  const acceptableGold = q.acceptable_gold ?? [];
  const primaryObs = new Set(primaryGold.map((g) => obsByDataset.get(g) ?? die(`${q.id} 的 primary_gold ${g} 未播种`)));
  const acceptableObs = new Set(acceptableGold.map((g) => obsByDataset.get(g) ?? die(`${q.id} 的 acceptable_gold ${g} 未播种`)));
  const pIdx = results.findIndex((r) => primaryObs.has(r.id));
  const aIdx = results.findIndex((r) => acceptableObs.has(r.id));
  // N3：非 acceptable 结果排在第一个 primary_gold 之前的条数。页面上没有 primary_gold
  // 的 query 不产生计数——没有真命中就谈不上"压过真命中"（判据 §5.2）。
  const nonAcceptableBeforePrimary = pIdx < 0
    ? 0
    : results.slice(0, pIdx).filter((r) => !acceptableObs.has(r.id)).length;

  return {
    id: q.id, kind: q.kind, cohort: q.cohort,
    ...(q.negative_type ? { negativeType: q.negative_type } : {}),
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
    nonAcceptableBeforePrimary,
  };
}

const hitAt5 = (rows: Row[], key: 'primaryRank' | 'acceptableRank'): number =>
  mean(rows.map((r) => (r[key] != null && r[key]! <= 5 ? 1 : 0)));
const mrr = (rows: Row[], key: 'primaryRank' | 'acceptableRank'): number =>
  mean(rows.map((r) => (r[key] != null ? 1 / r[key]! : 0)));
const worst = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

mkdirSync(ARM_DIR, { recursive: true });
const armSummaries: any[] = [];

for (const arm of arms) {
  const started = Date.now();
  const policy = policyFor(arm.floor, arm.cap);
  const rows: Row[] = [];
  for (const q of queries) rows.push(await runQuery(q, policy));

  const rel = rows.filter((r) => r.kind === 'relevance');
  const negRows = rows.filter((r) => r.kind === 'hard-negative');
  const near = rows.filter((r) => r.negativeType === 'near-domain');
  const foreign = rows.filter((r) => r.negativeType === 'foreign-domain');
  const byCohort = (rs: Row[], cohort: string) => rs.filter((r) => r.cohort === cohort);

  // --- 判据 §5.2 的四个门，机械计算 ---------------------------------------
  const f1Violations = foreign.filter((r) => r.physicalRows > 0 || r.distinctContent > 0);
  const F1 = {
    name: 'F1 foreign-domain 逐条返回数为 0（两套口径）',
    pass: f1Violations.length === 0,
    reading: `25 条中 ${f1Violations.length} 条非零；physicalRows 均 ${r3(mean(foreign.map((r) => r.physicalRows)))} / 最坏 ${worst(foreign.map((r) => r.physicalRows))}；` +
      `distinctContent 均 ${r3(mean(foreign.map((r) => r.distinctContent)))} / 最坏 ${worst(foreign.map((r) => r.distinctContent))}`,
    violations: f1Violations.map((r) => ({ id: r.id, cohort: r.cohort, physicalRows: r.physicalRows, distinctContent: r.distinctContent, sources: r.resultSources })),
  };

  const n1Violations = near.flatMap((r) => {
    const bad = r.resultSources.filter((s) => s !== 'semantic');
    return bad.length ? [{ id: r.id, cohort: r.cohort, sources: r.resultSources }] : [];
  });
  const N1 = {
    name: 'N1 near-domain 返回项 100% 为 semantic',
    pass: n1Violations.length === 0,
    reading: `45 条中 ${n1Violations.length} 条含非 semantic 来源` +
      `（empty-zero-fts ${n1Violations.filter((v) => v.cohort === 'empty-zero-fts').length}/${byCohort(near, 'empty-zero-fts').length}、` +
      `lexical-anchor ${n1Violations.filter((v) => v.cohort === 'lexical-anchor').length}/${byCohort(near, 'lexical-anchor').length}）`,
    violations: n1Violations,
  };

  const nearDistinctMean = mean(near.map((r) => r.distinctContent));
  const N2 = {
    name: 'N2 near-domain 的 distinctContent 平均 ≤ 1',
    pass: nearDistinctMean <= 1,
    reading: `distinctContent 均 ${r3(nearDistinctMean)} / 最坏 ${worst(near.map((r) => r.distinctContent))}；` +
      `physicalRows 均 ${r3(mean(near.map((r) => r.physicalRows)))} / 最坏 ${worst(near.map((r) => r.physicalRows))}（并列参考，非判定口径）`,
  };

  const n3Total = rel.reduce((n, r) => n + r.nonAcceptableBeforePrimary, 0);
  const N3 = {
    name: 'N3 非 acceptable 排在 primary_gold 之前的次数为 0',
    pass: n3Total === 0,
    reading: `${n3Total} 次，涉及 ${rel.filter((r) => r.nonAcceptableBeforePrimary > 0).length} 条 query`,
    offenders: rel.filter((r) => r.nonAcceptableBeforePrimary > 0)
      .map((r) => ({ id: r.id, count: r.nonAcceptableBeforePrimary, primaryRank: r.primaryRank, page: r.resultIds })),
  };

  // --- S4：护栏自身没坏 ---------------------------------------------------
  const capViolations = rows.filter((r) => r.semanticOnly > arm.cap);
  const S4 = {
    name: `S4 逐 query semanticOnly ≤ cap(${arm.cap})`,
    pass: capViolations.length === 0,
    reading: capViolations.length ? `越界 ${capViolations.length} 条：${JSON.stringify(capViolations.slice(0, 5).map((r) => `${r.id}:${r.semanticOnly}`))}` : '131/131 满足',
  };

  const bands = Object.fromEntries(BANDS.map((b) => {
    const rs = rel.filter((r) => r.band === b.key);
    return [b.key, { n: rs.length, primaryHitAt5: r3(hitAt5(rs, 'primaryRank')), primaryMrr: r3(mrr(rs, 'primaryRank')) }];
  }));

  const summary = {
    arm: arm.id, floor: arm.floor, cap: arm.cap,
    diagnosticOnly: arm.cap <= 1,
    diagnosticReason: arm.cap <= 1 ? '判据 r3 §4.5：cap ≤ 1 让「平均返回 ≤1」成为算术恒真，不得作为成功候选' : null,
    relevance: {
      n: rel.length,
      primaryHitAt5: r3(hitAt5(rel, 'primaryRank')), primaryMrr: r3(mrr(rel, 'primaryRank')),
      primaryReached: rel.filter((r) => r.primaryRank != null).length,
      acceptableHitAt5: r3(hitAt5(rel, 'acceptableRank')), acceptableMrr: r3(mrr(rel, 'acceptableRank')),
      acceptableReached: rel.filter((r) => r.acceptableRank != null).length,
      nonAcceptableMean: r3(mean(rel.map((r) => r.nonAcceptable))),
      nonAcceptableWorst: worst(rel.map((r) => r.nonAcceptable)),
    },
    lowScoreBands: bands,
    hardNegative: {
      all: {
        n: negRows.length,
        physicalRowsMean: r3(mean(negRows.map((r) => r.physicalRows))),
        physicalRowsWorst: worst(negRows.map((r) => r.physicalRows)),
        distinctContentMean: r3(mean(negRows.map((r) => r.distinctContent))),
        distinctContentWorst: worst(negRows.map((r) => r.distinctContent)),
      },
      nearDomain: {
        n: near.length,
        physicalRowsMean: r3(mean(near.map((r) => r.physicalRows))), physicalRowsWorst: worst(near.map((r) => r.physicalRows)),
        distinctContentMean: r3(nearDistinctMean), distinctContentWorst: worst(near.map((r) => r.distinctContent)),
        byCohort: Object.fromEntries(['empty-zero-fts', 'lexical-anchor'].map((c) => {
          const rs = byCohort(near, c);
          return [c, { n: rs.length, physicalRowsMean: r3(mean(rs.map((r) => r.physicalRows))), distinctContentMean: r3(mean(rs.map((r) => r.distinctContent))), semanticOnlyMean: r3(mean(rs.map((r) => r.semanticOnly))) }];
        })),
      },
      foreignDomain: {
        n: foreign.length,
        physicalRowsMean: r3(mean(foreign.map((r) => r.physicalRows))), physicalRowsWorst: worst(foreign.map((r) => r.physicalRows)),
        distinctContentMean: r3(mean(foreign.map((r) => r.distinctContent))), distinctContentWorst: worst(foreign.map((r) => r.distinctContent)),
        zeroed: foreign.filter((r) => r.physicalRows === 0).length,
        byCohort: Object.fromEntries(['empty-zero-fts', 'lexical-anchor'].map((c) => {
          const rs = byCohort(foreign, c);
          return [c, { n: rs.length, physicalRowsMean: r3(mean(rs.map((r) => r.physicalRows))), zeroed: rs.filter((r) => r.physicalRows === 0).length }];
        })),
      },
    },
    aboveFloor: {
      relevance: { min: Math.min(...rel.map((r) => r.aboveFloorCount)), median: median(rel.map((r) => r.aboveFloorCount)), max: worst(rel.map((r) => r.aboveFloorCount)) },
      hardNegative: {
        min: Math.min(...negRows.map((r) => r.aboveFloorCount)),
        median: median(negRows.map((r) => r.aboveFloorCount)),
        max: worst(negRows.map((r) => r.aboveFloorCount)),
      },
    },
    gates: { F1, N1, N2, N3 },
    selfChecks: { S4 },
    elapsedMs: Date.now() - started,
  };
  armSummaries.push(summary);

  writeFileSync(
    join(ARM_DIR, `arm-${arm.id}.json`),
    `${JSON.stringify({ criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256 }, policy, summary, perQuery: rows }, null, 2)}\n`,
  );
  console.log(
    `[p3] ${arm.id.padEnd(11)} ${arm.cap <= 1 ? '(诊断)' : '      '} ` +
    `primary hit@5 ${(summary.relevance.primaryHitAt5 * 100).toFixed(1)}% MRR ${summary.relevance.primaryMrr} | ` +
    `F1 ${F1.pass ? '✅' : '❌'} N1 ${N1.pass ? '✅' : '❌'} N2 ${N2.pass ? '✅' : '❌'}(${r3(nearDistinctMean)}) N3 ${N3.pass ? '✅' : '❌'} | ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

// ---------------------------------------------------------------------------
// 5. 装置级自证 S2 / S3（跨 arm 恒定，取第一个 arm 的逐 query 读数）
// ---------------------------------------------------------------------------
const firstArmRows = read(join(ARM_DIR, `arm-${arms[0]!.id}.json`)).perQuery as Row[];
const leaks = firstArmRows.flatMap((r) => r.resultRawIds.filter((id) => !ageDays.has(id)));
const protocols = [...new Set(firstArmRows.map((r) => r.protocol))];
const S2 = {
  name: 'S2 装置结构：向量数 / 无泄漏 / 无 degrade / 协议单一',
  pass: scopeVectorCount === freeze.fixture.totalPhysicalRows && leaks.length === 0 &&
    firstArmRows.every((r) => !r.degraded) && protocols.length === 1 && protocols[0] === SEMANTIC_EN_PROTOCOL &&
    firstArmRows.every((r) => r.rejectReason == null),
  reading: `scope 向量 ${scopeVectorCount}/${freeze.fixture.totalPhysicalRows}；泄漏 ${leaks.length}；` +
    `degrade ${firstArmRows.filter((r) => r.degraded).length}；协议 ${JSON.stringify(protocols)}；` +
    `英文 query 被护栏拒绝 ${firstArmRows.filter((r) => r.rejectReason != null).length}/${firstArmRows.length}`,
};

const emptyRows = firstArmRows.filter((r) => r.cohort === 'empty-zero-fts');
const anchorRows = firstArmRows.filter((r) => r.cohort === 'lexical-anchor');
const emptyNonZero = emptyRows.filter((r) => r.ftsCount !== 0);
const anchorZero = anchorRows.filter((r) => r.ftsCount < 1);
const S3 = {
  name: 'S3 本装置上零 FTS / 词面锚点的实测复核（判据 §4.6）',
  pass: emptyNonZero.length === 0 && anchorZero.length === 0,
  reading: `empty ${emptyRows.length - emptyNonZero.length}/${emptyRows.length} 条 ftsCount=0；` +
    `锚点 ${anchorRows.length - anchorZero.length}/${anchorRows.length} 条 ftsCount≥1（` +
    `实测区间 ${Math.min(...anchorRows.map((r) => r.ftsCount))}…${worst(anchorRows.map((r) => r.ftsCount))}）`,
  emptyViolations: emptyNonZero.map((r) => ({ id: r.id, ftsCount: r.ftsCount })),
  anchorViolations: anchorZero.map((r) => ({ id: r.id, ftsCount: r.ftsCount })),
};

const selfChecks = [
  { name: `S1 冻结 SHA 校验 ${p2Checks.length}/${p2Checks.length}`, pass: true, reading: `P3 判据 + P2 冻结 ${p2Checks.length} 项逐项一致` },
  S2, S3,
  { name: 'S4 逐 arm 的 semanticOnly ≤ cap', pass: armSummaries.every((a) => a.selfChecks.S4.pass), reading: armSummaries.map((a) => `${a.arm}:${a.selfChecks.S4.pass ? '✅' : '❌'}`).join(' ') },
  S5, S6,
];

// ---------------------------------------------------------------------------
// 6. 汇总输出
// ---------------------------------------------------------------------------
const out = {
  generatedAt: new Date().toISOString(),
  role: '机械仪表输出。门 F1/N1/N2/N3 与自证 S1–S6 为预登记项，机械计算；arm 的选择由 select-safety-round-arm.ts 计算，裁定由复核方作。',
  criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256 },
  freeze: { path: FREEZE, frozenAt: freeze.frozenAt, shaVerified: p2Checks.map((c) => ({ name: c.name, path: c.path, sha256: c.want })) },
  provenance: {
    harnessSha256: createHash('sha256').update(readFileSync(import.meta.path)).digest('hex').slice(0, 16),
    dbPath: DB_PATH, scopeKey: SCOPE, spaceKey: SPACE_KEY, embeddingModel: EMBEDDING_MODEL, dimensions: DIMENSIONS,
    limit: LIMIT,
    insertionOrder: '新 40（按 insertion_index 升序）→ 旧 26 → filler 50,000，与已消耗审计装置同为 gold-first',
    fixture: {
      newGold: newRecords.length, oldPrimary: oldTurns.length, filler: FILLER_ROWS,
      physicalRows: ageDays.size, scopeVectors: scopeVectorCount,
      newGoldAgeDays: freeze.fixture.newGold.ageDaysRange, oldPrimaryAgeDays: OLD_AGE_DAYS, spreadDays: SPREAD_DAYS,
    },
    embedding: { uniqueTexts: embedCalls, cacheHits: embedHits, note: '策略参数不进编码器，因此跨 arm 缓存与重复编码逐位等价（判据 §3.4）' },
    armsRun: arms.map((a) => a.id),
    armsSkipped: allArms.filter((a) => !arms.some((b) => b.id === a.id)).map((a) => a.id),
  },
  lowScoreBands: { counts: bandCounts, frozen: p2.queries.lowScorePositiveBands, perQuery: [...bandByQuery.entries()].map(([id, band]) => ({ id, band, cosine: cosineByQuery.get(id)! })) },
  selfChecks,
  arms: armSummaries,
};
const jsonPath = arg('json') ?? join(REPORT_DIR, 'p3-grid-results.json');
writeFileSync(jsonPath, `${JSON.stringify(out, null, 2)}\n`);

db.close();
if (!has('keep-db')) rmSync(DB_PATH, { force: true });

console.log('\n[p3] 结构自证：');
for (const s of selfChecks) console.log(`  ${s.pass ? '✅' : '❌'} ${s.name}\n       ${s.reading}`);
console.log(`\n[p3] 报告：${jsonPath}`);
console.log(`[p3] 每 arm 明细：${ARM_DIR}/arm-*.json`);
console.log('[p3] 下一步：bun run benchmark/select-safety-round-arm.ts');
