/**
 * 安全策略轮次 P3：**确定性** arm 选择（判据 `p3-grid-criteria.md` §7）。
 *
 * 判据要求"选择必须由脚本计算，不得手工抄表"。因此本脚本与仪表
 * （`run-safety-round-grid.ts`）分离：仪表只出读数，本脚本只做那五步，
 * 逐步中间结果全部落盘，任何人都能复算出同一个结论。
 *
 * 三条结构性保证，写成代码而不是纪律：
 *
 *  1. **`cap ≤ 1` 进不了候选集。** 第 1 步就把它们过滤掉，末尾再断言一次入选 arm 的
 *     `cap ≥ 2`。零 FTS 页面完全由 semantic-only 构成，`cap=1` 让"平均返回 ≤1"成为
 *     算术恒真（P2 判据 r3 §4.5 / 上游裁定 §3），它只能读诊断，不能当结论。
 *  2. **自证不过就不选。** 判据 §6 写着任一 S 项失败则该次运行的全部读数作废；
 *     那种情况下"选出一个 arm"本身就是错的，所以这里硬失败退出。
 *  3. **没有安全 arm 就报没有。** 第 4 步不做任何回退、不放宽任何门、不降级到
 *     "最接近通过的那个"。上游禁止清单第 9 条：如实报本轮不通过。
 *
 * 用法：bun run benchmark/select-safety-round-arm.ts
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const die = (m: string): never => { console.error(`[select] ✗ ${m}`); process.exit(1); };
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

const DIR = join(import.meta.dir, 'reports', 'safety-round');
const FREEZE = join(DIR, 'p3-grid-freeze.json');
const RESULTS = join(DIR, 'p3-grid-results.json');
const OUT = join(DIR, 'p3-arm-selection.json');

const freeze = read(FREEZE);
if (freeze.frozen !== true) die('p3-grid-freeze.json 的 frozen 不是 true');
if (sha256(freeze.criteria) !== freeze.criteriaSha256) die('P3 判据已被改动，冻结失效');

const results = read(RESULTS);
if (sha256(RESULTS) === freeze.criteriaSha256) die('不可能发生：结果文件与判据同 SHA');
if (results.criteria?.sha256 !== freeze.criteriaSha256) {
  die(`结果文件登记的判据 SHA 与冻结不符——该结果不是在当前判据下跑出来的`);
}

// --- 前置：网格必须跑满，自证必须全过 ---------------------------------------
const arms = results.arms as any[];
const expected = (freeze.grid.semanticFloor as number[]).flatMap((f: number) =>
  (freeze.grid.semanticOnlyLimit as number[]).map((c: number) => `f${f}-c${c}`));
const missing = expected.filter((id) => !arms.some((a) => a.arm === id));
if (missing.length) die(`网格未跑满，缺 ${missing.length} 个 arm：${missing.join(', ')}——不得在不完整网格上选参`);

const failedChecks = (results.selfChecks as any[]).filter((s) => !s.pass);
if (failedChecks.length) {
  die(`结构自证未全过（判据 §6：任一项失败则该次运行的全部读数作废）：\n  ` +
    failedChecks.map((s) => `${s.name} — ${s.reading}`).join('\n  '));
}

const BANDS = freeze.readings.lowScorePositiveBands.bands as string[];
const baselineId = freeze.grid.baselineArm as string;
const baseline = arms.find((a) => a.arm === baselineId) ?? die(`结果里没有基线 arm ${baselineId}`);

const gateNames = ['F1', 'N1', 'N2', 'N3'] as const;
const gatesOf = (a: any) => Object.fromEntries(gateNames.map((g) => [g, a.gates[g].pass as boolean]));
const allGatesPass = (a: any): boolean => gateNames.every((g) => a.gates[g].pass);

// --- 第 1 步 结构排除：cap ≥ 2 ---------------------------------------------
const step1 = {
  rule: 'candidates = { arm : cap >= 2 }（判据 §7 第 1 步；r3 §4.5 的 cap ≤ 1 诊断臂排除）',
  candidates: arms.filter((a) => a.cap >= 2).map((a) => a.arm),
  excluded: arms.filter((a) => a.cap <= 1).map((a) => ({ arm: a.arm, reason: 'cap ≤ 1 是诊断臂，算术恒真' })),
};
const candidates = arms.filter((a) => a.cap >= 2);

// --- 第 2 步 安全过滤：F1 ∧ N1 ∧ N2 ∧ N3 ------------------------------------
const feasible = candidates.filter(allGatesPass);
const step2 = {
  rule: 'feasible = { arm ∈ candidates : F1 ∧ N1 ∧ N2 ∧ N3 全部通过 }',
  perArm: candidates.map((a) => ({ arm: a.arm, gates: gatesOf(a), pass: allGatesPass(a) })),
  feasible: feasible.map((a) => a.arm),
};

// --- 第 3 步 低分正例分层不得回退 -------------------------------------------
const bandCheck = (a: any) => BANDS.map((b) => ({
  band: b,
  arm: a.lowScoreBands[b].primaryHitAt5 as number,
  baseline: baseline.lowScoreBands[b].primaryHitAt5 as number,
  ok: (a.lowScoreBands[b].primaryHitAt5 as number) >= (baseline.lowScoreBands[b].primaryHitAt5 as number),
}));
const eligible = feasible.filter((a) => bandCheck(a).every((b) => b.ok));
const step3 = {
  rule: `eligible = { arm ∈ feasible : 四档 primary hit@5 均 >= 基线 ${baselineId} 同档值 }`,
  rationale: freeze.selectionRule.step3Rationale,
  perArm: feasible.map((a) => ({ arm: a.arm, bands: bandCheck(a), pass: bandCheck(a).every((b) => b.ok) })),
  eligible: eligible.map((a) => a.arm),
};

// --- 第 4 / 5 步 -----------------------------------------------------------
let selected: any = null;
let step5: any = { rule: freeze.selectionRule.steps[4], ranking: [] as any[] };
if (eligible.length) {
  const ranked = [...eligible].sort((x, y) =>
    y.relevance.primaryHitAt5 - x.relevance.primaryHitAt5 ||
    y.relevance.primaryMrr - x.relevance.primaryMrr ||
    y.floor - x.floor ||
    (x.arm < y.arm ? -1 : x.arm > y.arm ? 1 : 0));
  selected = ranked[0];
  step5 = {
    ...step5,
    ranking: ranked.map((a, i) => ({
      position: i + 1, arm: a.arm, floor: a.floor, cap: a.cap,
      primaryHitAt5: a.relevance.primaryHitAt5, primaryMrr: a.relevance.primaryMrr,
    })),
  };
  // 结构性再断言：诊断臂绝不可能成为结论。
  if (selected.cap <= 1) die('不可能发生：入选 arm 的 cap ≤ 1');
}

const verdict = selected
  ? { outcome: 'safe-arm-found', arm: selected.arm, floor: selected.floor, cap: selected.cap }
  : {
      outcome: 'no-safe-arm',
      statement: '本轮没有安全 arm。按上游方案 §4 禁止清单第 9 条如实报告，不得为产出候选而下调 F1 / N2、不得删掉低分正例那一层、不得把 cap ≤ 1 提升为候选。',
      firstEmptyStep: feasible.length === 0 ? 'step2（安全过滤）' : 'step3（低分正例分层不得回退）',
    };

// --- 诊断读数：cap=1 与 cap=2 的收益差（判据 §2.2 说明它们为什么必须跑） -----
const diagnostics = (freeze.grid.semanticFloor as number[]).map((floor: number) => {
  const c1 = arms.find((a) => a.arm === `f${floor}-c1`);
  const c2 = arms.find((a) => a.arm === `f${floor}-c2`);
  return {
    floor,
    primaryHitAt5: { cap1: c1.relevance.primaryHitAt5, cap2: c2.relevance.primaryHitAt5, delta: Number((c2.relevance.primaryHitAt5 - c1.relevance.primaryHitAt5).toFixed(3)) },
    nearDomainDistinctContent: { cap1: c1.hardNegative.nearDomain.distinctContentMean, cap2: c2.hardNegative.nearDomain.distinctContentMean },
  };
});

const out = {
  generatedAt: new Date().toISOString(),
  role: '确定性选择。规则在判据 §7 冻结于第一个 arm 之前；本脚本只执行它，不裁定本轮通过与否。',
  criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256 },
  results: { path: RESULTS, sha256: sha256(RESULTS) },
  baseline: {
    arm: baselineId,
    note: '基线 arm 就是当前生产策略值（floor 0.197 / cap 2）',
    gates: gatesOf(baseline),
    primaryHitAt5: baseline.relevance.primaryHitAt5,
    primaryMrr: baseline.relevance.primaryMrr,
    lowScoreBands: Object.fromEntries(BANDS.map((b) => [b, baseline.lowScoreBands[b]])),
  },
  step1, step2, step3,
  step4: { rule: freeze.selectionRule.steps[3], eligibleCount: eligible.length },
  step5,
  verdict,
  diagnostics,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

// --- 控制台 ---------------------------------------------------------------
console.log(`[select] 判据 ${freeze.criteria}（SHA ${freeze.criteriaSha256.slice(0, 8)}…）`);
console.log(`[select] 网格 ${arms.length}/${expected.length} 个 arm，结构自证 ${results.selfChecks.length}/${results.selfChecks.length} 全过\n`);
console.log('  arm         floor  cap  primary hit@5   MRR    F1 N1 N2 N3   near distinctContent');
for (const a of arms) {
  console.log(
    `  ${a.arm.padEnd(11)} ${String(a.floor).padEnd(6)} ${String(a.cap).padEnd(4)} ` +
    `${pct(a.relevance.primaryHitAt5).padStart(8)}      ${a.relevance.primaryMrr.toFixed(3)}  ` +
    `  ${gateNames.map((g) => (a.gates[g].pass ? '✅' : '❌')).join(' ')}   ` +
    `${String(a.hardNegative.nearDomain.distinctContentMean).padStart(6)}` +
    `${a.cap <= 1 ? '   ← 诊断臂，不得作为候选' : ''}`,
  );
}
console.log(`\n[select] 第 1 步 结构排除后候选 ${step1.candidates.length} 个：${step1.candidates.join(', ')}`);
console.log(`[select] 第 2 步 安全门全过 ${feasible.length} 个${feasible.length ? `：${step2.feasible.join(', ')}` : ''}`);
console.log(`[select] 第 3 步 分层不回退 ${eligible.length} 个${eligible.length ? `：${step3.eligible.join(', ')}` : ''}`);
if (selected) {
  console.log(`\n[select] ✅ 入选 arm：${selected.arm}（floor ${selected.floor} / cap ${selected.cap}）`);
  console.log(`         primary hit@5 ${pct(selected.relevance.primaryHitAt5)} / MRR ${selected.relevance.primaryMrr}`);
} else {
  console.log(`\n[select] ❌ ${verdict.statement}`);
  console.log(`         第一个空掉的步骤：${(verdict as any).firstEmptyStep}`);
}
console.log(`\n[select] 逐步中间结果：${OUT}`);
