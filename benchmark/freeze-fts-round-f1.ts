#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F1 冻结**：判据 + 数据 + 语料 + 镜像一次性冻结。
 *
 * 判据：`benchmark/reports/fts-round/f1-criteria.md`（r3）§10
 *
 * 冻结记录由 `benchmark/freeze-util.ts` 产出，因此 `frozenAt` 与逐项 SHA 都不是手写的，
 * 且**目标文件已存在时硬失败**——作废重开必须换新路径或新轮次标识（F1 复核第 2 项）。
 *
 * 冻结之前先跑一遍机械校验；校验不过就不写记录。
 *
 * 用法：bun run benchmark/freeze-fts-round-f1.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFreezeRecord, verifyFreezeRecord } from './freeze-util';

const ROOT = join(import.meta.dir, '..');
const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

// --- 0. 冻结前的机械校验（判据 §4 + sample gate 结论）-------------------------
const validate = Bun.spawnSync(['bun', 'run', join(import.meta.dir, 'validate-fts-round-dataset.ts')], { cwd: ROOT });
const validateOut = new TextDecoder().decode(validate.stdout);
process.stdout.write(validateOut);
if (validate.exitCode !== 0) {
  console.error('[freeze-f1] ✗ 机械校验未通过，未写入冻结记录');
  process.exit(1);
}

// --- 1. 镜像覆盖与护栏（判据 §4.5：拒绝数必须为 0）----------------------------
const { checkSemanticEnQuery } = await import('../src/semantic-en');
const queries = read(join(DATASET, 'queries-fts-round.json')).queries as { id: string; query: string }[];
const queryMirror = read(join(DATASET, 'mirror-en-acp-queries-fts-round.json')).queries as Record<string, string>;
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string }[];
const recordMirror = read(join(DATASET, 'mirror-en-acp-records-fts-round.json')).records as Record<string, unknown>;

const zhQueries = queries.filter((q) => /[\u4e00-\u9fff]/.test(q.query));
const missingQueryMirror = zhQueries.filter((q) => !queryMirror[q.id]).map((q) => q.id);
const missingRecordMirror = records.filter((r) => !recordMirror[r.id]).map((r) => r.id);
/**
 * 纯拉丁 / 路径 / 数字 query 走**恒等归一化**：护栏明确允许英文原文归一化为自身，
 * 因此它们不经 ACP。这一条与 phase2 / r2 分支同口径，写在这里是为了让冻结记录
 * 自带这个事实，而不是留给读者推断。
 */
const identityQueries = queries.filter((q) => !/[\u4e00-\u9fff]/.test(q.query)).map((q) => q.id);
const rejects: { id: string; reason: string }[] = [];
for (const q of queries) {
  const en = queryMirror[q.id] ?? q.query;
  const r = checkSemanticEnQuery(en, q.query);
  if (!r.ok) rejects.push({ id: q.id, reason: String(r.reason) });
}

