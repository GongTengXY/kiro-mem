#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F2 第一段：四档分层测量**（判据 r3 §4.4）。
 *
 * 为什么单独一段先跑：它只需要 120 条向量（80 条正例 query 的英文形 + 40 条记录的英文镜像），
 * 一分钟内出结果；而整套装置要给 60,066 行真实编码 20,066 次。**若某档不足 8 条，
 * 现在发现比编码完再发现便宜二十倍。**
 *
 * 口径（判据 §4.4，r2 复核第 3 项裁定后的形态）：
 *
 *  - 分层对象是**全部 80 条正例** = 40 条 relevance + 40 条召回保护线；
 *  - 分层键是 query→自己 `primary_gold` 的**最高**余弦（多个 primary 取最大）；
 *  - 四档 `[<0.200) / [0.200,0.310) / [0.310,0.400) / [≥0.400)`；
 *  - 并集每档 ≥ 8 条；另报 relevance 与保护线各自的四档（只作归因，不参与判定）。
 *
 * **纯拉丁 / 路径 / 数字 query 走恒等归一化**（护栏允许英文原文归一化为自身），
 * 因此它们的英文形就是原文本身，与 F1 冻结记录里的 `mirror.queriesIdentity` 一致。
 *
 * 用法：bun run benchmark/run-fts-round-f2-strata.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyFreezeRecordFile } from './freeze-util';
import {
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
  semanticEnSearchTextFields,
  type SemanticEnRecord,
} from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';
import { annotationToResult, type Annotation } from './dataset';

const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
/** r4 §14：新轮次用 r2 数据与 r2 输出路径；原 f2-strata.json 逐字节保留。 */
const SUFFIX = arg('suffix') ?? '-r2';
const r3 = (x: number): number => Number(x.toFixed(3));
const die = (m: string): never => { console.error(`[f2-strata] ✗ ${m}`); process.exit(1); };

// --- S1：冻结校验（判据 §7 S1，计数标签由 freeze-util 生成）--------------------
//
// 裁定的执行顺序是「重测四档 → 新路径冻结」，因此**冻结前**这一步没有冻结记录可校验。
// 允许 `--pre-freeze`：跳过校验并在输出里显式登记跳过原因；该次输出的 SHA 随后进入
// `f1-freeze-r2.json`。冻结之后 F2 必须再跑一次（带校验），两次结果不一致则整轮作废。
const freezePath = join(REPORTS, arg('freeze') ?? `f1-freeze${SUFFIX}.json`);
const preFreeze = process.argv.includes('--pre-freeze');
let v: { ok: boolean; label: string; failures: { name: string; path: string; expected: string; actual: string | null }[] };
if (preFreeze) {
  v = { ok: true, label: '跳过（--pre-freeze：冻结记录尚未生成，本次读数将进入该记录）', failures: [] };
  console.log(`[f2-strata] S1 冻结校验：${v.label}`);
} else {
  v = verifyFreezeRecordFile(freezePath);
  console.log(`[f2-strata] S1 冻结校验：${v.label} → ${v.ok ? '✓' : '✗'}`);
  if (!v.ok) {
    for (const f of v.failures) console.error(`  - ${f.name} (${f.path}) expected=${f.expected} actual=${f.actual}`);
    die('F1 冻结物已漂移，装置定义不可信');
  }
}

// --- 输入 --------------------------------------------------------------------
interface Q {
  id: string; kind: string; cohort: string; protection_class?: string;
  query: string; primary_gold?: string[]; acceptable_gold?: string[];
}
const queries = read(join(DATASET, `queries-fts-round${SUFFIX}.json`)).queries as Q[];
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string; annotation: Annotation }[];
const queryMirror = read(join(DATASET, `mirror-en-acp-queries-fts-round${SUFFIX}.json`)).queries as Record<string, string>;
const recordMirror = read(join(DATASET, 'mirror-en-acp-records-fts-round.json')).records as Record<string, SemanticEnRecord>;

const positives = queries.filter((q) => q.cohort === 'new-relevance' || q.cohort === 'protection');
if (positives.length !== 80) die(`正例应为 80 条，实际 ${positives.length}`);

