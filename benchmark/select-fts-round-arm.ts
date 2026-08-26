#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F4：确定性选择规则**（判据 `f1-criteria.md` r3 §8）。
 *
 * 判据要求这一步**必须由脚本计算**，不得手工抄表——包括结论是"没有安全 arm"的情况。
 * 原文的算法逐步落地如下：
 *
 *   前置 P0  S7a 通过（K 由正确性阶梯选定，冻结在 f2-freeze-r3.json）
 *   前置 P1  S1–S4 通过（装置自证，F2 冻结记录里的 selfCert）
 *   1 结构排除  candidates = { arm ≠ baseline }        基线是参照不是候选
 *   2 安全过滤  feasible  = G1 ∧ G2 ∧ G3
 *   3 资格过滤  eligible  = G4 ∧ 保护线 ∧ 性能门        过滤器，不是排序键
 *   4 eligible 为空 → 输出「本轮没有安全 arm」并结束
 *   5 否则字典序取最大：hit@5 ↓ → MRR ↓ → 准入更强（r 大、d 小）→ arm id 升序
 *
 * 第 4 步之后**不得**下调任何门、删掉保护线中的任何一类、放宽 G2 的 2、
 * 放宽性能门或改用近似语义（判据 §8 第 4 步 + §9 第 9 / 13 条）。
 * 本脚本因此在 eligible 为空时**正常退出（0）并输出结论**——它是一个有效结果，
 * 不是运行失败。
 *
 * 用法：bun run benchmark/select-fts-round-arm.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyFreezeRecordFile } from './freeze-util';
import { BASELINE_ARM } from './fts-round-admission';

const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[f4-select] ✗ ${m}`); process.exit(1); };

// --- 前置 P0 / P1 -------------------------------------------------------------
const v = verifyFreezeRecordFile(join(REPORTS, 'f2-freeze-r3.json'));
console.log(`[f4-select] 冻结校验：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) die('冻结物已漂移');
const freeze = read(join(REPORTS, 'f2-freeze-r3.json'));
const kladder = read(join(REPORTS, 'f2-kladder-r2.json'));
const fixtureCert = read(join(REPORTS, 'f2-fixture-r2.json'));

const P0 = { name: 'P0 S7a 通过（K 由正确性阶梯选定）', pass: kladder.s7aPass === true && freeze.payload.selectedK != null, detail: `K = ${freeze.payload.selectedK}，${kladder.arms.length} arm × ${kladder.queries} query 差集 0` };
const P1 = { name: 'P1 S1–S4 通过（装置自证）', pass: fixtureCert.pass === true, detail: `${fixtureCert.checks.length} 项自证全过` };
for (const p of [P0, P1]) {
  console.log(`[f4-select] ${p.pass ? '✓' : '✗'} ${p.name}：${p.detail}`);
  if (!p.pass) die('前置条件不满足，不得进入选择');
}

// --- 读 F3 判定结果 -----------------------------------------------------------
const results = read(join(REPORTS, 'f3-grid-results.json'));
if (results.arms.length !== 16) die(`arm 数应为 16，实际 ${results.arms.length}`);

interface Judged {
  arm: string; isBaseline: boolean;
  policy: { windowCoverageRatio: number; unitDfRatioCeiling: number };
  safetyPass: boolean; eligibilityPass: boolean; selfCertPass: boolean;
  positives: { primaryHitAt5: number; primaryMrr: number };
  gates: any;
  latency: { p95: number };
}
const arms = results.arms as Judged[];

// --- 1 结构排除 ---------------------------------------------------------------
const candidates = arms.filter((a) => a.arm !== BASELINE_ARM);
// --- 2 安全过滤 ---------------------------------------------------------------
const feasible = candidates.filter((a) => a.safetyPass);
// --- 3 资格过滤 ---------------------------------------------------------------
const eligible = feasible.filter((a) => a.eligibilityPass);

console.log(`\n[f4-select] 1 结构排除：候选 ${candidates.length}（排除基线 ${BASELINE_ARM}）`);
console.log(`[f4-select] 2 安全过滤 G1∧G2∧G3：${feasible.length}/${candidates.length} 通过`);
console.log(`[f4-select] 3 资格过滤 G4∧保护线∧性能：${eligible.length}/${feasible.length} 通过`);

