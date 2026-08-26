/**
 * 一次性有效性检查：两份英文译文之间到底差多少？
 *
 * 背景：译者来源的 2×2 分解四格全是 0.972，一位不差。这有两种完全相反的解释：
 *   (a) 编码器把译者漂移完全吸收了 —— 方案成立的强证据；
 *   (b) 两份译文本来就几乎一样 —— 实验里没有可检测的差异，读数什么都不证明。
 *
 * 不区分这两者就引用那个 0.972，就是 §9 纪律 4 说的"证据链中途换层"。所以先量漂移
 * 本身：逐条算手写译文与 ACP 译文的 cosine，以及词面重叠率（Jaccard）。
 *
 * 判读口径（跑之前写下）：
 *   - 若 cosine 中位数 > 0.98 且 Jaccard > 0.8 → 落 (b)，实验无效，需要更强的扰动
 *   - 若 cosine 中位数 < 0.95 或 Jaccard < 0.7 → 落 (a)，漂移真实存在且被吸收
 *   - 中间区间 → 证据力弱，需要更强扰动再测
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { DATASET_DIR, loadDataset, annotationSearchText } from './dataset';
import { buildObservationSearchText, generateEmbedding, cosineSimilarity } from '../src/embedding';

interface Mirror {
  records?: Record<string, { title: string; summary: string; outcome: string; learned: string; concepts: string[] }>;
  queries?: Record<string, string>;
}

const hand = JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en.json'), 'utf-8')) as Mirror;
const acpR = JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en-acp-records.json'), 'utf-8')) as Mirror;
const acpQ = JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en-acp-queries.json'), 'utf-8')) as Mirror;

const { turns } = loadDataset();
const filesOf = new Map(turns.map((t) => [t.id, t.annotation.key_files]));

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

function jaccard(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

// --- 记录侧 ---
const recRows: { id: string; cos: number; jac: number }[] = [];
for (const id of Object.keys(hand.records ?? {})) {
  const h = hand.records![id]!;
  const a = acpR.records?.[id];
  if (!a) continue;
  const files = filesOf.get(id) ?? [];
  const ht = buildObservationSearchText({ ...h, concepts: h.concepts, files });
  const at = buildObservationSearchText({ ...a, concepts: a.concepts, files });
  const [hv, av] = await Promise.all([generateEmbedding(ht), generateEmbedding(at)]);
  recRows.push({ id, cos: cosineSimilarity(hv, av), jac: jaccard(ht, at) });
}

// --- query 侧 ---
const qRows: { id: string; cos: number; jac: number; hand: string; acp: string }[] = [];
for (const id of Object.keys(acpQ.queries ?? {})) {
  const h = hand.queries?.[id];
  const a = acpQ.queries![id]!;
  if (!h) continue;
  const [hv, av] = await Promise.all([generateEmbedding(h), generateEmbedding(a)]);
  qRows.push({ id, cos: cosineSimilarity(hv, av), jac: jaccard(h, a), hand: h, acp: a });
}

const f = (x: number) => x.toFixed(3);
console.log('');
console.log('=== 译文漂移（手写 vs ACP，同一模型下的 cosine 与词面 Jaccard）===');
console.log('');
console.log(`记录侧 n=${recRows.length}  cosine 中位数=${f(median(recRows.map((r) => r.cos)))}  min=${f(Math.min(...recRows.map((r) => r.cos)))}  Jaccard 中位数=${f(median(recRows.map((r) => r.jac)))}`);
console.log(`query侧 n=${qRows.length}  cosine 中位数=${f(median(qRows.map((r) => r.cos)))}  min=${f(Math.min(...qRows.map((r) => r.cos)))}  Jaccard 中位数=${f(median(qRows.map((r) => r.jac)))}`);
console.log('');
console.log('--- query 侧逐条（按 cosine 升序，最不一致的在前）---');
for (const r of [...qRows].sort((a, b) => a.cos - b.cos).slice(0, 8)) {
  console.log(`${r.id}  cos=${f(r.cos)} jac=${f(r.jac)}`);
  console.log(`   手写: ${r.hand}`);
  console.log(`   ACP : ${r.acp}`);
}
console.log('');
console.log('--- 记录侧最不一致的 5 条 ---');
for (const r of [...recRows].sort((a, b) => a.cos - b.cos).slice(0, 5)) {
  console.log(`${r.id}  cos=${f(r.cos)} jac=${f(r.jac)}`);
}