// --- 记录侧向量：与生产 embed_observation 同一条路径 --------------------------
const spaceKey = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const recVec = new Map<string, Float32Array>();
for (const rec of records) {
  const en = recordMirror[rec.id] ?? die(`记录缺英文镜像：${rec.id}`);
  const files = annotationToResult(rec.annotation).files_touched;
  recVec.set(rec.id, await generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(en, files))));
}

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};

// --- 逐条正例：query 英文形 → 自己 primary_gold 的最高余弦 --------------------
const BANDS = [
  { key: '<0.200', lo: -Infinity, hi: 0.2 },
  { key: '0.200-0.310', lo: 0.2, hi: 0.31 },
  { key: '0.310-0.400', lo: 0.31, hi: 0.4 },
  { key: '>=0.400', lo: 0.4, hi: Infinity },
] as const;
type BandKey = (typeof BANDS)[number]['key'];

const rows: { id: string; cohort: string; protectionClass?: string; identityEn: boolean; en: string; cosine: number; band: BandKey; primary: string[] }[] = [];
for (const q of positives) {
  const identityEn = !/[\u4e00-\u9fff]/.test(q.query);
  const en = queryMirror[q.id] ?? (identityEn ? q.query : die(`query 缺英文镜像：${q.id}`));
  const qv = await generateEmbedding(en);
  const best = Math.max(...(q.primary_gold ?? []).map((g) => dot(qv, recVec.get(g) ?? die(`${q.id} 的 primary_gold ${g} 不在记录集里`))));
  rows.push({
    id: q.id, cohort: q.cohort, ...(q.protection_class ? { protectionClass: q.protection_class } : {}),
    identityEn, en, cosine: r3(best),
    band: BANDS.find((b) => best >= b.lo && best < b.hi)!.key,
    primary: q.primary_gold ?? [],
  });
}

const countBy = (subset: typeof rows): Record<BandKey, number> =>
  Object.fromEntries(BANDS.map((b) => [b.key, subset.filter((r) => r.band === b.key).length])) as Record<BandKey, number>;

const union = countBy(rows);
const relevance = countBy(rows.filter((r) => r.cohort === 'new-relevance'));
const protection = countBy(rows.filter((r) => r.cohort === 'protection'));
const short = BANDS.filter((b) => union[b.key] < 8).map((b) => `${b.key}=${union[b.key]}`);

// --- 输出 --------------------------------------------------------------------
mkdirSync(REPORTS, { recursive: true });
const out = {
  purpose: 'F2 第一段：四档分层测量（判据 r3 §4.4）。',
  generatedAt: new Date().toISOString(),
  freeze: { path: freezePath, verify: v.label, ok: v.ok },
  space: { protocol: SEMANTIC_EN_PROTOCOL, spaceKey, dimensions: DIMENSIONS },
  bands: BANDS.map((b) => b.key),
  counts: { union, relevance, protection },
  requirement: '并集每档 ≥ 8 条（判据 §4.4 第 3 条）',
  pass: short.length === 0,
  shortBands: short,
  identityEnQueries: rows.filter((r) => r.identityEn).length,
  rows: rows.sort((a, b) => a.cosine - b.cosine),
};
writeFileSync(join(REPORTS, `f2-strata${SUFFIX}.json`), `${JSON.stringify(out, null, 2)}\n`);

console.log(`[f2-strata] 并集 80 条四档：${BANDS.map((b) => `${b.key}=${union[b.key]}`).join('  ')}`);
console.log(`[f2-strata]   relevance 40：${BANDS.map((b) => `${b.key}=${relevance[b.key]}`).join('  ')}`);
console.log(`[f2-strata]   保护线 40：${BANDS.map((b) => `${b.key}=${protection[b.key]}`).join('  ')}`);
console.log(`[f2-strata] 余弦范围 ${rows[0]!.cosine} … ${rows[rows.length - 1]!.cosine}；恒等英文形 ${out.identityEnQueries} 条`);
console.log(`[f2-strata] → ${join(REPORTS, `f2-strata${SUFFIX}.json`)}`);
if (short.length) {
  console.error(`[f2-strata] ✗ 以下档不足 8 条：${short.join('  ')}`);
  console.error('[f2-strata]   判据 §4.4 要求只补写 relevance query；但 F1 已冻结，补写需先取裁定。');
  process.exit(1);
}
console.log('[f2-strata] ✓ 四档均 ≥ 8 条');
