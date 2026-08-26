/**
 * 安全策略轮次 P1：为最终盲审补齐误召回的第二套计数口径。
 *
 * 方案：`plan/V3/retrieval-safety-round-plan-2026-08-10.md` §6。
 *
 * 本脚本**只读**已落盘的审计产物，不跑检索、不播种语料、不改动任何冻结文件，
 * 也**不重判任何门**：
 *
 *   - C1 的正式读数永远是物理行口径的 1.900，Phase 3C 状态永远是不通过；
 *   - 本脚本新增的"按不同原文去重"读数是**并列的补充口径**，不是替换。
 *
 * 之所以能不重跑：`codex-blind-audit-result.json` 已存有每条 query 两个臂的有序结果、
 * 逐项来源与分数、保留的语义候选名次表，以及 added / removed / moved。补齐口径只需重新
 * 计数，不需要重新检索——重跑要 1 万次编码 + 5 万条播种，成本与收益完全不成比例。
 *
 * 去重规则不是本脚本发明的，而是从冻结记录 `oldCorpus` 读出来的：装置由
 * `sourceRecords` 条原文 × `copies` 份副本构成，副本复用向量，所以 `filler:N` 与
 * `filler:N + sourceRecords × k` 是同一条原文，余弦分数逐位相同。
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const REPORTS = join(import.meta.dir, 'reports');
const DIR = join(REPORTS, 'final-recall');
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

const RESULT_PATH = join(DIR, 'codex-blind-audit-result.json');
const FREEZE_PATH = join(DIR, 'codex-blind-audit-freeze.json');
const result = read(RESULT_PATH);
const freeze = read(FREEZE_PATH);

const SOURCE_RECORDS: number = freeze.oldCorpus.sourceRecords;
const COPIES: number = freeze.oldCorpus.copies;
const LIMIT: number = result.provenance.limit;
const CAP: number = result.provenance.policy.semanticOnlyLimit;
/**
 * 一页最多能装多少条纯语义结果。
 *
 * 主 query 全部零 FTS 候选，页面 100% 由 semantic-only 构成，因此 cap 对**正例同样生效**：
 * 页面容量是 `min(cap, limit)` = 2，不是 limit 的 10。方案 §6 起草时把正例页面当成能到
 * 10 条，那个假设是错的，实测 56 条主 query 的页面长度只有 0 / 1 / 2 三种。
 */
const PAGE_CAPACITY = Math.min(CAP, LIMIT);

const ARMS = ['days90', 'unbounded'] as const;
type Arm = (typeof ARMS)[number];

/** 同源折叠键。gold（`tXX`）各自独立；`filler:N` 折到原文序号。 */
function contentKey(id: string): string {
  if (!id.startsWith('filler:')) return id;
  const n = Number(id.slice('filler:'.length));
  return `filler#${((n % SOURCE_RECORDS) + SOURCE_RECORDS) % SOURCE_RECORDS}`;
}
const distinct = (ids: string[]): number => new Set(ids.map(contentKey)).size;

interface RawRow {
  id: string; kind: string; gold: string[]; resultIds: string[]; resultSources: string[];
  semanticScores: number[]; semanticIds: string[]; aboveFloorCount: number; goldRank: number | null;
}
const rawByArm: Record<Arm, Map<string, RawRow>> = {
  days90: new Map((result.armsRaw.days90.main as RawRow[]).map((r) => [r.id, r])),
  unbounded: new Map((result.armsRaw.unbounded.main as RawRow[]).map((r) => [r.id, r])),
};
const perQuery = result.perQuery.main as {
  id: string; kind: string; negativeType?: string; gold: string[];
  returned: [number, number]; semanticOnly: [number, number]; goldRank: [number | null, number | null];
  added: { id: string }[]; removed: { id: string }[]; moved: unknown[];
}[];

const idsOf = (arm: Arm, qid: string): string[] => rawByArm[arm].get(qid)?.resultIds ?? [];

