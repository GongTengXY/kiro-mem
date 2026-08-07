/**
 * Top-K 轮次阶段二：按判据机械计算门槛 S1–S8 与选择结果。
 *
 * 判据：`benchmark/reports/topk-criteria.md`，A0 `699d988c419be7b3` +
 * **B1 `2285d0fa8cf5e1ee`**（裁定的聚合口径：S2/S3 **每次复现都需达标**，
 * 不接受中位数，也不接受最小值 + 分布；`semanticTopK=Infinity` 因为保留集随语料规模
 * 增长，不满足 `O(块大小 + K)`，不得作为发布形态）。
 *
 * 本脚本不跑检索，只读已落盘的 arm 读数并复算。判据 §8 第 4 项要求脚本输出、禁止手工抄表。
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const REPORTS = join(import.meta.dir, 'reports');
const TOPK_DIR = join(REPORTS, 'topk');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

// --- 判据常数，逐条抄自 §6.3 门槛表 ------------------------------------------
const P95_MAX = 300;
const P99_MAX = 500;
const RSS_LOOP_MAX = 512;
const RSS_PEAK_MAX = 1024;
const MIN_SAMPLES = 200;
/** 判据 §6.2 登记的 K 候选。`Infinity` 不在候选里（B1：不满足有界内存）。 */
const CANDIDATE_K = [200, 1000, 5000, 20000];

interface Check { id: string; pass: boolean; reading: string }

// --- S1：返回页一致性 --------------------------------------------------------
//
// 两个装置都要看，而且必须都看：2,000 条装置有 gold 标注但 above-floor ≤ ~600，
// K≥1000 在那里压根不截断；50,000 档没有 gold，但截断是真的（K=200 只保留 163/4,618）。
// 只看前者会把"没截断"读成"截断无害"。
const recallBase = read(join(REPORTS, 'pool-policy/recall.json'));
const baseRows = new Map<string, any>(recallBase.perQuery['pool-full'].map((r: any) => [r.id, r]));
const perf50Base = read(join(TOPK_DIR, 'perf-50000-full-noK.json')).results[0].pages as {
  id: string; resultIds: number[]; sources: string[];
}[];
const perf50BaseMap = new Map(perf50Base.map((p) => [p.id, p]));

function identity2000(k: number): { queries: number; diffIds: number; diffSources: number; diffReach: number } {
  const s = read(join(TOPK_DIR, `recall-k${k}.json`));
  const rows = s.perQuery['pool-full'] as any[];
  let diffIds = 0;
  let diffSources = 0;
  let diffReach = 0;
  for (const n of rows) {
    const o = baseRows.get(n.id);
    if (!o) continue;
    if (JSON.stringify(o.resultIds) !== JSON.stringify(n.resultIds)) diffIds++;
    if (JSON.stringify(o.resultSources) !== JSON.stringify(n.resultSources)) diffSources++;
    // 名次表是否仍含 gold。这是 T4（逐键一致）在装置上的可观测代理：截断掉 gold 的名次
    // 不改变页面，但改变"语义腿触达"这个读数，所以它算 S8 的失败而不是 S1 的。
    if (o.semanticReachedGold !== n.semanticReachedGold) diffReach++;
  }
  return { queries: rows.length, diffIds, diffSources, diffReach };
}

function identity50000(k: number): { queries: number; diffIds: number; diffSources: number } {
  const r = read(join(TOPK_DIR, `perf-50000-full-k${k}.json`)).results[0];
  let diffIds = 0;
  let diffSources = 0;
  for (const p of r.pages as { id: string; resultIds: number[]; sources: string[] }[]) {
    const o = perf50BaseMap.get(p.id);
    if (!o) continue;
    if (JSON.stringify(o.resultIds) !== JSON.stringify(p.resultIds)) diffIds++;
    if (JSON.stringify(o.sources) !== JSON.stringify(p.sources)) diffSources++;
  }
  return { queries: (r.pages as unknown[]).length, diffIds, diffSources };
}

// --- S2–S7：50,000 档全部复现，严格口径 --------------------------------------
interface Run { file: string; k: string; samples: number; p50: number; p95: number; p99: number; rssDelta: number; rssPeak: number; degraded: number }
const runs: Run[] = [];
for (const f of readdirSync(TOPK_DIR).filter((x) => x.startsWith('perf-50000-') && x.endsWith('.json'))) {
  const j = read(join(TOPK_DIR, f));
  for (const r of j.results ?? []) {
    runs.push({
      file: f,
      k: String(j.provenance?.semanticTopK ?? 'unknown'),
      samples: r.samples, p50: r.latency.p50, p95: r.latency.p95, p99: r.latency.p99,
      rssDelta: r.rssLoop.deltaMb, rssPeak: r.rssProcessPeakMb, degraded: r.degradedCount,
    });
  }
}
/** `perf-50000-stream-*` 是阶段一在 pool=20000 下测的，不是阶段二的 arm。 */
const phase2Runs = runs.filter((r) => !r.file.startsWith('perf-50000-stream'));

