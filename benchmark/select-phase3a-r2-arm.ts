/**
 * Phase 3A-R2 确定性选参（判据 §6 门槛 + §7 九条顺序）。
 *
 * 手工抄表选择在 2B 起就被禁止：判据写完之后，选择必须是一个能从 JSON 复算的函数。
 * 本脚本不读任何 Markdown，只读 `phase3a-r2/grid.json`。
 *
 * 门槛按 **A2 修订版**：empty-ext 的 N2/N3/N4 与总体是「不得高于 baseline」，只有 N1
 * 保留绝对门槛；既有 5 条 expected-empty 的绝对门槛不变。修订理由见判据附录 A2。
 */

const DIR = 'benchmark/reports/phase3a-r2';

interface Row {
  arm: string;
  variable: string;
  diagnostic: boolean;
  policy: Record<string, unknown>;
  diffRows: number;
  metrics: Record<string, number | null>;
  strata: Record<string, { n: number; hitAt5: number; mrr: number; rPrecision: number }>;
  emptyLayers: Record<string, { n: number; mean: number; worst: number }>;
  neutralityBreaks: string[];
  sameAsDiff: number | null;
}

const grid = (await Bun.file(`${DIR}/grid.json`).json()) as Row[];
const base = grid.find((r) => r.arm === 'baseline');
if (!base) throw new Error('grid.json 里没有 baseline');

/** 一条 query 的分辨力，用于「差值是否可区分」。S3 有 19 条。 */
const S3_RESOLUTION = 1 / (base.strata.S3?.n ?? 19);

interface Verdict { arm: string; feasible: boolean; reasons: string[] }

function judge(r: Row): Verdict {
  const reasons: string[] = [];
  const m = r.metrics;
  const bm = base!.metrics;
  const st = (x: Row, k: string) => x.strata[k];
  const el = (x: Row, k: string) => x.emptyLayers[k];

  // --- §6.1 fusion 集 ---
  if (r.neutralityBreaks.length > 0) {
    // 硬锁：不看其他指标。
    return { arm: r.arm, feasible: false, reasons: [`S2/S5 硬锁破 ${r.neutralityBreaks.length} 条：${r.neutralityBreaks.join(',')}`] };
  }
  const s1 = st(r, 'S1'), bs1 = st(base!, 'S1');
  if (s1 && bs1 && s1.mrr < bs1.mrr) reasons.push(`S1 MRR ${s1.mrr.toFixed(3)} < 基线 ${bs1.mrr.toFixed(3)}`);
  if (s1 && bs1 && s1.rPrecision < bs1.rPrecision) reasons.push(`S1 R-prec ${(s1.rPrecision * 100).toFixed(1)}% < 基线 ${(bs1.rPrecision * 100).toFixed(1)}%`);
  const s3 = st(r, 'S3'), bs3 = st(base!, 'S3');
  if (s3 && bs3 && s3.hitAt5 < bs3.hitAt5) reasons.push(`S3 hit@5 ${(s3.hitAt5 * 100).toFixed(1)}% < 基线`);
  if (m.fusionS3S4HitAt5! < bm.fusionS3S4HitAt5!) reasons.push('S3+S4 合计 hit@5 低于基线');
  if (m.fusionMrr! < bm.fusionMrr!) reasons.push(`fusion 全集 MRR ${m.fusionMrr!.toFixed(3)} < 基线 ${bm.fusionMrr!.toFixed(3)}`);

  // --- §6.2（A2 修订）误召回 ---
  if (m.emptyExtReturned! > bm.emptyExtReturned!) reasons.push(`empty-ext 均值 ${m.emptyExtReturned!.toFixed(2)} > 基线 ${bm.emptyExtReturned!.toFixed(2)}`);
  if (m.emptyExtWorst! > bm.emptyExtWorst!) reasons.push(`empty-ext 最坏 ${m.emptyExtWorst} > 基线 ${bm.emptyExtWorst}`);
  const n1 = el(r, 'N1');
  if (n1 && (n1.mean > 1 || n1.worst > 3)) reasons.push(`N1 绝对门槛破：${n1.mean.toFixed(2)}/${n1.worst}（≤1/≤3）`);
  for (const l of ['N1', 'N2', 'N3', 'N4']) {
    const a = el(r, l), b = el(base!, l);
    if (a && b && a.mean > b.mean) reasons.push(`${l} 均值 ${a.mean.toFixed(2)} > 基线 ${b.mean.toFixed(2)}`);
    if (a && b && a.worst > b.worst) reasons.push(`${l} 最坏 ${a.worst} > 基线 ${b.worst}`);
  }
  if (m.expectedEmptyReturned! > 1.0) reasons.push(`既有 expected-empty 均值 ${m.expectedEmptyReturned!.toFixed(2)} > 1.00`);
  if (m.expectedEmptyWorst! > 2) reasons.push(`既有 expected-empty 最坏 ${m.expectedEmptyWorst} > 2`);

  // --- §6.3 历史连续性锁 ---
  if (m.tunedHitAt5! < bm.tunedHitAt5!) reasons.push('tuned hit@5 回退');
  if (m.tunedMrr! < bm.tunedMrr!) reasons.push(`tuned MRR ${m.tunedMrr!.toFixed(3)} < ${bm.tunedMrr!.toFixed(3)}`);
  if (m.tunedRPrecision! < bm.tunedRPrecision!) reasons.push(`tuned R-prec ${(m.tunedRPrecision! * 100).toFixed(1)}% < ${(bm.tunedRPrecision! * 100).toFixed(1)}%`);
  if (!(m.phase2HitAt5! > bm.phase2HitAt5!)) reasons.push(`Phase 2 hit@5 未严格高于基线 ${(bm.phase2HitAt5! * 100).toFixed(1)}%`);

  // --- §6.4 结构不变量 ---
  const cap = r.policy.bigramOnlyLimit as number | string;
  const capNum = cap === 'inf' ? Infinity : Number(cap);
  if (m.bigramOnlyMax! > Math.min(capNum, 10)) reasons.push(`bigramOnlyMax ${m.bigramOnlyMax} 超过 min(cap, limit)`);
  if (r.policy.bigramVote === 'discovery-only' && !(m.bigramVotesSuppressedTotal! > 0)) {
    reasons.push('discovery-only 但 bigramVotesSuppressed 为 0——开关没生效');
  }
  if (r.policy.bigramVote === 'always' && m.bigramVotesSuppressedTotal !== 0) {
    reasons.push('always 但有被抑制的票——投票逻辑串了');
  }
  if (m.leakTotal! > 0) reasons.push(`跨 scope 泄漏 ${m.leakTotal}`);
  if (m.latencyP95! >= 300) reasons.push(`p95 ${m.latencyP95!.toFixed(1)}ms ≥ 300ms`);
  if (r.sameAsDiff !== null && r.sameAsDiff !== 0) reasons.push(`一致性自检失败：与同参 arm 差异 ${r.sameAsDiff} 行`);

  return { arm: r.arm, feasible: reasons.length === 0, reasons };
}

