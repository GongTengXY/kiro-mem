/**
 * Phase 3A-R2 arm driver（判据 `benchmark/reports/phase3a-r2-criteria.md` §5）。
 *
 * 三道装置纪律沿用 2D / 3A，理由不变：
 *
 *  1. 每个 arm 生成**全部**策略字段的 CLI 参数，跑完与内核上报的 policy 逐字段断言。
 *     `run.ts` 取第一个匹配的 `--name=`，重复给会静默保留基线值。
 *  2. 报告先写 `.staging`，断言通过后 MD 与 JSON 一起替换，`finally` 无条件清理。
 *  3. `BASE_POLICY` 与生产策略对象逐字段比对，并额外断言 `bigramAux === false` 与
 *     `bigramVote === 'always'`——否则「baseline = 当前发布行为」不成立。
 *
 * R2 特有的一条：**S2 / S5 逐条一致性是硬锁**（判据 §6.1）。那两层的 bigram 腿跑了但没碰到
 * gold，所以任何 bigram 参数都不该改变它们的返回页。驱动逐条比对并单独报出——不一致即该
 * arm 不可行，不看其他指标。
 */

const REPORT_DIR = 'benchmark/reports/phase3a-r2';

/** 冻结的生产策略（2C + 2D + 3A 关闭态），逐字段写出。每个 arm 从这里出发。 */
const BASE_POLICY = {
  semanticDiscovery: true,
  semanticFloor: 0.197,
  semanticOnlyLimit: 2,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: 'semantic-rank',
  semanticCandidatePool: 200,
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  bigramVote: 'always',
  // Top-K 轮次新增。历史读数都是在"不截断"下测的，所以这里就是 Infinity；
  // 阶段二若把生产默认改成有限 K，这一行仍应保持 Infinity 并加显式例外，
  // 理由与 semanticCandidatePool=200 那条相同。
  semanticTopK: Number.POSITIVE_INFINITY,
} as const;

type Policy = Record<string, unknown>;

{
  const { DEFAULT_RETRIEVAL_POLICY } = await import('../src/server/observation-search');
  const shipped = DEFAULT_RETRIEVAL_POLICY as unknown as Policy;
  for (const k of Object.keys(shipped)) {
    // 候选池轮次把生产默认从 200 改成了 Infinity，而 200 是本轮读数实际运行时的值。
    // 在这里钉住它（并在下面断言），比放宽字段数检查安全：字段数检查的作用是让新字段
    // 必须被显式登记，放宽它等于关掉守卫。
    if (k === "semanticCandidatePool") continue;
    // 同理：Top-K 轮次把生产默认从"不截断"改成 1000，历史读数都是在不截断下测的。
    if (k === "semanticTopK") continue;
    if ((BASE_POLICY as Policy)[k] !== shipped[k]) {
      throw new Error(
        `BASE_POLICY.${k}=${JSON.stringify((BASE_POLICY as Policy)[k])} 与生产策略的 ` +
        `${JSON.stringify(shipped[k])} 不一致——基线不再是当前发布行为，本驱动的报告会说谎`,
      );
    }
  }
  if (Object.keys(BASE_POLICY).length !== Object.keys(shipped).length) {
    throw new Error(
      `BASE_POLICY 字段数 ${Object.keys(BASE_POLICY).length} 与生产策略 ` +
      `${Object.keys(shipped).length} 不一致——有新字段没有进基线`,
    );
  }
  if (shipped.bigramAux !== false) {
    throw new Error('生产默认已经打开 bigramAux——R2 的 baseline 不再是「改动之前」');
  }
  if (BASE_POLICY.semanticCandidatePool !== 200) {
    throw new Error(
      `BASE_POLICY.semanticCandidatePool 必须是 200（本驱动历史读数实际使用的候选池；` +
      `生产默认已由候选池轮次改为 Infinity），实际 ${BASE_POLICY.semanticCandidatePool}`,
    );
  }
  if (BASE_POLICY.semanticTopK !== Number.POSITIVE_INFINITY) {
    throw new Error(
      `BASE_POLICY.semanticTopK 必须是 Infinity（本驱动历史读数在不截断下测的；` +
      `生产默认已由 Top-K 轮次改为 1000），实际 ${BASE_POLICY.semanticTopK}`,
    );
  }
  if (shipped.bigramVote !== 'always') {
    throw new Error('生产默认的 bigramVote 不是 always——R2 的自变量起点被改过了');
  }
}