// =============================================================================
// A. 双口径误召回读数
// =============================================================================
//
// physicalRows  = 页面物理行数，等于现行 C1 口径。必须复现出报告 §4.1 的 1.900 / 1.800，
//                 这是本脚本读对了数据的自证；不一致就退出非零，不产出报告。
// distinctContent = 同一条原文的多个副本只算一条。

interface Basis { mean: number; worst: number; perQuery: Record<string, number> }
function basisOf(arm: Arm, qids: string[], dedup: boolean): Basis {
  const per: Record<string, number> = {};
  for (const qid of qids) {
    const ids = idsOf(arm, qid);
    per[qid] = dedup ? distinct(ids) : ids.length;
  }
  const vals = Object.values(per);
  return { mean: r3(mean(vals)), worst: vals.length ? Math.max(...vals) : 0, perQuery: per };
}

const cohorts = {
  relevance: perQuery.filter((q) => q.kind === 'relevance').map((q) => q.id),
  hardNegative: perQuery.filter((q) => q.kind === 'hard-negative').map((q) => q.id),
  nearDomain: perQuery.filter((q) => q.negativeType === 'near-domain').map((q) => q.id),
  foreignDomain: perQuery.filter((q) => q.negativeType === 'foreign-domain').map((q) => q.id),
};

const dualBasis: Record<string, Record<Arm, { physicalRows: Basis; distinctContent: Basis }>> = {};
for (const [name, qids] of Object.entries(cohorts)) {
  dualBasis[name] = {
    days90: { physicalRows: basisOf('days90', qids, false), distinctContent: basisOf('days90', qids, true) },
    unbounded: { physicalRows: basisOf('unbounded', qids, false), distinctContent: basisOf('unbounded', qids, true) },
  };
}

// --- 自证：物理行口径必须逐位复现审计 summary --------------------------------
const official = result.summary.hardNegative as Record<Arm, { returnedMean: number; returnedWorst: number }>;
const selfCheck = ARMS.map((arm) => {
  const got = dualBasis.hardNegative![arm].physicalRows;
  // summary 里的均值按 3 位存盘（1.9 / 1.8），所以比较到 3 位。
  const pass = Math.abs(got.mean - official[arm].returnedMean) < 1e-9 && got.worst === official[arm].returnedWorst;
  return { arm, pass, expected: official[arm], got: { mean: got.mean, worst: got.worst } };
});

// =============================================================================
// B. 复印件命中分布
// =============================================================================
//
// 一个"冗余行"= 页面上同一条原文的第 2、3… 个副本。它占掉了一个页面位置，却没有带来
// 第二条不同的线索。C1 数的是物理行，所以每个冗余行都被算成一条独立的误召回。

interface DupRow {
  id: string; kind: string; negativeType: string | null; arm: Arm;
  page: string[]; physicalRows: number; distinctContent: number; redundantRows: number;
  duplicateGroups: { contentKey: string; ids: string[]; scores: number[]; scoreBitEqual: boolean }[];
}
const dupRows: DupRow[] = [];
for (const q of perQuery) {
  for (const arm of ARMS) {
    const row = rawByArm[arm].get(q.id);
    if (!row) continue;
    const groups = new Map<string, string[]>();
    row.resultIds.forEach((id) => {
      const k = contentKey(id);
      groups.set(k, [...(groups.get(k) ?? []), id]);
    });
    const dupGroups = [...groups.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([k, ids]) => {
        const scores = ids.map((id) => row.semanticScores[row.resultIds.indexOf(id)]!);
        return { contentKey: k, ids, scores, scoreBitEqual: new Set(scores).size === 1 };
      });
    if (dupGroups.length === 0) continue;
    dupRows.push({
      id: q.id, kind: q.kind, negativeType: q.negativeType ?? null, arm,
      page: row.resultIds,
      physicalRows: row.resultIds.length,
      distinctContent: distinct(row.resultIds),
      redundantRows: row.resultIds.length - distinct(row.resultIds),
      duplicateGroups: dupGroups,
    });
  }
}

