import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runS1 } from '../../benchmark/q6/s1-precheck';

/**
 * Q6 S1 预检的回归测试：跑在**已提交的真实捕获样本**上。
 *
 * 判据 §8 要求 S1 是"任一项失败则该次运行读数作废"的装置自证，所以它必须一直是绿的，
 * 而不是只在捕获当天绿过一次。样本由 `benchmark/q6/capture-search-response.ts` 从生产
 * `mcp-server.ts` 捕获，本测试不重新捕获、不启动任何进程。
 */
const FIXTURE = join(import.meta.dir, '..', '..', 'benchmark', 'q6', 'fixtures', 'captured-search-response.json');

describe('Q6 S1 预检（真实捕获样本）', () => {
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf-8'));

  test('捕获样本自身结构完好', () => {
    expect(captured.targetObservationId).toBeGreaterThan(0);
    expect(Array.isArray(captured.samples)).toBe(true);
    expect(captured.samples.length).toBeGreaterThanOrEqual(2);
  });

  test('每个样本都含一张 semantic 目标卡', () => {
    for (const s of captured.samples) {
      const cards = JSON.parse(JSON.parse(s.rawLine).result.content[0].text).results;
      const target = cards.find((c: any) => c.id === captured.targetObservationId);
      expect(target).toBeDefined();
      expect(target.match_source).toBe('semantic');
    }
  });

  test('存在多卡且含非 semantic 来源的样本 —— 否则非目标卡那条断言是空跑', () => {
    const mixed = captured.samples.find(
      (s: any) => s.cardSources.length >= 2 && s.cardSources.some((x: string | null) => x && x !== 'semantic'),
    );
    expect(mixed).toBeDefined();
  });

  test('S1 全部断言通过', () => {
    const r = runS1(captured);
    const failed = r.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
    expect(failed).toEqual([]);
    expect(r.pass).toBe(true);
  });

  test('S1 会在投影被破坏时失败（负向对照，证明它不是永真）', () => {
    // 把目标 id 换成页面上不存在的 id：目标卡就不会被识别，多条断言应当失败。
    const broken = { ...captured, targetObservationId: 999999 };
    const r = runS1(broken);
    expect(r.pass).toBe(false);
    const names = r.checks.filter((c) => !c.pass).map((c) => c.name);
    expect(names.some((n) => n.includes('target-present-on-captured-page'))).toBe(true);
    expect(names.some((n) => n.includes('l-hidden-removes-exactly-one'))).toBe(true);
  });
});