const problems: string[] = [];
if (missingQueryMirror.length) problems.push(`query 镜像缺失：${missingQueryMirror.join(' ')}`);
if (missingRecordMirror.length) problems.push(`记录镜像缺失：${missingRecordMirror.join(' ')}`);
if (rejects.length) problems.push(`护栏拒绝 ${rejects.length} 条：${rejects.map((r) => `${r.id}(${r.reason})`).join(' ')}`);
if (problems.length) {
  console.error('[freeze-f1] ✗ 镜像检查未通过，未写入冻结记录：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[freeze-f1] 镜像：query ${zhQueries.length} 条走 ACP + ${identityQueries.length} 条恒等；记录 ${records.length} 条；护栏拒绝 0`);

// --- 2. 冻结 -----------------------------------------------------------------
const corpusMeta = read(join(DATASET, 'fts-round-filler-zh-10k-meta.json'));

const record = writeFreezeRecord(join(REPORTS, 'f1-freeze.json'), {
  round: 'fts-safety-round-2026-08-12',
  phase: 'F1',
  criteria: join(REPORTS, 'f1-criteria.md'),
  note: '冻结于 F2 之前。此后不得修订判据、数据、语料与镜像；作废重开须换新路径或新 round id。'
    + 'K 不在本记录内——它由 F2 按判据 §2.2.1 的阶梯选定，单独冻结为 f2-freeze.json。',
  inputs: [
    { name: 'sampleGate', path: join(REPORTS, 'f1-sample.md') },
    { name: 'implProbe', path: join(REPORTS, 'f1-impl-probe.md') },
    { name: 'implProbeData', path: join(REPORTS, 'f1-impl-probe.json') },
    { name: 'records', path: join(DATASET, 'turns-fts-round.json') },
    { name: 'queries', path: join(DATASET, 'queries-fts-round.json') },
    { name: 'recordsMirrorEn', path: join(DATASET, 'mirror-en-acp-records-fts-round.json') },
    { name: 'queriesMirrorEn', path: join(DATASET, 'mirror-en-acp-queries-fts-round.json') },
    { name: 'corpusZh', path: join(DATASET, 'fts-round-filler-zh-10k.json') },
    { name: 'corpusZhMeta', path: join(DATASET, 'fts-round-filler-zh-10k-meta.json') },
    { name: 'corpusZhBuilder', path: join(import.meta.dir, 'build-fts-round-filler-zh.ts') },
    { name: 'corpusEn', path: join(DATASET, 'pool-policy-filler-10k.json') },
    { name: 'oldGold', path: join(DATASET, 'turns.json') },
    { name: 'validator', path: join(import.meta.dir, 'validate-fts-round-dataset.ts') },
    { name: 'freezeUtil', path: join(import.meta.dir, 'freeze-util.ts') },
  ],
  payload: {
    grid: {
      windowCoverageRatio: [0, 0.1, 0.2, 0.3],
      unitDfRatioCeiling: [1.0, 0.3, 0.1, 0.03],
      arms: 16,
      armIdFormat: 'r<r>-d<d>',
      baselineArm: 'r0-d1.00',
      provenance: 'r 由 0 起 0.10 等距铺开；d 由 1.00 关闭臂起约 √10 等比铺开。均不引用 F0 / F1 探针的任何数字（判据 §2.4）。',
    },
    kLadder: {
      ladder: [200, 1000, 5000, 'EXACT'],
      rule: '取最小的 K，使 16 个 (r,d) 设置 × 120 条 query 与 EXACT 的候选差集逐 query 为 0（判据 §2.2.1）',
      selectedIn: 'F2（单独冻结为 f2-freeze.json）',
      gate: 'S7a 前置门：不通过不得跑网格',
    },
    frozenPolicyFields: {
      semanticFloor: 0.197,
      semanticOnlyLimit: 2,
      semanticDiscovery: true,
      rrfK: 60,
      ftsWeight: 1,
      semanticWeight: 1,
      tieBreak: 'semantic-rank',
      semanticCandidatePool: 'Infinity',
      semanticTopK: 1000,
      bigramAux: false,
      defaultSearchDays: 'Infinity',
      ftsMinUnitLen: 3,
      ftsCjkWindow: 3,
      ftsMaxUnits: 32,
      ftsOrderBy: 'fts.rank, o.id ASC',
      internalCandidateLimit: 50,
    },
    gates: {
      G1: '全体 80 条正例：非 acceptable 结果排在任一 primary_gold 之前的次数 = 0（判据 §6.1）',
      G2: '40 条词面负例：整页跨来源 distinctContent ≤ 2，逐条判定不取平均（§6.2）',
      G3: '120 条全体：match_source 机械重算一致 + semantic-only ≤ 2（§6.3）',
      G4: '80 条正例四档分层 primary hit@5 / MRR 逐档不得低于基线（§6.4）',
      protection: '五类各 8 条，逐类不得回退（§6.5）',
      perf: '完整 search p95 < 300ms；基线已超预算时改为 arm.p95 ≤ baseline.p95 并单独登记缺陷（§6.6）',
      S7: 'K 的语义资格门，逐 query 候选差集 = 0（§2.2.1、§7 S7a/S7b）',
    },
    selection: '前置 P0（S7a）+ P1（S1–S4）→ 结构排除基线 → G1∧G2∧G3 → G4 ∧ 保护线 ∧ 性能门 → 字典序 (hit@5, MRR, 准入更强, arm id)（§8）',
    fixture: {
      newGold: 40,
      oldGold: 26,
      fillerEn: 50000,
      fillerEnSourceRows: 10000,
      fillerZh: 10000,
      totalPhysicalRows: 60066,
      spreadDays: 1095,
      oldGoldAgeDays: 400,
    },
    dataset: {
      queries: queries.length,
      relevance: 40,
      lexicalNegatives: { 'false-premise': 15, 'same-word-other-thing': 15, 'stale-state-confusion': 10 },
      protectionPerClass: 8,
      selfReferentialRecords: 0,
      sourcePriority: 'P3 / 门形状裁定 / F0 / Q6；本轮自身事实未被动用',
    },
    mirror: {
      queriesViaAcp: zhQueries.length,
      queriesIdentity: identityQueries.length,
      recordsViaAcp: records.length,
      guardrailRejects: 0,
      translator: 'kiro-mem-compressor（生产 ACP 运行时）',
      note: 'query 与记录两侧由两次独立运行产出，prompt 互不含对侧文本；纯拉丁/路径/数字 query 走恒等归一化，不经 ACP。',
    },
    corpusZh: {
      seed: corpusMeta.seed,
      count: corpusMeta.count,
      domains: corpusMeta.domains,
      functionWords: corpusMeta.functionWords,
      lexicalViolations: corpusMeta.lexicalViolations,
      note: '功能词按「恰好 N 条」注入，每词三变体以打散窗口相关性；S3 用 df / 中文记录数 比对生成占比（判据 §3.1.1、§7 S3）。',
    },
    strata: {
      status: '未测',
      rule: '判据 §4.4：80 条正例并集四档 ≥8 条/档，另冻结 relevance 与保护线各自四档；由 F2 一次性测量后写入 f2-freeze.json',
    },
  },
});

const v = verifyFreezeRecord(record);
console.log(`[freeze-f1] 冻结完成：${record.itemCountLabel} 项（${record.frozenAt}）`);
console.log(`[freeze-f1] 自校验：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) process.exit(1);
console.log(`[freeze-f1] → ${join(REPORTS, 'f1-freeze.json')}`);