function strictGates(k: number): { checks: Check[]; runs: Run[] } {
  const mine = phase2Runs.filter((r) => r.k === String(k));
  const checks: Check[] = [];
  const add = (id: string, pass: boolean, reading: string) => checks.push({ id, pass, reading });
  add('复现次数 ≥3', mine.length >= 3, `${mine.length} 次`);
  // 严格口径（B1）：每一次读数都必须达标，取最坏值判定。
  const worst = (sel: (r: Run) => number): number => (mine.length ? Math.max(...mine.map(sel)) : Number.POSITIVE_INFINITY);
  add(`S2 每次 p95 < ${P95_MAX}ms`, worst((r) => r.p95) < P95_MAX,
    mine.map((r) => r.p95).sort((a, b) => a - b).join(' / ') + 'ms');
  add(`S3 每次 p99 < ${P99_MAX}ms`, worst((r) => r.p99) < P99_MAX,
    mine.map((r) => r.p99).sort((a, b) => a - b).join(' / ') + 'ms');
  add(`S4 每次循环内 RSS ≤ ${RSS_LOOP_MAX}MB`, worst((r) => r.rssDelta) <= RSS_LOOP_MAX,
    mine.map((r) => `+${r.rssDelta}`).sort().join(' / ') + 'MB');
  add(`S5 每次进程峰值 ≤ ${RSS_PEAK_MAX}MB`, worst((r) => r.rssPeak) <= RSS_PEAK_MAX,
    mine.map((r) => r.rssPeak).sort((a, b) => a - b).join(' / ') + 'MB');
  add(`S6 每次样本 ≥ ${MIN_SAMPLES}`, mine.length > 0 && mine.every((r) => r.samples >= MIN_SAMPLES),
    mine.map((r) => r.samples).join(' / '));
  add('S7 degrade = 0', mine.length > 0 && mine.every((r) => r.degraded === 0),
    mine.map((r) => r.degraded).join(' / '));
  return { checks, runs: mine };
}

// --- 逐 K 判定 ---------------------------------------------------------------
const verdicts = CANDIDATE_K.map((k) => {
  const id2000 = identity2000(k);
  const id50000 = identity50000(k);
  const { checks, runs: mine } = strictGates(k);
  const s1: Check[] = [
    { id: 'S1 2,000 装置有序 resultIds', pass: id2000.diffIds === 0, reading: `${id2000.diffIds}/${id2000.queries}` },
    { id: 'S1 2,000 装置 match_source', pass: id2000.diffSources === 0, reading: `${id2000.diffSources}` },
    { id: 'S1 50,000 档有序 resultIds（真截断）', pass: id50000.diffIds === 0, reading: `${id50000.diffIds}/${id50000.queries}` },
    { id: 'S1 50,000 档 match_source', pass: id50000.diffSources === 0, reading: `${id50000.diffSources}` },
    // S8 要求 T1–T6 仍成立；T4 是名次表逐键一致，触达差异即其失败信号。
    { id: 'S8/T4 名次表仍含 gold（触达差异 0）', pass: id2000.diffReach === 0, reading: `${id2000.diffReach} 条 query` },
  ];
  const all = [...s1, ...checks];
  return { k, checks: all, feasible: all.every((c) => c.pass), runs: mine };
});

const feasible = verdicts.filter((v) => v.feasible);
// §6.3 选择规则：可行 K 取最小者（内存最省）。
const selected = feasible.length ? feasible.reduce((a, b) => (a.k <= b.k ? a : b)) : null;

const out = {
  generatedAt: new Date().toISOString(),
  provenance: {
    criteria: 'benchmark/reports/topk-criteria.md',
    criteriaSha256: sha16(readFileSync(join(REPORTS, 'topk-criteria.md'), 'utf-8')),
    aggregationRule: '每次复现都需达标（裁定 B1；不接受中位数 / 最小值+分布）',
    scriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    identityBaselines: {
      '2000': 'pool-policy/recall.json arm pool-full（换之前的全量打分）',
      '50000': 'topk/perf-50000-full-noK.json（流式但不截断）',
    },
  },
  candidateK: CANDIDATE_K,
  excluded: {
    Infinity: 'B1：topK=Infinity 让保留集随语料规模增长（50,000 档实测均 4,618 / 最坏 14,830 条），不满足 O(块大小 + K)，不得作为发布形态',
  },
  verdicts,
  selected: selected ? { semanticCandidatePool: 'Infinity', semanticTopK: selected.k } : null,
};
writeFileSync(join(REPORTS, 'topk-selection.json'), `${JSON.stringify(out, null, 2)}\n`);

// --- 控制台 ------------------------------------------------------------------
console.log('=== 聚合口径（裁定 B1）：每次复现都需达标 ===\n');
for (const v of verdicts) {
  const failed = v.checks.filter((c) => !c.pass);
  console.log(`${v.feasible ? '✅' : '❌'} K=${String(v.k).padStart(5)}（${v.runs.length} 次复现）`);
  for (const c of v.checks) console.log(`      ${c.pass ? '✅' : '❌'} ${c.id}：${c.reading}`);
  if (failed.length) console.log(`      → 失败 ${failed.length} 项`);
}
console.log('\n=== 不截断（topK=Infinity）===');
const infRuns = phase2Runs.filter((r) => r.k === 'default');
console.log(`  参考读数 ${infRuns.length} 次：p95 ${infRuns.map((r) => r.p95).sort((a, b) => a - b).join(' / ')}ms；` +
  `RSS ${infRuns.map((r) => `+${r.rssDelta}`).join(' / ')}MB`);
console.log('  按 B1 排除：保留集随语料规模增长，不满足 O(块大小 + K)；且严格口径下 p95 有超限读数。');
console.log(`\n最终：${selected ? `pool=Infinity + semanticTopK=${selected.k}` : '无可行 K → 保持 pool=20000'}`);
console.log('写入 benchmark/reports/topk-selection.json');
if (!selected) process.exit(1);
