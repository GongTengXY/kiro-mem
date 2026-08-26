#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 **F2 冻结**（判据 r3 §2.2.1 末段：`K` 单独冻结；r4 §14 的新路径）。
 *
 * 冻结内容：装置自证（S2–S4 + 预检一致性）、四档分层、**S7a 选定的 K**。
 * F1 冻结的是阶梯与选择规则；`K` 的取值由 F2 产出，所以它有自己的记录——
 * "K 是怎么定的"因此在证据链里可独立核对，而不是藏在某个脚本的默认参数里。
 *
 * 前置：`f1-freeze-r2.json` 必须校验通过，且三份 F2 读数都必须已存在且通过。
 *
 * 用法：bun run benchmark/freeze-fts-round-f2.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyFreezeRecordFile, writeFreezeRecord, verifyFreezeRecord } from './freeze-util';

const REPORTS = join(import.meta.dir, 'reports', 'fts-round');
const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const SUFFIX = process.argv.find((a) => a.startsWith('--suffix='))?.split('=')[1] ?? '-r2';

// --- 前置：F1 冻结仍一致 ------------------------------------------------------
const f1Path = join(REPORTS, `f1-freeze${SUFFIX}.json`);
const v1 = verifyFreezeRecordFile(f1Path);
console.log(`[freeze-f2] F1 冻结校验：${v1.label} → ${v1.ok ? '✓' : '✗'}`);
if (!v1.ok) { console.error('[freeze-f2] ✗ F1 冻结物已漂移'); process.exit(1); }

// --- 前置：三份 F2 读数 -------------------------------------------------------
const fixture = read(join(REPORTS, `f2-fixture${SUFFIX}.json`));
const strata = read(join(REPORTS, `f2-strata${SUFFIX}.json`));
const kladder = read(join(REPORTS, `f2-kladder${SUFFIX}.json`));

const problems: string[] = [];
if (!fixture.pass) problems.push(`装置自证未通过：${fixture.checks.filter((c: any) => !c.pass).map((c: any) => c.name).join(', ')}`);
if (!strata.pass) problems.push(`四档分层不达标：${strata.shortBands.join(', ')}`);
if (!kladder.s7aPass) problems.push('S7a 未通过');
if (kladder.selectedK === undefined || kladder.selectedK === null) problems.push('K 未选定');
if (kladder.arms.length !== 16) problems.push(`K 阶梯只跑了 ${kladder.arms.length} 个 arm，必须 16 个`);
if (kladder.queries !== 120) problems.push(`K 阶梯只跑了 ${kladder.queries} 条 query，必须 120 条`);
if (kladder.s6Identity && kladder.s6Identity.mismatches.length) problems.push(`S6 恒等锚点有 ${kladder.s6Identity.mismatches.length} 条不一致`);
if (problems.length) { for (const p of problems) console.error(`  - ${p}`); process.exit(1); }

const consistency = fixture.checks.find((c: any) => c.name.includes('16.2'));
console.log(`[freeze-f2] 装置自证 ${fixture.checks.length} 项全过（含 ${consistency?.name}：${consistency?.detail}）`);
console.log(`[freeze-f2] 四档（80 条并集）：${Object.entries(strata.counts.union).map(([k, n]) => `${k}=${n}`).join('  ')}`);
console.log(`[freeze-f2] S7a：K = ${kladder.selectedK}，${kladder.arms.length} arm × ${kladder.queries} query 差异 0`);