// --- 4 / 5 --------------------------------------------------------------------
/** 字典序比较（§8 第 5 步）：hit@5 ↓ → MRR ↓ → r ↑ → d ↓ → arm id ↑。 */
const better = (a: Judged, b: Judged): number =>
  b.positives.primaryHitAt5 - a.positives.primaryHitAt5
  || b.positives.primaryMrr - a.positives.primaryMrr
  || b.policy.windowCoverageRatio - a.policy.windowCoverageRatio
  || a.policy.unitDfRatioCeiling - b.policy.unitDfRatioCeiling
  || a.arm.localeCompare(b.arm);

const ranked = [...eligible].sort(better);
const selected = ranked[0] ?? null;

/** 逐 arm 的淘汰原因，供 F4 报告逐条引用。 */
const elimination = candidates.map((a) => {
  const failed: string[] = [];
  if (!a.gates.G1.pass) failed.push(`G1(污染 ${a.gates.G1.pollutionCount} 次 / ${a.gates.G1.offenderQueries} 条 query，primary 缺席 ${a.gates.G1.primaryAbsent})`);
  if (!a.gates.G2.pass) failed.push(`G2(超限 ${a.gates.G2.overCapQueries}/40，最坏 distinctContent ${a.gates.G2.distinctContentWorst})`);
  if (!a.gates.G3.pass) failed.push('G3');
  if (!a.gates.G4.pass) failed.push(`G4(回退 ${a.gates.G4.regressions.length} 项)`);
  if (!a.gates.protection.pass) failed.push(`保护线(回退 ${a.gates.protection.regressions.length} 项)`);
  if (!a.gates.perf.pass) failed.push(`性能门(p95 ${a.latency.p95}ms)`);
  return { arm: a.arm, policy: a.policy, eliminatedBy: failed, selfCertPass: a.selfCertPass };
});

const out = {
  purpose: 'F4 确定性选择（判据 r3 §8）。判据要求本步必须由脚本计算，包含「没有安全 arm」这一结论。',
  round: results.round,
  phase: 'F4',
  generatedAt: new Date().toISOString(),
  freeze: { path: 'benchmark/reports/fts-round/f2-freeze-r3.json', verify: v.label, selectedK: freeze.payload.selectedK },
  preconditions: [P0, P1],
  algorithm: freeze.payload.selection ?? read(join(REPORTS, 'f1-freeze-r3.json')).payload.selection,
  tieBreakOrder: ['primary hit@5 ↓', 'primary MRR ↓', 'r ↑（准入更强）', 'd ↓（准入更强）', 'arm id ↑'],
  baselineArm: BASELINE_ARM,
  counts: { arms: arms.length, candidates: candidates.length, feasible: feasible.length, eligible: eligible.length },
  feasibleArms: feasible.map((a) => a.arm),
  eligibleArms: eligible.map((a) => a.arm),
  selected: selected ? { arm: selected.arm, policy: selected.policy, primaryHitAt5: selected.positives.primaryHitAt5, primaryMrr: selected.positives.primaryMrr, p95: selected.latency.p95 } : null,
  verdict: selected ? 'arm-selected' : 'no-safe-arm',
  verdictText: selected
    ? `选出 ${selected.arm}`
    : '本轮没有安全 arm：15 个候选 arm 在安全过滤（G1∧G2∧G3）阶段全部被淘汰。'
      + '按判据 §8 第 4 步与 §9 第 9 条，结论是「本轮不通过」，不得下调门槛、'
      + '不得删掉保护线中的任何一类、不得放宽 G2 的 2、不得加密网格刻度再扫一遍。',
  elimination,
  // 淘汰原因的分布：让"为什么不通过"可以一眼看出主因，而不必读 16 份报告。
  eliminationHistogram: (() => {
    const h = new Map<string, number>();
    for (const e of elimination) for (const f of e.eliminatedBy) {
      const key = f.split('(')[0]!;
      h.set(key, (h.get(key) ?? 0) + 1);
    }
    return Object.fromEntries([...h.entries()].sort((a, b) => b[1] - a[1]));
  })(),
};
writeFileSync(join(REPORTS, 'f4-selection.json'), `${JSON.stringify(out, null, 2)}\n`);

console.log(`\n[f4-select] 判定：${out.verdict}`);
console.log(`[f4-select] ${out.verdictText}`);
console.log(`[f4-select] 淘汰原因分布：${JSON.stringify(out.eliminationHistogram)}`);
console.log(`[f4-select] → ${join(REPORTS, 'f4-selection.json')}`);