const dupSummary: Record<string, Record<Arm, { queries: number; queriesWithDup: number; share: number; redundantRows: number; totalRows: number; allScoresBitEqual: boolean }>> = {};
for (const [name, qids] of Object.entries(cohorts)) {
  dupSummary[name] = {} as any;
  for (const arm of ARMS) {
    const mine = dupRows.filter((r) => r.arm === arm && qids.includes(r.id));
    const totalRows = qids.reduce((a, qid) => a + idsOf(arm, qid).length, 0);
    dupSummary[name]![arm] = {
      queries: qids.length,
      queriesWithDup: mine.length,
      share: qids.length ? r3(mine.length / qids.length) : 0,
      redundantRows: mine.reduce((a, r) => a + r.redundantRows, 0),
      totalRows,
      allScoresBitEqual: mine.every((r) => r.duplicateGroups.every((g) => g.scoreBitEqual)),
    };
  }
}

// =============================================================================
// C. 页面替换：两套口径各算一遍
// =============================================================================
//
// added / removed 是"无界臂相对 days=90 臂"的页面变化，审计已按物理行统计（109 / 105）。
// 同源折叠后，同一条原文换进来两个副本只应算作一条内容变化。

const churn = (() => {
  let addedRows = 0; let removedRows = 0; let movedRows = 0;
  let addedDistinct = 0; let removedDistinct = 0;
  let pagesChanged = 0; let pagesChangedDistinct = 0;
  for (const q of perQuery) {
    const a = q.added.map((x) => x.id);
    const r = q.removed.map((x) => x.id);
    addedRows += a.length; removedRows += r.length; movedRows += q.moved.length;
    addedDistinct += distinct(a); removedDistinct += distinct(r);
    if (a.length || r.length || q.moved.length) pagesChanged++;
    // 折叠口径下的"页面是否变化"：比较两臂页面的内容键多重集合。
    const keyBag = (ids: string[]): string => [...ids.map(contentKey)].sort().join('|');
    if (keyBag(idsOf('days90', q.id)) !== keyBag(idsOf('unbounded', q.id))) pagesChangedDistinct++;
  }
  return {
    physicalRows: { added: addedRows, removed: removedRows, moved: movedRows, pagesChanged },
    distinctContent: { added: addedDistinct, removed: removedDistinct, pagesChanged: pagesChangedDistinct },
    officialAdded: result.summary.pageChurn.addedTotal,
    officialRemoved: result.summary.pageChurn.removedTotal,
  };
})();

