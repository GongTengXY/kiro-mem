/**
 * 安全策略轮次 P2：新记录 × 26 条旧 gold 的**重叠筛查**（判据 §5）。
 *
 * 三层里只执行前两层：
 *
 *   1 硬重复 —— 文本逐字相同 / 同 id。确定性判断，不用余弦。
 *   2 复核带 —— 余弦 > 0.450 标记 `overlap-review`，交人工按 `fact_source` 裁决。
 *   3 自动删除 —— **本轮不启用**（判据 §5.1）。
 *
 * 本脚本只**筛查**：它输出该由人看的对，不做去留决定，也不写任何阈值。
 * pilot（第 2 步）已实测两个分布在跨集口径下重叠 [0.558, 0.614]，自动化路线已登记为不可行。
 *
 * 用法：
 *   bun run benchmark/screen-safety-round-overlap.ts --record-set=safety-round-sample
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { loadDataset, annotationToResult, annotationSearchText, DATASET_DIR } from './dataset';
import type { Annotation } from './dataset';
import { semanticEnSearchTextFields, type SemanticEnRecord } from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';

const args = process.argv.slice(2);
const flag = (n: string, d?: string): string | undefined => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const recordSet = flag('record-set', 'safety-round')!;
const RECORD_FILES: Record<string, string> = {
  'safety-round-sample': 'turns-safety-round-sample.json',
  'safety-round': 'turns-safety-round.json',
};
const recordFile = RECORD_FILES[recordSet] ?? `${recordSet}.json`;

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => {
  console.error(`[screen] ✗ ${m}`);
  process.exit(1);
};
const r3 = (x: number): number => Number(x.toFixed(3));

const OUT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const FREEZE = join(OUT_DIR, 'p2-calibration-freeze.json');
const REVIEW_BAND = 0.45;

const freeze = read(FREEZE);
if (sha256(freeze.criteria) !== freeze.criteriaSha256) die('判据已被改动，冻结失效');
if (freeze.overlapReview.band !== REVIEW_BAND) die(`复核带与冻结值不一致：冻结 ${freeze.overlapReview.band}`);
if (freeze.overlapReview.autoDeleteEnabled !== false) die('冻结记录声称启用了自动删除，与判据 §5.1 冲突');
console.log(`[screen] 冻结校验通过（判据 / 复核带 ${REVIEW_BAND} / 自动删除关闭）`);

// --- 输入 -------------------------------------------------------------------
interface NewRecord {
  id: string;
  age_days?: number;
  fact_source?: { kind: string; path?: string; section?: string; symbol?: string; line?: number; sha?: string; supports?: string }[];
  annotation: Annotation;
}
const newRecords = (read(join(DATASET_DIR, recordFile)) as { records: NewRecord[] }).records;
const newEn = read(join(DATASET_DIR, `mirror-en-acp-records-${recordSet}.json`)).records as Record<string, SemanticEnRecord>;
const dataset = loadDataset();
const oldPrimary = dataset.turns.filter((t) => t.scope === 'primary');
const oldEn = read(join(DATASET_DIR, 'mirror-en-acp-records.json')).records as Record<string, SemanticEnRecord>;

// --- 第 0 层：fact_source 的机械可核验性 -------------------------------------
//
// 判据 §2.2 的"章节确实陈述该事实"必须人看，但三件事可以机械查：文件存在、
// 必填字段齐全、decision 至少两个来源。查不过的直接失败——判据 §8.7 禁止写出
// 无法核验的东西，而路径打错是最容易发生也最容易查的一种。
const factIssues: string[] = [];
for (const r of newRecords) {
  const fs = r.fact_source ?? [];
  if (!fs.length) factIssues.push(`${r.id}: 缺 fact_source`);
  if (r.annotation.memory_type === 'decision' && fs.length < 2) {
    factIssues.push(`${r.id}: memory_type=decision 至少需要 2 个 fact_source，实际 ${fs.length}`);
  }
  for (const [i, f] of fs.entries()) {
    const at = `${r.id}.fact_source[${i}]`;
    if (f.kind === 'report') {
      if (!f.path || !f.section) factIssues.push(`${at}: report 必须同时有 path 与 section`);
    } else if (f.kind === 'code') {
      if (!f.path || (!f.symbol && f.line === undefined)) factIssues.push(`${at}: code 必须有 path 与 symbol 或 line`);
    } else if (f.kind === 'commit') {
      if (!f.sha || !f.supports) factIssues.push(`${at}: commit 必须有 sha 与 supports`);
    } else {
      factIssues.push(`${at}: 未知 kind=${f.kind}`);
    }
    if (f.path) {
      try {
        readFileSync(join(import.meta.dir, '..', f.path));
      } catch {
        factIssues.push(`${at}: 路径不存在 ${f.path}`);
      }
    }
  }
}
if (factIssues.length) die(`fact_source 机械校验失败：\n  ${factIssues.join('\n  ')}`);
console.log(`[screen] fact_source 机械校验通过（${newRecords.length} 条，路径全部存在，decision 均 ≥2 来源）`);

// --- 第 1 层：硬重复 --------------------------------------------------------
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const oldText = new Map(oldPrimary.map((t) => [norm(annotationSearchText(t.annotation)), t.id]));
const hardDuplicates: { newId: string; oldId: string }[] = [];
const seenNew = new Map<string, string>();
for (const r of newRecords) {
  const key = norm(annotationSearchText(r.annotation));
  const hitOld = oldText.get(key);
  if (hitOld) hardDuplicates.push({ newId: r.id, oldId: hitOld });
  const hitNew = seenNew.get(key);
  if (hitNew) hardDuplicates.push({ newId: r.id, oldId: `(新集内) ${hitNew}` });
  seenNew.set(key, r.id);
  if (oldPrimary.some((t) => t.id === r.id)) hardDuplicates.push({ newId: r.id, oldId: `${r.id}（id 撞车）` });
}
console.log(`[screen] 第 1 层硬重复：${hardDuplicates.length} 对`);

// --- 第 2 层：复核带 --------------------------------------------------------
type Vec = Float32Array;
const dot = (a: Vec, b: Vec): number => {
  let s = 0;
  for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!;
  return s;
};
const embed = async (en: SemanticEnRecord, files: string[]): Promise<Vec> =>
  generateEmbedding(buildObservationSearchText(semanticEnSearchTextFields(en, files)));

const oldVecs: { id: string; v: Vec }[] = [];
for (const t of oldPrimary) {
  oldVecs.push({ id: t.id, v: await embed(oldEn[t.id] ?? die(`旧记录缺英文派生值 ${t.id}`), annotationToResult(t.annotation).files_touched) });
}
const newVecs: { id: string; v: Vec }[] = [];
for (const r of newRecords) {
  newVecs.push({ id: r.id, v: await embed(newEn[r.id] ?? die(`新记录缺英文派生值 ${r.id}（先跑 probe-acp-translate --record-set=${recordSet}）`), annotationToResult(r.annotation).files_touched) });
}

const pairs: { newId: string; oldId: string; cosine: number }[] = [];
for (const n of newVecs) for (const o of oldVecs) pairs.push({ newId: n.id, oldId: o.id, cosine: dot(n.v, o.v) });
const sorted = pairs.map((p) => p.cosine).sort((a, b) => a - b);
const q = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
const band = pairs.filter((p) => p.cosine > REVIEW_BAND).sort((a, b) => b.cosine - a.cosine);

/** 新集内部两两——第 4 步要靠它发现自己造出来的重复。 */
const innerPairs: { a: string; b: string; cosine: number }[] = [];
for (let i = 0; i < newVecs.length; i++)
  for (let j = i + 1; j < newVecs.length; j++)
    innerPairs.push({ a: newVecs[i]!.id, b: newVecs[j]!.id, cosine: dot(newVecs[i]!.v, newVecs[j]!.v) });
