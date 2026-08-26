#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F2 第二段：装置构建 + S2–S4 自证**（判据 r3 §3、§7）。
 *
 * 装置构成（判据 §3.1 / §3.2，冻结记录 `f1-freeze.json` 的 `payload.fixture`）：
 *
 *   40 条新 gold + 26 条旧 gold + 50,000 条英文 filler（10,000 × 5 副本）
 *   + 10,000 条中文 filler = **60,066 行**
 *
 * 向量全部走 `semantic-en-v1`：新旧 gold 用 ACP 英文镜像，中文 filler 用**同一套模板的
 * 英文面**（判据 §3.1「向量」行：它是 filler 不是 gold，因此不调 ACP）。
 * 真实编码 20,066 次——英文 filler 的 5 份副本共享同一条向量（与 P3 同口径）。
 *
 * ## 年龄与插入顺序（§3.2）
 *
 * 新 gold 的 `age_days` 与插入顺序**在这里确定性生成并落盘**，随后由 `f2-freeze.json`
 * 冻结。它属装置布局而非数据内容，所以不在 F1 冻结范围内；但它必须可复算，
 * 否则 `id ASC` 与年龄的解耦就成了一句口头声明。
 *
 * 用法：
 *   bun run benchmark/run-fts-round-f2-fixture.ts            # 建装置 + 自证
 *   bun run benchmark/run-fts-round-f2-fixture.ts --reuse    # 复用已建好的库，只跑自证
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { verifyFreezeRecordFile } from './freeze-util';
import {
  SEMANTIC_EN_PROTOCOL, embeddingSpaceKey, semanticEnSearchTextFields, type SemanticEnRecord,
} from '../src/semantic-en';
import {
  generateEmbedding, buildObservationSearchText, embeddingToBlob, DIMENSIONS, EMBEDDING_MODEL,
} from '../src/embedding';
import { annotationToResult, type Annotation, type DatasetTurn } from './dataset';

const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const has = (n: string): boolean => process.argv.includes(`--${n}`);
/** r4 §14：新轮次读写 -r2 后缀；原 f2-fixture.json 逐字节保留为拦截证据。 */
const SUFFIX = arg('suffix') ?? '-r2';
const die = (m: string): never => { console.error(`[f2-fixture] ✗ ${m}`); process.exit(1); };
const r4 = (x: number): number => Number(x.toFixed(4));

export const DB_PATH = arg('db') ?? join(process.env.TMPDIR ?? '/tmp', 'fts-round-f2.db');
export const CWD = '/fts-round/primary';
export const SCOPE = computeScopeKey(CWD, CWD);
const SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const NOW = Date.now();
const SPREAD_DAYS = 1095;
const OLD_AGE_DAYS = 400;
const FILLER_EN_ROWS = 50_000;
/** 新 gold 的年龄与插入顺序的随机源。写入 f2-freeze.json，逐位可复算。 */
const LAYOUT_SEED = 0xf2_2026;

