#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F3：门判定与汇总**（判据 `f1-criteria.md` r3 §6、§7）。
 *
 * 判定与读数分开的理由：门是**机械计算**，必须能在不重跑 1920 次搜索的前提下复算。
 * 本脚本只读 `f3-arms/arm-*.json` 与 `perf-*.json`，不碰装置、不发起任何搜索。
 *
 * 判定项（判据 §6）：
 *
 *   G1 排序污染门（主门）  全体 80 条正例：Σ nonAcceptableBeforePrimary = 0
 *   G2 容量门（辅门）      40 条词面负例：**逐条** distinctContent ≤ 2，不取平均
 *   G3 标记门（辅门）      120 条全体：match_source 重算一致 + semantic-only ≤ 2
 *   G4 非回退线（与 G1 同等）80 条并集四档：hit@5 / MRR 逐档不低于基线
 *   召回保护线（同等地位）  五类各 8 条：逐类不得回退
 *   性能资格门             完整 search p95 < 300ms（基线未超预算，走绝对判定）
 *   S5–S9                  装置与护栏自证
 *
 * 三条口径纪律，直接来自判据：
 *
 * 1. **G1 的两个数分开报**（§6.1）：`pollutionCount` 是"排在 primary 前的非 acceptable 条数"，
 *    `actualDisplacement` 是相对基线的反事实位移。不得把前者说成后者。
 * 2. **G1 在 primary 缺席时记 0**，这是可被利用的退化解——把页面连 gold 一起压掉反而通过。
 *    G4 与保护线是它的资格过滤器，因此三者必须一起读。
 * 3. **G2 的 2 不得依据本轮数据调高**（§6.2）。
 *
 * 用法：bun run benchmark/collect-fts-round-f3.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyFreezeRecordFile } from './freeze-util';
import { ALL_ARMS, BASELINE_ARM } from './fts-round-admission';