const innerBand = innerPairs.filter((p) => p.cosine > REVIEW_BAND).sort((a, b) => b.cosine - a.cosine);

const out = {
  step: `P2 重叠筛查 · ${recordSet}`,
  criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256, section: '§5' },
  reviewBand: REVIEW_BAND,
  autoDeleteEnabled: false,
  inputs: [
    { path: `benchmark/dataset/${recordFile}`, sha256: sha256(join(DATASET_DIR, recordFile)) },
    { path: `benchmark/dataset/mirror-en-acp-records-${recordSet}.json`, sha256: sha256(join(DATASET_DIR, `mirror-en-acp-records-${recordSet}.json`)) },
  ],
  counts: { newRecords: newRecords.length, oldGold: oldVecs.length, pairs: pairs.length },
  factSourceCheck: { passed: true, checked: newRecords.length },
  layer1HardDuplicate: { count: hardDuplicates.length, entries: hardDuplicates },
  layer2ReviewBand: {
    distribution: { min: r3(sorted[0]!), p50: r3(q(0.5)), p95: r3(q(0.95)), max: r3(sorted.at(-1)!) },
    count: band.length,
    entries: band.map((p) => ({ newId: p.newId, oldId: p.oldId, cosine: r3(p.cosine), verdict: 'PENDING-HUMAN' })),
  },
  withinNewSet: {
    pairs: innerPairs.length,
    max: innerPairs.length ? r3(Math.max(...innerPairs.map((p) => p.cosine))) : null,
    count: innerBand.length,
    entries: innerBand.map((p) => ({ a: p.a, b: p.b, cosine: r3(p.cosine), verdict: 'PENDING-HUMAN' })),
  },
};
mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `p2-overlap-screen-${recordSet}.json`);
writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

console.log(`[screen] 新 × 旧 ${pairs.length} 对：min ${out.layer2ReviewBand.distribution.min} / p50 ${out.layer2ReviewBand.distribution.p50} / p95 ${out.layer2ReviewBand.distribution.p95} / max ${out.layer2ReviewBand.distribution.max}`);
console.log(`[screen] 进复核带（> ${REVIEW_BAND}）：${band.length} 对`);
for (const e of out.layer2ReviewBand.entries) console.log(`   ${e.newId} × ${e.oldId}  ${e.cosine}`);
console.log(`[screen] 新集内部 ${innerPairs.length} 对，进复核带 ${innerBand.length} 对${innerBand.length ? '：' : ''}`);
for (const e of out.withinNewSet.entries) console.log(`   ${e.a} × ${e.b}  ${e.cosine}`);
console.log(`[screen] 写入 ${outPath}（裁决字段全为 PENDING-HUMAN，需按 fact_source 逐对判）`);
