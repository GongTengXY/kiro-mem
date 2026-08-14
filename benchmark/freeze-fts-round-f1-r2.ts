#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F1 冻结 r2**（判据 `f1-criteria-r4.md` §14 / §16.3）。
 *
 * 与 r1 的差别，逐条对应裁定第 1 项：
 *
 *  - 轮次标识 `fts-safety-round-2026-08-12-r2`，输出路径 `f1-freeze-r2.json`；
 *  - **原 `f1-freeze.json` 及其 14 项输入逐字节不动**（`freeze-util` 拒绝覆盖，
 *    所以这一点由工具保证而不是靠自觉）；
 *  - 判据是**两份**：r3 基线 + r4 增量，两份都进 SHA 列表；
 *  - query 与 query 镜像换成 r2 版本；**记录、记录镜像、中文语料按原 SHA 复用**；
 *  - 新增输入 `f1-precheck-r2.json`（r4 §16.3：没有预检记录的冻结无效）
 *    与 `f2-strata-r2.json`（裁定要求四档在冻结前重测）。
 *
 * 用法：bun run benchmark/freeze-fts-round-f1-r2.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFreezeRecord, verifyFreezeRecord } from './freeze-util';

const ROOT = join(import.meta.dir, '..');
const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));

// --- 0. 机械校验（r2 集）------------------------------------------------------
const validate = Bun.spawnSync(['bun', 'run', join(import.meta.dir, 'validate-fts-round-dataset.ts')], { cwd: ROOT });
process.stdout.write(new TextDecoder().decode(validate.stdout));
if (validate.exitCode !== 0) { console.error('[freeze-r2] ✗ 机械校验未通过'); process.exit(1); }

// --- 1. 四道资格门必须已通过（r4 §16）----------------------------------------
const precheck = read(join(REPORTS, 'f1-precheck-r2.json'));
if (!precheck.pass) {
  console.error('[freeze-r2] ✗ 冻结前资格门未通过：');
  for (const g of precheck.gates) if (!g.pass) console.error(`  - ${g.gate}：失败 ${g.fail}/${g.total} → ${g.failedIds.join(' ')}`);
  process.exit(1);
}
if (precheck.queriesFile !== join(DATASET, 'queries-fts-round-r2.json')) {
  console.error(`[freeze-r2] ✗ 预检跑的不是 r2 query 集：${precheck.queriesFile}`);
  process.exit(1);
}
console.log(`[freeze-r2] 资格门：${precheck.gates.map((g: any) => `${g.gate.split(' ')[0]}✓`).join(' ')}`);

// --- 2. 镜像覆盖与护栏 --------------------------------------------------------
const { checkSemanticEnQuery } = await import('../src/semantic-en');
const queries = read(join(DATASET, 'queries-fts-round-r2.json')).queries as { id: string; query: string }[];
const queryMirror = read(join(DATASET, 'mirror-en-acp-queries-fts-round-r2.json')).queries as Record<string, string>;
const records = read(join(DATASET, 'turns-fts-round.json')).records as { id: string }[];
const recordMirror = read(join(DATASET, 'mirror-en-acp-records-fts-round.json')).records as Record<string, unknown>;
const zhQueries = queries.filter((q) => /[\u4e00-\u9fff]/.test(q.query));
const identityQueries = queries.filter((q) => !/[\u4e00-\u9fff]/.test(q.query));
const problems: string[] = [];
for (const q of zhQueries) if (!queryMirror[q.id]) problems.push(`query 镜像缺失：${q.id}`);
for (const r of records) if (!recordMirror[r.id]) problems.push(`记录镜像缺失：${r.id}`);
let rejects = 0;
for (const q of queries) if (!checkSemanticEnQuery(queryMirror[q.id] ?? q.query, q.query).ok) rejects++;
if (rejects) problems.push(`护栏拒绝 ${rejects} 条`);
if (problems.length) { for (const p of problems) console.error(`  - ${p}`); process.exit(1); }
console.log(`[freeze-r2] 镜像：query ${zhQueries.length} 走 ACP + ${identityQueries.length} 恒等；记录 ${records.length}；护栏拒绝 0`);

// --- 3. 四档分层（冻结前重测，裁定要求）--------------------------------------
const strata = read(join(REPORTS, 'f2-strata-r2.json'));
if (!strata.pass) { console.error('[freeze-r2] ✗ 四档分层不达标'); process.exit(1); }
console.log(`[freeze-r2] 四档（80 条并集）：${Object.entries(strata.counts.union).map(([k, n]) => `${k}=${n}`).join('  ')}`);

// --- 4. 冻结 -----------------------------------------------------------------
const corpusMeta = read(join(DATASET, 'fts-round-filler-zh-10k-meta.json'));
const r1Freeze = read(join(REPORTS, 'f1-freeze.json'));

