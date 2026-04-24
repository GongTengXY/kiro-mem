import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryDB } from '../db';

const db = new MemoryDB();

const server = new Server(
  { name: 'kiro-mem', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description:
        '搜索历史会话记忆。返回匹配的 observation 摘要列表（含 ID），用于快速定位相关历史。支持按类型、时间过滤。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          type: {
            type: 'string',
            enum: [
              'decision',
              'bugfix',
              'feature',
              'refactor',
              'discovery',
              'change',
            ],
            description: '按类型过滤',
          },
          repo: { type: 'string', description: '按 git repo 过滤' },
          days: { type: 'number', description: '最近 N 天内', default: 30 },
          limit: { type: 'number', description: '最大返回数', default: 20 },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_observations',
      description:
        '按 ID 批量获取 observation 完整内容。先用 search 找到相关 ID，再用此工具获取详情。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          ids: {
            type: 'array',
            items: { type: 'number' },
            description: 'observation ID 列表',
            maxItems: 20,
          },
        },
        required: ['ids'],
      },
    },
    {
      name: 'timeline',
      description:
        '获取某个 observation 前后的时间线，用于理解事件上下文。返回同一会话中相邻的 observations。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          observation_id: { type: 'number', description: '中心 observation ID' },
          before: { type: 'number', description: '向前取 N 条', default: 5 },
          after: { type: 'number', description: '向后取 N 条', default: 5 },
        },
        required: ['observation_id'],
      },
    },
    {
      name: 'pin',
      description:
        '标记/取消标记某个 observation 为高价值记忆。被 pin 的记忆会在后续会话中优先注入。',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'observation ID' },
          pinned: { type: 'boolean', description: 'true=标记, false=取消', default: true },
        },
        required: ['id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search') {
    const { query, type, repo, days, limit } = args as {
      query: string;
      type?: string;
      repo?: string;
      days?: number;
      limit?: number;
    };
    const results = await db.searchObservations(query, { type, repo, days, limit });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              results: results.map((r) => ({
                id: r.id,
                title: r.title,
                type: r.obs_type,
                date: r.created_at?.slice(0, 10),
                session_id: r.session_id,
                match_source: r.match_source,
                semantic_score: r.semantic_score != null ? Math.round(r.semantic_score * 100) / 100 : null,
              })),
              total: results.length,
              hint: '使用 get_observations 获取完整详情',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'get_observations') {
    const { ids } = args as { ids: number[] };
    const observations = db.getObservationsByIds(ids);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              observations: observations.map((o) => ({
                id: o.id,
                title: o.title,
                narrative: o.narrative,
                facts: o.facts ? JSON.parse(o.facts) : [],
                concepts: o.concepts ? JSON.parse(o.concepts) : [],
                type: o.obs_type,
                files: o.files ? JSON.parse(o.files) : [],
                created_at: o.created_at,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'timeline') {
    const { observation_id, before, after } = args as {
      observation_id: number;
      before?: number;
      after?: number;
    };
    const observations = db.getTimeline(observation_id, before ?? 5, after ?? 5);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              center_id: observation_id,
              observations: observations.map((o) => ({
                id: o.id,
                title: o.title,
                type: o.obs_type,
                date: o.created_at?.slice(0, 10),
                is_center: o.id === observation_id,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'pin') {
    const { id, pinned } = args as { id: number; pinned?: boolean };
    db.pinObservation(id, pinned ?? true);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, id, pinned: pinned ?? true }),
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  startMcpServer();
}
