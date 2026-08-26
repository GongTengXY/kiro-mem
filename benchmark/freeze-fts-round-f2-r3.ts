#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F2 冻结 r3：证据链闭合**（Codex F2 验收第 3–5 项）。
 *
 * ## 与 f2-freeze-r2.json 的关系
 *
 * **不覆盖、不作废它的读数。** 装置、K = 200、四档分层、S2–S4、S6 全部沿用 r2 的同一批
 * 测量（数据与 60,066 行编码未重新生成）。本记录做三件 r2 记录做不到的事：
 *
 *  1. **显式冻结三份历史冻结记录**（`f1-freeze.json` / `f1-freeze-r2.json` /
 *     `f2-freeze-r2.json`）的字节——此前它们只是"存在于库里"，没有任何记录钉住它们，
 *     所以"旧记录逐字节保留"这句话没有机械落点，而本次缺陷恰恰是它不成立；
 *  2. **要求 strata 的冻结后复现通过**（`f2-strata-verify-r3.json`）——r2 的冻结脚本
 *     只检查 `strata.pass`，没有落实预冻结 runner 注释里承诺的冻结后复现；
 *  3. **把 F3 的负例分组报告口径预登记下来**（Codex 第 5 项），先写后跑。
 *
 * ## 硬前置（任一失败即非零退出，不产出记录）
 *
 *   G-a  f1-freeze-r3.json 校验通过（判据 1/1 + 输入 21/21）
 *   G-b  旧 f1-freeze.json 校验通过（判据 1/1 + 输入 14/14）← 本次修复的核心断言
 *   G-c  f2-freeze-r2.json 校验通过（判据 1/1 + 输入 10/10）
 *   G-d  f1-freeze-r2.json 的失败项**恰好只有 validator**（判据 1/1 + 输入 20/21）：
 *        它把 r2 字节钉在原路径上，而原路径已按裁定恢复。若失败项多于这一项，
 *        说明还有别的冻结输入被改动过，本次修复的前提不成立
 *   G-e  两份 validator 的 SHA 恰为期望值（写死断言）
 *   G-f  f2-strata-verify-r3.json：pass + 冻结校验通过 + 四类 mismatch 全空
 *   G-g  装置自证、K 阶梯、S6 恒等锚点沿用 r2 的同一批检查
 *
 * 用法：bun run benchmark/freeze-fts-round-f2-r3.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyFreezeRecordFile, writeFreezeRecord, verifyFreezeRecord, sha256File } from './freeze-util';

const ROOT = join(import.meta.dir, '..');
const DATASET = join(import.meta.dir, 'dataset');
const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const die = (m: string): never => { console.error(`[freeze-f2-r3] ✗ ${m}`); process.exit(1); };

const VALIDATOR_R1_SHA = 'cc56ef921e2e6ef7681d6d3cb0abfe1d3f9aa60747f0cc7d22ecd7f23102110f';
const VALIDATOR_R2_SHA = 'cf81527bce6151f344391b1eb5053ecbc831388e97ea8f36e167bde3d777c48b';
const VALIDATOR_R1 = join(import.meta.dir, 'validate-fts-round-dataset.ts');
const VALIDATOR_R2 = join(import.meta.dir, 'validate-fts-round-dataset-r2.ts');

// --- G-a / G-b / G-c：三份必须通过的记录 --------------------------------------
const paths = {
  f1r3: join(REPORTS, 'f1-freeze-r3.json'),
  f1r1: join(REPORTS, 'f1-freeze.json'),
  f1r2: join(REPORTS, 'f1-freeze-r2.json'),
  f2r2: join(REPORTS, 'f2-freeze-r2.json'),
};
const verify = {
  f1r3: verifyFreezeRecordFile(paths.f1r3),
  f1r1: verifyFreezeRecordFile(paths.f1r1),
  f1r2: verifyFreezeRecordFile(paths.f1r2),
  f2r2: verifyFreezeRecordFile(paths.f2r2),
};
for (const [k, want] of [['f1r3', '判据 1/1 + 输入 21/21'], ['f1r1', '判据 1/1 + 输入 14/14'], ['f2r2', '判据 1/1 + 输入 10/10']] as const) {
  const v = verify[k];
  console.log(`[freeze-f2-r3] ${k}：${v.label} → ${v.ok ? '✓' : '✗'}`);
  if (!v.ok) { for (const f of v.failures) console.error(`  - ${f.name} expected=${f.expected.slice(0, 12)} actual=${(f.actual ?? 'null').slice(0, 12)}`); die(`${k} 校验未通过（期望 ${want}）`); }
  if (v.label !== want) die(`${k} 的计数标签是「${v.label}」，期望「${want}」`);
}