const verdicts = grid.filter((r) => r.arm !== 'baseline').map(judge);
const eligible = grid.filter((r) => r.arm !== 'baseline' && !r.diagnostic);
const feasible = eligible.filter((r) => verdicts.find((v) => v.arm === r.arm)!.feasible);

// --- §7 九条顺序 ---
function pick(cands: Row[]): { winner: Row | null; trace: string[] } {
  const trace: string[] = [];
  if (cands.length === 0) return { winner: null, trace: ['可行 arm 数为 0 → §7 第 9 条：R2 未通过'] };
  let pool = [...cands];
  const step = (label: string, key: (r: Row) => number, dir: 'max' | 'min', tol = 0) => {
    if (pool.length <= 1) return;
    const vals = pool.map(key);
    const best = dir === 'max' ? Math.max(...vals) : Math.min(...vals);
    const kept = pool.filter((r) => Math.abs(key(r) - best) <= tol);
    trace.push(`${label}：最优 ${best.toFixed(4)}，保留 ${kept.length}/${pool.length}`);
    pool = kept;
  };
  step('1 S3 hit@5 最大', (r) => r.strata.S3?.hitAt5 ?? 0, 'max', S3_RESOLUTION - 1e-9);
  step('2 fusion 全集 MRR 最大', (r) => r.metrics.fusionMrr ?? 0, 'max');
  step('3 S1 MRR 最大', (r) => r.strata.S1?.mrr ?? 0, 'max');
  step('4 empty-ext 最坏最小', (r) => r.metrics.emptyExtWorst ?? 0, 'min');
  step('5 empty-ext 均值最小', (r) => r.metrics.emptyExtReturned ?? 0, 'min');
  step('6 优先 discovery-only', (r) => (r.policy.bigramVote === 'discovery-only' ? 1 : 0), 'max');
  step('7 bigramOnlyLimit 更小', (r) => Number(r.policy.bigramOnlyLimit), 'min');
  step('8 bigramDfRatioCeiling 更小', (r) => Number(r.policy.bigramDfRatioCeiling), 'min');
  return { winner: pool[0] ?? null, trace };
}
const { winner, trace } = pick(feasible);

