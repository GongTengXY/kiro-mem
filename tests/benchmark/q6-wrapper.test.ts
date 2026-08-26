import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Q6 取证：包装器管道的端到端确定性测试。
 *
 * 判据：`benchmark/reports/agent-behavior/q6-criteria.md`（r4）§2.2 / §8.1
 *
 * 这里用一个**假 MCP server** 验证管道本身（登记、投影、透传、日志），
 * 不启动任何 ACP agent，符合当前实施边界。真实捕获样本由 S1 预检那一步产出。
 */

const WRAPPER = join(import.meta.dir, '..', '..', 'benchmark', 'q6', 'wrapper.ts');
const tmp = mkdtempSync(join(tmpdir(), 'q6-wrapper-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 假 server：按行读 JSON-RPC，对 search 回生产同形响应，对其他方法回一个无关结果。 */
const FAKE_SERVER = join(tmp, 'fake-server.ts');
writeFileSync(
  FAKE_SERVER,
  `
const card = (id: number, ms?: string) => ({
  id, title: 'obs ' + id, type: 'decision', date: '2026-08-01',
  turn_id: id * 10, turn_seq: 1, files: [], is_pinned: false,
  ...(ms ? { match_source: ms } : {}), has_next_steps: false, confidence: 0.9,
});
let buf = '';
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.method === 'tools/call' && req.params?.name === 'search') {
      const payload = { results: [card(43, 'fts'), card(42, 'semantic')], total: 2, hint: 'H' };
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: { tools: ['search'] },
      }) + '\\n');
    }
  }
}
`,
  'utf-8',
);

interface RunResult {
  frames: any[];
  log: any[];
}

async function runWrapper(arm: string, requests: unknown[]): Promise<RunResult> {
  const logPath = join(tmp, `log-${arm}-${Math.random().toString(36).slice(2)}.jsonl`);
  const proc = Bun.spawn({
    cmd: ['bun', 'run', WRAPPER],
    env: {
      ...process.env,
      Q6_ARM: arm,
      Q6_TARGET_OBS_ID: '42',
      Q6_FRAME_LOG: logPath,
      Q6_SERVER_ARGV: JSON.stringify(['bun', 'run', FAKE_SERVER]),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const w = proc.stdin as unknown as { write(d: Uint8Array): void; end(): void };
  for (const r of requests) w.write(new TextEncoder().encode(`${JSON.stringify(r)}\n`));
  w.end();
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return {
    frames: out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
    log: readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
  };
}

const searchReq = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'x' } } };
const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

function cardsOf(frame: any): any[] {
  return JSON.parse(frame.result.content[0].text).results;
}

describe('Q6 包装器：管道端到端', () => {
  test('L-hidden 删掉目标卡标签，其余卡与其他方法不受影响', async () => {
    const { frames } = await runWrapper('L-hidden', [searchReq, listReq]);
    expect(frames.length).toBe(2);

    const cards = cardsOf(frames.find((f) => f.id === 1));
    expect(cards.find((c) => c.id === 42)).not.toHaveProperty('match_source');
    expect(cards.find((c) => c.id === 43).match_source).toBe('fts');

    // tools/list 必须原样透传
    expect(frames.find((f) => f.id === 2).result.tools).toEqual(['search']);
  });

  test('L-full 保留目标卡标签', async () => {
    const { frames } = await runWrapper('L-full', [searchReq]);
    expect(cardsOf(frames[0]).find((c) => c.id === 42).match_source).toBe('semantic');
  });

  test('帧日志记下 E1 / S2 所需的读数', async () => {
    const { log } = await runWrapper('L-hidden', [searchReq]);
    const projected = log.find((e) => e.projected === true);
    expect(projected.isSearchResponse).toBe(true);
    expect(projected.targetPresent).toBe(true);
    expect(projected.targetOriginalMatchSource).toBe('semantic');
    expect(projected.removedCount).toBe(1);
    expect(projected.cardCount).toBe(2);

    expect(log.find((e) => e.event === 'spawn').arm).toBe('L-hidden');
    expect(log.find((e) => e.event === 'exit').pendingSearchIds).toBe(0);
  });

  test('非 search 的 tools/call 不被投影（按 request ID 关联）', async () => {
    const timelineReq = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'timeline' } };
    const { log } = await runWrapper('L-hidden', [timelineReq]);
    expect(log.some((e) => e.projected === true)).toBe(false);
    expect(log.find((e) => e.dir === 'agent->server').isSearchCall).toBe(false);
  });

  test('缺必需 env 时快速失败，不静默降级', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'run', WRAPPER],
      env: { ...process.env, Q6_ARM: '', Q6_TARGET_OBS_ID: '', Q6_FRAME_LOG: '', Q6_SERVER_ARGV: '' },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    (proc.stdin as any).end();
    const code = await proc.exited;
    expect(code).toBe(64);
    expect(await new Response(proc.stderr).text()).toContain('missing required env');
  });

  test('非法 Q6_ARM 被拒绝（L-weak 已由 R3 删除）', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'run', WRAPPER],
      env: {
        ...process.env,
        Q6_ARM: 'L-weak',
        Q6_TARGET_OBS_ID: '42',
        Q6_FRAME_LOG: join(tmp, 'reject.jsonl'),
        Q6_SERVER_ARGV: JSON.stringify(['bun', 'run', FAKE_SERVER]),
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });
    (proc.stdin as any).end();
    expect(await proc.exited).toBe(64);
    expect(await new Response(proc.stderr).text()).toContain('L-full or L-hidden');
  });
});