// --- S1：冻结校验 -------------------------------------------------------------
const freezePath = join(REPORTS, `f1-freeze${SUFFIX}.json`);
const v = verifyFreezeRecordFile(freezePath);
console.log(`[f2-fixture] S1 冻结校验：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) die('F1 冻结物已漂移');
const f1 = read(freezePath);
const expectRows = f1.payload.fixture.totalPhysicalRows as number;

// --- 输入 --------------------------------------------------------------------
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string; annotation: Annotation }[];
const oldTurns = (read(join(DATASET, 'turns.json')) as DatasetTurn[]).filter((t) => t.scope === 'primary');
const recordMirror = read(join(DATASET, 'mirror-en-acp-records-fts-round.json')).records as Record<string, SemanticEnRecord>;
const fillerEn = read(join(DATASET, 'pool-policy-filler-10k.json')) as Array<{
  title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}>;
const fillerZh = read(join(DATASET, 'fts-round-filler-zh-10k.json')) as Array<{
  id: string; title: string; summary: string; outcome: string; learned: string;
  concepts: string[]; files: string[]; en: SemanticEnRecord;
}>;
const corpusMeta = read(join(DATASET, 'fts-round-filler-zh-10k-meta.json'));
const queries = read(join(DATASET, `queries-fts-round${SUFFIX}.json`)).queries as Array<{
  id: string; cohort: string; lexical_negative_class?: string; protection_class?: string; query: string;
}>;

/** 确定性 PRNG，与语料生成器同一实现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 新 gold 的年龄与插入顺序：**刻意解耦**（§3.2）。
 *
 * 年龄在 30…900 天之间按 seed 均匀取值，插入顺序是另一次独立洗牌，
 * 因此 `id ASC` 在本装置上不再等价于 oldest-first——那条 bm25 并列时的排序键
 * 因此不会与年龄相关，避免把"老记录赢"误读成排序键的效果。
 */
const layoutRnd = mulberry32(LAYOUT_SEED);
const layout = records.map((r) => ({ id: r.id, ageDays: 30 + Math.floor(layoutRnd() * 871) }));
const insertionOrder = [...records.map((r) => r.id)];
for (let i = insertionOrder.length - 1; i > 0; i--) {
  const j = Math.floor(layoutRnd() * (i + 1));
  [insertionOrder[i], insertionOrder[j]] = [insertionOrder[j]!, insertionOrder[i]!];
}
const ageOf = new Map(layout.map((l) => [l.id, l.ageDays]));

// --- 播种 --------------------------------------------------------------------
if (!has('reuse')) for (const s of ['', '-wal', '-shm']) if (existsSync(DB_PATH + s)) rmSync(DB_PATH + s, { force: true });
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new MemoryDB(DB_PATH);
const raw = (db as unknown as { db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } } }).db;

const obsByDataset = new Map<string, number>();
const datasetByObs = new Map<number, string>();
const contentKeyByObs = new Map<number, string>();

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
const embedEn = (en: SemanticEnRecord, files: string[]): Promise<Float32Array> =>
  generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(en, files)));

if (!has('reuse')) {
  const t0 = Date.now();
  // 1) 新 gold 40 条：按洗牌后的插入顺序，时间戳用各自 age_days
  for (const id of insertionOrder) {
    const rec = records.find((r) => r.id === id)!;
    const en = recordMirror[id] ?? die(`记录缺英文镜像：${id}`);
    const res = annotationToResult(rec.annotation);
    const at = new Date(NOW - ageOf.get(id)! * 86400000).toISOString();
    const obsId = insert({
      session: 'fts-round-new', title: res.title, summary: res.summary, outcome: res.outcome,
      learned: res.learned, concepts: res.concepts, files: res.files_touched, at,
    });
    db.upsertObservationSemanticText({ observation_id: obsId, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready', payload: en, translator: 'f2-fixture(frozen new gold)' });
    db.upsertObservationEmbedding(obsId, SPACE_KEY, DIMENSIONS, embeddingToBlob(await embedEn(en, res.files_touched)));
    obsByDataset.set(id, obsId); datasetByObs.set(obsId, id); contentKeyByObs.set(obsId, id);
  }
  // 2) 旧 gold 26 条：全部 400 天前，分钟间隔
  const oldEn = read(join(DATASET, 'mirror-en-acp-records.json')).records as Record<string, SemanticEnRecord>;
  const oldBase = NOW - OLD_AGE_DAYS * 86400000;
  for (const t of oldTurns) {
    const en = oldEn[t.id] ?? die(`旧记录缺英文镜像：${t.id}`);
    const res = annotationToResult(t.annotation);
    const obsId = insert({
      session: 'gold-old', title: res.title, summary: res.summary, outcome: res.outcome,
      learned: res.learned, concepts: res.concepts, files: res.files_touched,
      at: new Date(oldBase + minute++ * 60_000).toISOString(),
    });
    db.upsertObservationSemanticText({ observation_id: obsId, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready', payload: en, translator: 'f2-fixture(frozen old gold)' });
    db.upsertObservationEmbedding(obsId, SPACE_KEY, DIMENSIONS, embeddingToBlob(await embedEn(en, res.files_touched)));
    obsByDataset.set(t.id, obsId); datasetByObs.set(obsId, t.id); contentKeyByObs.set(obsId, t.id);
  }
  console.log(`[f2-fixture] gold 播种完成：新 40 + 旧 ${oldTurns.length}，${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 3) 英文 filler 50,000 = 10,000 条真实编码 × 5 份副本
  const tEn = Date.now();
  const enVec: Buffer[] = [];
  for (const f of fillerEn) {
    enVec.push(embeddingToBlob(await embedEn(
      { title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts },
      f.files,
    )));
  }
  console.log(`[f2-fixture] 英文 filler 编码 ${enVec.length} 条：${((Date.now() - tEn) / 1000).toFixed(1)}s`);
  const startEn = NOW - SPREAD_DAYS * 86400000;
  const stepEn = (SPREAD_DAYS * 86400000) / (FILLER_EN_ROWS - 1);
  for (let i = 0; i < FILLER_EN_ROWS; i++) {
    const src = i % fillerEn.length;
    const copy = Math.floor(i / fillerEn.length);
    const f = fillerEn[src]!;
    const obsId = insert({
      session: 'filler-en',
      title: copy === 0 ? f.title : `${f.title} [copy ${copy}]`,
      summary: f.summary, outcome: f.outcome, learned: f.learned,
      concepts: f.concepts, files: f.files,
      at: new Date(startEn + Math.round(i * stepEn)).toISOString(),
    });
    db.upsertObservationSemanticText({ observation_id: obsId, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready', payload: { title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned, concepts: f.concepts }, translator: 'f2-fixture(frozen filler-en)' });
    db.upsertObservationEmbedding(obsId, SPACE_KEY, DIMENSIONS, enVec[src]!);
    contentKeyByObs.set(obsId, `filler-en#${src}`);
  }

  // 4) 中文 filler 10,000：向量走模板英文面，不做副本
  const tZh = Date.now();
  const startZh = NOW - SPREAD_DAYS * 86400000;
  const stepZh = (SPREAD_DAYS * 86400000) / (fillerZh.length - 1);
  for (let i = 0; i < fillerZh.length; i++) {
    const f = fillerZh[i]!;
    const obsId = insert({
      session: 'filler-zh', title: f.title, summary: f.summary, outcome: f.outcome,
      learned: f.learned, concepts: f.concepts, files: f.files,
      at: new Date(startZh + Math.round(i * stepZh)).toISOString(),
    });
    db.upsertObservationSemanticText({ observation_id: obsId, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready', payload: f.en, translator: 'f2-fixture(frozen filler-zh template en face)' });
    db.upsertObservationEmbedding(obsId, SPACE_KEY, DIMENSIONS, embeddingToBlob(await embedEn(f.en, f.files)));
    contentKeyByObs.set(obsId, `filler-zh#${i}`);
  }
  console.log(`[f2-fixture] 中文 filler 编码 ${fillerZh.length} 条：${((Date.now() - tZh) / 1000).toFixed(1)}s`);
} else {
  // 复用已播种的库时必须重建数据集 id → Observation id 的映射，否则所有 gold 查询都会
  // 落到 -1，把"可达"读成"不可达"。按标题回查即可：标题在装置里唯一（语料自证保证）。
  for (const rec of records) {
    const title = annotationToResult(rec.annotation).title;
    const row = (raw.query('SELECT id FROM observations WHERE scope_key = ? AND title = ? LIMIT 1').all(SCOPE, title) as { id: number }[])[0];
    if (row) { obsByDataset.set(rec.id, row.id); datasetByObs.set(row.id, rec.id); }
  }
  for (const t of oldTurns) {
    const title = annotationToResult(t.annotation).title;
    const row = (raw.query('SELECT id FROM observations WHERE scope_key = ? AND title = ? LIMIT 1').all(SCOPE, title) as { id: number }[])[0];
    if (row) { obsByDataset.set(t.id, row.id); datasetByObs.set(row.id, t.id); }
  }
  console.log(`[f2-fixture] 复用装置：重建 id 映射 ${obsByDataset.size} 条`);
}

// --- S2：装置结构 -------------------------------------------------------------
const rowCount = (raw.query('SELECT count(*) AS n FROM observations WHERE scope_key = ?').all(SCOPE) as { n: number }[])[0]!.n;
const totalRows = (raw.query('SELECT count(*) AS n FROM observations').all() as { n: number }[])[0]!.n;
const scopeVectors = db.countScopeVectors({ scopeKey: SCOPE, model: SPACE_KEY, dimensions: DIMENSIONS });
const protocols = raw.query('SELECT DISTINCT protocol AS p FROM observation_semantic_texts').all() as { p: string }[];
const zhRows = (raw.query(
  `SELECT count(*) AS n FROM observations WHERE scope_key = ? AND (title GLOB '*[一-龥]*' OR summary GLOB '*[一-龥]*')`,
).all(SCOPE) as { n: number }[])[0]!.n;

// --- S3：中文语料自证（判据 §7 S3，两个分母分开报）----------------------------
const df = (unit: string): number => (raw.query(
  `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o
     ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`,
).all(`"${unit.replaceAll('"', '""')}"`, SCOPE) as { n: number }[])[0]!.n;

const ZH_ROWS = fillerZh.length;
const functionWords = (corpusMeta.functionWords as { word: string; share: number }[]).map((fw) => {
  const d = df(fw.word);
  const perZh = d / ZH_ROWS;
  const perScope = d / rowCount;
  const deviation = fw.share === 0 ? 0 : (perZh - fw.share) / fw.share;
  return {
    word: fw.word, df: d, target: fw.share,
    dfOverZhRecords: r4(perZh), dfOverScope: r4(perScope),
    relativeDeviation: r4(deviation), pass: Math.abs(deviation) <= 0.2,
  };
});

// --- S4：词面命中自证 ---------------------------------------------------------
const ftsCount = (q: string): number => (raw.query(
  `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o
     ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`,
).all(extractFtsSearchUnits(q).map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ') || '""', SCOPE) as { n: number }[])[0]!.n;

const negatives = queries.filter((q) => q.cohort === 'lexical-anchor');
/** 生产检索分支（含 LIKE 回退）；limit 放大只为判定"可达"，与预检同一口径。 */
const lexicalHits = (q: string, limit = 2000): number[] =>
  db.searchObservationsFts(q, { scopeKey: SCOPE, limit }).map((o) => o.id);
const negHits = negatives.map((q) => ({ id: q.id, cls: q.lexical_negative_class!, ftsCount: extractFtsSearchUnits(q.query).length ? ftsCount(q.query) : 0 }));
const negZero = negHits.filter((h) => h.ftsCount < 1);
const posHits = queries.filter((q) => q.cohort === 'new-relevance' || q.cohort === 'protection')
  .map((q) => ({ id: q.id, cohort: q.cohort, units: extractFtsSearchUnits(q.query).length, ftsCount: extractFtsSearchUnits(q.query).length ? ftsCount(q.query) : 0 }));

// --- r4 §16.2：与冻结前预检逐条一致性 ---
const precheck = read(join(REPORTS, `f1-precheck${SUFFIX}.json`));
const preNeg = new Map((precheck.negatives as { id: string; ftsCount: number }[]).map((n) => [n.id, n.ftsCount]));
const preProt = new Map((precheck.protections as { id: string; primaryLexicalReachable: boolean; primaryLexicalRank: number | null }[]).map((p) => [p.id, p]));
const negMismatch = negHits.filter((h) => {
  // 预检的 ftsCount 是**带可达上限（2000）的返回列表长度**，会在超限时饱和；
  // 这里的 ftsCount 是无上限的 count(*)。拿饱和值与真实值比会报出假的不一致
  // （实测 5 条：预检 2000 vs F2 2502…2899）。因此比较同口径的截断值，
  // 真实计数另列在 s4.negatives[].ftsCount 里。
  //
  // 门的结论不受影响：Q1 判的是 ≥1，Q3/Q4 判的是 gold 是否在返回集合里，
  // 而全部 gold 的命中位次都远小于 2000（见 f1-precheck-r2.json）。
  const capped = Math.min(h.ftsCount, 2000);
  return preNeg.get(h.id) !== capped;
}).map((h) => `${h.id}: 预检 ${preNeg.get(h.id)} vs F2(同口径) ${Math.min(h.ftsCount, 2000)}`);
const protMismatch: string[] = [];
for (const [id, pre] of preProt) {
  const hits = lexicalHits(queries.find((q) => q.id === id)!.query);
  const goldIds = (queries.find((q) => q.id === id) as any).primary_gold?.map((g: string) => obsByDataset.get(g) ?? -1) ?? [];
  const rank = goldIds.map((x: number) => hits.indexOf(x)).filter((i: number) => i >= 0).sort((a: number, b: number) => a - b)[0];
  const reachable = rank !== undefined;
  if (reachable !== pre.primaryLexicalReachable || (reachable ? rank! + 1 : null) !== pre.primaryLexicalRank) {
    protMismatch.push(`${id}: 预检 ${pre.primaryLexicalReachable}/${pre.primaryLexicalRank} vs F2 ${reachable}/${reachable ? rank! + 1 : null}`);
  }
}

// --- 报告 --------------------------------------------------------------------
const checks = [
  { name: 'r4 §16.2 预检一致', pass: negMismatch.length === 0 && protMismatch.length === 0, detail: [...negMismatch, ...protMismatch].slice(0, 6).join('; ') || '负例 40 + 保护线 40 逐条一致' },
  { name: 'S2 物理行数', pass: rowCount === expectRows, detail: `${rowCount} / 期望 ${expectRows}` },
  { name: 'S2 无跨域行', pass: totalRows === rowCount, detail: `全库 ${totalRows} = 作用域内 ${rowCount}` },
  { name: 'S2 向量齐全', pass: scopeVectors === rowCount, detail: `${scopeVectors} / ${rowCount}` },
  { name: 'S2 协议单一', pass: protocols.length === 1 && protocols[0]!.p === SEMANTIC_EN_PROTOCOL, detail: protocols.map((p) => p.p).join(',') },
  { name: 'S3 中文行数', pass: zhRows >= ZH_ROWS, detail: `含中文 ${zhRows}（≥ ${ZH_ROWS}，gold 也含中文）` },
  { name: 'S3 功能词占比', pass: functionWords.every((f) => f.pass), detail: functionWords.filter((f) => !f.pass).map((f) => `${f.word} 偏差 ${f.relativeDeviation}`).join('; ') || '全部在 ±20% 内' },
  { name: 'S4 负例词面命中', pass: negZero.length === 0, detail: negZero.length ? `${negZero.length} 条命中 <1：${negZero.map((h) => h.id).join(' ')}` : `40 条全部 ≥1（区间 ${Math.min(...negHits.map((h) => h.ftsCount))}…${Math.max(...negHits.map((h) => h.ftsCount))}）` },
];

mkdirSync(REPORTS, { recursive: true });
writeFileSync(join(REPORTS, `f2-fixture${SUFFIX}.json`), `${JSON.stringify({
  purpose: 'F2 第二段：装置构建 + S2–S4 自证（判据 r3 §3、§7）。',
  generatedAt: new Date().toISOString(),
  freeze: { path: freezePath, verify: v.label },
  fixture: {
    dbPath: DB_PATH, scopeKey: SCOPE, rows: rowCount, scopeVectors,
    embeddingModel: EMBEDDING_MODEL, spaceKey: SPACE_KEY, dimensions: DIMENSIONS,
    composition: { newGold: 40, oldGold: oldTurns.length, fillerEn: FILLER_EN_ROWS, fillerEnSourceRows: fillerEn.length, fillerZh: fillerZh.length },
    realEncodes: 40 + oldTurns.length + fillerEn.length + fillerZh.length,
    spreadDays: SPREAD_DAYS, oldGoldAgeDays: OLD_AGE_DAYS,
  },
  layout: { seed: LAYOUT_SEED, note: '年龄与插入顺序刻意解耦（判据 §3.2）', ageDays: layout, insertionOrder },
  s2: { rows: rowCount, totalRows, scopeVectors, protocols: protocols.map((p) => p.p), zhRows },
  s3: { zhRecords: ZH_ROWS, functionWords, note: '比对口径是 df / 中文记录数；df / scopeSize 单独报，不参与比对（判据 §7 S3 第 2–3 条）' },
  s4: { negatives: negHits, positives: posHits },
  checks,
  pass: checks.every((c) => c.pass),
}, null, 2)}\n`);

console.log(`\n[f2-fixture] 自证`);
for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name.padEnd(16)} ${c.detail}`);
console.log(`\n[f2-fixture] S3 功能词（df / 中文记录数 vs 目标；df / scopeSize 单独列）`);
for (const f of functionWords) {
  console.log(`  ${f.word.padEnd(5)} df=${String(f.df).padStart(5)}  /中文=${f.dfOverZhRecords}  目标=${f.target}  偏差=${(f.relativeDeviation * 100).toFixed(1)}%  /scope=${f.dfOverScope}`);
}
console.log(`\n[f2-fixture] → ${join(REPORTS, `f2-fixture${SUFFIX}.json`)}`);
db.close();
if (!checks.every((c) => c.pass)) process.exit(1);