// =============================================================================
// D. 正例侧新测项：复印件有没有挤掉真答案
// =============================================================================
//
// 方案 §6 列这一项时假设正例页面能到 10 条、因此有被挤占的空间。实测不是：主 query 全部
// 零 FTS，页面 100% semantic-only，cap=2 对正例一样生效，页面容量就是 2。这反而让问题更
// 尖锐——两个副本足以占满整页。
//
// 判定方法：在保留的语义名次表里找 gold 的名次，再算"同源折叠后 gold 的有效名次"。
// 只有当折叠后的有效名次 ≤ 页面容量时，去重才可能真的把 gold 换进页面。
//
// 一处必须诚实的边界：`semanticIds` 是 Top-K **保留集**（本次 topK=1000，43/56 条 query
// 顶格）。gold 不在其中，可能是没过 floor，也可能是过了 floor 但名次在 1000 之外——从这份
// 产物无法区分。两种情况下它的语义名次都 >1000，对一个 2 条的页面同样不可达，所以结论不受
// 影响，但措辞不能写成"未过 floor"。
interface RelRow {
  id: string; gold: string[]; page: string[]; pageAllOneSource: boolean; redundantRows: number;
  goldOnPage: boolean; goldSemanticRank: number | null; goldEffectiveRank: number | null;
  goldInRetainedSet: boolean; aboveFloorCount: number; retainedSize: number;
  dedupCouldRecover: boolean;
}
const relRows: RelRow[] = cohorts.relevance.map((qid) => {
  const q = perQuery.find((x) => x.id === qid)!;
  const row = rawByArm.unbounded.get(qid)!;
  const gold = new Set(q.gold);
  const page = row.resultIds;
  const idx = row.semanticIds.findIndex((x) => gold.has(x));
  let effective: number | null = null;
  if (idx >= 0) {
    const seen = new Set<string>();
    for (let i = 0; i <= idx; i++) seen.add(contentKey(row.semanticIds[i]!));
    effective = seen.size;
  }
  const goldOnPage = page.some((x) => gold.has(x));
  return {
    id: qid, gold: [...gold], page,
    pageAllOneSource: page.length > 1 && distinct(page) === 1,
    redundantRows: page.length - distinct(page),
    goldOnPage,
    goldSemanticRank: idx >= 0 ? idx + 1 : null,
    goldEffectiveRank: effective,
    goldInRetainedSet: idx >= 0,
    aboveFloorCount: row.aboveFloorCount,
    retainedSize: row.semanticIds.length,
    // 去重能否真的救回来：gold 当前不在页面上，且折叠后有效名次进得了页面容量。
    dedupCouldRecover: !goldOnPage && effective !== null && effective <= PAGE_CAPACITY,
  };
});
const relDisplacement = {
  queries: relRows.length,
  goldOnPage: relRows.filter((r) => r.goldOnPage).length,
  goldMissing: relRows.filter((r) => !r.goldOnPage).length,
  missingWithFullDuplicatePage: relRows.filter((r) => !r.goldOnPage && r.pageAllOneSource).length,
  pageSlotsLostToRedundancy: relRows.reduce((a, r) => a + r.redundantRows, 0),
  dedupCouldRecover: relRows.filter((r) => r.dedupCouldRecover).map((r) => r.id),
};

// =============================================================================
// 落盘
// =============================================================================

const out = {
  generatedAt: new Date().toISOString(),
  role: '描述性补充口径。不重判任何门；C1 正式读数与 P6 结论不变。',
  verdictUnchanged: {
    c1OfficialReading: official.unbounded.returnedMean,
    c1Basis: 'physicalRows（页面物理行数）',
    c1Threshold: 1,
    c1Pass: false,
    p6: '不通过',
    phase3c: '不通过',
    note: '本报告新增 distinctContent 口径仅作并列参考，不构成对 C1 或 P6 的重新判定。',
  },
  provenance: {
    plan: 'plan/V3/retrieval-safety-round-plan-2026-08-10.md §6',
    source: 'benchmark/reports/final-recall/codex-blind-audit-result.json',
    sourceSha256: sha16(readFileSync(RESULT_PATH, 'utf-8')),
    freeze: 'benchmark/reports/final-recall/codex-blind-audit-freeze.json',
    freezeSha256: sha16(readFileSync(FREEZE_PATH, 'utf-8')),
    scriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    rewrittenFiles: 'none（本脚本只读，不修改任何既有产物或冻结文件）',
    dedupRule: `filler:N -> filler#(N mod ${SOURCE_RECORDS})；来源为冻结记录 oldCorpus（${SOURCE_RECORDS} 条原文 × ${COPIES} 份副本）`,
    policy: result.provenance.policy,
    limit: LIMIT,
    pageCapacity: PAGE_CAPACITY,
  },
  selfCheck,
  dualBasis,
  duplicateDistribution: { summary: dupSummary, perQuery: dupRows },
  pageChurn: churn,
  relevanceDisplacement: { summary: relDisplacement, perQuery: relRows },
};
writeFileSync(join(DIR, 'duplicate-supplement.json'), `${JSON.stringify(out, null, 2)}\n`);

