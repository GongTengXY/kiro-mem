#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F1 冻结 r3：证据链修复闭合**（Codex F2 验收第 1–3 项）。
 *
 * ## 为什么需要这一份
 *
 * r2 冻结把 **r2 的 validator 字节钉在了原路径** `validate-fts-round-dataset.ts` 上，
 * 而那个文件正是 r1 冻结的 14 项输入之一。于是两件事结构性不可同时成立：
 *
 *   旧 f1-freeze.json 要求该路径 = cc56ef92…（r1 字节）
 *   f1-freeze-r2.json 要求该路径 = cf81527b…（r2 字节）
 *
 * 验收裁定的处置：**旧路径恢复 r1 原始字节，当前实现迁到版本化路径**
 * `validate-fts-round-dataset-r2.ts`，然后用版本化路径重新闭合 F1 的输入清单。
 * 因此本记录与 r2 的差别**只有 validator 那一项**（路径 + SHA），其余 20 项逐字节相同，
 * 这一点由 §payload.chain.diffVsR2 机械自证，而不是靠这段注释声明。
 *
 * ## 不动的部分
 *
 * 数据、ACP 镜像、中文语料、60,066 行编码、K = 200、四档分层**全部未重新生成**。
 * `f1-freeze.json`、`f1-freeze-r2.json`、`f2-freeze-r2.json` 三份历史记录逐字节保留，
 * 由 `freeze-fts-round-f2-r3.ts` 显式冻结（Codex 第 3 项）。
 *
 * ## 机械门（任一失败即非零退出，不产出记录）
 *
 *  1. 两份 validator 的 SHA 必须**恰为**期望值——把"不得就地改动冻结输入"变成脚本断言，
 *     这正是本次缺陷缺的那道门；
 *  2. 旧 `f1-freeze.json` 必须校验通过（判据 1/1 + 输入 14/14），否则恢复没有生效；
 *  3. r2 版 validator 对 r2 数据集实跑通过；
 *  4. 资格门 Q1–Q4、镜像覆盖与护栏、四档分层沿用 r2 的同一批检查。
 *
 * 用法：bun run benchmark/freeze-fts-round-f1-r3.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFreezeRecord, verifyFreezeRecord, verifyFreezeRecordFile, sha256File } from './freeze-util';

