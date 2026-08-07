/**
 * Phase 3A arm driver（判据 `benchmark/reports/phase3a-criteria.md` §5）。
 *
 * 与 2D 的驱动同一套纪律，理由也相同：
 *
 *  - 每个 arm 生成**全部**策略字段的 CLI 参数，不是「基线 flag + 覆盖 flag」拼接。
 *    `run.ts` 取第一个匹配的 `--name=`，重复给会静默保留基线值，于是 arm 测的是别的
 *    东西。2D 的第一版就踩过这个坑，是策略断言当场抓出来的。
 *  - 报告先写 `.staging`，断言通过后 MD 与 JSON **一起**替换。只保护 JSON 会在断言
 *    失败时留下「新 MD + 旧 JSON」——一份自相矛盾的证据比没有证据更糟。
 *  - `--no-heldout`：heldout、既有 validation 与 Codex 盲审集都是确认集（判据 §9），
 *    在这里算出来就等于让「选参发生在确认集之前」变成一句无法证明的承诺。
 *
 * 3A 特有的一条：**Phase 2 校准集按冻结成员前后配对**（判据 §4.1）。这个驱动对
 * `ftsCount` 的比较一律是「同一条 query 的 baseline 值 vs 本 arm 值」，绝不按 arm 跑完
 * 之后的 `ftsCount=0` 重新筛子集——那样会把被 3A 修好的 query 踢出分母，指标显示持平
 * 甚至变差，而产品其实改善了。这是本阶段最容易出的假读数。
 */

const REPORT_DIR = 'benchmark/reports/phase3a';

/**
 * 冻结的 2C+2D 生产策略，逐字段写出。每个 arm 从这里出发。
 *
 * 与 2D 驱动的一个区别：那时 `tieBreak` 是自变量，所以 BASE_POLICY 与当时的生产默认
 * 在该字段上不同。3A 的自变量全是新增字段，而它们的生产默认就是「关闭」，所以
 * BASE_POLICY 必须与生产默认**逐字段完全相同**——baseline 就是当前发布的行为。
 */
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
  // 3A 当时还没有 `bigramVote` 这个字段——它是 3A-R2 新增的。守卫按字段值逐条比对生产策略，
  // 所以 R2 落地那一刻这个驱动就开始抛错（先于候选池轮次，与它无关）。补 `always` 是**历史
  // 装置修复**：`always` 正是 3A 运行时的既有行为（每个命中候选都加一票），不是在替已经收口的
  // bigram 路线选新策略。按裁定不因此重跑 3A 矩阵。
  bigramVote: "always",
  // Top-K 轮次新增。历史读数都是在"不截断"下测的，所以这里就是 Infinity；
  // 阶段二若把生产默认改成有限 K，这一行仍应保持 Infinity 并加显式例外，
  // 理由与 semanticCandidatePool=200 那条相同。
  semanticTopK: Number.POSITIVE_INFINITY,
} as const;

type Policy = Record<string, unknown>;

/**
 * BASE_POLICY 必须真的是当前发布的那份。
 *
 * per-arm 断言抓不到这件事：它的 expected 与 CLI 参数同源，写错 BASE_POLICY 会让两边
 * 一起错，跑出一份 provenance 自洽但基线不是生产值的报告。所以这里拿**生产策略对象
 * 本身**当参照物，逐字段相同，一个字段都不许差。
 *
 * 它同时是一个有意的耦合：将来生产改了任何一个字段，这个驱动会立刻停下——因为那时
 * 「baseline = 当前发布行为」这句话已经不成立。
 */
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
    throw new Error('生产默认已经打开 bigramAux——3A 的 baseline 不再是「改动之前」');
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
}

interface Arm {
  name: string;
  /** 只写这个 arm 相对 {@link BASE_POLICY} 改动的字段。 */
  override: Policy;
  variable: string;
  /** 预登记为「不参与选择」的 arm（判据 §5.2）。 */
  diagnostic?: boolean;
}

/** 完整策略 → CLI 参数，每个字段恰好出现一次。 */
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
    // 与 BASE_POLICY 同批补上（裁定第 5 条）：字段是 R2 新增的，`run.ts` 早已支持该参数，
    // 缺的只是这个驱动里的映射。不补映射，守卫会在字段比对之后再挂一次。
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
  { name: 'baseline', override: {}, variable: '—（当前发布行为，bigram 关闭）' },
];

