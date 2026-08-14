/**
 * Q6 取证：`match_source` 投影的纯变换。
 *
 * 判据：`benchmark/reports/agent-behavior/q6-criteria.md`（r4，已冻结）
 *
 * 为什么单独成文件：§2.2 要求改写发生在 **agent 真正感知的那一层**（wire），
 * 且生产 `compactCard` 一个字节不动。把变换与进程管道分开，S1 预检（§8.1）才能
 * 在不启动任何 ACP 会话的前提下确定性地验证它——这正是当前实施边界允许的部分。
 *
 * 协议形状（实测自 `src/server/mcp-server.ts`）：
 *
 *  - 传输是 MCP `StdioServerTransport`，**换行分隔 JSON**，不是 Content-Length 分帧；
 *  - `search` 的响应是 `result.content[0].text`，其中 text 又是一层
 *    `JSON.stringify({ results, total, hint }, null, 2)`；
 *  - 每张卡由 `compactCard`（`mcp-server.ts:133`）产出，`match_source` 是**条件展开**的
 *    （`...(o.match_source ? {...} : {})`），因此删除该字段与"字段天然缺失"在 wire 上同形。
 */

/** 判据 §2.2 的两个臂。L-weak 已由 R3 删除，此处刻意不提供第三种取值。 */
export type Q6Arm = 'L-full' | 'L-hidden';

export interface ProjectOptions {
  arm: Q6Arm;
  /** 目标卡的 Observation id。T-false 条件下是假目标卡，T-true 条件下是真目标卡（§4.1）。 */
  targetObservationId: number;
}

export interface ProjectOutcome {
  /** 投影后的帧对象。未改动时与输入内容等价。 */
  frame: unknown;
  /** 该帧是否被识别为 search 响应。 */
  isSearchResponse: boolean;
  /** 目标卡是否出现在该页上——E1 暴露门（§4.1）的机械依据。 */
  targetPresent: boolean;
  /** 目标卡改写前的 `match_source` 原值；S2 要求它必须是 `semantic`。 */
  targetOriginalMatchSource: string | null;
  /** 实际删除了 `match_source` 的卡数量。L-full 恒为 0；L-hidden 命中时为 1。 */
  removedCount: number;
  /** 该页的卡片总数，用于 S4 校验"其余卡未被波及"。 */
  cardCount: number;
}

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: { content?: unknown };
  error?: unknown;
}

interface SearchPayload {
  results?: unknown;
  total?: unknown;
  hint?: unknown;
}

/**
 * 判据 §2.2：改写必须**按 request ID 关联 `tools/call`**，禁止全局字符串替换。
 *
 * 这个类就是那条纪律的载体：只有先在请求方向见过某个 id 属于 `search`，
 * 响应方向才允许对它动手。全局替换会波及非目标卡，甚至波及 Observation 正文里
 * 恰好出现的同名字符串。
 */
export class SearchRequestRegistry {
  private readonly pending = new Set<string>();

  /** 记录一个请求方向的帧。返回该帧是否是 `search` 的 `tools/call`。 */
  observeRequest(frame: unknown): boolean {
    if (!isObject(frame)) return false;
    if (frame.method !== 'tools/call') return false;
    const params = frame.params;
    if (!isObject(params) || params.name !== 'search') return false;
    const key = idKey(frame.id);
    if (key === null) return false; // 通知（无 id）不可能有响应
    this.pending.add(key);
    return true;
  }

  /** 该响应 id 是否对应一个已登记的 search 请求。命中即消费掉，避免重复改写。 */
  consumeResponse(frame: unknown): boolean {
    if (!isObject(frame)) return false;
    const key = idKey(frame.id);
    if (key === null) return false;
    return this.pending.delete(key);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * 把一个**已确认属于 search 的**响应帧投影到指定臂。
 *
 * 关键设计决定：**两个臂走同一条 parse → modify → serialize 路径**，
 * L-full 的 modify 是空操作。这样两臂输出的格式化、键序完全同源，
 * 唯一差别就是目标卡上有没有 `match_source`——否则 agent 理论上能从
 * 空白或键序差异反推自己在哪个臂。
 *
 * 任何解析失败都**原样透传**并在结果里标注，绝不猜测结构：一个被猜错的帧
 * 会让整轮读数不可信，而透传只会让 E1 判定为未暴露，走 §6.3 的替补。
 */
export function projectSearchResponse(frame: unknown, opts: ProjectOptions): ProjectOutcome {
  const miss: ProjectOutcome = {
    frame,
    isSearchResponse: false,
    targetPresent: false,
    targetOriginalMatchSource: null,
    removedCount: 0,
    cardCount: 0,
  };

  if (!isObject(frame)) return miss;
  const res = frame as JsonRpcResponse;
  const content = res.result?.content;
  if (!Array.isArray(content) || content.length === 0) return miss;

  const first = content[0];
  if (!isObject(first) || first.type !== 'text' || typeof first.text !== 'string') return miss;

  let payload: SearchPayload;
  try {
    payload = JSON.parse(first.text) as SearchPayload;
  } catch {
    return miss; // 不是 JSON 正文：透传
  }
  if (!isObject(payload) || !Array.isArray(payload.results)) return miss;

  const cards = payload.results;
  let targetPresent = false;
  let targetOriginalMatchSource: string | null = null;
  let removedCount = 0;

  const projectedCards = cards.map((card) => {
    if (!isObject(card)) return card;
    if (card.id !== opts.targetObservationId) return card;

    targetPresent = true;
    targetOriginalMatchSource = typeof card.match_source === 'string' ? card.match_source : null;

    if (opts.arm === 'L-full') return card; // 空操作，但仍经过下面的重序列化
    if (!('match_source' in card)) return card;

    const { match_source: _dropped, ...rest } = card;
    removedCount++;
    return rest;
  });

  // 与生产一致的缩进（`mcp-server.ts` 用 `JSON.stringify(..., null, 2)`），
  // 保证两臂之外不引入第三种格式。
  const projectedText = JSON.stringify(
    { ...payload, results: projectedCards },
    null,
    2,
  );

  const projectedFrame = {
    ...(frame as Record<string, unknown>),
    result: {
      ...(res.result as Record<string, unknown>),
      content: [{ ...first, text: projectedText }, ...content.slice(1)],
    },
  };

  return {
    frame: projectedFrame,
    isSearchResponse: true,
    targetPresent,
    targetOriginalMatchSource,
    removedCount,
    cardCount: cards.length,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** JSON-RPC id 允许 string | number；统一成带类型前缀的键，避免 `1` 与 `"1"` 混淆。 */
function idKey(id: unknown): string | null {
  if (typeof id === 'number') return `n:${id}`;
  if (typeof id === 'string') return `s:${id}`;
  return null;
}