// --- 报告 ---
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const fx = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d));
const L: string[] = [];
L.push('# 阶段 3A-R2 arm 选择（确定性计算）');
L.push('');
L.push(`> 生成时间：${new Date().toISOString()}`);
L.push(`> 输入：\`${DIR}/grid.json\``);
L.push('> 判据：`benchmark/reports/phase3a-r2-criteria.md` §6 门槛 + §7 顺序（**A2 修订版**）');
L.push('');
L.push('## 基线（当前发布行为，bigram 关闭）');
L.push('');
L.push('| 项 | 值 |');
L.push('| --- | ---: |');
L.push(`| fusion hit@5 / MRR / R-prec | ${pct(base.metrics.fusionHitAt5)} / ${fx(base.metrics.fusionMrr)} / ${pct(base.metrics.fusionRPrecision)} |`);
for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) {
  const x = base.strata[s];
  if (x) L.push(`| └ ${s}（n=${x.n}） hit@5 / MRR | ${pct(x.hitAt5)} / ${fx(x.mrr)} |`);
}
L.push(`| empty-ext 均值 / 最坏 | ${fx(base.metrics.emptyExtReturned, 2)} / ${base.metrics.emptyExtWorst} |`);
for (const l of ['N1', 'N2', 'N3', 'N4']) {
  const x = base.emptyLayers[l];
  if (x) L.push(`| └ ${l}（n=${x.n}） 均 / 坏 | ${x.mean.toFixed(2)} / ${x.worst} |`);
}
L.push(`| 既有 expected-empty 均 / 坏 | ${fx(base.metrics.expectedEmptyReturned, 2)} / ${base.metrics.expectedEmptyWorst} |`);
L.push(`| Phase 2 hit@5 | ${pct(base.metrics.phase2HitAt5)} |`);
L.push(`| tuned MRR / R-prec | ${fx(base.metrics.tunedMrr)} / ${pct(base.metrics.tunedRPrecision)} |`);
L.push('');

L.push('## 逐 arm 判定');
L.push('');
L.push('| arm | 参选 | 可行 | 未达标项 |');
L.push('| --- | :--: | :--: | --- |');
for (const r of grid) {
  if (r.arm === 'baseline') continue;
  const v = verdicts.find((x) => x.arm === r.arm)!;
  L.push(`| \`${r.arm}\` | ${r.diagnostic ? '否（诊断）' : '是'} | ${v.feasible ? '✅' : '❌'} | ${v.reasons.join('；') || '—'} |`);
}
L.push('');

L.push('## 选择');
L.push('');
L.push(`参选 arm ${eligible.length} 个，可行 **${feasible.length}** 个。`);
L.push('');
for (const t of trace) L.push(`- ${t}`);
L.push('');
if (winner) {
  L.push(`### 选中：\`${winner.arm}\``);
  L.push('');
  L.push('| 字段 | 值 |');
  L.push('| --- | --- |');
  for (const [k, v] of Object.entries(winner.policy)) L.push(`| ${k} | \`${String(v)}\` |`);
} else {
  L.push('### 结论：**R2 未通过**');
  L.push('');
  L.push('判据 §7 第 9 条：没有 arm 可行时，`bigramAux` 继续保持关闭，');
  L.push('不得用「恢复原状」充当阶段成功。');
}
L.push('');

await Bun.write('benchmark/reports/phase3a-r2-selection.md', `${L.join('\n')}\n`);
await Bun.write('benchmark/reports/phase3a-r2-selection.json', JSON.stringify(
  { generatedAt: new Date().toISOString(), baseline: { metrics: base.metrics, strata: base.strata, emptyLayers: base.emptyLayers },
    verdicts, eligible: eligible.map((r) => r.arm), feasible: feasible.map((r) => r.arm),
    trace, winner: winner?.arm ?? null }, null, 2));
console.log(L.join('\n'));
console.log(`\n[R2] 选参写入 benchmark/reports/phase3a-r2-selection.{md,json}`);