// 主网格：判据 §5.1 预登记的 4 × 3。
// primary=26 时四个比例分别等价 DF≤1 / ≤2 / ≤3 / 不设上限——这个映射写在报告里，
// 否则读者无法判断分辨力。
const DF_CEILINGS = [0.04, 0.08, 0.12, 1.0];
const ONLY_LIMITS = [1, 2, 3];
for (const ceiling of DF_CEILINGS) {
  for (const cap of ONLY_LIMITS) {
    arms.push({
      name: `df${String(ceiling).replace('.', '')}-cap${cap}`,
      override: { bigramAux: true, bigramDfRatioCeiling: ceiling, bigramOnlyLimit: cap },
      variable: `DF≤${ceiling} cap=${cap}`,
    });
  }
}

// 诊断 arm（判据 §5.2 预登记为不参与选择）。
arms.push({
  name: 'diag-no-cap',
  override: { bigramAux: true, bigramDfRatioCeiling: 1, bigramOnlyLimit: Number.POSITIVE_INFINITY },
  variable: '诊断：方案 §10 字面实现（无上限、无 cap）',
  diagnostic: true,
});
arms.push({
  name: 'diag-min2',
  override: { bigramAux: true, bigramDfRatioCeiling: 1, bigramMinMatches: 2, bigramOnlyLimit: 2 },
  variable: '诊断：共现下限 minMatches=2',
  diagnostic: true,
});

/**
 * 行为 fingerprint。与 2D 同口径：剥掉延迟与平局统计。
 *
 * 3A 额外剥掉 `bigramUnits*`：它们描述的是**探测过程**（切了几个词、几个 DF=0），
 * 不是用户拿到的那一页。把它们计进行为差异会让每一条含中文的 query 都显示"改动"，
 * 于是"改动 N 条"这个数字失去判别力。候选层与返回层的读数照常单独报。
 */
const strip = (r: Record<string, unknown>): string => {
  const {
    latencyMs, exactTiePairs, exactTieInPage,
    bigramUnitsProbed, bigramUnitsZeroDf, bigramUnitsDropped, bigramHitUnits,
    ...rest
  } = r;
  return JSON.stringify(rest);
};

interface Row {
  arm: string;
  variable: string;
  diagnostic: boolean;
  policy: Policy;
  /** harness 自带门槛是否全过。false 不阻断留档——它就是这个 arm 的结果。 */
  allGatesOk: boolean;
  /** 未达标的门槛名，逐条留档（方案 §7.8：失败 arm 不得只写"失败"）。 */
  failedGates: string[];
  diffRows: number;
  diffIds: string[];
  metrics: Record<string, number | null>;
  /**
   * 冻结成员的前后配对（判据 §4.1）：baseline 里 `ftsCount=0`、本 arm 变正的 query。
   * 分母恒为 baseline 的成员名单，不按本 arm 重算。
   */
  ftsRescued: { id: string; kind: string; origin: string | null; units: string[]; hit5Before: boolean; hit5After: boolean }[];
  /** 不含 CJK bigram 的 query 里出现行为改动的（判据 §6.4 中立性锁，必须为空）。 */
  neutralityViolations: string[];
}

const KEYS = [
  'phase2HitAt5', 'phase2Mrr', 'phase2RPrecision',
  'phase2EmptyReturned', 'phase2EmptyWorst',
  'tunedHitAt5', 'tunedMrr', 'tunedRPrecision',
  'expectedEmptyReturned', 'expectedEmptyWorst',
  'semanticOnlyMax', 'semanticOnlyTotal', 'semanticOnlyDroppedTotal',
  'bigramOnlyMax', 'bigramOnlyTotal', 'bigramOnlyDroppedTotal',
  'bigramProbedQueries', 'bigramCandidateQueries', 'bigramUnitsDroppedTotal',
  'leakTotal', 'degrades', 'latencyP95',
] as const;

await Bun.$`mkdir -p ${REPORT_DIR}`.quiet();

const results: Row[] = [];
let baseRows: Record<string, unknown>[] = [];

