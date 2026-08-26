#!/usr/bin/env bun
/**
 * Q6 取证：MCP stdio 包装器（wire 级 `match_source` 投影）。
 *
 * 判据：`benchmark/reports/agent-behavior/q6-criteria.md`（r4，已冻结）§2.2
 *
 * agent 通过 `mcpServers['kiro-mem']` 以 stdio 拉起 MCP server，所以把 `command` 指向本脚本
 * 即可在 **agent 真正感知的那一层**改写标记，而生产 `compactCard` 一个字节不动。
 * 本脚本**不含任何策略判断**：投影逻辑全在 `project-response.ts`，由 S1 预检独立验证。
 *
 * 三条纪律，直接来自判据：
 *
 *  1. **按 request ID 关联 `tools/call`**，禁止全局字符串替换（§8.1）；
 *  2. 解析失败一律**原样透传**，绝不猜结构——猜错会让整轮读数不可信，而透传只会让
 *     E1 判定为未暴露，走 §6.3 的替补状态机；
 *  3. 每一帧都落 JSONL 日志，那是 **E1 暴露门与 S2 的机械证据**（§4.1）。
 *
 * 用法（由 runner 设置，不手动跑）：
 *
 * ```
 * Q6_ARM=L-hidden Q6_TARGET_OBS_ID=42 Q6_FRAME_LOG=/tmp/t1.jsonl \
 * Q6_SERVER_ARGV='["bun","run","/tmp/dd/src/server/mcp-server.ts"]' \
 *   bun run benchmark/q6/wrapper.ts
 * ```
 */
import { appendFileSync } from 'node:fs';
import { makeLineSplitter } from './line-splitter';
import {
  projectSearchResponse,
  SearchRequestRegistry,
  type Q6Arm,
} from './project-response';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    // 不给默认值：一个静默降级的包装器会产出无法归因的 trial。
    process.stderr.write(`[q6-wrapper] missing required env ${name}\n`);
    process.exit(64);
  }
  return v;
}

const arm = required('Q6_ARM') as Q6Arm;
if (arm !== 'L-full' && arm !== 'L-hidden') {
  process.stderr.write(`[q6-wrapper] Q6_ARM must be L-full or L-hidden, got ${arm}\n`);
  process.exit(64);
}
const targetObservationId = Number(required('Q6_TARGET_OBS_ID'));
if (!Number.isInteger(targetObservationId) || targetObservationId <= 0) {
  process.stderr.write('[q6-wrapper] Q6_TARGET_OBS_ID must be a positive integer\n');
  process.exit(64);
}
const frameLog = required('Q6_FRAME_LOG');
let serverArgv: string[];
try {
  serverArgv = JSON.parse(required('Q6_SERVER_ARGV'));
  if (!Array.isArray(serverArgv) || serverArgv.length === 0) throw new Error('empty');
} catch {
  process.stderr.write('[q6-wrapper] Q6_SERVER_ARGV must be a non-empty JSON string array\n');
  process.exit(64);
}

function log(entry: Record<string, unknown>): void {
  appendFileSync(frameLog, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

// Q6_* 不传给真实 server —— 它对本实验一无所知，这是"生产代码零改动"的一部分。
const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith('Q6_') && v !== undefined) childEnv[k] = v;
}

const child = Bun.spawn({
  cmd: serverArgv,
  env: childEnv,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'inherit',
});

log({ dir: 'meta', event: 'spawn', arm, targetObservationId, serverArgv });

const registry = new SearchRequestRegistry();
const encoder = new TextEncoder();

const childStdin = child.stdin as unknown as { write(d: Uint8Array): void; end(): void };

// --- agent → server（请求方向）：只登记 id，逐字节透传 ---
const upstream = makeLineSplitter((line) => {
  let frame: unknown = null;
  try {
    frame = JSON.parse(line);
  } catch {
    /* 透传，不猜 */
  }
  const isSearch = registry.observeRequest(frame);
  log({
    dir: 'agent->server',
    isSearchCall: isSearch,
    id: (frame as any)?.id ?? null,
    method: (frame as any)?.method ?? null,
    toolName: (frame as any)?.params?.name ?? null,
  });
  childStdin.write(encoder.encode(`${line}\n`));
});

// --- server → agent（响应方向）：命中登记过的 search id 才投影 ---
const downstream = makeLineSplitter((line) => {
  let frame: unknown = null;
  try {
    frame = JSON.parse(line);
  } catch {
    process.stdout.write(`${line}\n`);
    log({ dir: 'server->agent', parsed: false });
    return;
  }

  if (!registry.consumeResponse(frame)) {
    process.stdout.write(`${line}\n`);
    log({ dir: 'server->agent', id: (frame as any)?.id ?? null, projected: false });
    return;
  }

  const out = projectSearchResponse(frame, { arm, targetObservationId });
  process.stdout.write(`${JSON.stringify(out.frame)}\n`);
  // 这条记录就是 E1（§4.1）与 S2（§8）的机械依据：目标卡是否送达、原始标签是什么。
  log({
    dir: 'server->agent',
    id: (frame as any)?.id ?? null,
    projected: true,
    isSearchResponse: out.isSearchResponse,
    targetPresent: out.targetPresent,
    targetOriginalMatchSource: out.targetOriginalMatchSource,
    removedCount: out.removedCount,
    cardCount: out.cardCount,
  });
});

(async () => {
  for await (const chunk of Bun.stdin.stream()) upstream.push(chunk as Uint8Array);
  upstream.flush();
  childStdin.end();
})();

(async () => {
  for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
    downstream.push(chunk);
  }
  downstream.flush();
  const code = await child.exited;
  log({ dir: 'meta', event: 'exit', code, pendingSearchIds: registry.pendingCount });
  process.exit(code ?? 0);
})();