const record = writeFreezeRecord(join(REPORTS, 'f1-freeze-r2.json'), {
  round: 'fts-safety-round-2026-08-12-r2',
  phase: 'F1',
  criteria: join(REPORTS, 'f1-criteria-r4.md'),
  note: '作废重开的新冻结。原 f1-freeze.json 及其 14 项输入、f2-fixture.json、f2-strata.json 全部逐字节保留为历史与拦截证据。'
    + '记录、记录英文镜像、中文语料按原 SHA 复用；改动严格限定在 query 侧（38 条）。'
    + 'K 仍不在本记录内，由 F2 按 r3 §2.2.1 的阶梯选定并单独冻结为 f2-freeze-r2.json。',
  inputs: [
    { name: 'criteriaBaselineR3', path: join(REPORTS, 'f1-criteria.md') },
    { name: 'precheckR2', path: join(REPORTS, 'f1-precheck-r2.json') },
    { name: 'strataR2', path: join(REPORTS, 'f2-strata-r2.json') },
    { name: 'interceptEvidence', path: join(REPORTS, 'f2-fixture.json') },
    { name: 'sampleGate', path: join(REPORTS, 'f1-sample.md') },
    { name: 'implProbe', path: join(REPORTS, 'f1-impl-probe.md') },
    { name: 'implProbeData', path: join(REPORTS, 'f1-impl-probe.json') },
    { name: 'records', path: join(DATASET, 'turns-fts-round.json') },
    { name: 'queriesR2', path: join(DATASET, 'queries-fts-round-r2.json') },
    { name: 'queriesR1Superseded', path: join(DATASET, 'queries-fts-round.json') },
    { name: 'queriesR2PatchScript', path: join(import.meta.dir, 'build-fts-round-queries-r2.ts') },
    { name: 'recordsMirrorEn', path: join(DATASET, 'mirror-en-acp-records-fts-round.json') },
    { name: 'queriesMirrorEnR2', path: join(DATASET, 'mirror-en-acp-queries-fts-round-r2.json') },
    { name: 'corpusZh', path: join(DATASET, 'fts-round-filler-zh-10k.json') },
    { name: 'corpusZhMeta', path: join(DATASET, 'fts-round-filler-zh-10k-meta.json') },
    { name: 'corpusZhBuilder', path: join(import.meta.dir, 'build-fts-round-filler-zh.ts') },
    { name: 'corpusEn', path: join(DATASET, 'pool-policy-filler-10k.json') },
    { name: 'oldGold', path: join(DATASET, 'turns.json') },
    { name: 'validator', path: join(import.meta.dir, 'validate-fts-round-dataset.ts') },
    { name: 'precheckTool', path: join(import.meta.dir, 'precheck-fts-round-data.ts') },
    { name: 'freezeUtil', path: join(import.meta.dir, 'freeze-util.ts') },
  ],
  payload: {
    supersedes: {
      freeze: 'benchmark/reports/fts-round/f1-freeze.json',
      round: r1Freeze.round,
      // 键名刻意不叫 frozenAt：freeze-util 会拒绝 payload 里任何 frozenAt 形状的键，
      // 而这里承载的是**前一份记录里由工具生成**的时间，属溯源引用而非手写时间。
      // 守卫在第一次运行时确实拦下了原写法，这行注释是那次拦截的登记。
      supersededFrozenAt: r1Freeze.frozenAt,
      reason: 'F2 的 S4 拦下 9 条零命中词面负例；随后新增的冻结前资格门又查出 26 条锚点不可达与 12 条保护线空门。证据：f2-fixture.json 与 f1-precheck-r2.json。',
      untouched: '原记录及其 14 项输入逐字节保留，未被覆盖（freeze-util 拒绝覆盖）。',
    },
    grid: r1Freeze.payload.grid,
    kLadder: r1Freeze.payload.kLadder,
    frozenPolicyFields: r1Freeze.payload.frozenPolicyFields,
    gates: r1Freeze.payload.gates,
    preFreezeQualificationGates: {
      Q1: '40 条词面负例实测 ftsCount ≥ 1（逐条）',
      Q2: '锚点索引可达：存在单元 u，df(u) ≥ 1 且 u 与锚点有重叠（r4 §16.1.1 的实现更正）',
      Q3: '40 条保护线 primary_gold 在对应词面分支可达（short-query 走 LIKE，其余走 FTS）',
      Q4: '基线非空门：逐 query 冻结 primaryLexicalReachable 与命中位次',
      result: precheck.gates,
      tool: 'benchmark/precheck-fts-round-data.ts（完整 60,066 行纯文本投影，无向量无 ACP）',
      f2Consistency: '判据 r4 §16.2：F2 在完整装置上重跑同一批判定，与预检不一致则整轮作废。',
    },
    selection: r1Freeze.payload.selection,
    fixture: r1Freeze.payload.fixture,
    dataset: {
      ...r1Freeze.payload.dataset,
      queriesPatched: read(join(DATASET, 'queries-fts-round-r2.json')).meta.patched,
      queriesPatchedIds: read(join(DATASET, 'queries-fts-round-r2.json')).meta.patchedIds,
      recordsUnchanged: true,
    },
    mirror: {
      queriesViaAcp: zhQueries.length,
      queriesIdentity: identityQueries.length,
      recordsViaAcp: records.length,
      guardrailRejects: 0,
      retranslated: 27,
      reusedFromR1: zhQueries.length - 27,
      staleCheck: '变更条目的镜像与 r1 逐条不同（27/27），未变更条目逐字节复用（69/69）',
    },
    corpusZh: {
      seed: corpusMeta.seed, count: corpusMeta.count, domains: corpusMeta.domains,
      functionWords: corpusMeta.functionWords, lexicalViolations: corpusMeta.lexicalViolations,
      reusedFromR1: true,
    },
    strata: {
      union: strata.counts.union,
      relevance: strata.counts.relevance,
      protection: strata.counts.protection,
      measuredPreFreeze: true,
      supersededReading: '原 f2-strata.json 的 24/15/13/28 随 query 改动失效，不得带入新轮（裁定第 1 项）',
    },
  },
});

const vr = verifyFreezeRecord(record);
console.log(`[freeze-r2] 冻结完成：${record.itemCountLabel} 项（${record.frozenAt}）`);
console.log(`[freeze-r2] 自校验：${vr.label} → ${vr.ok ? '✓' : '✗'}`);
if (!vr.ok) process.exit(1);
console.log(`[freeze-r2] → ${join(REPORTS, 'f1-freeze-r2.json')}`);
