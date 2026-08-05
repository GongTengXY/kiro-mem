/**
 * Phase 2D arm driver (plan §9.2).
 *
 * Runs the registered experiments against the ONLY sets §9.3 allows for selection
 * — the Gate A frozen Phase 2 calibration set plus the existing `tuned` continuity
 * lock — and diffs every arm against the 2C baseline row by row.
 *
 * `--no-heldout` is passed on every arm and is not optional: heldout, the existing
 * validation set and the Codex blind audit set are confirmation-only (§9.3), and a
 * driver that computed them here would make "the parameters were chosen before the
 * confirmation sets ran" unprovable.
 *
 * EVERY arm states the full 2C baseline explicitly, including
 * `--tie-break=recency`, and then overrides only its own variable (Gate D P1-1).
 * Inheriting the kernel default would silently break reproducibility the moment
 * 2D lands its own default: re-running this file after the default moved to
 * `semantic-rank` would turn "baseline" into the candidate and quietly overwrite
 * the evidence with a run that measured something else. The expected policy is
 * asserted against what the kernel reports BEFORE any report is kept.
 */

const REPORT_DIR = 'benchmark/reports/phase2d';

/**
 * The frozen 2C production policy, spelled out. Every arm starts from this.
 *
 * The 7 fields below are 2C's; the 7 after them are fields LATER phases added to
 * `RetrievalPolicy` (3A's bigram leg, R2's vote mode, 3B's candidate pool). They
 * are listed at the values 2D actually ran with — there was no bigram leg then,
 * and the pool was the hardcoded literal 200 — so adding them changes no reading.
 *
 * They have to be listed because the guard below compares against EVERY key of
 * the shipped policy. Without them this driver has been throwing since 3A landed,
 * which is how it was found: `bigramAux` etc. read `undefined` here against
 * `false` there. Repairing the list is the fix; loosening the guard would not be.
 */
const BASE_POLICY = {
  semanticDiscovery: true,
  semanticFloor: 0.197,
  semanticOnlyLimit: 2,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: 'recency',
  semanticCandidatePool: 200,
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  bigramVote: 'always',
} as const;

type Policy = Record<string, unknown>;

/**
 * BASE_POLICY 必须真的是 2C 冻结的那份，只在 `tieBreak` 上与当前生产默认不同。
 *
 * 上面那个 per-arm 断言抓不到这件事：它的 expected 与 CLI 参数同源，写错 `BASE_POLICY`
 * 会让两边一起错，跑出一份 provenance 自洽但基线不是 2C 的报告。所以这里拿**生产策略
 * 对象本身**当参照物：floor / cap / K / 权重 / discovery 必须逐字段相同，`tieBreak` 必须
 * 是 `recency`（2D 之前的取值，也是本轮的自变量起点）。
 *
 * 它同时是一个有意的耦合：如果将来生产改了 floor 或 cap，这个驱动会立刻停下——因为那时
 * "baseline = 2C 生产默认"这句话已经不成立，继续跑只会产出一份标题说谎的报告。
 */
{
  const { DEFAULT_RETRIEVAL_POLICY } = await import('../src/server/observation-search');
  const shipped = DEFAULT_RETRIEVAL_POLICY as unknown as Policy;
  for (const k of Object.keys(shipped)) {
    if (k === 'tieBreak') continue;
    // Same shape as `tieBreak`: the pool round moved the shipped default from 200
    // to `Infinity`, and 200 is the value THIS round's readings were measured
    // under. Pinning it here (and asserting it below) keeps the baseline honest;
    // relaxing the field-count check instead would let a future field slip in
    // unregistered, which is exactly what this guard exists to prevent.
    if (k === 'semanticCandidatePool') continue;
    if ((BASE_POLICY as Policy)[k] !== shipped[k]) {
      throw new Error(
        `BASE_POLICY.${k}=${JSON.stringify((BASE_POLICY as Policy)[k])} 与生产策略的 ` +
        `${JSON.stringify(shipped[k])} 不一致——基线不再是 2C 冻结值，本驱动的报告会说谎`,
      );
    }
  }
  if (BASE_POLICY.tieBreak !== 'recency') {
    throw new Error(`BASE_POLICY.tieBreak 必须是 recency（2D 的自变量起点），实际 ${BASE_POLICY.tieBreak}`);
  }
  if (BASE_POLICY.semanticCandidatePool !== 200) {
    throw new Error(
      `BASE_POLICY.semanticCandidatePool 必须是 200（2D 实际运行时的候选池；生产默认已由候选池` +
      `轮次改为 Infinity），实际 ${BASE_POLICY.semanticCandidatePool}`,
    );
  }
}

interface Arm {
  name: string;
  /** Only the fields this arm changes relative to {@link BASE_POLICY}. */
  override: Policy;
  /** What this arm varies. `—` for the baseline. */
  variable: string;
}

