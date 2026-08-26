/**
 * 混合语料可比性探针：中文向量与英文向量能不能进同一个 cosine 排序表？
 *
 * 为什么这是个独立问题：把"入库译成英文 + 检索用英文"上线之后，**迁移窗口内语料必然
 * 是混的**——已重算的记录是英文向量，还没轮到的是中文向量，`quality=fallback` 的记录
 * 可能永远没有译文。而 `hybridSearchObservations` 把所有候选放进**一张** cosine 排序表
 * （`scored.sort` 之后统一编号喂给 RRF），所以两类向量必须在同一标度上可比。
 *
 * 已知的怀疑来自 §1.1 的实测：无关**中文**句对的 cosine 地板约 0.417，而无关**英文**句对
 * 是 −0.048。如果这个"中文侧整体偏高"也出现在"英文 query × 中文记录"上，那么未翻译的
 * 记录会因为**标度**而不是因为**相关性**系统性地压过已翻译的记录——迁移期间的检索质量
 * 会比迁移前后**两个端点都差**，而且没有任何报错。
 *
 * 两个最坏情形分别测（不是取平均，平均会把它们互相抵消）：
 *   - 配置 X：期望记录**已翻译**，其余全是中文 → 已翻译的信号 vs 未翻译的噪声
 *   - 配置 Y：期望记录**未翻译**，其余全是英文 → 未翻译的信号 vs 已翻译的噪声
 *
 * query 侧一律用 ACP 独立译出的英文（= 生产里 agent 会给的东西）。
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { DATASET_DIR, loadDataset, annotationSearchText } from './dataset';
import { buildObservationSearchText, generateEmbedding, cosineSimilarity } from '../src/embedding';

interface Mirror {
  records?: Record<string, { title: string; summary: string; outcome: string; learned: string; concepts: string[] }>;
  queries?: Record<string, string>;
}

const acpR = JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en-acp-records.json'), 'utf-8')) as Mirror;
const acpQ = JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en-acp-queries.json'), 'utf-8')) as Mirror;

const { turns, queries } = loadDataset();
const primary = turns.filter((t) => t.scope === 'primary' && acpR.records?.[t.id]);

// 每条记录两个向量：中文原文的、英文译文的。
const zhVec = new Map<string, Float32Array>();
const enVec = new Map<string, Float32Array>();
for (const t of primary) {
  const m = acpR.records![t.id]!;
  zhVec.set(t.id, await generateEmbedding(annotationSearchText(t.annotation)));
  enVec.set(
    t.id,
    await generateEmbedding(
      buildObservationSearchText({ ...m, concepts: m.concepts, files: t.annotation.key_files }),
    ),
  );
}

const tuned = queries.filter((q) => q.kind === 'relevance' && q.origin === 'tuned' && acpQ.queries?.[q.id]);

const f = (x: number) => x.toFixed(3);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]!;
};

// --- 噪声地板：英文 query 对「非期望」记录的 cosine，按记录语言分开 ---
const noiseZh: number[] = [];
const noiseEn: number[] = [];
const signalZh: number[] = [];
const signalEn: number[] = [];

const rowsX: { id: string; rank: number }[] = [];
const rowsY: { id: string; rank: number }[] = [];

for (const q of tuned) {
  const qv = await generateEmbedding(acpQ.queries![q.id]!);
  const expect = new Set(q.expect);

  for (const t of primary) {
    const cz = cosineSimilarity(qv, zhVec.get(t.id)!);
    const ce = cosineSimilarity(qv, enVec.get(t.id)!);
    if (expect.has(t.id)) {
      signalZh.push(cz);
      signalEn.push(ce);
    } else {
      noiseZh.push(cz);
      noiseEn.push(ce);
    }
  }

  // 配置 X：期望记录用英文向量，其余用中文向量
  const scoredX = primary
    .map((t) => ({
      id: t.id,
      s: cosineSimilarity(qv, expect.has(t.id) ? enVec.get(t.id)! : zhVec.get(t.id)!),
    }))
    .sort((a, b) => b.s - a.s);
  const rx = scoredX.findIndex((s) => expect.has(s.id)) + 1;
  rowsX.push({ id: q.id, rank: rx });

  // 配置 Y：期望记录用中文向量，其余用英文向量
  const scoredY = primary
    .map((t) => ({
      id: t.id,
      s: cosineSimilarity(qv, expect.has(t.id) ? zhVec.get(t.id)! : enVec.get(t.id)!),
    }))
    .sort((a, b) => b.s - a.s);
  const ry = scoredY.findIndex((s) => expect.has(s.id)) + 1;
  rowsY.push({ id: q.id, rank: ry });
}

const mrr = (rows: { rank: number }[]) =>
  rows.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / rows.length;
const top5 = (rows: { rank: number }[]) => rows.filter((r) => r.rank > 0 && r.rank <= 5).length;

console.log('');
console.log('=== 标度对比（英文 query，n=18 × 26 条记录）===');
console.log('');
console.log('| 记录语言 | 正例 cosine 中位数 | 噪声 p50 | 噪声 p95 | 噪声 max |');
console.log('| --- | --- | --- | --- | --- |');
console.log(`| 中文（未翻译） | ${f(median(signalZh))} | ${f(quantile(noiseZh, 0.5))} | ${f(quantile(noiseZh, 0.95))} | ${f(Math.max(...noiseZh))} |`);
console.log(`| 英文（已翻译） | ${f(median(signalEn))} | ${f(quantile(noiseEn, 0.5))} | ${f(quantile(noiseEn, 0.95))} | ${f(Math.max(...noiseEn))} |`);
console.log('');
console.log('=== 混合语料排名（最坏两种情形分开算）===');
console.log('');
console.log(`配置 X  期望已翻译 / 其余中文   MRR=${f(mrr(rowsX))}  Top-5=${top5(rowsX)}/18`);
console.log(`配置 Y  期望未翻译 / 其余英文   MRR=${f(mrr(rowsY))}  Top-5=${top5(rowsY)}/18`);
console.log('');
console.log('对照：全英文 0.972（18/18） / 全中文记录+英文 query 0.704（16/18）');
console.log('');
console.log('--- 配置 Y 名次分布（未翻译记录被已翻译噪声压制的程度）---');
console.log(
  [...rowsY].sort((a, b) => b.rank - a.rank).map((r) => `${r.id}:${r.rank}`).join(' '),
);
console.log('--- 配置 X 名次分布 ---');
console.log(
  [...rowsX].sort((a, b) => b.rank - a.rank).map((r) => `${r.id}:${r.rank}`).join(' '),
);
