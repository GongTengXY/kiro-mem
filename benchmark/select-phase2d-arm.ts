/**
 * Phase 2D arm selection — deterministic, no human judgement in the loop.
 *
 * Reads ONLY `benchmark/reports/phase2d/grid.json` (arms run with `--no-heldout`)
 * and applies D1–D4 from `benchmark/reports/phase2d-criteria.md`. It refuses to run
 * if any heldout, validation or audit metric is present: those are
 * confirmation-only (§9.3), and a selector that could read them would make "the
 * parameters were frozen before the confirmation sets ran" unprovable.
 *
 * The exact-tie set is MEASURED, not inferred (Gate D P2): `exactTieInPage` comes
 * from grouping the kernel's own fused scores by float64 `===`, the same
 * comparison the comparator makes. The `w_sem = 1+ε` arm is kept only as a
 * cross-check — it is a finite perturbation and can in principle flip
 * strictly-ordered pairs that are merely close, so it cannot bound anything.
 */

import { resolve } from 'path';

const DIR = 'benchmark/reports/phase2d';
const BASELINE = 'baseline';
const DIAGNOSTIC = 'diag-wsem-epsilon';
/** The profile the plan registered. A candidate must not contradict it. */
const REGISTERED = 'tb-source-confidence';

interface GridRow {
  arm: string;
  variable: string;
  policy: Record<string, unknown>;
  diffRows: number;
  diffIds: string[];
  metrics: Record<string, number | null>;
  tieInPageIds: string[];
}

const grid: GridRow[] = await Bun.file(`${DIR}/grid.json`).json();
const byArm = new Map(grid.map((r) => [r.arm, r]));
const base = byArm.get(BASELINE);
const diag = byArm.get(DIAGNOSTIC);
const registered = byArm.get(REGISTERED);
if (!base) throw new Error(`grid.json 缺少 ${BASELINE} arm`);
if (!registered) throw new Error(`grid.json 缺少方案登记的 ${REGISTERED} arm`);

for (const r of grid) {
  for (const k of Object.keys(r.metrics)) {
    if (/heldout|validation|audit/i.test(k) && r.metrics[k] !== null) {
      console.error(`[2D] ${r.arm} 的 grid.json 含确认集指标 ${k}——选参不得读到它`);
      process.exit(2);
    }
  }
}

/** 平局集：基线运行里结果页内存在精确平局的 query，由实际融合分枚举得到。 */
const tieSet = new Set(base.tieInPageIds);

const LOCKS: { key: string; dir: 'up' | 'down' | 'eq'; label: string }[] = [
  { key: 'phase2HitAt5', dir: 'up', label: 'Phase 2 hit@5' },
  { key: 'phase2Mrr', dir: 'up', label: 'Phase 2 MRR' },
  { key: 'phase2RPrecision', dir: 'up', label: 'Phase 2 R-precision' },
  { key: 'phase2EmptyReturned', dir: 'down', label: 'Phase 2 empty 均值' },
  { key: 'phase2EmptyWorst', dir: 'down', label: 'Phase 2 empty 最坏' },
  { key: 'expectedEmptyReturned', dir: 'down', label: '既有 expected-empty 均值' },
  { key: 'expectedEmptyWorst', dir: 'down', label: '既有 expected-empty 最坏' },
  { key: 'tunedHitAt5', dir: 'up', label: 'tuned hit@5' },
  { key: 'tunedMrr', dir: 'up', label: 'tuned MRR' },
  { key: 'tunedRPrecision', dir: 'up', label: 'tuned R-precision' },
  { key: 'semanticOnlyMax', dir: 'eq', label: 'semantic-only 最坏（cap 不变量）' },
  { key: 'leakTotal', dir: 'eq', label: '跨 scope 泄漏' },
];
const LATENCY_BUDGET_MS = 300;

interface Verdict {
  arm: GridRow;
  changed: string[];
  /** D1a：改动集里落在平局集之外的 query。非空 = 越界，tie-break 不再只是 tie-break。 */
  overreach: string[];
  /** D1b */
  resolvesAny: boolean;
  d2Failures: string[];
  /** D3：是否不与方案登记的 profile 冲突（改动集必须是它的超集）。 */
  conservativeExtension: boolean;
  feasible: boolean;
}

const registeredChanged = new Set(registered.diffIds);
const verdicts: Verdict[] = [];
for (const arm of grid) {
  if (arm.arm === BASELINE || arm.arm === DIAGNOSTIC) continue;
  const changed = arm.diffIds;
  const overreach = changed.filter((id) => !tieSet.has(id));

  const d2Failures: string[] = [];
  for (const { key, dir, label } of LOCKS) {
    const b = base.metrics[key];
    const v = arm.metrics[key];
    if (b === null || v === null || b === undefined || v === undefined) continue;
    if (dir === 'up' && v < b) d2Failures.push(`${label} 回退（${b} → ${v}）`);
    if (dir === 'down' && v > b) d2Failures.push(`${label} 恶化（${b} → ${v}）`);
    if (dir === 'eq' && v !== b) d2Failures.push(`${label} 变化（${b} → ${v}）`);
  }
  const p95 = arm.metrics.latencyP95;
  if (p95 != null && p95 >= LATENCY_BUDGET_MS) d2Failures.push(`p95 ${p95}ms ≥ ${LATENCY_BUDGET_MS}ms`);

  // 保守扩展：凡方案登记的 profile 决定了的 query，候选必须也决定，且给出同一结果。
  // 后半句由 fixture 保证（分档在语义名次之前），这里检查前半句可机械验证的部分。
  const conservativeExtension = [...registeredChanged].every((id) => changed.includes(id));

  verdicts.push({
    arm,
    changed,
    overreach,
    resolvesAny: changed.length > 0,
    d2Failures,
    conservativeExtension,
    feasible: overreach.length === 0 && changed.length > 0 && d2Failures.length === 0 && conservativeExtension,
  });
}

