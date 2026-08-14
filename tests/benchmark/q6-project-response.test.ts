import { describe, expect, test } from 'bun:test';
import {
  projectSearchResponse,
  SearchRequestRegistry,
  type Q6Arm,
} from '../../benchmark/q6/project-response';

/**
 * Q6 取证：`match_source` 投影的确定性测试。
 *
 * 判据 §8.1 要求 S1 是**包装器预检**而不是对实际 trial 响应的比对，理由是不同 agent
 * 会话会生成不同的 `search` 参数。本文件测的就是那个预检所依赖的性质，全部不启动任何进程、
 * 不涉及 ACP——符合当前实施边界（前三步可做确定性测试，不得跑真实 agent trial）。
 */

const TARGET = 42;
const OTHER = 43;

/** 复刻生产响应形状：`result.content[0].text` 里再套一层 `JSON.stringify(..., null, 2)`。 */
function makeSearchFrame(
  cards: Record<string, unknown>[],
  opts?: { id?: unknown; hint?: string },
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: opts?.id ?? 7,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { results: cards, total: cards.length, hint: opts?.hint ?? 'use get_observations' },
            null,
            2,
          ),
        },
      ],
    },
  };
}

function card(id: number, matchSource?: string): Record<string, unknown> {
  return {
    id,
    title: `obs ${id}`,
    type: 'decision',
    date: '2026-08-01',
    turn_id: id * 10,
    turn_seq: 3,
    files: ['src/a.ts'],
    is_pinned: false,
    ...(matchSource ? { match_source: matchSource } : {}),
    semantic_score: 0.412,
    has_next_steps: false,
    confidence: 0.8,
  };
}

function readCards(frame: unknown): Record<string, unknown>[] {
  const text = (frame as any).result.content[0].text as string;
  return JSON.parse(text).results;
}

function project(frame: unknown, arm: Q6Arm) {
  return projectSearchResponse(frame, { arm, targetObservationId: TARGET });
}