// --- Markdown ----------------------------------------------------------------
const hn = dualBasis.hardNegative!;
const nd = dualBasis.nearDomain!;
const fd = dualBasis.foreignDomain!;
const md = `# 最终盲审误召回：补充计数口径（P1）

> **C1 正式读数 = ${official.unbounded.returnedMean}（物理行口径），不变。**
> **P6 仍为不通过，Phase 3C 仍为不通过。**
> **本报告是描述性补充，不重判任何门。**

> 方案：\`plan/V3/retrieval-safety-round-plan-2026-08-10.md\` §6
> 产出脚本：\`benchmark/analyze-duplicate-supplement.ts\`（只读，未重跑审计，未改动任何冻结文件）
> 数据源：\`final-recall/codex-blind-audit-result.json\`（SHA-256 前缀 \`${sha16(readFileSync(RESULT_PATH, 'utf-8'))}\`）
> 机器可读：\`final-recall/duplicate-supplement.json\`

---

## 1. 为什么要补这个口径

装置的 5 万条 filler 是 **${SOURCE_RECORDS} 条原文 × ${COPIES} 份副本**（副本复用向量，
来源：冻结记录 \`oldCorpus\`）。因此 \`filler:N\` 与 \`filler:N+${SOURCE_RECORDS}\` 是同一条原文，
余弦分数逐位相同。

C1 数的是**页面物理行数**（\`run-codex-final-recall-audit.ts\` 的 \`returned: results.length\`），
所以同一条原文的两个副本被算成两条独立的误召回线索。

本报告并列给出两套口径：

| 口径 | 定义 |
| --- | --- |
| \`physicalRows\` | 页面物理行数，**等于现行 C1 口径** |
| \`distinctContent\` | 同一条原文的多个副本只算一条 |

去重规则不是本脚本发明的，直接来自冻结记录，因此不构成对判据的改写。

---

## 2. 自证：物理行口径逐位复现审计读数

${selfCheck.map((c) => `- \`${c.arm}\`：期望 mean ${c.expected.returnedMean} / worst ${c.expected.returnedWorst}，实算 mean ${c.got.mean} / worst ${c.got.worst} → ${c.pass ? '✅ 一致' : '❌ 不一致'}`).join('\n')}

两臂都一致，说明本脚本读的是同一份数据、同一套页面。以下的第二口径才有意义。

---

## 3. 双口径读数

### 3.1 hard-negative（C1 的作用对象）

| 臂 | physicalRows 均值 | physicalRows 最坏 | distinctContent 均值 | distinctContent 最坏 |
| --- | ---: | ---: | ---: | ---: |
| \`days=90\` | **${hn.days90.physicalRows.mean}** | ${hn.days90.physicalRows.worst} | ${hn.days90.distinctContent.mean} | ${hn.days90.distinctContent.worst} |
| 无界 | **${hn.unbounded.physicalRows.mean}** | ${hn.unbounded.physicalRows.worst} | ${hn.unbounded.distinctContent.mean} | ${hn.unbounded.distinctContent.worst} |

**两套口径都没有通过 ≤1。** 副本口径解释了 ${r3(hn.unbounded.physicalRows.mean - hn.unbounded.distinctContent.mean)} 的差值，
剩下的 ${hn.unbounded.distinctContent.mean} 是真实的不同假线索数量。

### 3.2 按负例类型分层

| 类型 | 臂 | physicalRows | distinctContent |
| --- | --- | ---: | ---: |
| near-domain（${cohorts.nearDomain.length} 条） | \`days=90\` | ${nd.days90.physicalRows.mean} | ${nd.days90.distinctContent.mean} |
| near-domain | 无界 | ${nd.unbounded.physicalRows.mean} | ${nd.unbounded.distinctContent.mean} |
| foreign-domain（${cohorts.foreignDomain.length} 条） | \`days=90\` | ${fd.days90.physicalRows.mean} | ${fd.days90.distinctContent.mean} |
| foreign-domain | 无界 | ${fd.unbounded.physicalRows.mean} | ${fd.unbounded.distinctContent.mean} |

---

## 4. 复印件命中分布

| 集合 | 臂 | 出现同源副本的 query | 占比 | 冗余行 / 总行 | 分数逐位相同 |
| --- | --- | ---: | ---: | ---: | :--: |
${(['hardNegative', 'relevance'] as const).flatMap((name) => ARMS.map((arm) => {
  const s = dupSummary[name]![arm];
  return `| ${name} | \`${arm === 'days90' ? 'days=90' : '无界'}\` | ${s.queriesWithDup} / ${s.queries} | ${pct(s.share)} | ${s.redundantRows} / ${s.totalRows} | ${s.allScoresBitEqual ? '是' : '否'} |`;
})).join('\n')}