// --- G-d：r2 记录的失败项必须恰好只有 validator --------------------------------
//
// 这道门存在的理由：本次修复把原路径的字节换回 r1，代价是 r2 记录的 validator 项
// 必然失败。那是**已登记的结构性后果**；但如果失败项不止这一个，就说明还有别的
// 冻结输入被人改过，此时"只修证据链"的断言不成立，必须停下。
const r2Failures = verify.f1r2.failures.map((f) => f.name);
console.log(`[freeze-f2-r3] f1r2：${verify.f1r2.label}（已登记的结构性失败项：${r2Failures.join(', ') || '无'}）`);
if (r2Failures.length !== 1 || r2Failures[0] !== 'validator') {
  die(`f1-freeze-r2.json 的失败项应恰为 [validator]，实际 [${r2Failures.join(', ')}]`);
}

// --- G-e：两份 validator 的字节 -----------------------------------------------
for (const [path, want, label] of [
  [VALIDATOR_R1, VALIDATOR_R1_SHA, 'r1 原始'],
  [VALIDATOR_R2, VALIDATOR_R2_SHA, 'r2 固化'],
] as const) {
  const got = sha256File(path);
  if (got !== want) die(`validator 字节不符（${label}）：期望 ${want} 实际 ${got}`);
}
console.log(`[freeze-f2-r3] validator 双版本字节：r1 ${VALIDATOR_R1_SHA.slice(0, 12)}… + r2 ${VALIDATOR_R2_SHA.slice(0, 12)}… ✓`);

// --- G-f：strata 冻结后复现 ---------------------------------------------------
const strataVerify = read(join(REPORTS, 'f2-strata-verify-r3.json'));
if (!strataVerify.pass) die(`strata 冻结后复现未通过：${strataVerify.checks.filter((c: any) => !c.pass).map((c: any) => c.name).join(', ')}`);
if (!strataVerify.freeze?.ok) die('strata 复现报告里的冻结校验未通过');
for (const [k, v] of Object.entries(strataVerify.mismatches as Record<string, string[]>)) {
  if (v.length) die(`strata 复现存在 ${k} 不一致 ${v.length} 条：${v.slice(0, 4).join('; ')}`);
}
console.log(`[freeze-f2-r3] strata 冻结后复现：80/80 逐条一致（最大 |Δ| = ${strataVerify.maxAbsDelta}，阈值 ${strataVerify.cosineEps}）✓`);

// --- G-g：装置 / K / S6 沿用 r2 的同一批读数 ----------------------------------
const fixture = read(join(REPORTS, 'f2-fixture-r2.json'));
const strata = read(join(REPORTS, 'f2-strata-r2.json'));
const kladder = read(join(REPORTS, 'f2-kladder-r2.json'));
const precheck = read(join(REPORTS, 'f1-precheck-r2.json'));
const problems: string[] = [];
if (!fixture.pass) problems.push(`装置自证未通过：${fixture.checks.filter((c: any) => !c.pass).map((c: any) => c.name).join(', ')}`);
if (!strata.pass) problems.push(`预冻结四档不达标：${strata.shortBands.join(', ')}`);
if (!precheck.pass) problems.push('冻结前资格门未通过');
if (!kladder.s7aPass) problems.push('S7a 未通过');
if (kladder.selectedK === undefined || kladder.selectedK === null) problems.push('K 未选定');
if (kladder.arms.length !== 16) problems.push(`K 阶梯只跑了 ${kladder.arms.length} 个 arm，必须 16 个`);
if (kladder.queries !== 120) problems.push(`K 阶梯只跑了 ${kladder.queries} 条 query，必须 120 条`);
if (kladder.s6Identity && kladder.s6Identity.mismatches.length) problems.push(`S6 恒等锚点有 ${kladder.s6Identity.mismatches.length} 条不一致`);
if (problems.length) { for (const p of problems) console.error(`  - ${p}`); process.exit(1); }
console.log(`[freeze-f2-r3] 装置 ${fixture.fixture.rows} 行 / K = ${kladder.selectedK} / S6 ${kladder.s6Identity.checked - kladder.s6Identity.mismatches.length}/${kladder.s6Identity.checked} ✓`);