interface Arm {
  name: string;
  override: Policy;
  variable: string;
  /** 预登记为「不参与选择」（判据 §5.4）。 */
  diagnostic?: boolean;
  /** 与另一个 arm 同参，用作一致性自检；两者必须逐位相同。 */
  sameAs?: string;
}

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
    semanticTopK: 'semantic-topk',
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

const ON = { bigramAux: true };
const arms: Arm[] = [
  { name: 'baseline', override: {}, variable: '—（当前发布行为，bigram 关闭）' },

  // 实验一（主）：只改投票范围，其余全部保持 3A 的值。
  { name: 'exp1-disc', override: { ...ON, bigramVote: 'discovery-only' },
    variable: '实验一：只改 bigramVote=discovery-only', sameAs: 'disc-df1-cap2' },
];

// 实验二：discovery-only 下重新校准两个护栏。
for (const ceiling of [0.12, 1.0]) {
  for (const cap of [1, 2, 3]) {
    arms.push({
      name: `disc-df${String(ceiling).replace('.', '')}-cap${cap}`,
      override: { ...ON, bigramVote: 'discovery-only', bigramDfRatioCeiling: ceiling, bigramOnlyLimit: cap },
      variable: `实验二：discovery-only DF≤${ceiling} cap=${cap}`,
    });
  }
}

// 实验三：always + 降权（竞争方案）。
for (const w of [0.25, 0.5, 0.75]) {
  arms.push({
    name: `always-w${String(w).replace('.', '')}`,
    override: { ...ON, bigramVote: 'always', bigramWeight: w },
    variable: `实验三：always w_bigram=${w}`,
  });
}

// 诊断（预登记不参与选择）。
arms.push({
  name: 'diag-3a-best', override: { ...ON, bigramVote: 'always' },
  variable: '诊断：3A 形态（always DF≤1.0 cap2 w1）', diagnostic: true,
});
arms.push({
  name: 'diag-min2', override: { ...ON, bigramVote: 'always', bigramMinMatches: 2 },
  variable: '诊断：共现下限 minMatches=2', diagnostic: true,
});

/** 行为 fingerprint。与 3A 同口径：剥掉延迟、平局统计与探测过程。 */
const strip = (r: Record<string, unknown>): string => {
  const {
    latencyMs, exactTiePairs, exactTieInPage,
    bigramUnitsProbed, bigramUnitsZeroDf, bigramUnitsDropped, bigramHitUnits,
    bigramVoteMode, bigramVotesSuppressed,
    ...rest
  } = r;
  return JSON.stringify(rest);
};

const KEYS = [
  'fusionHitAt5', 'fusionMrr', 'fusionRPrecision', 'fusionS3S4HitAt5',
  'emptyExtReturned', 'emptyExtWorst',
  'phase2HitAt5', 'phase2Mrr',
  'tunedHitAt5', 'tunedMrr', 'tunedRPrecision',
  'expectedEmptyReturned', 'expectedEmptyWorst',
  'semanticOnlyMax', 'bigramOnlyMax', 'bigramOnlyTotal', 'bigramOnlyDroppedTotal',
  'bigramVotesSuppressedTotal', 'bigramProbedQueries', 'bigramCandidateQueries',
  'leakTotal', 'degrades', 'latencyP95',
] as const;