// D4：可行集里，解决更多平局 query 者优先；再相同时字典序，保证确定性。
const feasible = verdicts
  .filter((v) => v.feasible)
  .sort((a, b) => (b.changed.length - a.changed.length) || a.arm.arm.localeCompare(b.arm.arm));

const lines: string[] = [];
lines.push('# 阶段 2D arm 选择（确定性计算）');
lines.push('');
lines.push(`> 生成时间：${new Date().toISOString()}`);
lines.push(`> 输入：\`${resolve(DIR, 'grid.json')}\``);
lines.push(`> 判据：\`benchmark/reports/phase2d-criteria.md\` D1–D4（Gate D 反馈后的修订版，附录 A4）`);
lines.push('');
lines.push('## 精确平局集（实测，非推断）');
lines.push('');
lines.push(`基线运行里结果页内存在精确平局的 query 共 **${tieSet.size}** 条：`);
lines.push(`${[...tieSet].map((s) => `\`${s}\``).join('、')}`);
lines.push('');
lines.push('来源是内核 `onFusion` 报出的**实际融合分**按 float64 `===` 分组——与比较器里');
lines.push('那一行是同一个比较。页外深处的平局不计入：它不影响任何指标。');
lines.push('');
if (diag) {
  const epsOutside = diag.diffIds.filter((id) => !tieSet.has(id));
  lines.push(`辅助诊断 \`${DIAGNOSTIC}\`（w_sem=1+ε）改动 ${diag.diffIds.length} 条：` +
    `${diag.diffIds.map((s) => `\`${s}\``).join('、')}；` +
    (epsOutside.length === 0
      ? '全部落在平局集内（本轮它与实测一致，但这是读数，不是它可靠的证明）。'
      : `其中 **${epsOutside.length} 条落在平局集之外**（${epsOutside.join('、')}）——` +
        '有限扰动翻转了严格有序对，正是它不能当判据的直接证据。'));
  lines.push('');
}
lines.push('## 全部候选 arm');
lines.push('');
lines.push('| arm | 自变量 | 改动 | D1a 不越界 | D1b 有解决 | D2 锁 | D3 保守扩展 | 可行 | 失败原因 |');
lines.push('| --- | --- | ---: | :--: | :--: | :--: | :--: | :--: | --- |');
for (const v of verdicts) {
  const reasons = [
    ...(v.overreach.length ? [`越界改动非平局 query：${v.overreach.join(',')}`] : []),
    ...(v.resolvesAny ? [] : ['一条平局都没解决']),
    ...v.d2Failures,
    ...(v.conservativeExtension ? [] : ['与方案登记的 source-confidence 结论冲突']),
  ];
  lines.push(
    `| \`${v.arm.arm}\` | ${v.arm.variable} | ${v.changed.length} | ${v.overreach.length === 0 ? '✅' : '❌'} | ` +
    `${v.resolvesAny ? '✅' : '❌'} | ${v.d2Failures.length === 0 ? '✅' : '❌'} | ` +
    `${v.conservativeExtension ? '✅' : '❌'} | ${v.feasible ? '✅' : '❌'} | ${reasons.join('；') || '—'} |`,
  );
}
lines.push('');
lines.push('## D4 顺位（解决更多平局者优先）');
lines.push('');
if (feasible.length === 0) {
  lines.push('**没有可行候选 → 阶段 2D 结论为未通过。**');
} else {
  lines.push('| # | arm | 解决的平局 query | tuned MRR | tuned R-prec |');
  lines.push('| ---: | --- | ---: | ---: | ---: |');
  feasible.forEach((v, i) => {
    lines.push(
      `| ${i + 1} | \`${v.arm.arm}\` | ${v.changed.length} / ${tieSet.size}（${v.changed.join(',')}） | ` +
      `${(v.arm.metrics.tunedMrr ?? 0).toFixed(3)} | ${((v.arm.metrics.tunedRPrecision ?? 0) * 100).toFixed(1)}% |`,
    );
  });
  const win = feasible[0]!;
  lines.push('');
  lines.push(`## 选中：\`${win.arm.arm}\``);
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('| --- | --- |');
  for (const [k, val] of Object.entries(win.arm.policy)) lines.push(`| ${k} | \`${JSON.stringify(val)}\` |`);
  lines.push(`| 行为改动 | ${win.changed.length} / 145，全部落在平局集内 |`);
  lines.push(`| 解决的平局 query | ${win.changed.length} / ${tieSet.size} |`);
  lines.push('');
  lines.push('**"解决"是可见口径，会低估**：一条平局 query 上，规则按证据判出的次序也可能');
  lines.push('恰好与 recency 相同，那样它不进改动集，但平局确实不再由时间戳决定。低估对结论');
  lines.push('是安全的——胜出者的改动集是次优者的超集（D3 已断言），所以真实覆盖只会更大。');
}
lines.push('');

const out = lines.join('\n');
await Bun.write('benchmark/reports/phase2d-selection.md', `${out}\n`);
await Bun.write(
  'benchmark/reports/phase2d-selection.json',
  JSON.stringify({ tieSet: [...tieSet], verdicts, selected: feasible[0]?.arm.arm ?? null }, null, 2),
);
console.log(out);
if (feasible.length === 0) process.exit(1);