// --- Codex 第 5 项：F3 负例分组报告口径的预登记基线 ----------------------------
//
// 分组定义先写死，再算基线：
//   修补/未修补 = query 是否带 `repair` 字段（r2 补丁表的机械标记）
//   ftsCount 档 = 1 / 2-9 / 10-99 / 100-999 / >=1000，**等比铺开**，
//                 与判据 §2.4 的刻度生成规则同一形态，不引用任何门读数
// F3 必须复现这份基线条数；对不上说明装置或数据漂移。
const NEG_FTS_BANDS = [
  { key: '1', lo: 1, hi: 1 },
  { key: '2-9', lo: 2, hi: 9 },
  { key: '10-99', lo: 10, hi: 99 },
  { key: '100-999', lo: 100, hi: 999 },
  { key: '>=1000', lo: 1000, hi: Number.POSITIVE_INFINITY },
] as const;
const queries = read(join(DATASET, 'queries-fts-round-r2.json')).queries as any[];
const ftsCountById = new Map<string, number>((fixture.s4.negatives as { id: string; ftsCount: number }[]).map((n) => [n.id, n.ftsCount]));
const negatives = queries.filter((q) => q.cohort === 'lexical-anchor').map((q) => {
  const ftsCount = ftsCountById.get(q.id) ?? die(`负例 ${q.id} 在装置自证里没有 ftsCount`);
  return {
    id: q.id,
    lexicalNegativeClass: q.lexical_negative_class as string,
    negativeType: q.negative_type as string,
    patched: q.repair !== undefined,
    ftsCount,
    ftsBand: NEG_FTS_BANDS.find((b) => ftsCount >= b.lo && ftsCount <= b.hi)!.key,
  };
});
if (negatives.length !== 40) die(`负例应为 40 条，实际 ${negatives.length}`);
const bandCounts = (subset: typeof negatives): Record<string, number> =>
  Object.fromEntries(NEG_FTS_BANDS.map((b) => [b.key, subset.filter((n) => n.ftsBand === b.key).length]));
const negBaseline = {
  total: negatives.length,
  patched: { n: negatives.filter((n) => n.patched).length, byFtsBand: bandCounts(negatives.filter((n) => n.patched)) },
  unpatched: { n: negatives.filter((n) => !n.patched).length, byFtsBand: bandCounts(negatives.filter((n) => !n.patched)) },
  byClass: Object.fromEntries(['false-premise', 'same-word-other-thing', 'stale-state-confusion'].map((c) => {
    const s = negatives.filter((n) => n.lexicalNegativeClass === c);
    return [c, { n: s.length, patched: s.filter((n) => n.patched).length, unpatched: s.filter((n) => !n.patched).length }];
  })),
  ftsCountRange: [Math.min(...negatives.map((n) => n.ftsCount)), Math.max(...negatives.map((n) => n.ftsCount))],
};
console.log(`[freeze-f2-r3] F3 负例分组基线：修补 ${negBaseline.patched.n} / 未修补 ${negBaseline.unpatched.n}；`
  + `档 ${NEG_FTS_BANDS.map((b) => `${b.key}=${(negBaseline.patched.byFtsBand[b.key] ?? 0) + (negBaseline.unpatched.byFtsBand[b.key] ?? 0)}`).join(' ')}`);

