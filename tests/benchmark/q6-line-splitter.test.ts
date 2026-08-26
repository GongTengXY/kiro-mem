import { describe, expect, test } from 'bun:test';
import { makeLineSplitter } from '../../benchmark/q6/line-splitter';

/**
 * Q6：跨 chunk 多字节字符的回归测试。
 *
 * 背景：包装器第一版在每次 `push()` 里 `new TextDecoder()`，丢掉流式状态，于是一个被 pipe
 * 切开的中文字符会解码成 `�`。那会**双向**破坏字节（中文 query 与搜索结果正文），
 * 并造成**虚假的 E1 / 装置失败**——失败会被记成"agent 没看到线索"，而真因是代理弄坏了字节。
 *
 * 这里用**逐字节穷举切分**来证明修复，而不是靠真实 pipe 碰运气命中那个边界。
 */

const encoder = new TextEncoder();

function collect(chunks: Uint8Array[]): string[] {
  const lines: string[] = [];
  const s = makeLineSplitter((l) => lines.push(l));
  for (const c of chunks) s.push(c);
  s.flush();
  return lines;
}

function splitAt(bytes: Uint8Array, at: number): Uint8Array[] {
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

describe('Q6 line splitter：跨 chunk 的 UTF-8', () => {
  const zh = '压缩失败时降级为 fallback 观察';
  const payload = `${JSON.stringify({ query: zh, note: '总结那一步出问题的时候还能查到吗' })}\n`;
  const bytes = encoder.encode(payload);

  test('在**每一个**字节位置切开，结果都必须逐字符还原', () => {
    // 这是核心断言：中文在 UTF-8 下是 3 字节，穷举切点必然覆盖"切在字符中间"的情况。
    const expected = payload.trimEnd();
    for (let at = 1; at < bytes.length; at++) {
      const lines = collect(splitAt(bytes, at));
      expect(lines.length).toBe(1);
      if (lines[0] !== expected) {
        throw new Error(`切点 ${at} 处解码不一致：\n得到 ${lines[0]}\n期望 ${expected}`);
      }
      expect(JSON.parse(lines[0]!).query).toBe(zh);
    }
  });

  test('逐字节喂入（每次 1 字节）也必须还原', () => {
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    const lines = collect(chunks);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).query).toBe(zh);
    expect(lines[0]).not.toContain('\uFFFD');
  });

  test('复现旧写法的缺陷：每次新建 decoder 会产出替换字符', () => {
    // 负向对照。若哪天有人"顺手简化"回旧写法，这条测试说明代价是什么。
    let bad = '';
    for (const c of splitAt(bytes, 12)) {
      bad += new TextDecoder().decode(c, { stream: true });
    }
    expect(bad).toContain('\uFFFD');
    // 而修复后的切分器在同一切点上是干净的。
    expect(collect(splitAt(bytes, 12))[0]).not.toContain('\uFFFD');
  });

  test('flush 会吐出解码器残留，不静默丢弃末尾字节', () => {
    // 最后一行不带换行，且刻意在末尾中文字符的字节中间断流。
    const noNewline = encoder.encode('{"q":"降级"}');
    const lines = collect([noNewline.subarray(0, noNewline.length - 2), noNewline.subarray(noNewline.length - 2)]);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!).q).toBe('降级');
  });

  test('多行、含空行、行内含中文，逐行完整', () => {
    const src = `${JSON.stringify({ a: '第一行' })}\n\n${JSON.stringify({ b: '第二行' })}\n`;
    const b = encoder.encode(src);
    for (let at = 1; at < b.length; at++) {
      const lines = collect(splitAt(b, at));
      expect(lines.length).toBe(2); // 空行被跳过
      expect(JSON.parse(lines[0]!).a).toBe('第一行');
      expect(JSON.parse(lines[1]!).b).toBe('第二行');
    }
  });

  test('emoji（4 字节序列）同样不被破坏', () => {
    const src = `${JSON.stringify({ e: '✅🚀 完成' })}\n`;
    const b = encoder.encode(src);
    for (let at = 1; at < b.length; at++) {
      const lines = collect(splitAt(b, at));
      expect(JSON.parse(lines[0]!).e).toBe('✅🚀 完成');
    }
  });

  test('空流不产出任何行', () => {
    expect(collect([])).toEqual([]);
    expect(collect([new Uint8Array([])])).toEqual([]);
  });
});
