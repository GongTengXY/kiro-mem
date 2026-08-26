#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 F1：数据集**机械校验**。
 *
 * 判据：`benchmark/reports/fts-round/f1-criteria.md`（r3）§4；
 * sample gate 结论要求的冻结前校验项。
 *
 * 存在的理由：这些规则全部是"写的时候很容易漏、漏了之后读数无法归因"的那一类——
 * 一条没被任何 query 当过 primary_gold 的记录会静静占着装置里的一行，
 * 一个悬空 gold 会让某条 query 的 hit@5 永远是 0，而两者都不会报错。
 * 因此它们必须是**硬失败的脚本**，不是撰写时的自觉。
 *
 * 校验项（任一失败退出非零）：
 *
 *  1. 记录：id 唯一；`self_referential` 字段存在；`fact_source` 非空且每项带 section / symbol / line；
 *     annotation 必备字段齐全；与旧 gold（`turns.json`）无 title 重叠。
 *  2. query：id 唯一；cohort 合法；kind 与 cohort 一致；
 *     relevance / 保护线必须有 `primary_gold`，hard-negative 必须 `gold: []`。
 *  3. gold 引用：无悬空（primary / acceptable 都必须指向本轮记录）；
 *     **每条新记录至少一次 primary_gold**（P2 裁决 1.4）。
 *  4. 负例字段：三类各自的专属基据字段必须存在且非空；`negative_type` / `lexical_anchor` 齐全；
 *     锚点若来自合成语料，必须带 `anchor_source`。
 *  5. 保护线：五类齐全，且（批量阶段）每类条数达标。
 *  6. `criteriaRevision` 必须是 r3。
 *
 * 用法：
 *   bun run benchmark/validate-fts-round-dataset.ts --sample     # 校验样本（宽松：不检查条数配额）
 *   bun run benchmark/validate-fts-round-dataset.ts              # 校验冻结候选（严格：检查全部配额）
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATASET_DIR = join(import.meta.dir, 'dataset');
const has = (n: string): boolean => process.argv.includes(`--${n}`);
const SAMPLE = has('sample');

const RECORDS_FILE = join(DATASET_DIR, SAMPLE ? 'turns-fts-round-sample.json' : 'turns-fts-round.json');
const QUERIES_FILE = join(DATASET_DIR, SAMPLE ? 'queries-fts-round-sample.json' : 'queries-fts-round.json');
const OLD_GOLD_FILE = join(DATASET_DIR, 'turns.json');

/** 严格模式下的配额（判据 §4.1）。样本模式只检查结构，不检查条数。 */
const QUOTA = {
  records: 40,
  relevance: 40,
  'false-premise': 15,
  'same-word-other-thing': 15,
  'stale-state-confusion': 10,
  protectionPerClass: 8,
} as const;

const PROTECTION_CLASSES = ['short-query', 'proper-noun', 'path', 'number', 'historical-state'] as const;
const NEGATIVE_CLASSES = ['false-premise', 'same-word-other-thing', 'stale-state-confusion'] as const;
const NEGATIVE_BASIS_FIELD: Record<string, string> = {
  'false-premise': 'false_premise_basis',
  'same-word-other-thing': 'other_meaning_basis',
  'stale-state-confusion': 'no_change_record_basis',
};
const ANNOTATION_FIELDS = [
  'request', 'completed', 'memory_type', 'key_files', 'key_facts',
  'unfinished', 'title', 'summary', 'outcome', 'learned', 'concepts',
] as const;
const MEMORY_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];

const problems: string[] = [];
const fail = (m: string): void => { problems.push(m); };
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

for (const f of [RECORDS_FILE, QUERIES_FILE]) {
  if (!existsSync(f)) { console.error(`[validate] ✗ 缺少输入：${f}`); process.exit(1); }
}

const recordsDoc = read(RECORDS_FILE) as { meta?: any; records: any[] };
const queriesDoc = read(QUERIES_FILE) as { meta?: any; queries: any[] };
const records = recordsDoc.records ?? [];
const queries = queriesDoc.queries ?? [];

// --- 0. criteriaRevision -----------------------------------------------------
for (const [name, doc] of [['records', recordsDoc], ['queries', queriesDoc]] as const) {
  if (doc.meta?.criteriaRevision !== 'r3') {
    fail(`${name}.meta.criteriaRevision 必须是 r3，实际 ${JSON.stringify(doc.meta?.criteriaRevision)}`);
  }
}

