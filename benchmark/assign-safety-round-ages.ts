/**
 * P2 第 4 步第 3 阶段：给最终 40 条记录一次性生成 `age_days` 与插入顺序。
 *
 * 裁决 1.2（`p2-step3-review-and-step4-ruling.md` §1.2）：
 *
 *   - 固定种子 + 固定脚本，独立打乱年龄与插入顺序；
 *   - 报告「年龄 vs 文本长度」与「年龄 vs 插入顺序」的 **Spearman 秩相关系数**；
 *   - **相关系数只作检查记录**：不得临时设阈值、不得看到结果后重新洗牌；
 *   - 种子、脚本 SHA、最终排列进入冻结记录。
 *
 * ## 种子怎么来的（这一条比种子本身重要）
 *
 * 种子 = 已冻结判据 SHA-256 的前 8 位十六进制。判据在任何记录产出之前就冻结了，
 * 所以这个种子**不可能是挑出来的**——它在有任何洗牌结果可看之前就已经确定。
 * 换一个"看起来更均匀"的种子会立刻在这里露出来：SHA 是公开的，任何人都能复算。
 *
 * ## 为什么这一步在复核之后
 *
 * 复核会删记录（本轮删了 c16）。若在复核之前赋值，之后要么重排（看起来像重新洗牌），
 * 要么留下一个与最终集合不匹配的排列。放在这里，洗牌只发生一次。
 *
 * 用法：bun run benchmark/assign-safety-round-ages.ts [--write]
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

import { annotationSearchText, DATASET_DIR } from './dataset';
import type { Annotation } from './dataset';

const write = process.argv.includes('--write');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[age] ✗ ${m}`); process.exit(1); };

const OUT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const CAND = join(DATASET_DIR, 'turns-safety-round.json');
const freeze = read(join(OUT_DIR, 'p2-calibration-freeze.json'));

// 种子来自冻结判据的 SHA-256 前 8 位十六进制——在任何洗牌结果可见之前就已确定。
const SEED_HEX: string = freeze.ageSeed?.hex ?? die('冻结记录缺 ageSeed.hex');
const SEED = parseInt(SEED_HEX, 16);
/** 与 filler 装置同跨度（1,095 天），使新记录与旧语料的时间轴交错而不是聚成一簇。 */
const SPAN_DAYS = freeze.oldCorpusSpreadDays ?? 1095;

/** mulberry32：确定性、可移植、不依赖运行时的 Math.random 实现。 */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates，用同一个流。 */
function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 秩（平均秩处理并列）。 */
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((p, q) => p.v - q.v);
  const r = new Array<number>(xs.length);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1]!.v === idx[k]!.v) j++;
    const avg = (k + j) / 2 + 1;
    for (let m = k; m <= j; m++) r[idx[m]!.i] = avg;
    k = j + 1;
  }
  return r;
}

/** Spearman = 秩上的 Pearson。 */
function spearman(xs: number[], ys: number[]): number {
  const rx = ranks(xs), ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx, b = ry[i]! - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return num / Math.sqrt(dx * dy);
}

// --- 执行 -------------------------------------------------------------------
const cand = read(CAND) as { meta: any; records: { id: string; annotation: Annotation }[] };
const n = cand.records.length;
if (n < 40) die(`最终集合只有 ${n} 条，低于判据 §7.1 的 40 条下限`);

const rnd = mulberry32(SEED);

// 1) 年龄：从 [1, SPAN_DAYS] 里取 n 个互不相同的整数，再打乱后按记录在文件里的顺序分配。
//    先取集合再打乱，保证年龄本身与"取到的先后"无关。
const pool = new Set<number>();
while (pool.size < n) pool.add(1 + Math.floor(rnd() * SPAN_DAYS));
const ages = shuffle([...pool], rnd);

// 2) 插入顺序：**另取一次**打乱，与年龄用同一个流的后续输出，因此两者独立。
const insertionOrder = shuffle(cand.records.map((r) => r.id), rnd);

const lengths = cand.records.map((r) => annotationSearchText(r.annotation).length);
const insertionIndex = cand.records.map((r) => insertionOrder.indexOf(r.id));

const ageVsLength = spearman(ages, lengths);
const ageVsInsertion = spearman(ages, insertionIndex);
const r3 = (x: number): number => Number(x.toFixed(3));

const assignment = cand.records.map((r, i) => ({
  id: r.id,
  age_days: ages[i]!,
  insertion_index: insertionIndex[i]!,
  search_text_length: lengths[i]!,
}));

const scriptSha = createHash('sha256').update(readFileSync(import.meta.path)).digest('hex');
const report = {
  step: 'P2 第 4 步第 3 阶段：年龄与插入顺序的一次性随机化',
  ruling: 'benchmark/reports/safety-round/p2-step3-review-and-step4-ruling.md §1.2',
  seed: { value: SEED, hex: SEED_HEX, source: 'p2-calibration-freeze.json 的 ageSeed（钉死值）', derivedFrom: freeze.ageSeed.derivedFrom, pinnedReason: freeze.ageSeed.pinnedReason },
  script: { path: 'benchmark/assign-safety-round-ages.ts', sha256: scriptSha },
  spanDays: SPAN_DAYS,
  records: n,
  spearman: {
    ageVsSearchTextLength: r3(ageVsLength),
    ageVsInsertionOrder: r3(ageVsInsertion),
    note: '只作检查记录。判据与裁决都没有为它设阈值，因此不得据此重新洗牌——重洗等于用结果反向选装置。',
  },
  assignment,
};
writeFileSync(join(OUT_DIR, 'p2-age-assignment.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

console.log(`[age] 种子 0x${SEED_HEX} = ${SEED}（冻结记录 ageSeed 的钉死值，出处见 derivedFrom）`);
console.log(`[age] ${n} 条，年龄跨度 1…${SPAN_DAYS} 天，实际 ${Math.min(...ages)}…${Math.max(...ages)}`);
console.log(`[age] Spearman 年龄 vs 文本长度   ${r3(ageVsLength)}`);
console.log(`[age] Spearman 年龄 vs 插入顺序   ${r3(ageVsInsertion)}`);
console.log('[age] 相关系数只作检查记录，不设阈值、不重洗');

if (write) {
  for (const [i, r] of cand.records.entries()) {
    (r as any).age_days = ages[i]!;
    (r as any).insertion_index = insertionIndex[i]!;
  }
  cand.meta.ageAssignment = {
    ruling: 'p2-step3-review-and-step4-ruling.md §1.2',
    seedHex: SEED_HEX,
    script: 'benchmark/assign-safety-round-ages.ts',
    scriptSha256: scriptSha,
    report: 'benchmark/reports/safety-round/p2-age-assignment.json',
    spearman: { ageVsSearchTextLength: r3(ageVsLength), ageVsInsertionOrder: r3(ageVsInsertion) },
  };
  delete cand.meta.no_age_yet;
  writeFileSync(CAND, JSON.stringify(cand, null, 2) + '\n', 'utf-8');
  console.log(`[age] 已写回 ${CAND}`);
} else {
  console.log('[age] 未写回（加 --write 生效）');
}