interface Row {
  arm: string;
  variable: string;
  diagnostic: boolean;
  policy: Policy;
  allGatesOk: boolean;
  failedGates: string[];
  diffRows: number;
  diffIds: string[];
  metrics: Record<string, number | null>;
  /** 逐层读数（S1–S5 / N1–N4）。 */
  strata: Record<string, { n: number; hitAt5: number; mrr: number; rPrecision: number }>;
  emptyLayers: Record<string, { n: number; mean: number; worst: number }>;
  /** S2 / S5 硬锁：与 baseline 逐条不一致的 query id。必须为空。 */
  neutralityBreaks: string[];
  /** 一致性自检：与 sameAs 指定的 arm 逐条不一致的行数。必须为 0。 */
  sameAsDiff: number | null;
}

await Bun.$`mkdir -p ${REPORT_DIR}`.quiet();

const results: Row[] = [];
let baseRows: Record<string, unknown>[] = [];
const rowsByArm = new Map<string, Record<string, unknown>[]>();

for (const arm of arms) {
  process.stdout.write(`[R2] ${arm.name} … `);
  const jsonPath = `${REPORT_DIR}/${arm.name}.json`;
  const mdPath = `${REPORT_DIR}/${arm.name}.md`;
  const tmpJson = `${jsonPath}.staging`;
  const tmpMd = `${mdPath}.staging`;
  const expected = { ...BASE_POLICY, ...arm.override };
  try {
    const proc = Bun.spawn(
      [
        'bun', 'run', 'benchmark/run.ts',
        '--compressor=gold', '--protocol=semantic-en',
        '--phase2', '--fusion', '--empty-ext', '--no-heldout',
        ...flagsFor(expected),
        `--report=${tmpMd}`,
        `--json=${tmpJson}`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const code = await proc.exited;
    // 退出码 1 = harness 自带门槛未达标，那是**实验结果**（判据 §10 要求失败 arm 留档）。
    // ≥2 是真错误（参数非法、策略非法、播种失败），仍然致命。
    if (code !== 0 && code !== 1) {
      throw new Error(`arm ${arm.name} 退出码 ${code}\n${await new Response(proc.stderr).text()}`);
    }
    if (!(await Bun.file(tmpJson).exists())) {
      throw new Error(`arm ${arm.name} 没有产出 JSON（退出码 ${code}）`);
    }

    const j = await Bun.file(tmpJson).json();
    const actual = j.provenance.retrievalPolicy;
    for (const [k, v] of Object.entries(expected)) {
      const want = v === Number.POSITIVE_INFINITY ? 'inf' : v;
      if (actual[k] !== want) {
        throw new Error(
          `arm ${arm.name} 的实际 policy 与预期不符：${k}=${JSON.stringify(actual[k])}，` +
          `预期 ${JSON.stringify(want)}\n实际：${JSON.stringify(actual)}`,
        );
      }
    }
    if (Object.keys(actual).length !== Object.keys(expected).length) {
      throw new Error(`arm ${arm.name} 的 policy 字段数变了：${JSON.stringify(actual)}`);
    }
    await Bun.write(jsonPath, JSON.stringify(j, null, 2));
    await Bun.write(mdPath, await Bun.file(tmpMd).text());

    const rows = j.queryRows as Record<string, unknown>[];
    if (arm.name === 'baseline') baseRows = rows;
    rowsByArm.set(arm.name, rows);
    const diff = rows.filter((r, i) => strip(r) !== strip(baseRows[i]!));

    // S2 / S5 硬锁：那两层的 bigram 腿跑了但没碰到 gold，返回页必须逐条不变。
    const neutralityBreaks = rows
      .filter((r, i) => {
        const st = r.fusionStratum as string | null;
        if (st !== 'S2' && st !== 'S5') return false;
        return JSON.stringify(r.resultIds) !== JSON.stringify(baseRows[i]!.resultIds);
      })
      .map((r) => r.id as string);

    const m = j.retrievalMetrics;
    const metrics: Record<string, number | null> = {};
    for (const k of KEYS) metrics[k] = m[k] ?? null;
    const strata: Row['strata'] = {};
    for (const [st, v] of Object.entries(m.fusionByStratum ?? {})) {
      const x = v as { n: number; hitAt5: number; mrr: number; rPrecision: number };
      strata[st] = { n: x.n, hitAt5: x.hitAt5, mrr: x.mrr, rPrecision: x.rPrecision };
    }

    results.push({
      arm: arm.name,
      variable: arm.variable,
      diagnostic: arm.diagnostic === true,
      policy: actual,
      allGatesOk: j.allGatesOk === true,
      failedGates: (j.gates ?? []).filter((g: { ok: boolean }) => !g.ok).map((g: { name: string }) => g.name),
      diffRows: diff.length,
      diffIds: diff.map((r) => r.id as string),
      metrics,
      strata,
      emptyLayers: (m.emptyExtByLayer ?? {}) as Row['emptyLayers'],
      neutralityBreaks,
      sameAsDiff: null,
    });
    console.log(
      `差异 ${diff.length}/${rows.length} 行` +
      (neutralityBreaks.length ? `，⚠️ S2/S5 硬锁破 ${neutralityBreaks.length} 条` : '') +
      (j.allGatesOk === true ? '' : '，harness 门槛未达标'),
    );
  } finally {
    await Bun.$`rm -f ${tmpJson} ${tmpMd}`.quiet();
  }
}

// 一致性自检：同参 arm 必须逐位相同。
for (const arm of arms) {
  if (!arm.sameAs) continue;
  const a = rowsByArm.get(arm.name);
  const b = rowsByArm.get(arm.sameAs);
  if (!a || !b) continue;
  const d = a.filter((r, i) => strip(r) !== strip(b[i]!)).length;
  const row = results.find((r) => r.arm === arm.name)!;
  row.sameAsDiff = d;
  console.log(`[R2] 一致性自检 ${arm.name} vs ${arm.sameAs}：逐 query 差异 ${d} 行（必须为 0）`);
}

await Bun.write(`${REPORT_DIR}/grid.json`, JSON.stringify(results, null, 2));

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const fx = (v: number | null, d = 3) => (v === null ? '—' : v.toFixed(d));
const L: string[] = [];
L.push('> `S2/S5 破` 非 0 即该 arm 不可行（判据 §6.1 硬锁）。empty-ext 门槛按 A2 修订为「不得高于 baseline」。');
L.push('');
L.push('| arm | 自变量 | 诊断 | 差异行 | S2/S5 破 | fusion hit@5 | fusion MRR | S1 MRR | S3 hit@5 | S4 hit@5 | empty-ext 均/坏 | N3 均/坏 | 既有 empty 均/坏 | Phase2 hit@5 | tuned MRR/R-prec | 抑制票 | p95 |');
L.push('| --- | --- | :--: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of results) {
  const m = r.metrics;
  const s = (st: string, f: 'hitAt5' | 'mrr') => (r.strata[st] ? r.strata[st]![f] : null);
  const n3 = r.emptyLayers.N3;
  L.push(
    `| \`${r.arm}\` | ${r.variable} | ${r.diagnostic ? '是' : '—'} | ${r.diffRows} | ${r.neutralityBreaks.length} | ` +
    `${pct(m.fusionHitAt5!)} | ${fx(m.fusionMrr!)} | ${fx(s('S1', 'mrr'))} | ${pct(s('S3', 'hitAt5'))} | ${pct(s('S4', 'hitAt5'))} | ` +
    `${fx(m.emptyExtReturned!, 2)}/${m.emptyExtWorst} | ${n3 ? `${n3.mean.toFixed(2)}/${n3.worst}` : '—'} | ` +
    `${fx(m.expectedEmptyReturned!, 2)}/${m.expectedEmptyWorst} | ${pct(m.phase2HitAt5!)} | ` +
    `${fx(m.tunedMrr!)}/${pct(m.tunedRPrecision!)} | ${m.bigramVotesSuppressedTotal} | ${fx(m.latencyP95!, 1)}ms |`,
  );
}
console.log(`\n${L.join('\n')}`);
await Bun.write(`${REPORT_DIR}/grid-table.md`, `${L.join('\n')}\n`);
console.log(`\n[R2] 汇总写入 ${REPORT_DIR}/grid.json 与 grid-table.md`);