/**
 * 跨 chunk 的 UTF-8：**双向**端到端。
 *
 * 单测（`q6-line-splitter.test.ts`）已经用逐字节穷举证明了切分器本身；这里再用真实进程管道
 * 覆盖两个方向，确认包装器把切分器接对了：
 *
 *  - agent → server：测试把请求切在中文字符的字节中间写入，假 server 把收到的 query 原样
 *    回写进卡片标题，于是标题还原即证明请求侧未被破坏；
 *  - server → agent：假 server 把响应切在中文字符的字节中间分两次写出。
 */
const ECHO_SERVER = join(tmp, 'echo-split-server.ts');
writeFileSync(
  ECHO_SERVER,
  `
const enc = new TextEncoder();
const dec = new TextDecoder();
let buf = '';
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    const q = req.params?.arguments?.query ?? '';
    // 卡片标题回写收到的 query，并带上一段中文正文。
    const payload = { results: [{
      id: 42, title: q, summary: '压缩失败时降级为 fallback 观察，总结那一步出问题也能查到',
      match_source: 'semantic',
    }], total: 1, hint: '用 get_observations 获取完整详情' };
    const frame = JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
    }) + '\\n';
    // 刻意切在一个中文字符的 3 个字节中间：找到第一个多字节字符的起始，+1 分片。
    const bytes = enc.encode(frame);
    let cut = Math.floor(bytes.length / 2);
    while (cut < bytes.length && (bytes[cut] & 0xc0) !== 0x80) cut++;
    // 此时 bytes[cut] 是一个 continuation byte，切在它前面即切在字符内部。
    Bun.write(Bun.stdout, bytes.subarray(0, cut));
    await Bun.sleep(30);
    Bun.write(Bun.stdout, bytes.subarray(cut));
  }
}
`,
  'utf-8',
);

describe('Q6 包装器：跨 chunk UTF-8（双向）', () => {
  const zhQuery = '总结那一步出问题的时候还能查到吗';

  async function runSplit(arm: string): Promise<{ frames: any[]; log: any[] }> {
    const logPath = join(tmp, `split-${arm}-${Math.random().toString(36).slice(2)}.jsonl`);
    const proc = Bun.spawn({
      cmd: ['bun', 'run', WRAPPER],
      env: {
        ...process.env,
        Q6_ARM: arm,
        Q6_TARGET_OBS_ID: '42',
        Q6_FRAME_LOG: logPath,
        Q6_SERVER_ARGV: JSON.stringify(['bun', 'run', ECHO_SERVER]),
      },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    });

    const req = `${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'search', arguments: { query: zhQuery, semantic_query_en: 'x' } },
    })}\n`;
    const bytes = new TextEncoder().encode(req);
    // 同样切在中文字符内部：定位一个 continuation byte，切在它之前。
    let cut = Math.floor(bytes.length / 2);
    while (cut < bytes.length && (bytes[cut]! & 0xc0) !== 0x80) cut++;

    const w = proc.stdin as unknown as { write(d: Uint8Array): void; end(): void };
    w.write(bytes.subarray(0, cut));
    await Bun.sleep(30);
    w.write(bytes.subarray(cut));
    w.end();

    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return {
      frames: out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
      log: readFileSync(logPath, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)),
    };
  }

  test('agent→server：中文 query 逐字符透传（标题回写证明）', async () => {
    const { frames } = await runSplit('L-hidden');
    expect(frames.length).toBe(1);
    const card = cardsOf(frames[0])[0];
    expect(card.title).toBe(zhQuery);
    expect(card.title).not.toContain('\uFFFD');
  });

  test('server→agent：响应正文的中文不被破坏，且投影仍然生效', async () => {
    const { frames, log } = await runSplit('L-hidden');
    const card = cardsOf(frames[0])[0];
    expect(card.summary).toBe('压缩失败时降级为 fallback 观察，总结那一步出问题也能查到');
    expect(card.summary).not.toContain('\uFFFD');
    // 分块没有影响识别与改写。
    expect(card).not.toHaveProperty('match_source');
    expect(log.find((e) => e.projected === true).removedCount).toBe(1);
  });

  test('L-full 在分块下同样完整，且保留标记', async () => {
    const { frames } = await runSplit('L-full');
    const card = cardsOf(frames[0])[0];
    expect(card.title).toBe(zhQuery);
    expect(card.summary).not.toContain('\uFFFD');
    expect(card.match_source).toBe('semantic');
  });
});