/**
 * CLI flags for a COMPLETE policy — every field emitted exactly once.
 *
 * Not "base flags + override flags": `run.ts` reads the first matching
 * `--name=` occurrence, so a duplicated flag silently keeps the base value and the
 * arm measures the wrong thing. That is not hypothetical — the first version of
 * this file did exactly that and the policy assertion below caught it.
 */
function flagsFor(policy: Policy): string[] {
  const map: Record<string, string> = {
    semanticFloor: 'semantic-floor',
    semanticOnlyLimit: 'semantic-only-limit',
    rrfK: 'rrf-k',
    ftsWeight: 'fts-weight',
    semanticWeight: 'semantic-weight',
    tieBreak: 'tie-break',
    semanticCandidatePool: 'semantic-candidate-pool',
    bigramDfRatioCeiling: 'bigram-df-ratio-ceiling',
    bigramMinMatches: 'bigram-min-matches',
    bigramOnlyLimit: 'bigram-only-limit',
    bigramWeight: 'bigram-weight',
    bigramVote: 'bigram-vote',
  };
  return Object.entries(policy).map(([k, v]) => {
    if (k === 'semanticDiscovery') return `--semantic-discovery=${v ? 'on' : 'off'}`;
    if (k === 'bigramAux') return `--bigram-aux=${v ? 'on' : 'off'}`;
    const flag = map[k];
    if (!flag) throw new Error(`policy 里有未映射到 CLI 参数的字段：${k}`);
    return `--${flag}=${v === Number.POSITIVE_INFINITY ? 'inf' : String(v)}`;
  });
}

const arms: Arm[] = [
  { name: 'baseline', override: {}, variable: '—（2C 生产默认）' },
  // 实验一：只改平局策略（方案 §9.2 登记的形状）
  { name: 'tb-source-confidence', override: { tieBreak: 'source-confidence' }, variable: 'tieBreak' },
  // 实验三：source-confidence 的保守扩展——分档在前，同档内再按语义名次。
  // 来源与目的在 `benchmark/reports/phase2d-criteria.md` §3 写在实现之前。
  { name: 'tb-semantic-rank', override: { tieBreak: 'semantic-rank' }, variable: 'tieBreak' },
];

// 实验二：加权 RRF。tie-break 显式保持 recency，所以唯一自变量是 (rrfK, w_sem)。
// w_sem=1.0 + rrfK=60 与 baseline 同参，是谐波自检：它必须逐位等于 baseline。
for (const rrfK of [30, 60, 90]) {
  for (const semanticWeight of [1.0, 1.1, 1.25, 1.5]) {
    arms.push({
      name: `k${rrfK}-wsem${semanticWeight}`,
      override: { rrfK, semanticWeight },
      variable: `rrfK=${rrfK} w_sem=${semanticWeight}`,
    });
  }
}

// 辅助诊断 arm（不参与选择）。
//
// Gate D P2：它**不是**精确平局的证明。`1.000001` 是有限扰动，一般情况下可能翻转分数只是
// 很接近的严格有序对，而生产比较器判的是 float64 `===`。精确平局集现在由内核实际算出的
// 融合分机械枚举（`exactTieInPage`），这个 arm 只保留为交叉核对：它的改动集**应当**落在
// 平局集之内，如果不是，那正好是"ε 不可靠"的证据。
arms.push({
  name: 'diag-wsem-epsilon',
  override: { semanticWeight: 1.000001 },
  variable: '辅助诊断：w_sem=1+ε',
});

/**
 * Behavioural fingerprint of a query row.
 *
 * `exactTiePairs` / `exactTieInPage` are stripped along with `latencyMs`: they
 * describe the SCORE LANDSCAPE, not the page the user gets. Counting them as a
 * behaviour change would make the weighted arms look like they moved 11 queries
 * when they moved 7 — unequal weights make exact equality essentially
 * unreachable, so every tied query changes those two fields without its results
 * changing. Tie statistics are reported separately (`tieInPageIds`).
 */
const strip = (r: Record<string, unknown>): string => {
  const { latencyMs, exactTiePairs, exactTieInPage, ...rest } = r;
  return JSON.stringify(rest);
};

interface Row {
  arm: string;
  variable: string;
  policy: Policy;
  diffRows: number;
  diffIds: string[];
  metrics: Record<string, number | null>;
  /** 平局集：本 arm 自己测到的、有平局进结果页的 query。 */
  tieInPageIds: string[];
}

const KEYS = [
  'phase2HitAt5', 'phase2Mrr', 'phase2RPrecision',
  'phase2EmptyReturned', 'phase2EmptyWorst',
  'tunedHitAt5', 'tunedMrr', 'tunedRPrecision',
  'expectedEmptyReturned', 'expectedEmptyWorst',
  'semanticOnlyMax', 'semanticOnlyTotal', 'semanticOnlyDroppedTotal',
  'exactTieQueries', 'exactTieInPageQueries', 'exactTiePairsTotal',
  'leakTotal', 'degrades', 'latencyP95',
] as const;