// --- 冻结 --------------------------------------------------------------------
const record = writeFreezeRecord(join(REPORTS, `f2-freeze${SUFFIX}.json`), {
  round: 'fts-safety-round-2026-08-12-r2',
  phase: 'F2',
  criteria: join(REPORTS, 'f1-criteria-r4.md'),
  note: 'F2 收口：装置、四档分层与 K 一次性冻结。K 由 S7a 的正确性阶梯选出，不由任何门的读数选出。'
    + 'F3 必须在本记录固定的 K 与装置上跑，且全程不得改动 K（r3 §2.2 第 3 条）。',
  inputs: [
    { name: 'criteriaBaselineR3', path: join(REPORTS, 'f1-criteria.md') },
    { name: 'f1Freeze', path: f1Path },
    { name: 'fixtureSelfCert', path: join(REPORTS, `f2-fixture${SUFFIX}.json`) },
    { name: 'strata', path: join(REPORTS, `f2-strata${SUFFIX}.json`) },
    { name: 'kLadder', path: join(REPORTS, `f2-kladder${SUFFIX}.json`) },
    { name: 'precheck', path: join(REPORTS, `f1-precheck${SUFFIX}.json`) },
    { name: 'admissionImpl', path: join(import.meta.dir, 'fts-round-admission.ts') },
    { name: 'fixtureBuilder', path: join(import.meta.dir, 'run-fts-round-f2-fixture.ts') },
    { name: 'strataRunner', path: join(import.meta.dir, 'run-fts-round-f2-strata.ts') },
    { name: 'kLadderRunner', path: join(import.meta.dir, 'run-fts-round-f2-kladder.ts') },
  ],
  payload: {
    selectedK: kladder.selectedK,
    kSelection: {
      ladder: kladder.ladder,
      rule: '取最小的 K，使 16 个 (r,d) 设置 × 120 条 query 与 EXACT 的候选差集逐 query 为 0（r3 §2.2.1）',
      comparisons: kladder.results.find((r: any) => r.k === kladder.selectedK)?.comparisons,
      mismatches: 0,
      basis: '只用正确性判定，未看任何门的读数',
      exactByConstruction: 'EXACT 差集恒为 0，阶梯不会走空；其成本由 §6.6 性能门在 F3 判定',
    },
    fixture: {
      dbPath: fixture.fixture.dbPath,
      rows: fixture.fixture.rows,
      scopeVectors: fixture.fixture.scopeVectors,
      composition: fixture.fixture.composition,
      realEncodes: fixture.fixture.realEncodes,
      embeddingModel: fixture.fixture.embeddingModel,
      spaceKey: fixture.fixture.spaceKey,
      layoutSeed: fixture.layout.seed,
      ageDays: fixture.layout.ageDays,
      insertionOrder: fixture.layout.insertionOrder,
    },
    selfCert: {
      s2: fixture.s2,
      s3FunctionWords: fixture.s3.functionWords,
      s4NegativeFtsCountRange: [
        Math.min(...fixture.s4.negatives.map((n: any) => n.ftsCount)),
        Math.max(...fixture.s4.negatives.map((n: any) => n.ftsCount)),
      ],
      precheckConsistency: consistency?.detail,
      s6Identity: kladder.s6Identity,
      checks: fixture.checks.map((c: any) => ({ name: c.name, pass: c.pass })),
    },
    strata: {
      union: strata.counts.union,
      relevance: strata.counts.relevance,
      protection: strata.counts.protection,
      bands: strata.bands,
    },
    admissionReadings: {
      note: '准入机制自身的读数（判据 §5.4），不是门读数；F3 会在完整检索链上重出。',
      perArm: kladder.perArm,
      observed: {
        v1Bites: 'r 从 0 到 0.3，逐 arm 平均返回 17.78 → 5.23 → 1.96 → 1.37；空返回 4 → 26 → 57 → 76（共 120 条）',
        v2Inert: 'd 从 1.0 到 0.03，被丢弃单元共 0 / 0 / 1 / 7 个——60,066 行下连最高频功能词的 df/scope 也只有 0.0416，低于 0.10。刻度已冻结，不因此读数改动（§2.4 第 2 条）',
        exemption: '精确单元豁免命中在所有 arm 上恒为 86，它是拉丁 / 路径 / 数字 query 不被覆盖度打死的原因（§2.1 边界 1）',
      },
    },
    nextPhase: {
      f3: '在本记录固定的 K 与装置上扫 16 个 arm，出 G1–G4 + 保护线 + 性能门读数',
      forbidden: 'F3 不得改动 K、不得改动网格刻度、不得改动语义侧任何参数',
    },
  },
});

const vr = verifyFreezeRecord(record);
console.log(`[freeze-f2] 冻结完成：${record.itemCountLabel} 项（${record.frozenAt}）`);
console.log(`[freeze-f2] 自校验：${vr.label} → ${vr.ok ? '✓' : '✗'}`);
if (!vr.ok) process.exit(1);
console.log(`[freeze-f2] → ${join(REPORTS, `f2-freeze${SUFFIX}.json`)}`);