for (const arm of arms) {
  process.stdout.write(`[3A] ${arm.name} … `);
  const jsonPath = `${REPORT_DIR}/${arm.name}.json`;
  const mdPath = `${REPORT_DIR}/${arm.name}.md`;
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
    // 退出码 1 = `allGatesOk` 为假（`run.ts:1766`），也就是「这个 arm 有门槛未达标」。
    // 那是**实验结果**，不是运行错误：判据 §10 与方案 §7.8 都要求所有失败 arm 留档，
    // 只保留能跑通的 arm 就是在筛选证据。真正的错误（参数非法、策略非法、播种失败）
    // 走退出码 2，仍然致命。
    if (code !== 0 && code !== 1) {
      throw new Error(`arm ${arm.name} 退出码 ${code}\n${await new Response(proc.stderr).text()}`);
    }
    if (!(await Bun.file(tmpJson).exists())) {
      throw new Error(`arm ${arm.name} 没有产出 JSON（退出码 ${code}）`);
    }

    // 断言在覆盖既有证据**之前**。
    const j = await Bun.file(tmpJson).json();
    const actual = j.provenance.retrievalPolicy;
    for (const [k, v] of Object.entries(expected)) {
      // JSON 里 Infinity 被序列化成 'inf'（run.ts 的 policyForReport）。
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

    if (arm.name === 'baseline') baseRows = j.queryRows;
    const rows = j.queryRows as Record<string, unknown>[];
    const diff = rows.filter((r, i) => strip(r) !== strip(baseRows[i]!));

    // 冻结成员配对：baseline ftsCount=0 → 本 arm 变正。
    const ftsRescued: Row['ftsRescued'] = [];
    rows.forEach((r, i) => {
      const b = baseRows[i]! as Record<string, unknown>;
      if ((b.ftsCount as number) === 0 && ((r.ftsCount as number) > 0 || (r.bigramCount as number) > 0)) {
        ftsRescued.push({
          id: r.id as string,
          kind: r.kind as string,
          origin: (r.origin as string) ?? null,
          units: (r.bigramHitUnits as string[]) ?? [],
          hit5Before: b.hitAt5 as boolean,
          hit5After: r.hitAt5 as boolean,
        });
      }
    });

    // 中立性锁：不含 CJK bigram 的 query（probed=0）不得有任何行为改动。
    const neutralityViolations = rows
      .filter((r, i) => (r.bigramUnitsProbed as number) === 0 && strip(r) !== strip(baseRows[i]!))
      .map((r) => r.id as string);

    const metrics: Record<string, number | null> = {};
    for (const k of KEYS) metrics[k] = j.retrievalMetrics[k] ?? null;
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
      ftsRescued,
      neutralityViolations,
    });
    console.log(
      `差异 ${diff.length}/${rows.length} 行，ftsCount 由 0 变正 ${ftsRescued.length} 条` +
      (j.allGatesOk === true ? '' : '，门槛未达标') +
      (neutralityViolations.length ? `，⚠️ 中立性违规 ${neutralityViolations.length} 条` : ''),
    );
  } finally {
    // 无条件清理，包括抛出路径。否则「断言失败不残留 staging」只是声明不是保证。
    await Bun.$`rm -f ${tmpJson} ${tmpMd}`.quiet();
  }
}

await Bun.write(`${REPORT_DIR}/grid.json`, JSON.stringify(results, null, 2));

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const fx = (v: number | null, d = 3) => (v === null ? '—' : v.toFixed(d));
const lines: string[] = [];
lines.push('> `empty 最坏 > 3` 即破判据 §6.3 的硬上界。`中立性` 非 0 即破 §6.4。');
lines.push('');
lines.push('| arm | 自变量 | 诊断 | 门槛 | 差异行 | 救回 | Phase2 hit@5 | Phase2 MRR | Phase2 empty 均/坏 | tuned hit@5/MRR/R-prec | 既有 empty 均/坏 | bigramOnly max | 中立性 | 泄漏 | p95 |');
lines.push('| --- | --- | :--: | :--: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of results) {
  const m = r.metrics;
  lines.push(
    `| \`${r.arm}\` | ${r.variable} | ${r.diagnostic ? '是' : '—'} | ${r.allGatesOk ? '✅' : '❌'} | ${r.diffRows} | ${r.ftsRescued.length} | ` +
    `${pct(m.phase2HitAt5!)} | ${fx(m.phase2Mrr!)} | ${fx(m.phase2EmptyReturned!, 2)}/${m.phase2EmptyWorst} | ` +
    `${pct(m.tunedHitAt5!)}/${fx(m.tunedMrr!)}/${pct(m.tunedRPrecision!)} | ` +
    `${fx(m.expectedEmptyReturned!, 2)}/${m.expectedEmptyWorst} | ${m.bigramOnlyMax} | ` +
    `${r.neutralityViolations.length} | ${m.leakTotal} | ${fx(m.latencyP95!, 1)}ms |`,
  );
}
console.log(`\n${lines.join('\n')}`);
await Bun.write(`${REPORT_DIR}/grid-table.md`, `${lines.join('\n')}\n`);
console.log(`\n[3A] 汇总写入 ${REPORT_DIR}/grid.json 与 grid-table.md`);
