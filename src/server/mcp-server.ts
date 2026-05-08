import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config';
import { MemoryDB } from '../db';
import type { Memory } from '../db/types';
import {
  generateEmbedding,
  cosineSimilarity,
  blobToEmbedding,
} from '../embedding';

const db = new MemoryDB();
const config = loadConfig();
const isEnglish = config.language === 'en';

const server = new Server(
  { name: 'kiro-mem', version: '2.0.0' },
  { capabilities: { tools: {} } },
);

const toolText = isEnglish
  ? {
      searchDescription:
        'Search history memories. Returns matching memory summaries with type, time, and repo filters.',
      queryDescription: 'Search keywords',
      typeDescription: 'Filter by memory type',
      repoDescription: 'Filter by git repo',
      daysDescription: 'Within the last N days',
      limitDescription: 'Maximum number of results',
      getMemoriesDescription:
        'Fetch full memory details by ID. Use search first, then fetch the relevant memories.',
      idsDescription: 'List of memory IDs',
      traceDescription:
        'Trace one memory back to its source turns and neighboring memories.',
      memoryIdDescription: 'Memory ID',
      beforeDescription: 'Number of previous neighboring memories',
      afterDescription: 'Number of next neighboring memories',
      topicsDescription: 'Get active topics and their unresolved summaries.',
      pinDescription:
        'Mark or unmark a memory as high-value. Pinned memories are prioritized in later context injection.',
      pinnedDescription: 'true = pin, false = unpin',
      hint: 'Use get_memories to fetch full details',
    }
  : {
      searchDescription:
        '搜索历史记忆。返回匹配的 memory 摘要列表，支持按类型、时间、repo 过滤。',
      queryDescription: '搜索关键词',
      typeDescription: '按类型过滤',
      repoDescription: '按 git repo 过滤',
      daysDescription: '最近 N 天内',
      limitDescription: '最大返回数',
      getMemoriesDescription:
        '按 ID 批量获取 memory 完整内容。先用 search 找到相关 ID，再用此工具获取详情。',
      idsDescription: 'memory ID 列表',
      traceDescription:
        '追溯一条 memory 的来源 turn 和相邻记忆，用于理解上下文。',
      memoryIdDescription: 'memory ID',
      beforeDescription: '向前取 N 条相邻记忆',
      afterDescription: '向后取 N 条相邻记忆',
      topicsDescription: '获取活跃主题列表及其未完成摘要。',
      pinDescription:
        '标记/取消标记某个 memory 为高价值记忆。被 pin 的记忆会在后续会话中优先注入。',
      pinnedDescription: 'true=标记, false=取消',
      hint: '使用 get_memories 获取完整详情',
    };

// --- Hybrid search: FTS + semantic rerank ---

async function hybridSearch(query: string, opts?: {
  type?: string; repo?: string; days?: number; limit?: number;
}): Promise<Array<Memory & { match_source: string; semantic_score: number | null }>> {
  const limit = opts?.limit ?? 20;
  const days = opts?.days ?? 90;
  const RRF_K = 60;

  // FTS candidates
  const ftsResults = db.searchMemoriesFts(query, { type: opts?.type, repo: opts?.repo, days, limit: 50 });
  const ftsIds = new Set(ftsResults.map(m => m.id));

  // Semantic candidates
  let semanticRanking = new Map<number, number>();
  try {
    const queryEmbedding = await generateEmbedding(query);
    const recentIds = db.getRecentMemoryIds(days, 200, opts?.repo);
    const candidateIds = [...new Set([...ftsIds, ...recentIds])];
    const embeddings = db.getMemoryEmbeddingsByIds(candidateIds);
    const scored: { id: number; score: number }[] = [];
    for (const row of embeddings) {
      const vec = blobToEmbedding(row.embedding);
      const score = cosineSimilarity(queryEmbedding, vec);
      if (score > 0.2) scored.push({ id: row.memory_id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((item, idx) => semanticRanking.set(item.id, idx + 1));
  } catch {
    // embedding unavailable — FTS only
  }

  // RRF fusion
  const allIds = new Set([...ftsIds, ...semanticRanking.keys()]);
  const ftsRankMap = new Map<number, number>();
  ftsResults.forEach((m, idx) => ftsRankMap.set(m.id, idx + 1));

  const scored: { id: number; score: number; ftsRank: number | null; semRank: number | null }[] = [];
  for (const id of allIds) {
    const ftsRank = ftsRankMap.get(id) ?? null;
    const semRank = semanticRanking.get(id) ?? null;
    let score = 0;
    if (ftsRank !== null) score += 1 / (RRF_K + ftsRank);
    if (semRank !== null) score += 1 / (RRF_K + semRank);
    scored.push({ id, score, ftsRank, semRank });
  }
  scored.sort((a, b) => b.score - a.score);

  const topIds = scored.slice(0, limit);
  const ftsMap = new Map(ftsResults.map(m => [m.id, m]));
  const missingIds = topIds.filter(s => !ftsMap.has(s.id)).map(s => s.id);
  const missingMems = db.getMemoriesByIds(missingIds);
  const missingMap = new Map(missingMems.map(m => [m.id, m]));

  return topIds.map(s => {
    const mem = ftsMap.get(s.id) || missingMap.get(s.id);
    if (!mem) return null;
    const matchSource = s.ftsRank != null && s.semRank != null ? 'hybrid'
      : s.ftsRank != null ? 'fts' : 'semantic';
    return { ...mem, match_source: matchSource, semantic_score: null };
  }).filter(Boolean) as Array<Memory & { match_source: string; semantic_score: number | null }>;
}

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: toolText.searchDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: toolText.queryDescription },
          type: { type: 'string', enum: ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'], description: toolText.typeDescription },
          repo: { type: 'string', description: toolText.repoDescription },
          days: { type: 'number', description: toolText.daysDescription, default: 90 },
          limit: { type: 'number', description: toolText.limitDescription, default: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_memories',
      description: toolText.getMemoriesDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          ids: { type: 'array', items: { type: 'number' }, description: toolText.idsDescription, maxItems: 20 },
        },
        required: ['ids'],
      },
    },
    {
      name: 'trace_memory',
      description: toolText.traceDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          memory_id: { type: 'number', description: toolText.memoryIdDescription },
          before: { type: 'number', description: toolText.beforeDescription, default: 3 },
          after: { type: 'number', description: toolText.afterDescription, default: 3 },
        },
        required: ['memory_id'],
      },
    },
    {
      name: 'topics',
      description: toolText.topicsDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: toolText.repoDescription },
          limit: { type: 'number', description: toolText.limitDescription, default: 20 },
        },
      },
    },
    {
      name: 'pin',
      description: toolText.pinDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          memory_id: { type: 'number', description: toolText.memoryIdDescription },
          pinned: { type: 'boolean', description: toolText.pinnedDescription, default: true },
        },
        required: ['memory_id'],
      },
    },
  ],
}));