// --- 冻结 --------------------------------------------------------------------
const r2Record = read(paths.f2r2);
const record = writeFreezeRecord(join(REPORTS, 'f2-freeze-r3.json'), {
  round: 'fts-safety-round-2026-08-12-r2',
  phase: 'F2',
  criteria: join(REPORTS, 'f1-criteria-r4.md'),
  note: '证据链闭合冻结（Codex F2 验收第 3–5 项）。装置、K = 200、四档分层、S2–S4、S6 全部沿用 f2-freeze-r2.json 的同一批测量，'
    + '数据与 60,066 行编码未重新生成。本记录新增三件事：显式冻结三份历史冻结记录的字节、'
    + '要求 strata 的冻结后复现通过、预登记 F3 的负例分组报告口径。'
    + 'F3 必须在本记录固定的 K 与装置上跑，全程不得改动 K。',
  inputs: [
    { name: 'criteriaBaselineR3', path: join(REPORTS, 'f1-criteria.md') },
    { name: 'f1FreezeR3', path: paths.f1r3 },
    // 显式冻结三份历史记录：此前没有任何记录钉住它们的字节。
    { name: 'f1FreezeR1Historical', path: paths.f1r1 },
    { name: 'f1FreezeR2Historical', path: paths.f1r2 },
    { name: 'f2FreezeR2Historical', path: paths.f2r2 },
    { name: 'fixtureSelfCert', path: join(REPORTS, 'f2-fixture-r2.json') },
    { name: 'strataPreFreeze', path: join(REPORTS, 'f2-strata-r2.json') },
    { name: 'strataVerifyPostFreeze', path: join(REPORTS, 'f2-strata-verify-r3.json') },
    { name: 'kLadder', path: join(REPORTS, 'f2-kladder-r2.json') },
    { name: 'precheck', path: join(REPORTS, 'f1-precheck-r2.json') },
    { name: 'admissionImpl', path: join(import.meta.dir, 'fts-round-admission.ts') },
    { name: 'fixtureBuilder', path: join(import.meta.dir, 'run-fts-round-f2-fixture.ts') },
    { name: 'strataRunner', path: join(import.meta.dir, 'run-fts-round-f2-strata.ts') },
    { name: 'strataVerifyRunner', path: join(import.meta.dir, 'verify-fts-round-f2-strata.ts') },
    { name: 'kLadderRunner', path: join(import.meta.dir, 'run-fts-round-f2-kladder.ts') },
    { name: 'f1FreezeRunnerR3', path: join(import.meta.dir, 'freeze-fts-round-f1-r3.ts') },
    { name: 'validatorR1', path: VALIDATOR_R1 },
    { name: 'validatorR2', path: VALIDATOR_R2 },
    { name: 'freezeUtil', path: join(import.meta.dir, 'freeze-util.ts') },
  ],
  payload: {
    chain: {
      revision: 'r3',
      kind: 'evidence-chain-repair',
      trigger: 'Codex F2 验收：F2 暂不通过，阻塞点是冻结证据链而不是读数。',
      codexFindings: [
        { item: 1, finding: '把当前 validator 固化为版本化新路径', resolution: 'benchmark/validate-fts-round-dataset-r2.ts，逐字节复制（SHA 保持 cf81527b…，与 F2 实际跑过的字节相同）' },
        { item: 2, finding: '恢复旧 validator 原始字节，旧冻结回到 14/14', resolution: `原路径恢复 cc56ef92…；旧 f1-freeze.json 现为「${verify.f1r1.label}」` },
        { item: 3, finding: '不覆盖现有 r2 冻结，生成新冻结链并显式冻结旧 freeze record', resolution: 'f1-freeze-r3.json + 本记录；三份历史记录作为输入项被钉住字节，原文件逐字节未动' },
        { item: 4, finding: '冻结后另出 strata 复现报告，F2 冻结必须要求其校验通过', resolution: 'benchmark/verify-fts-round-f2-strata.ts → f2-strata-verify-r3.json；本脚本的 G-f 是那道硬前置' },
        { item: 5, finding: 'F3 对 40 条负例额外按「修补/未修补」与 ftsCount 档报告', resolution: '口径与基线条数预登记在 payload.nextPhase.f3.negativeBreakdown，先写后跑' },
      ],
      historicalRecords: [
        { name: 'f1-freeze.json', role: 'r1 冻结（14 项输入）', recordedFrozenAt: read(paths.f1r1).frozenAt, verifyNow: verify.f1r1.label, status: '恢复后通过' },
        {
          name: 'f1-freeze-r2.json', role: 'r2 冻结（21 项输入）', recordedFrozenAt: read(paths.f1r2).frozenAt, verifyNow: verify.f1r2.label,
          status: '结构性失败，已登记',
          knownFailure: 'validator 一项：该记录把 r2 字节钉在原路径上，而原路径已按裁定恢复 r1 字节。'
            + '两者不可同时成立，因此本轮改用版本化路径（f1-freeze-r3.json）承接同一份实现的字节。'
            + '其余 20 项仍逐项一致，文件逐字节未被修改。',
        },
        { name: 'f2-freeze-r2.json', role: 'F2 冻结（10 项输入）', recordedFrozenAt: r2Record.frozenAt, verifyNow: verify.f2r2.label, status: '通过' },
      ],
      unchanged: {
        data: '记录、query、镜像、中文语料、英文 filler 全部逐字节未变（f1-freeze-r3 的 diffVsR2 自证 20/21 相同）',
        fixture: `${fixture.fixture.rows} 行装置与 ${fixture.fixture.realEncodes} 次真实编码未重新生成`,
        k: `K = ${kladder.selectedK}，由 S7a 的正确性阶梯选出，本次未重跑、未改动`,
        strata: '四档分层读数不变（20/19/14/27），本次只增加冻结后复现',
      },
    },
    selectedK: kladder.selectedK,
    kSelection: r2Record.payload.kSelection,
    fixture: r2Record.payload.fixture,
    selfCert: {
      ...r2Record.payload.selfCert,
      strataPostFreezeVerify: {
        path: 'benchmark/reports/fts-round/f2-strata-verify-r3.json',
        pass: strataVerify.pass,
        freezeVerify: strataVerify.freeze.verify,
        rowsCompared: strataVerify.rows.length,
        maxAbsDelta: strataVerify.maxAbsDelta,
        cosineEps: strataVerify.cosineEps,
        checks: strataVerify.checks.map((c: any) => ({ name: c.name, pass: c.pass })),
        note: '预冻结报告 f2-strata-r2.json 逐字节保留（它记录的 --pre-freeze 跳过是裁定顺序的产物），本项是它的冻结后对照。',
      },
    },
    strata: r2Record.payload.strata,
    admissionReadings: r2Record.payload.admissionReadings,
    nextPhase: {
      f3: {
        scope: '在本记录固定的 K 与装置上扫 16 个 arm，出 G1–G4 + 五类召回保护线 + 性能门读数，S5–S9 每 arm 自证',
        forbidden: 'F3 不得改动 K、不得改动网格刻度、不得改动语义侧任何参数、不得修订判据',
        negativeBreakdown: {
          requirement: 'Codex 第 5 项：40 条词面负例的 G2 读数必须**额外**按「修补 / 未修补」× ftsCount 档分组报告，'
            + '并逐条给出 ftsCount，使任何阈值口径都可复算。分组不改变 G2 的判定（仍是逐条 distinctContent ≤ 2）。',
          patchedDefinition: 'query 带 `repair` 字段 = r2 补丁表改过它的 token；不带 = r1 原样',
          ftsBands: NEG_FTS_BANDS.map((b) => b.key),
          ftsBandsProvenance: '等比铺开（1 / 2-9 / 10-99 / 100-999 / ≥1000），与判据 §2.4 的刻度生成规则同一形态，不引用任何门读数',
          baseline: negBaseline,
          perQuery: negatives,
          note: '10-99 档在两侧都为 0 是数据的真实形态（词面命中要么只有个别行、要么成百上千行），'
            + '**不因此调整档位**——档位是报告口径，不是门槛。',
        },
        pageLimitInherited: {
          value: 10,
          provenance: 'F1 判据冻结了 internalCandidateLimit = 50（V4，FTS 腿返回内核的条数），但**没有冻结请求级页面 limit**。'
            + 'G2 的「≤ 2」是 Phase 2B 在 limit = 10 下预登记选出的，P3 网格同样用 10（p3-grid-freeze.json）。'
            + 'F3 因此只能沿用 10：换任何其他值都会改变那个已冻结阈值的含义。',
          status: '判据缺口，按继承处理并在此登记；不是本轮新选的取值',
        },
      },
    },
  },
});

const vr = verifyFreezeRecord(record);
console.log(`[freeze-f2-r3] 冻结完成：${record.itemCountLabel} 项（${record.frozenAt}）`);
console.log(`[freeze-f2-r3] 自校验：${vr.label} → ${vr.ok ? '✓' : '✗'}`);
if (!vr.ok) process.exit(1);
console.log(`[freeze-f2-r3] → ${join(REPORTS, 'f2-freeze-r3.json')}`);