describe('Q6 S1: match_source 投影', () => {
  test('L-hidden 只删目标卡的 match_source，其余卡不动', () => {
    const frame = makeSearchFrame([card(OTHER, 'fts'), card(TARGET, 'semantic')]);
    const out = project(frame, 'L-hidden');

    expect(out.isSearchResponse).toBe(true);
    expect(out.targetPresent).toBe(true);
    expect(out.targetOriginalMatchSource).toBe('semantic');
    expect(out.removedCount).toBe(1);
    expect(out.cardCount).toBe(2);

    const cards = readCards(out.frame);
    expect(cards.find((c) => c.id === TARGET)).not.toHaveProperty('match_source');
    // 其余卡必须原样保留自己的来源标签。
    expect(cards.find((c) => c.id === OTHER)!.match_source).toBe('fts');
  });

  test('L-full 不删任何字段', () => {
    const frame = makeSearchFrame([card(TARGET, 'semantic')]);
    const out = project(frame, 'L-full');

    expect(out.removedCount).toBe(0);
    expect(readCards(out.frame)[0]!.match_source).toBe('semantic');
  });

  test('两臂差异**只有**目标卡的 match_source —— S1 的核心断言', () => {
    const frame = makeSearchFrame([card(OTHER, 'hybrid'), card(TARGET, 'semantic')]);
    const full = readCards(project(frame, 'L-full').frame);
    const hidden = readCards(project(frame, 'L-hidden').frame);

    expect(hidden.length).toBe(full.length);
    for (let i = 0; i < full.length; i++) {
      const a = { ...full[i]! };
      const b = { ...hidden[i]! };
      if (a.id === TARGET) {
        expect(a.match_source).toBe('semantic');
        expect(b).not.toHaveProperty('match_source');
        delete a.match_source;
      }
      expect(b).toEqual(a);
    }
  });

  test('两臂的帧外层结构一致（id / jsonrpc / total / hint 不受影响）', () => {
    const frame = makeSearchFrame([card(TARGET, 'semantic')], { id: 'req-9', hint: 'H' });
    for (const arm of ['L-full', 'L-hidden'] as Q6Arm[]) {
      const f = project(frame, arm).frame as any;
      expect(f.jsonrpc).toBe('2.0');
      expect(f.id).toBe('req-9');
      const payload = JSON.parse(f.result.content[0].text);
      expect(payload.total).toBe(1);
      expect(payload.hint).toBe('H');
    }
  });

  test('两臂经过同一条重序列化路径：L-full 的输出与 L-hidden 同格式', () => {
    // 若 L-full 直接透传原始字符串，两臂的空白/键序可能不同，agent 理论上能反推臂别。
    const frame = makeSearchFrame([card(TARGET, 'semantic')]);
    const fullText = (project(frame, 'L-full').frame as any).result.content[0].text as string;
    const hiddenText = (project(frame, 'L-hidden').frame as any).result.content[0].text as string;
    const stripped = fullText.replace(/^\s*"match_source": "semantic",\n/m, '');
    expect(hiddenText).toBe(stripped);
  });

  test('目标卡不在页上时 targetPresent=false —— E1 的机械依据', () => {
    const frame = makeSearchFrame([card(OTHER, 'fts')]);
    const out = project(frame, 'L-hidden');
    expect(out.isSearchResponse).toBe(true);
    expect(out.targetPresent).toBe(false);
    expect(out.removedCount).toBe(0);
  });

  test('目标卡已无 match_source 时不报删除（幂等）', () => {
    const frame = makeSearchFrame([card(TARGET)]);
    const out = project(frame, 'L-hidden');
    expect(out.targetPresent).toBe(true);
    expect(out.targetOriginalMatchSource).toBeNull();
    expect(out.removedCount).toBe(0);
  });

  test('非 search 形状的帧原样透传，不猜测结构', () => {
    const cases: unknown[] = [
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: { content: [] } },
      { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'image', data: 'x' }] } },
      { jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'not json' }] } },
      { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: '{"total":0}' }] } },
      { jsonrpc: '2.0', id: 6, error: { code: -32000, message: 'boom' } },
      null,
      'plain string',
    ];
    for (const c of cases) {
      const out = project(c, 'L-hidden');
      expect(out.isSearchResponse).toBe(false);
      expect(out.removedCount).toBe(0);
      expect(out.frame).toBe(c); // 同一引用 = 逐字节透传
    }
  });

  test('正文里恰好出现 match_source 字样的 Observation 不被波及', () => {
    // 这就是判据 §8.1 禁止全局字符串替换的理由。
    const noisy = card(OTHER, 'fts');
    noisy.title = 'why match_source is not a relevance label';
    const frame = makeSearchFrame([noisy, card(TARGET, 'semantic')]);
    const cards = readCards(project(frame, 'L-hidden').frame);
    expect(cards.find((c) => c.id === OTHER)!.title).toBe(
      'why match_source is not a relevance label',
    );
    expect(cards.find((c) => c.id === OTHER)!.match_source).toBe('fts');
  });
});

describe('Q6 S1: 按 request ID 关联 tools/call', () => {
  test('只有登记过的 search 请求 id 才允许改写', () => {
    const reg = new SearchRequestRegistry();
    expect(reg.observeRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } })).toBe(true);
    expect(reg.observeRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'timeline' } })).toBe(false);
    expect(reg.observeRequest({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).toBe(false);

    expect(reg.consumeResponse({ jsonrpc: '2.0', id: 1 })).toBe(true);
    expect(reg.consumeResponse({ jsonrpc: '2.0', id: 2 })).toBe(false);
  });

  test('同一个 id 只消费一次，避免重复改写', () => {
    const reg = new SearchRequestRegistry();
    reg.observeRequest({ id: 1, method: 'tools/call', params: { name: 'search' } });
    expect(reg.consumeResponse({ id: 1 })).toBe(true);
    expect(reg.consumeResponse({ id: 1 })).toBe(false);
  });

  test('字符串 id 与数字 id 不混淆', () => {
    const reg = new SearchRequestRegistry();
    reg.observeRequest({ id: 1, method: 'tools/call', params: { name: 'search' } });
    expect(reg.consumeResponse({ id: '1' })).toBe(false);
    expect(reg.consumeResponse({ id: 1 })).toBe(true);
  });

  test('通知（无 id）不登记', () => {
    const reg = new SearchRequestRegistry();
    expect(reg.observeRequest({ method: 'tools/call', params: { name: 'search' } })).toBe(false);
    expect(reg.pendingCount).toBe(0);
  });
});