const ROOT = join(import.meta.dir, '..');
const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[freeze-r3] ✗ ${m}`); process.exit(1); };

/** r1 冻结记录里 validator 那一项的字节；恢复来源见 f2-completion-r3.md §2。 */
const VALIDATOR_R1_SHA = 'cc56ef921e2e6ef7681d6d3cb0abfe1d3f9aa60747f0cc7d22ecd7f23102110f';
/** F2 实际使用的 validator 字节，现固化在版本化路径上。 */
const VALIDATOR_R2_SHA = 'cf81527bce6151f344391b1eb5053ecbc831388e97ea8f36e167bde3d777c48b';
const VALIDATOR_R1 = join(import.meta.dir, 'validate-fts-round-dataset.ts');
const VALIDATOR_R2 = join(import.meta.dir, 'validate-fts-round-dataset-r2.ts');

// --- 门 1：两份 validator 的字节必须恰为期望值 --------------------------------
//
// 写死期望值而不是"当前是什么就冻什么"：本次缺陷的成因正是原路径被就地改动后
// 无人当场发现。有了这道断言，任何再次就地改动都会在冻结之前失败。
for (const [path, want, label] of [
  [VALIDATOR_R1, VALIDATOR_R1_SHA, 'r1 原始（旧冻结的第 13 项输入）'],
  [VALIDATOR_R2, VALIDATOR_R2_SHA, 'r2 固化（F2 实际使用）'],
] as const) {
  const got = sha256File(path);
  if (got !== want) die(`validator 字节不符（${label}）：${path}\n    期望 ${want}\n    实际 ${got}`);
  console.log(`[freeze-r3] validator ${label}：${got.slice(0, 12)}… ✓`);
}

// --- 门 2：旧冻结必须已恢复到 14/14 -------------------------------------------
const r1Path = join(REPORTS, 'f1-freeze.json');
const v1 = verifyFreezeRecordFile(r1Path);
console.log(`[freeze-r3] 旧 f1-freeze.json：${v1.label} → ${v1.ok ? '✓' : '✗'}`);
if (!v1.ok) {
  for (const f of v1.failures) console.error(`  - ${f.name} (${f.path}) expected=${f.expected.slice(0, 12)} actual=${(f.actual ?? 'null').slice(0, 12)}`);
  die('旧冻结未恢复，证据链修复未生效');
}

// --- 门 3：r2 validator 对 r2 数据实跑 ----------------------------------------
const validate = Bun.spawnSync(['bun', 'run', VALIDATOR_R2], { cwd: ROOT });
process.stdout.write(new TextDecoder().decode(validate.stdout));
if (validate.exitCode !== 0) die('r2 版 validator 对 r2 数据校验未通过');

// --- 门 4：资格门 / 镜像 / 分层（沿用 r2 的同一批检查）------------------------
const precheck = read(join(REPORTS, 'f1-precheck-r2.json'));
if (!precheck.pass) {
  for (const g of precheck.gates) if (!g.pass) console.error(`  - ${g.gate}：失败 ${g.fail}/${g.total} → ${g.failedIds.join(' ')}`);
  die('冻结前资格门未通过');
}
if (precheck.queriesFile !== join(DATASET, 'queries-fts-round-r2.json')) die(`预检跑的不是 r2 query 集：${precheck.queriesFile}`);
console.log(`[freeze-r3] 资格门：${precheck.gates.map((g: any) => `${g.gate.split(' ')[0]}✓`).join(' ')}`);

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
if (problems.length) { for (const p of problems) console.error(`  - ${p}`); die('镜像或护栏检查失败'); }
console.log(`[freeze-r3] 镜像：query ${zhQueries.length} 走 ACP + ${identityQueries.length} 恒等；记录 ${records.length}；护栏拒绝 0`);

const strata = read(join(REPORTS, 'f2-strata-r2.json'));
if (!strata.pass) die('四档分层不达标');
console.log(`[freeze-r3] 四档（80 条并集）：${Object.entries(strata.counts.union).map(([k, n]) => `${k}=${n}`).join('  ')}`);

// --- 与 r2 记录的逐项对照（本记录"只改了 validator"的机械自证）----------------
const r2Record = read(join(REPORTS, 'f1-freeze-r2.json'));
const inputs = [
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
  // 唯一的改动项：r2 记录里这一项指向原路径 + r2 字节。
  { name: 'validator', path: VALIDATOR_R2 },
  { name: 'precheckTool', path: join(import.meta.dir, 'precheck-fts-round-data.ts') },
  { name: 'freezeUtil', path: join(import.meta.dir, 'freeze-util.ts') },
];
if (inputs.length !== r2Record.inputs.length) die(`输入项数与 r2 记录不符：${inputs.length} vs ${r2Record.inputs.length}`);

const r2ByName = new Map<string, { path: string; sha256: string }>(
  (r2Record.inputs as { name: string; path: string; sha256: string }[]).map((i) => [i.name, i]),
);
const identical: string[] = [];
const changed: { name: string; r2Path: string; r2Sha: string; r3Path: string; r3Sha: string }[] = [];
for (const item of inputs) {
  const prev = r2ByName.get(item.name) ?? die(`r2 记录里没有名为 ${item.name} 的输入项`);
  const sha = sha256File(item.path);
  const relPath = item.path.replace(`${ROOT}/`, '');
  if (prev.sha256 === sha && prev.path === relPath) identical.push(item.name);
  else changed.push({ name: item.name, r2Path: prev.path, r2Sha: prev.sha256, r3Path: relPath, r3Sha: sha });
}
if (changed.length !== 1 || changed[0]!.name !== 'validator') {
  console.error('[freeze-r3] ✗ 除 validator 外还有输入项发生变化，这不是纯证据链修复：');
  for (const c of changed) console.error(`  - ${c.name}: ${c.r2Path}@${c.r2Sha.slice(0, 12)} → ${c.r3Path}@${c.r3Sha.slice(0, 12)}`);
  process.exit(1);
}
console.log(`[freeze-r3] 与 r2 逐项对照：${identical.length}/21 项逐字节相同，唯一变化 validator（原路径 → 版本化路径）`);

// --- 冻结 --------------------------------------------------------------------
const corpusMeta = read(join(DATASET, 'fts-round-filler-zh-10k-meta.json'));
const r1Freeze = read(r1Path);

const record = writeFreezeRecord(join(REPORTS, 'f1-freeze-r3.json'), {
  round: 'fts-safety-round-2026-08-12-r2',
  phase: 'F1',
  criteria: join(REPORTS, 'f1-criteria-r4.md'),
  note: '证据链修复闭合，不是新一轮数据。round id 与 r2 相同正是为了表明数据、判据、装置、K 全部逐字节未变；'
    + '与 f1-freeze-r2.json 的唯一差别是 validator 从原路径迁到 validate-fts-round-dataset-r2.ts，'
    + '原路径已恢复 r1 原始字节（cc56ef92…）以让旧 f1-freeze.json 重新回到 判据 1/1 + 输入 14/14。'
    + '三份历史冻结记录逐字节保留，由 freeze-fts-round-f2-r3.ts 显式冻结。',
  inputs,
  payload: {
    chain: {
      revision: 'r3',
      kind: 'evidence-chain-repair',
      trigger: 'Codex F2 验收：旧 f1-freeze.json 校验失败（判据 1/1 + 输入 13/14），'
        + '原因是 benchmark/validate-fts-round-dataset.ts 被就地加入 r2 路径选择与 token_source 校验。',
      supersedes: {
        freeze: 'benchmark/reports/fts-round/f1-freeze-r2.json',
        round: r2Record.round,
        supersededFrozenAt: r2Record.frozenAt,
        knownFailure: 'f1-freeze-r2.json 的 validator 项在本次修复后结构性失败（判据 1/1 + 输入 20/21）：'
          + '它把 r2 字节钉在原路径上，而原路径已按裁定恢复 r1 字节。该记录仍逐字节保留，'
          + '其余 20 项仍逐项一致；本记录用版本化路径承接同一份实现的字节。',
      },
      r1Freeze: {
        freeze: 'benchmark/reports/fts-round/f1-freeze.json',
        supersededFrozenAt: r1Freeze.frozenAt,
        verifyAfterRepair: v1.label,
        restored: '原路径恢复 r1 字节，SHA 回到 cc56ef92…；14 项输入全部一致。',
      },
      diffVsR2: {
        totalInputs: inputs.length,
        identicalCount: identical.length,
        identical,
        changed,
        assertion: '除 validator 外全部逐字节相同 → 数据与判据未重新生成，本次只修证据链。',
      },
      validatorVersions: {
        r1: { path: 'benchmark/validate-fts-round-dataset.ts', sha256: VALIDATOR_R1_SHA, role: '旧冻结（f1-freeze.json）的第 13 项输入，逐字节恢复' },
        r2: { path: 'benchmark/validate-fts-round-dataset-r2.ts', sha256: VALIDATOR_R2_SHA, role: 'F2 实际使用的实现（r2 路径选择 + r4 §18 的 token_source 校验），逐字节固化' },
        knownTextDefect: '两份文件的头部用法行都写不带后缀的路径（保 SHA 的代价）。正确入口以本记录为准：'
          + 'r2 数据必须用 validate-fts-round-dataset-r2.ts 校验。',
        gate: '本脚本对两份 SHA 做写死断言，任何再次就地改动都会在冻结前失败。',
      },
    },
    grid: r1Freeze.payload.grid,
    kLadder: r1Freeze.payload.kLadder,
    frozenPolicyFields: r1Freeze.payload.frozenPolicyFields,
    gates: r1Freeze.payload.gates,
    preFreezeQualificationGates: r2Record.payload.preFreezeQualificationGates,
    selection: r1Freeze.payload.selection,
    fixture: r1Freeze.payload.fixture,
    dataset: r2Record.payload.dataset,
    mirror: r2Record.payload.mirror,
    corpusZh: {
      seed: corpusMeta.seed, count: corpusMeta.count, domains: corpusMeta.domains,
      functionWords: corpusMeta.functionWords, lexicalViolations: corpusMeta.lexicalViolations,
      reusedFromR1: true,
    },
    strata: r2Record.payload.strata,
  },
});

const vr = verifyFreezeRecord(record);
console.log(`[freeze-r3] 冻结完成：${record.itemCountLabel} 项（${record.frozenAt}）`);
console.log(`[freeze-r3] 自校验：${vr.label} → ${vr.ok ? '✓' : '✗'}`);
if (!vr.ok) process.exit(1);
console.log(`[freeze-r3] → ${join(REPORTS, 'f1-freeze-r3.json')}`);
