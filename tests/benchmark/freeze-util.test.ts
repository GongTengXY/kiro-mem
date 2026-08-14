import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildFreezeRecord,
  sha256File,
  verifyFreezeRecord,
  verifyFreezeRecordFile,
  writeFreezeRecord,
  type FreezeInput,
} from '../../benchmark/freeze-util';

/**
 * `benchmark/freeze-util.ts` 的测试：它是冻结记录的唯一写入口（FTS 轮次 plan §6）。
 *
 * 三件事必须被钉住，因为它们各自对应一个已登记的缺陷：
 *
 *  1. `frozenAt` 由模块生成，调用方无法传入 —— P3 的手写时间比判据 mtime 早 2.5 分钟；
 *  2. 计数标签把判据与其余输入分开 —— P3 的 S1 把 16 项打印成 `15/15`；
 *  3. 文件缺失 / 内容漂移必须硬失败，不得静默产出记录。
 */
const tmp = (): string => mkdtempSync(join(tmpdir(), 'freeze-util-test-'));

function fixture(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, body);
  return p;
}

function baseInput(dir: string): FreezeInput {
  return {
    round: 'fts-safety-round-2026-08-12',
    phase: 'F1',
    criteria: fixture(dir, 'criteria.md', '# 判据\n'),
    inputs: [
      { name: 'queries', path: fixture(dir, 'queries.json', '{"queries":[]}') },
      { name: 'corpus', path: fixture(dir, 'corpus.json', '[]') },
    ],
  };
}