// --- Tool handlers ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search') {
    const { query, type, repo, days, limit } = args as {
      query: string; type?: string; repo?: string; days?: number; limit?: number;
    };
    const results = await hybridSearch(query, { type, repo, days, limit });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: results.map(m => ({
            id: m.id, title: m.title, type: m.memory_type,
            topic_id: m.topic_id, date: m.last_turn_at?.slice(0, 10),
            is_pinned: !!m.is_pinned, match_source: m.match_source,
            source_turn_count: m.source_turn_count,
          })),
          total: results.length,
          hint: toolText.hint,
        }, null, 2),
      }],
    };
  }

  if (name === 'get_memories') {
    const { ids } = args as { ids: number[] };
    const memories = db.getMemoriesByIds(ids);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          memories: memories.map(m => ({
            id: m.id, title: m.title, summary: m.summary,
            request: m.request, investigated: m.investigated,
            learned: m.learned, completed: m.completed, next_steps: m.next_steps,
            type: m.memory_type, kind: m.memory_kind,
            files: JSON.parse(m.files_touched_json),
            concepts: JSON.parse(m.concepts_json),
            topic_id: m.topic_id, is_pinned: !!m.is_pinned,
            source_turn_count: m.source_turn_count,
            first_turn_at: m.first_turn_at, last_turn_at: m.last_turn_at,
          })),
        }, null, 2),
      }],
    };
  }

  if (name === 'trace_memory') {
    const memoryId = (args as any).memory_id;
    const before = (args as any).before ?? 3;
    const after = (args as any).after ?? 3;
    const trace = db.traceMemory(memoryId, { before, after });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          memory: trace.memory ? {
            id: trace.memory.id, title: trace.memory.title, type: trace.memory.memory_type,
          } : null,
          source_turns: trace.source_turns.map(t => ({
            id: t.id, seq: t.seq, prompt: t.prompt_text?.slice(0, 200),
            started_at: t.started_at, tool_count: t.tool_event_count,
          })),
          neighbors: trace.neighbors.map(m => ({
            id: m.id, title: m.title, type: m.memory_type,
            date: m.last_turn_at?.slice(0, 10),
          })),
        }, null, 2),
      }],
    };
  }

  if (name === 'topics') {
    const { repo, limit } = args as { repo?: string; limit?: number };
    const topics = db.getActiveTopics(repo, limit ?? 20);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          topics: topics.map(t => ({
            id: t.id, label: t.canonical_label,
            summary: t.summary, unresolved: t.unresolved_summary,
            memory_count: t.memory_count, last_active: t.last_active_at?.slice(0, 10),
          })),
        }, null, 2),
      }],
    };
  }

  if (name === 'pin') {
    const { memory_id, pinned } = args as { memory_id: number; pinned?: boolean };
    db.pinMemory(memory_id, pinned ?? true);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, memory_id, pinned: pinned ?? true }) }],
    };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  startMcpServer();
}