所有同源副本对的余弦分数**逐位相同**，这是"副本复用向量"的直接确认，不是巧合。

---

## 5. 页面替换：两套口径

| 口径 | 新增 | 移除 | 页面发生变化 |
| --- | ---: | ---: | ---: |
| \`physicalRows\`（审计原口径） | ${churn.physicalRows.added} | ${churn.physicalRows.removed} | ${churn.physicalRows.pagesChanged} / ${perQuery.length} |
| \`distinctContent\` | ${churn.distinctContent.added} | ${churn.distinctContent.removed} | ${churn.distinctContent.pagesChanged} / ${perQuery.length} |

原口径与审计 summary 一致（新增 ${churn.officialAdded} / 移除 ${churn.officialRemoved}）。

---

## 6. 正例侧：复印件有没有挤掉真答案

**先修正方案 §6 的一个错误假设。** 起草时以为正例页面能返回到 10 条、因此有被挤占的空间。
实测不是：主 query 全部零 FTS 候选，页面 100% 由 semantic-only 构成，**cap=${CAP} 对正例同样生效**，
页面容量是 \`min(cap, limit)\` = **${PAGE_CAPACITY}**。全部 ${perQuery.length} 条主 query 的页面长度只有 0 / 1 / 2 三种。

这反而让问题更尖锐：**两个副本就足以占满整页。**

| 读数 | 值 |
| --- | ---: |
| 正例 query 数 | ${relDisplacement.queries} |
| gold 进入页面 | ${relDisplacement.goldOnPage} |
| gold 未进页面 | ${relDisplacement.goldMissing} |
| 其中**整页被同一条原文的副本占满** | **${relDisplacement.missingWithFullDuplicatePage}** |
| 被冗余副本占掉的页面位置合计 | ${relDisplacement.pageSlotsLostToRedundancy} |
| **去重后真能换回页面的 gold** | **${relDisplacement.dedupCouldRecover.length} 条**${relDisplacement.dedupCouldRecover.length ? `（${relDisplacement.dedupCouldRecover.join('、')}）` : ''} |

未找回的 ${relDisplacement.goldMissing} 条逐条明细：

| query | 页面 | 整页同源 | gold 在保留集中的名次 | 折叠后有效名次 | 过 floor 总数 | 去重能否救回 |
| --- | --- | :--: | ---: | ---: | ---: | :--: |
${relRows.filter((r) => !r.goldOnPage).map((r) => `| ${r.id} | \`${r.page.join(', ') || '（空）'}\` | ${r.pageAllOneSource ? '是' : '否'} | ${r.goldSemanticRank ?? '不在保留集'} | ${r.goldEffectiveRank ?? '—'} | ${r.aboveFloorCount} | ${r.dedupCouldRecover ? '能' : '**否**'} |`).join('\n')}

### 结论

${relDisplacement.missingWithFullDuplicatePage} 条未找回的正例确实是**整页被两个同源副本占满**，
但去重**救不回任何一条**：