const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const ARM_DIR = join(REPORTS, 'f3-arms');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[f3-collect] ✗ ${m}`); process.exit(1); };
const r3 = (x: number): number => Number(x.toFixed(3));
const r2n = (x: number): number => Number(x.toFixed(2));
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const worst = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0);

const BANDS = ['<0.200', '0.200-0.310', '0.310-0.400', '>=0.400'] as const;
const PROTECTION_CLASSES = ['short-query', 'proper-noun', 'path', 'number', 'historical-state'] as const;
const NEG_BANDS = ['1', '2-9', '10-99', '100-999', '>=1000'] as const;
/** G2 的容量上限。早于 P3、由 Phase 2B 预登记，本轮只沿用，不得依据本轮数据调高。 */
const G2_CAP = 2;
/** semantic-only 配额（生产策略值，全程冻结）。 */
const SEMANTIC_ONLY_CAP = 2;
/** 完整 search 的延迟预算（§6.6）。 */
const PERF_BUDGET_MS = 300;
/** MRR 比较的浮点吸收项；判据 §6.4 明写它不是容差。 */
const EPS = 1e-9;

// --- S1：冻结校验 -------------------------------------------------------------
const v = verifyFreezeRecordFile(join(REPORTS, 'f2-freeze-r3.json'));
console.log(`[f3-collect] S1 冻结校验：${v.label} → ${v.ok ? '✓' : '✗'}`);
if (!v.ok) die('冻结物已漂移');
const freeze = read(join(REPORTS, 'f2-freeze-r3.json'));
const frozenStrata = freeze.payload.strata as Record<'union' | 'relevance' | 'protection', Record<string, number>>;
const frozenNeg = freeze.payload.nextPhase.f3.negativeBreakdown as {
  baseline: { patched: { n: number; byFtsBand: Record<string, number> }; unpatched: { n: number; byFtsBand: Record<string, number> } };
  perQuery: { id: string; patched: boolean; ftsCount: number; ftsBand: string }[];
};
const negMeta = new Map(frozenNeg.perQuery.map((n) => [n.id, n]));

// --- 读 32 份读数 -------------------------------------------------------------
interface Row {
  id: string; kind: string; cohort: string; band?: string;
  negativeType?: string; lexicalNegativeClass?: string; protectionClass?: string; patched?: boolean;
  primaryRank: number | null; acceptableRank: number | null;
  nonAcceptable: number; nonAcceptableBeforePrimary: number;
  physicalRows: number; distinctContent: number;
  semanticOnly: number; sourceRecomputeMismatch: number;
  resultIds: string[]; resultSources: string[];
  s7bMissing: number; s7bExtra: number; pageShrink: number;
  degraded: boolean; protocol: string;
  admission: { branch: string; candidates: number; admitted: number; W: number; required: number; dropped: unknown[]; exemptHits: number; droppedEmpty: boolean };
}
interface ArmFile { arm: string; policy: { windowCoverageRatio: number; unitDfRatioCeiling: number }; rows: Row[]; s6Identity: { checked: number; mismatches: string[] } | null; ftsLegCalls: number }
interface PerfFile { arm: string; latency: { p50: number; p95: number; p99: number; max: number }; segments: Record<string, number>; repeats: number }

const armFiles = new Map<string, ArmFile>();
const perfFiles = new Map<string, PerfFile>();
for (const a of ALL_ARMS) {
  const gp = join(ARM_DIR, `arm-${a.id}.json`);
  const pp = join(ARM_DIR, `perf-${a.id}.json`);
  if (!existsSync(gp)) die(`缺门读数：${gp}`);
  if (!existsSync(pp)) die(`缺性能读数：${pp}`);
  armFiles.set(a.id, read(gp));
  perfFiles.set(a.id, read(pp));
}
console.log(`[f3-collect] 读入 ${armFiles.size} 份门读数 + ${perfFiles.size} 份性能读数`);

// --- 指标 ---------------------------------------------------------------------
const hitAt5 = (rows: Row[]): number => mean(rows.map((r) => (r.primaryRank != null && r.primaryRank <= 5 ? 1 : 0)));
const mrr = (rows: Row[]): number => mean(rows.map((r) => (r.primaryRank != null ? 1 / r.primaryRank : 0)));
const accHit = (rows: Row[]): number => mean(rows.map((r) => (r.acceptableRank != null && r.acceptableRank <= 5 ? 1 : 0)));
const accMrr = (rows: Row[]): number => mean(rows.map((r) => (r.acceptableRank != null ? 1 / r.acceptableRank : 0)));
const bandSets = (rows: Row[]) => ({
  union: rows.filter((r) => r.kind === 'relevance'),
  relevance: rows.filter((r) => r.cohort === 'new-relevance'),
  protection: rows.filter((r) => r.cohort === 'protection'),
});
const byBand = (rows: Row[]) => Object.fromEntries(BANDS.map((b) => {
  const rs = rows.filter((r) => r.band === b);
  return [b, { n: rs.length, primaryHitAt5: r3(hitAt5(rs)), primaryMrr: r3(mrr(rs)) }];
})) as Record<string, { n: number; primaryHitAt5: number; primaryMrr: number }>;

/** 每个 arm 的一整套读数（§5.1–§5.4 + 分层 + 保护线 + 负例分组）。 */
function summarize(file: ArmFile, perf: PerfFile) {
  const rows = file.rows;
  const sets = bandSets(rows);
  const rel = sets.relevance;
  const prot = sets.protection;
  const positives = sets.union;
  const negs = rows.filter((r) => r.cohort === 'lexical-anchor');

  return {
    arm: file.arm,
    policy: file.policy,
    relevance: {
      n: rel.length,
      primaryHitAt5: r3(hitAt5(rel)), primaryMrr: r3(mrr(rel)),
      primaryReached: rel.filter((r) => r.primaryRank != null).length,
      acceptableHitAt5: r3(accHit(rel)), acceptableMrr: r3(accMrr(rel)),
      nonAcceptableMean: r3(mean(rel.map((r) => r.nonAcceptable))),
      nonAcceptableWorst: worst(rel.map((r) => r.nonAcceptable)),
    },
    positives: {
      n: positives.length,
      primaryHitAt5: r3(hitAt5(positives)), primaryMrr: r3(mrr(positives)),
      primaryAbsent: positives.filter((r) => r.primaryRank == null).length,
    },
    strata: { union: byBand(positives), relevance: byBand(rel), protection: byBand(prot) },
    protection: Object.fromEntries(PROTECTION_CLASSES.map((c) => {
      const rs = prot.filter((r) => r.protectionClass === c);
      return [c, {
        n: rs.length, primaryHitAt5: r3(hitAt5(rs)), primaryMrr: r3(mrr(rs)),
        pageShrinkQueries: rs.filter((r) => r.pageShrink > 0).length,
        pageShrinkRows: rs.reduce((s, r) => s + r.pageShrink, 0),
      }];
    })),
    hardNegative: {
      n: negs.length,
      physicalRowsMean: r3(mean(negs.map((r) => r.physicalRows))), physicalRowsWorst: worst(negs.map((r) => r.physicalRows)),
      distinctContentMean: r3(mean(negs.map((r) => r.distinctContent))), distinctContentWorst: worst(negs.map((r) => r.distinctContent)),
      overCapQueries: negs.filter((r) => r.distinctContent > G2_CAP).length,
      byClass: Object.fromEntries(['false-premise', 'same-word-other-thing', 'stale-state-confusion'].map((c) => {
        const rs = negs.filter((r) => r.lexicalNegativeClass === c);
        return [c, { n: rs.length, distinctContentMean: r3(mean(rs.map((r) => r.distinctContent))), overCap: rs.filter((r) => r.distinctContent > G2_CAP).length }];
      })),
      // Codex 第 5 项：修补 / 未修补 × ftsCount 档
      byPatchAndFtsBand: Object.fromEntries((['patched', 'unpatched'] as const).map((k) => {
        const rs = negs.filter((r) => (k === 'patched' ? r.patched : !r.patched));
        return [k, {
          n: rs.length,
          distinctContentMean: r3(mean(rs.map((r) => r.distinctContent))),
          overCap: rs.filter((r) => r.distinctContent > G2_CAP).length,
          byFtsBand: Object.fromEntries(NEG_BANDS.map((b) => {
            const bs = rs.filter((r) => negMeta.get(r.id)?.ftsBand === b);
            return [b, {
              n: bs.length,
              distinctContentMean: bs.length ? r3(mean(bs.map((r) => r.distinctContent))) : null,
              distinctContentWorst: bs.length ? worst(bs.map((r) => r.distinctContent)) : null,
              overCap: bs.filter((r) => r.distinctContent > G2_CAP).length,
            }];
          })),
        }];
      })),
      perQuery: negs.map((r) => ({
        id: r.id, patched: r.patched === true, ftsCount: negMeta.get(r.id)?.ftsCount ?? null,
        ftsBand: negMeta.get(r.id)?.ftsBand ?? null,
        physicalRows: r.physicalRows, distinctContent: r.distinctContent,
        sources: r.resultSources, overCap: r.distinctContent > G2_CAP,
      })),
    },
    admission: {
      exemptHitsTotal: rows.reduce((s, r) => s + r.admission.exemptHits, 0),
      droppedUnitsTotal: rows.reduce((s, r) => s + r.admission.dropped.length, 0),
      droppedEmptyQueries: rows.filter((r) => r.admission.droppedEmpty).length,
      likeBranchQueries: rows.filter((r) => r.admission.branch === 'like').length,
      candidatesMean: r3(mean(rows.map((r) => r.admission.candidates))),
      admittedMean: r3(mean(rows.map((r) => r.admission.admitted))),
      pageShrinkQueries: rows.filter((r) => r.pageShrink > 0).length,
      pageShrinkRows: rows.reduce((s, r) => s + r.pageShrink, 0),
      returnedMean: r3(mean(rows.map((r) => r.physicalRows))),
      zeroReturnQueries: rows.filter((r) => r.physicalRows === 0).length,
    },
    latency: perf.latency,
    segments: perf.segments,
  };
}

const summaries = new Map(ALL_ARMS.map((a) => [a.id, summarize(armFiles.get(a.id)!, perfFiles.get(a.id)!)]));
const baseline = summaries.get(BASELINE_ARM) ?? die(`缺基线臂 ${BASELINE_ARM}`);
const baselineRows = armFiles.get(BASELINE_ARM)!.rows;
const baselineRankById = new Map(baselineRows.map((r) => [r.id, r.primaryRank]));

// --- 性能门：先判基线是否超预算（§6.6 的预登记分支）--------------------------
const perfBaselineOverBudget = baseline.latency.p95 >= PERF_BUDGET_MS;
console.log(`[f3-collect] 性能门：基线 p95 = ${baseline.latency.p95}ms ${perfBaselineOverBudget ? '≥' : '<'} ${PERF_BUDGET_MS}ms`
  + ` → ${perfBaselineOverBudget ? '相对判定（并单独登记缺陷）' : '绝对判定'}`);

// --- 逐 arm 判门 --------------------------------------------------------------
function judge(armId: string) {
  const s = summaries.get(armId)!;
  const file = armFiles.get(armId)!;
  const rows = file.rows;
  const positives = rows.filter((r) => r.kind === 'relevance');
  const negs = rows.filter((r) => r.cohort === 'lexical-anchor');

  // G1：主门。求和为 0；两个数分开报（§6.1 的口径纪律）。
  const pollutionCount = positives.reduce((n, r) => n + r.nonAcceptableBeforePrimary, 0);
  const displaced = positives.filter((r) => {
    const b = baselineRankById.get(r.id) ?? null;
    if (b == null) return false;              // 基线本来就没命中，谈不上"被压下去"
    if (r.primaryRank == null) return false;  // 本 arm 缺席：由 primaryAbsent 单独计，不算位移
    return r.primaryRank > b && r.nonAcceptableBeforePrimary > 0;
  });
  const G1 = {
    name: 'G1 排序污染门（全体 80 条正例，非 acceptable 排在 primary_gold 之前的次数 = 0）',
    pass: pollutionCount === 0,
    pollutionCount,
    offenderQueries: positives.filter((r) => r.nonAcceptableBeforePrimary > 0).length,
    actualDisplacement: displaced.length,
    primaryAbsent: positives.filter((r) => r.primaryRank == null).length,
    note: 'pollutionCount 是条数，actualDisplacement 是相对基线的反事实位移；两者不是同一个数（§6.1）。'
      + 'primary 缺席记 0 是可被利用的退化解，由 G4 与保护线过滤。',
    offenders: positives.filter((r) => r.nonAcceptableBeforePrimary > 0)
      .map((r) => ({ id: r.id, count: r.nonAcceptableBeforePrimary, primaryRank: r.primaryRank, baselineRank: baselineRankById.get(r.id) ?? null, page: r.resultIds })),
  };

  // G2：辅门。逐条 distinctContent ≤ 2，不取平均。
  const overCap = negs.filter((r) => r.distinctContent > G2_CAP);
  const G2 = {
    name: `G2 容量门（40 条词面负例，逐条整页跨来源 distinctContent ≤ ${G2_CAP}）`,
    pass: overCap.length === 0,
    overCapQueries: overCap.length,
    distinctContentMean: s.hardNegative.distinctContentMean,
    distinctContentWorst: s.hardNegative.distinctContentWorst,
    physicalRowsWorst: s.hardNegative.physicalRowsWorst,
    capProvenance: '2 早于 P3、由 Phase 2B 预登记选出；本轮只沿用，不得依据本轮数据调高（§6.2）。',
    violations: overCap.map((r) => ({
      id: r.id, cls: r.lexicalNegativeClass, patched: r.patched === true,
      ftsCount: negMeta.get(r.id)?.ftsCount ?? null, ftsBand: negMeta.get(r.id)?.ftsBand ?? null,
      physicalRows: r.physicalRows, distinctContent: r.distinctContent,
      sources: r.resultSources, page: r.resultIds,
    })),
  };

  // G3：标记门。match_source 重算一致 + semantic-only ≤ cap。
  const srcBad = rows.filter((r) => r.sourceRecomputeMismatch > 0);
  const capBad = rows.filter((r) => r.semanticOnly > SEMANTIC_ONLY_CAP);
  const G3 = {
    name: `G3 标记门（120 条全体：match_source 重算一致 + semantic-only ≤ ${SEMANTIC_ONLY_CAP}）`,
    pass: srcBad.length === 0 && capBad.length === 0,
    sourceMismatchQueries: srcBad.length,
    capViolationQueries: capBad.length,
    semanticOnlyMax: worst(rows.map((r) => r.semanticOnly)),
    violations: [...srcBad.map((r) => ({ id: r.id, kind: 'source-mismatch', detail: r.sourceRecomputeMismatch })),
      ...capBad.map((r) => ({ id: r.id, kind: 'cap', detail: r.semanticOnly }))],
  };

  // G4：非回退线。判定用并集那一套；另两套只报不判（§6.4）。
  const regressions: { band: string; metric: string; arm: number; baseline: number }[] = [];
  for (const b of BANDS) {
    const a = s.strata.union[b]!;
    const base = baseline.strata.union[b]!;
    if (a.primaryHitAt5 < base.primaryHitAt5) regressions.push({ band: b, metric: 'primaryHitAt5', arm: a.primaryHitAt5, baseline: base.primaryHitAt5 });
    if (a.primaryMrr < base.primaryMrr - EPS) regressions.push({ band: b, metric: 'primaryMrr', arm: a.primaryMrr, baseline: base.primaryMrr });
  }
  const G4 = {
    name: 'G4 分层非回退线（80 条并集四档，hit@5 / MRR 逐档不低于基线）',
    pass: regressions.length === 0,
    regressions,
    union: s.strata.union,
    attribution: { relevance: s.strata.relevance, protection: s.strata.protection },
    note: '判定只用并集；relevance / 保护线两套同时报，用于归因回退来自哪一侧，不参与判定（§6.4）。',
  };

  // 召回保护线：五类逐类判定。
  const protRegressions: { cls: string; metric: string; arm: number; baseline: number }[] = [];
  for (const c of PROTECTION_CLASSES) {
    const a = s.protection[c]!;
    const base = baseline.protection[c]!;
    if (a.primaryHitAt5 < base.primaryHitAt5) protRegressions.push({ cls: c, metric: 'primaryHitAt5', arm: a.primaryHitAt5, baseline: base.primaryHitAt5 });
    if (a.primaryMrr < base.primaryMrr - EPS) protRegressions.push({ cls: c, metric: 'primaryMrr', arm: a.primaryMrr, baseline: base.primaryMrr });
  }
  const PROT = {
    name: '召回保护线（五类各 8 条，逐类不得回退；与误召回门同等地位）',
    pass: protRegressions.length === 0,
    regressions: protRegressions,
    byClass: s.protection,
  };

  // 性能资格门（§6.6）。
  const PERF = {
    name: perfBaselineOverBudget ? `性能资格门（基线超预算 → 相对判定 arm.p95 ≤ 基线 ${baseline.latency.p95}ms）` : `性能资格门（arm.p95 < ${PERF_BUDGET_MS}ms）`,
    pass: perfBaselineOverBudget ? s.latency.p95 <= baseline.latency.p95 : s.latency.p95 < PERF_BUDGET_MS,
    p95: s.latency.p95, p50: s.latency.p50, p99: s.latency.p99,
    baselineP95: baseline.latency.p95,
    mode: perfBaselineOverBudget ? 'relative' : 'absolute',
    segments: s.segments,
  };

  // S 系列（每 arm）。
  const s7bBad = rows.filter((r) => r.s7bMissing > 0 || r.s7bExtra > 0);
  const droppedEmpty = rows.filter((r) => r.admission.droppedEmpty);
  const strataCountsMatch = (['union', 'relevance', 'protection'] as const)
    .flatMap((set) => BANDS.filter((b) => s.strata[set][b]!.n !== frozenStrata[set][b]).map((b) => `${set}.${b}: ${s.strata[set][b]!.n} vs ${frozenStrata[set][b]}`));
  const S = {
    S5: { name: 'S5 三套四档条数复现冻结值', pass: strataCountsMatch.length === 0, detail: strataCountsMatch.length ? strataCountsMatch.join('; ') : '12/12 项一致' },
    S6: armId === BASELINE_ARM
      ? { name: 'S6 恒等锚点（基线臂 vs 生产实现逐条相同）', pass: (file.s6Identity?.mismatches.length ?? -1) === 0, detail: file.s6Identity ? `${file.s6Identity.checked - file.s6Identity.mismatches.length}/${file.s6Identity.checked} 一致` : '缺读数' }
      : { name: 'S6 恒等锚点', pass: true, detail: '仅基线臂适用' },
    S7b: { name: 'S7b 形状 C 与 EXACT 的候选差集逐 query 为 0', pass: s7bBad.length === 0, detail: s7bBad.length ? `${s7bBad.length} 条非零：${s7bBad.slice(0, 5).map((r) => r.id).join(' ')}` : `${rows.length}/${rows.length} 差集为 0` },
    S8: {
      name: 'S8 semantic-only ≤ cap；V2 丢空的 query 确认 FTS 腿空且未回退 LIKE',
      pass: capBad.length === 0 && droppedEmpty.every((r) => r.admission.branch === 'empty' && r.admission.admitted === 0),
      detail: `semantic-only 最大 ${worst(rows.map((r) => r.semanticOnly))}；V2 丢空 ${droppedEmpty.length} 条`
        + (droppedEmpty.length ? `（${droppedEmpty.map((r) => r.id).slice(0, 6).join(' ')}）` : ''),
    },
    S9: { name: 'S9 每 arm 出完整 search p50/p95/p99 与分段耗时', pass: Number.isFinite(s.latency.p95) && Object.keys(s.segments).length > 0, detail: `p50 ${s.latency.p50} / p95 ${s.latency.p95} / p99 ${s.latency.p99}` },
    ftsLegCalls: { name: '代理生效（FTS 腿调用次数 = query 数）', pass: file.ftsLegCalls === rows.length + (armId === BASELINE_ARM ? 0 : 0), detail: `${file.ftsLegCalls} 次` },
  };

  const selfCertPass = Object.values(S).every((x) => x.pass);
  return {
    ...summarize(file, perfFiles.get(armId)!),
    isBaseline: armId === BASELINE_ARM,
    gates: { G1, G2, G3, G4, protection: PROT, perf: PERF },
    selfCert: S,
    selfCertPass,
    // §8 第 2/3 步用的两个布尔：安全过滤与资格过滤分开，理由见判据 §6.4 / §6.5。
    safetyPass: G1.pass && G2.pass && G3.pass,
    eligibilityPass: G4.pass && PROT.pass && PERF.pass,
  };
}

const judged = ALL_ARMS.map((a) => judge(a.id));

// --- 汇总输出 ----------------------------------------------------------------
const out = {
  purpose: 'F3 门判定与汇总（判据 r3 §6、§7）。只读 f3-arms/ 的读数，不发起任何搜索。',
  round: freeze.round,
  phase: 'F3',
  generatedAt: new Date().toISOString(),
  freeze: { path: 'benchmark/reports/fts-round/f2-freeze-r3.json', verify: v.label, selectedK: freeze.payload.selectedK },
  constants: { pageLimit: freeze.payload.nextPhase.f3.pageLimitInherited.value, g2Cap: G2_CAP, semanticOnlyCap: SEMANTIC_ONLY_CAP, perfBudgetMs: PERF_BUDGET_MS, mrrEps: EPS },
  baselineArm: BASELINE_ARM,
  perfMode: perfBaselineOverBudget ? 'relative' : 'absolute',
  perfBaselineOverBudget,
  frozenStrata,
  frozenNegativeBaseline: frozenNeg.baseline,
  arms: judged,
  summaryTable: judged.map((a) => ({
    arm: a.arm,
    G1: a.gates.G1.pass, pollutionCount: a.gates.G1.pollutionCount, primaryAbsent: a.gates.G1.primaryAbsent,
    G2: a.gates.G2.pass, negOverCap: a.gates.G2.overCapQueries, negDistinctWorst: a.gates.G2.distinctContentWorst,
    G3: a.gates.G3.pass, G4: a.gates.G4.pass, protection: a.gates.protection.pass, perf: a.gates.perf.pass,
    p95: a.latency.p95,
    positivesHitAt5: a.positives.primaryHitAt5, relevanceHitAt5: a.relevance.primaryHitAt5,
    returnedMean: a.admission.returnedMean, zeroReturn: a.admission.zeroReturnQueries,
    selfCert: a.selfCertPass,
  })),
};
writeFileSync(join(REPORTS, 'f3-grid-results.json'), `${JSON.stringify(out, null, 2)}\n`);

// --- 控制台 ------------------------------------------------------------------
console.log(`\narm          G1(污染) G2(超限) G3  G4  保护线 性能   p95     正例hit@5 均返回 空页 自证`);
for (const a of judged) {
  const g = a.gates;
  console.log(`${a.arm.padEnd(12)} ${g.G1.pass ? '✓' : '✗'}(${String(g.G1.pollutionCount).padStart(3)})`
    + `  ${g.G2.pass ? '✓' : '✗'}(${String(g.G2.overCapQueries).padStart(2)})`
    + `  ${g.G3.pass ? '✓' : '✗'}  ${g.G4.pass ? '✓' : '✗'}  ${g.protection.pass ? '✓' : '✗'}    ${g.perf.pass ? '✓' : '✗'}  ${String(a.latency.p95).padStart(6)}`
    + `  ${String(a.positives.primaryHitAt5).padStart(5)}   ${String(a.admission.returnedMean).padStart(5)}  ${String(a.admission.zeroReturnQueries).padStart(3)}  ${a.selfCertPass ? '✓' : '✗'}`);
}
const feasible = judged.filter((a) => !a.isBaseline && a.safetyPass);
const eligible = feasible.filter((a) => a.eligibilityPass);
console.log(`\n[f3-collect] 安全过滤（G1∧G2∧G3）通过 ${feasible.length}/15；再过资格（G4∧保护线∧性能）剩 ${eligible.length}`);
console.log(`[f3-collect] 自证全过：${judged.filter((a) => a.selfCertPass).length}/16`);
console.log(`[f3-collect] → ${join(REPORTS, 'f3-grid-results.json')}`);