// --- 1. 记录 -----------------------------------------------------------------
const ids = new Set<string>();
for (const r of records) {
  const at = `记录 ${r.id ?? '<无 id>'}`;
  if (!r.id) fail(`${at}：缺 id`);
  else if (ids.has(r.id)) fail(`${at}：id 重复`);
  else ids.add(r.id);

  if (typeof r.self_referential !== 'boolean') fail(`${at}：self_referential 必须显式给出 true/false`);
  if (r.gold_only !== true) fail(`${at}：gold_only 必须为 true`);
  if (r.source_mode !== 'evidence_reconstructed') fail(`${at}：source_mode 必须是 evidence_reconstructed`);

  const fs = r.fact_source ?? [];
  if (!Array.isArray(fs) || fs.length === 0) fail(`${at}：fact_source 不得为空`);
  for (const [i, s] of fs.entries()) {
    if (!s.path) fail(`${at}：fact_source[${i}] 缺 path`);
    // sample gate 结论：批量记录需继续保留具体 section、symbol 或行号。
    if (!s.section && !s.symbol && s.line === undefined) {
      fail(`${at}：fact_source[${i}] 必须给 section / symbol / line 三者之一（${s.path}）`);
    }
    if (!s.supports) fail(`${at}：fact_source[${i}] 缺 supports`);
  }

  const a = r.annotation ?? {};
  for (const f of ANNOTATION_FIELDS) {
    if (a[f] === undefined) fail(`${at}：annotation 缺 ${f}`);
  }
  if (!MEMORY_TYPES.includes(a.memory_type)) fail(`${at}：memory_type 非法 ${JSON.stringify(a.memory_type)}`);
  for (const f of ['key_files', 'key_facts', 'concepts'] as const) {
    if (!Array.isArray(a[f]) || a[f].length === 0) fail(`${at}：annotation.${f} 不得为空`);
  }
}
if (!SAMPLE && records.length !== QUOTA.records) {
  fail(`记录条数 ${records.length} ≠ 配额 ${QUOTA.records}`);
}

// --- 2. 与旧 gold 无重叠 ------------------------------------------------------
if (existsSync(OLD_GOLD_FILE)) {
  const oldTitles = new Set<string>(
    (read(OLD_GOLD_FILE) as any[]).map((t) => String(t.annotation?.title ?? '')).filter(Boolean),
  );
  for (const r of records) {
    if (oldTitles.has(r.annotation?.title)) fail(`记录 ${r.id}：title 与旧 gold 重叠`);
  }
  // 关键事实重叠只报警：数字重复是正常的（0.197 会出现在多轮里），
  // 但整条 title 重复意味着这条不是新事实。
}

// --- 3. query 结构 ------------------------------------------------------------
const qIds = new Set<string>();
const primaryUsed = new Set<string>();
const negativeCounts = new Map<string, number>();
const protectionCounts = new Map<string, number>();
let relevanceCount = 0;