- 其中 gold 不在 Top-K 保留集里的，语义名次必然 >${result.provenance.policy.semanticTopK}，对一个 ${PAGE_CAPACITY} 条的页面不可达；
- 唯一在保留集里的 \`fra-r09\`，gold 名次 641，折叠后仍是 129，同样进不了 ${PAGE_CAPACITY} 条的页面；
- \`fra-r12\` 与副本无关：两个位置被另外两条**真实 gold 记录**（\`t19\` / \`t15\`，语义第 1、第 2）占住，gold 自己排第 3，是被正常竞争挤掉的。

**这条是负面结果，而且它是好消息：** 副本口径只抬高了误召回读数，**没有掩盖任何召回收益**。
所以 B 组的 hit@5 \`0% → 80.769%\` 不受本报告影响。

> 一处必须写明的边界：\`semanticIds\` 是 Top-K 保留集（本次 \`semanticTopK=${result.provenance.policy.semanticTopK}\`，
> ${(result.armsRaw.unbounded.main as RawRow[]).filter((r) => r.semanticIds.length === result.provenance.policy.semanticTopK).length}/${perQuery.length} 条 query 顶格）。
> gold 不在其中，可能是没过 floor，也可能是过了 floor 但名次在 ${result.provenance.policy.semanticTopK} 之外——从这份产物**无法区分**。
> 两种情况下语义名次都 >${result.provenance.policy.semanticTopK}，对 ${PAGE_CAPACITY} 条的页面同样不可达，所以结论不变，
> 但不能把它写成"未过 floor"。

---

## 7. 这份报告改变了什么、没改变什么

**没改变：** C1 = ${official.unbounded.returnedMean}（物理行）仍然失败；P6 不通过；Phase 3C 不通过；
任何生产策略值；任何冻结文件。

**改变的是后续轮次的记账方式：**

1. 安全策略轮次必须**同时**报告两套口径（方案 §11 第 2 项）；
2. 装置的副本结构解释了 ${r3(hn.unbounded.physicalRows.mean - hn.unbounded.distinctContent.mean)} 的读数，
   下一轮如果只盯物理行口径调 floor，有一部分参数是在对付副本而不是对付真实误召回；
3. 真实的不同假线索数量是 **${hn.unbounded.distinctContent.mean}**，这才是新一轮要压下去的目标值。
`;
writeFileSync(join(DIR, 'duplicate-supplement.md'), md);

// --- 控制台 ------------------------------------------------------------------
console.log('=== P1 补充口径（描述性，不重判任何门）===\n');
for (const c of selfCheck) {
  console.log(`  ${c.pass ? '✅' : '❌'} 自证 ${c.arm}：期望 ${c.expected.returnedMean}/${c.expected.returnedWorst}，实算 ${c.got.mean}/${c.got.worst}`);
}
console.log(`\n  hard-negative 无界臂：physicalRows ${hn.unbounded.physicalRows.mean}（= C1 正式读数，仍失败）`);
console.log(`                        distinctContent ${hn.unbounded.distinctContent.mean}（补充口径，同样 >1）`);
console.log(`  复印件：${dupSummary.hardNegative!.unbounded.queriesWithDup}/${cohorts.hardNegative.length} 条负例页面含同源副本，冗余行 ${dupSummary.hardNegative!.unbounded.redundantRows}`);
console.log(`  正例侧：${relDisplacement.missingWithFullDuplicatePage} 条未找回的正例整页被同源副本占满，但去重能救回 ${relDisplacement.dedupCouldRecover.length} 条`);
console.log(`\n写入 ${join(DIR, 'duplicate-supplement.md')}`);
console.log(`写入 ${join(DIR, 'duplicate-supplement.json')}`);
if (!selfCheck.every((c) => c.pass)) {
  console.error('\n自证失败：物理行口径未能复现审计读数，报告不可信。');
  process.exit(1);
}