describe('freeze-util：时间由模块生成', () => {
  test('frozenAt 是本次调用生成的 ISO 时间', () => {
    const dir = tmp();
    try {
      const before = Date.now();
      const rec = buildFreezeRecord(baseInput(dir));
      const after = Date.now();
      const t = Date.parse(rec.frozenAt);
      expect(rec.frozenAt).toBe(new Date(t).toISOString());
      // 允许边界相等：同一毫秒内完成是合法的。
      expect(t).toBeGreaterThanOrEqual(before - 1);
      expect(t).toBeLessThanOrEqual(after + 1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('payload 里任何 frozenAt 形状的键都被拒绝（含嵌套与下划线写法）', () => {
    const dir = tmp();
    try {
      for (const payload of [
        { frozenAt: '2026-08-11T12:55:00Z' },
        { grid: { frozen_at: '2026-08-11T12:55:00Z' } },
        { arms: [{ FrozenAt: 'x' }] },
      ]) {
        expect(() => buildFreezeRecord({ ...baseInput(dir), payload })).toThrow(/手写时间键/);
      }
      // 不含该键的 payload 原样落盘。
      const rec = buildFreezeRecord({ ...baseInput(dir), payload: { grid: { minUnits: [1, 2] } } });
      expect(rec.payload).toEqual({ grid: { minUnits: [1, 2] } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('freeze-util：计数标签把判据单独计', () => {
  test('itemCountLabel 是 1 + N，itemCount 是合计', () => {
    const dir = tmp();
    try {
      const rec = buildFreezeRecord(baseInput(dir));
      expect(rec.itemCountLabel).toBe('1 + 2');
      expect(rec.itemCount).toBe(3);
      expect(rec.criteria.name).toBe('criteria');
      expect(rec.inputs.map((i) => i.name)).toEqual(['queries', 'corpus']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('verify 的 label 也把两侧分开，且不会把判据算进输入计数', () => {
    const dir = tmp();
    try {
      const v = verifyFreezeRecord(buildFreezeRecord(baseInput(dir)));
      expect(v.ok).toBe(true);
      expect(v.label).toBe('判据 1/1 + 输入 2/2');
      expect(v.inputs.length).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('freeze-util：SHA 与存在性', () => {
  test('逐项 sha256 与 sha256File 一致', () => {
    const dir = tmp();
    try {
      const input = baseInput(dir);
      const rec = buildFreezeRecord(input);
      expect(rec.criteria.sha256).toBe(sha256File(input.criteria));
      expect(rec.criteria.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.inputs[0]!.sha256).toBe(sha256File(input.inputs[0]!.path));
      expect(rec.inputs[0]!.bytes).toBe(readFileSync(input.inputs[0]!.path).length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('文件不存在时抛错，不产出记录', () => {
    const dir = tmp();
    try {
      const input = baseInput(dir);
      expect(() => buildFreezeRecord({
        ...input,
        inputs: [...input.inputs, { name: 'missing', path: join(dir, 'nope.json') }],
      })).toThrow(/不存在/);
      expect(() => buildFreezeRecord({ ...input, criteria: join(dir, 'no-criteria.md') })).toThrow(/不存在/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('目录不能当被冻结项', () => {
    const dir = tmp();
    try {
      const input = baseInput(dir);
      expect(() => buildFreezeRecord({
        ...input,
        inputs: [...input.inputs, { name: 'dir', path: dir }],
      })).toThrow(/不是文件/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('内容漂移被 verify 逐项测到', () => {
    const dir = tmp();
    try {
      const input = baseInput(dir);
      const rec = buildFreezeRecord(input);
      writeFileSync(input.inputs[1]!.path, '[1]'); // 改一个字节
      const v = verifyFreezeRecord(rec);
      expect(v.ok).toBe(false);
      expect(v.failures.map((f) => f.name)).toEqual(['corpus']);
      expect(v.label).toBe('判据 1/1 + 输入 1/2');
      expect(v.failures[0]!.actual).not.toBe(v.failures[0]!.expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('被冻结的文件被删除时 verify 报 actual=null 而不是抛错', () => {
    const dir = tmp();
    try {
      const input = baseInput(dir);
      const rec = buildFreezeRecord(input);
      rmSync(input.inputs[0]!.path, { force: true });
      const v = verifyFreezeRecord(rec);
      expect(v.ok).toBe(false);
      expect(v.failures[0]!.actual).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('freeze-util：重复项与落盘', () => {
  test('重名、重复路径、把判据混进 inputs 都被拒绝', () => {
    const dir = tmp();
    try {
      const input = baseInput(dir);
      expect(() => buildFreezeRecord({
        ...input,
        inputs: [input.inputs[0]!, { name: 'queries', path: input.inputs[1]!.path }],
      })).toThrow(/name 重复/);
      expect(() => buildFreezeRecord({
        ...input,
        inputs: [input.inputs[0]!, { name: 'queries2', path: input.inputs[0]!.path }],
      })).toThrow(/路径重复/);
      expect(() => buildFreezeRecord({
        ...input,
        inputs: [...input.inputs, { name: 'criteriaAgain', path: input.criteria }],
      })).toThrow(/路径重复/);
      expect(() => buildFreezeRecord({
        ...input,
        inputs: [...input.inputs, { name: 'criteria', path: input.inputs[0]!.path }],
      })).toThrow(/不得再出现名为 criteria/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('writeFreezeRecord 落盘后可从磁盘校验', () => {
    const dir = tmp();
    try {
      const out = join(dir, 'nested', 'freeze.json');
      const rec = writeFreezeRecord(out, baseInput(dir));
      const onDisk = JSON.parse(readFileSync(out, 'utf-8'));
      expect(onDisk.frozenAt).toBe(rec.frozenAt);
      expect(onDisk.generatedBy).toBe('benchmark/freeze-util.ts');
      expect(verifyFreezeRecordFile(out).ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('round / phase 不得为空', () => {
    const dir = tmp();
    try {
      expect(() => buildFreezeRecord({ ...baseInput(dir), round: '  ' })).toThrow(/round/);
      expect(() => buildFreezeRecord({ ...baseInput(dir), phase: '' })).toThrow(/phase/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('freeze-util：冻结记录不可覆盖（F1 复核第 2 项）', () => {
  test('目标文件已存在时硬失败，且磁盘上的原记录一个字节不动', () => {
    const dir = tmp();
    try {
      const out = join(dir, 'freeze.json');
      const first = writeFreezeRecord(out, baseInput(dir));
      const before = readFileSync(out, 'utf-8');

      // 改掉一项输入后重跑：这正是"证据链被重写"的那个场景。
      writeFileSync(join(dir, 'corpus.json'), '[1,2,3]');
      expect(() => writeFreezeRecord(out, baseInput(dir))).toThrow(/拒绝覆盖/);

      expect(readFileSync(out, 'utf-8')).toBe(before);
      expect(JSON.parse(before).frozenAt).toBe(first.frozenAt);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('换新路径可以写第二份记录，两份并存可比', () => {
    const dir = tmp();
    try {
      const r1 = writeFreezeRecord(join(dir, 'freeze.json'), baseInput(dir));
      const r2 = writeFreezeRecord(join(dir, 'freeze-r2.json'), {
        ...baseInput(dir), round: 'fts-safety-round-2026-08-12-r2',
      });
      expect(r2.round).not.toBe(r1.round);
      expect(verifyFreezeRecordFile(join(dir, 'freeze.json')).ok).toBe(true);
      expect(verifyFreezeRecordFile(join(dir, 'freeze-r2.json')).ok).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('已存在时不产出记录，也不读被冻结的文件（缺文件也先报覆盖）', () => {
    const dir = tmp();
    try {
      const out = join(dir, 'freeze.json');
      writeFreezeRecord(out, baseInput(dir));
      const input = baseInput(dir);
      rmSync(input.inputs[0]!.path, { force: true });
      // 覆盖检查必须在 SHA 计算之前：否则报出来的会是"文件不存在"，掩盖真实原因。
      expect(() => writeFreezeRecord(out, input)).toThrow(/拒绝覆盖/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