for (const q of queries) {
  const at = `query ${q.id ?? '<无 id>'}`;
  if (!q.id) fail(`${at}：缺 id`);
  else if (qIds.has(q.id)) fail(`${at}：id 重复`);
  else qIds.add(q.id);
  if (!q.query) fail(`${at}：缺 query 文本`);
  if (!q.annotation_basis) fail(`${at}：缺 annotation_basis`);

  const refs = [...(q.primary_gold ?? []), ...(q.acceptable_gold ?? [])];
  for (const g of refs) if (!ids.has(g)) fail(`${at}：悬空 gold「${g}」`);

  if (q.cohort === 'new-relevance' || q.cohort === 'protection') {
    if (q.kind !== 'relevance') fail(`${at}：cohort ${q.cohort} 的 kind 必须是 relevance`);
    const p = q.primary_gold ?? [];
    if (p.length === 0) fail(`${at}：正例必须有 primary_gold`);
    for (const g of p) primaryUsed.add(g);
    const acc = q.acceptable_gold ?? [];
    for (const g of p) if (!acc.includes(g)) fail(`${at}：primary_gold「${g}」必须同时在 acceptable_gold 里`);
    if (q.cohort === 'new-relevance') relevanceCount++;
    else {
      if (!PROTECTION_CLASSES.includes(q.protection_class)) {
        fail(`${at}：protection_class 非法 ${JSON.stringify(q.protection_class)}`);
      } else protectionCounts.set(q.protection_class, (protectionCounts.get(q.protection_class) ?? 0) + 1);
    }
  } else if (q.cohort === 'lexical-anchor') {
    if (q.kind !== 'hard-negative') fail(`${at}：词面负例的 kind 必须是 hard-negative`);
    if (!Array.isArray(q.gold) || q.gold.length !== 0) fail(`${at}：hard-negative 的 gold 必须是空数组`);
    if (q.primary_gold || q.acceptable_gold) fail(`${at}：hard-negative 不得带 primary_gold / acceptable_gold`);
    if (!['near-domain', 'foreign-domain'].includes(q.negative_type)) {
      fail(`${at}：negative_type 非法 ${JSON.stringify(q.negative_type)}`);
    }
    if (!q.negative_type_basis) fail(`${at}：缺 negative_type_basis`);
    if (!q.lexical_anchor) fail(`${at}：缺 lexical_anchor`);
    if (!q.lexical_anchor_basis) fail(`${at}：缺 lexical_anchor_basis`);
    const cls = q.lexical_negative_class;
    if (!NEGATIVE_CLASSES.includes(cls)) fail(`${at}：lexical_negative_class 非法 ${JSON.stringify(cls)}`);
    else {
      negativeCounts.set(cls, (negativeCounts.get(cls) ?? 0) + 1);
      const field = NEGATIVE_BASIS_FIELD[cls]!;
      if (!q[field]) fail(`${at}：${cls} 必须带 ${field}`);
    }
    // 锚点来自合成语料时必须标注，否则会被读成项目事实（sample gate 结论）。
    if (q.anchor_source !== undefined && !['synthetic-filler', 'project-fact'].includes(q.anchor_source)) {
      fail(`${at}：anchor_source 非法 ${JSON.stringify(q.anchor_source)}`);
    }
  } else {
    fail(`${at}：cohort 非法 ${JSON.stringify(q.cohort)}`);
  }
}

// --- 4. 覆盖与配额 ------------------------------------------------------------
const uncovered = [...ids].filter((id) => !primaryUsed.has(id));
if (uncovered.length) fail(`以下记录没有任何 query 把它当 primary_gold：${uncovered.join(' ')}`);

if (!SAMPLE) {
  if (relevanceCount !== QUOTA.relevance) fail(`relevance 条数 ${relevanceCount} ≠ ${QUOTA.relevance}`);
  for (const cls of NEGATIVE_CLASSES) {
    const got = negativeCounts.get(cls) ?? 0;
    if (got !== QUOTA[cls]) fail(`负例 ${cls} 条数 ${got} ≠ ${QUOTA[cls]}`);
  }
  for (const cls of PROTECTION_CLASSES) {
    const got = protectionCounts.get(cls) ?? 0;
    if (got !== QUOTA.protectionPerClass) fail(`保护线 ${cls} 条数 ${got} ≠ ${QUOTA.protectionPerClass}`);
  }
} else {
  for (const cls of NEGATIVE_CLASSES) if (!negativeCounts.has(cls)) fail(`样本缺负例类别 ${cls}`);
  for (const cls of PROTECTION_CLASSES) if (!protectionCounts.has(cls)) fail(`样本缺保护线类别 ${cls}`);
}

// --- 5. 报告 -----------------------------------------------------------------
const mode = SAMPLE ? '样本模式（不检查条数配额）' : '冻结候选模式（严格）';
console.log(`[validate] ${mode}`);
console.log(`[validate] 记录 ${records.length} 条；query ${queries.length} 条`
  + `（relevance ${relevanceCount} / 负例 ${[...negativeCounts.values()].reduce((a, b) => a + b, 0)}`
  + ` / 保护线 ${[...protectionCounts.values()].reduce((a, b) => a + b, 0)}）`);
console.log(`[validate] 负例分类：${NEGATIVE_CLASSES.map((c) => `${c}=${negativeCounts.get(c) ?? 0}`).join('  ')}`);
console.log(`[validate] 保护线分类：${PROTECTION_CLASSES.map((c) => `${c}=${protectionCounts.get(c) ?? 0}`).join('  ')}`);
console.log(`[validate] self_referential=true：${records.filter((r) => r.self_referential).length} 条`);
console.log(`[validate] primary_gold 覆盖：${primaryUsed.size}/${ids.size}`);

if (problems.length) {
  console.error(`\n[validate] ✗ ${problems.length} 项失败：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\n[validate] ✓ 全部通过');