await Bun.$`mkdir -p ${REPORT_DIR}`.quiet();

const results: Row[] = [];
let baseRows: Record<string, unknown>[] = [];

for (const arm of arms) {
  process.stdout.write(`[2D] ${arm.name} … `);
  const jsonPath = `${REPORT_DIR}/${arm.name}.json`;
  const mdPath = `${REPORT_DIR}/${arm.name}.md`;
  // 两份都先写 staging（Gate D 第二轮 P2）。只 staging JSON 会在断言失败时留下
  // "新 MD + 旧 JSON"的组合——一份自相矛盾的证据比没有证据更糟。
  const tmpJson = `${jsonPath}.staging`;
  const tmpMd = `${mdPath}.staging`;
  const expected = { ...BASE_POLICY, ...arm.override };
  try {
    const proc = Bun.spawn(
      [
        'bun', 'run', 'benchmark/run.ts',
        '--compressor=gold', '--protocol=semantic-en', '--phase2', '--no-heldout',
        ...flagsFor(expected),
        `--report=${tmpMd}`,
        `--json=${tmpJson}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`arm ${arm.name} 退出码 ${code}\n${await new Response(proc.stderr).text()}`);
    }

    // 断言在覆盖既有证据**之前**。
    const j = await Bun.file(tmpJson).json();
    const actual = j.provenance.retrievalPolicy;
    for (const [k, v] of Object.entries(expected)) {
      if (actual[k] !== v) {
        throw new Error(
          `arm ${arm.name} 的实际 policy 与预期不符：${k}=${JSON.stringify(actual[k])}，` +
          `预期 ${JSON.stringify(v)}\n实际：${JSON.stringify(actual)}`,
        );
      }
    }
    if (Object.keys(actual).length !== Object.keys(expected).length) {
      throw new Error(`arm ${arm.name} 的 policy 字段数变了：${JSON.stringify(actual)}`);
    }
    // 断言通过：两份 staging 一起换到正式路径。
    await Bun.write(jsonPath, JSON.stringify(j, null, 2));
    await Bun.write(mdPath, await Bun.file(tmpMd).text());

    if (arm.name === 'baseline') baseRows = j.queryRows;
    const diff = j.queryRows.filter(
      (r: Record<string, unknown>, i: number) => strip(r) !== strip(baseRows[i]!),
    );
    const metrics: Record<string, number | null> = {};
    for (const k of KEYS) metrics[k] = j.retrievalMetrics[k] ?? null;
    results.push({
      arm: arm.name,
      variable: arm.variable,
      policy: actual,
      diffRows: diff.length,
      diffIds: diff.map((r: { id: string }) => r.id),
      metrics,
      tieInPageIds: j.queryRows.filter((r: { exactTieInPage: boolean }) => r.exactTieInPage)
        .map((r: { id: string }) => r.id),
    });
    console.log(`差异 ${diff.length}/${j.queryRows.length} 行，平局进页 ${results.at(-1)!.tieInPageIds.length} 条`);
  } finally {
    // 无条件清理，**包括抛出路径**。否则"断言失败不会残留 .staging"只是一句声明而不是
    // 代码保证，而一份半成品 staging 在下次运行时会被误读成上一轮的证据。
    await Bun.$`rm -f ${tmpJson} ${tmpMd}`.quiet();
  }
}

await Bun.write(`${REPORT_DIR}/grid.json`, JSON.stringify(results, null, 2));

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const fx = (v: number | null, d = 3) => (v === null ? '—' : v.toFixed(d));
const lines: string[] = [];
lines.push('| arm | 自变量 | 差异行 | 平局进页 | Phase2 hit@5 | Phase2 MRR | Phase2 empty 均/坏 | tuned hit@5/MRR/R-prec | semOnly max | 泄漏 |');
lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of results) {
  const m = r.metrics;
  lines.push(
    `| \`${r.arm}\` | ${r.variable} | ${r.diffRows} | ${r.tieInPageIds.length} | ${pct(m.phase2HitAt5!)} | ${fx(m.phase2Mrr!)} | ` +
    `${fx(m.phase2EmptyReturned!, 2)}/${m.phase2EmptyWorst} | ${pct(m.tunedHitAt5!)}/${fx(m.tunedMrr!)}/${pct(m.tunedRPrecision!)} | ` +
    `${m.semanticOnlyMax} | ${m.leakTotal} |`,
  );
}
console.log(`\n${lines.join('\n')}`);
await Bun.write(`${REPORT_DIR}/grid-table.md`, `${lines.join('\n')}\n`);
console.log(`\n[2D] 汇总写入 ${REPORT_DIR}/grid.json 与 grid-table.md`);
