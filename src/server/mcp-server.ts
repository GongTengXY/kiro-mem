import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../config';
import { MemoryDB, computeScopeKey } from '../db';
import type { Observation } from '../db/types';
import { hybridSearchObservations } from './observation-search';
import { MissingSearchScopeError, resolveScopeKey } from './mcp-scope';

const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf-8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim() ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const db = new MemoryDB();
const config = loadConfig();
const isEnglish = config.language === 'en';

/**
 * Resolve the default search scope from the active Kiro session. Kiro injects
 * KIRO_SESSION_ID into this MCP server process; the worker records that
 * session's real workspace (cwd/repo) in session_refs via the userPromptSubmit
 * hook. Using it makes the default scope authoritative instead of relying on
 * where this process was launched. Returns undefined when no session is known;
 * a scope-less search then fails closed and asks for repo/cwd.
 */
function sessionScopeKey(): string | undefined {
  const sessionId = process.env.KIRO_SESSION_ID;
  if (!sessionId) return undefined;
  const ref = db.getSessionRef(sessionId);
  if (!ref) return undefined;
  return computeScopeKey(ref.repo, ref.cwd);
}

const server = new Server(
  { name: 'kiro-mem', version: PKG_VERSION },
  { capabilities: { tools: {} } },
);

const T = isEnglish
  ? {
      searchDescription:
        'Search prior atomic observations (one per closed turn). Returns a compact index; scoped to the current workspace unless repo/cwd is given.',
      queryDescription: 'Search keywords',
      typeDescription: 'Filter by memory type',
      repoDescription: 'Filter by git repo root (explicit scope)',
      cwdDescription: 'Current working directory — scopes results to this workspace when no repo is given',
      daysDescription: 'Within the last N days',
      limitDescription: 'Maximum number of results',
      allScopesDescription:
        'Search across all workspaces; set true when the user asks for other projects, cross-project, all-project, or global history (default false)',
      timelineDescription:
        'Given an observation, show the temporally adjacent observations from its source-turn timeline (same workspace scope by default, or same session).',
      obsIdDescription: 'Observation ID (anchor)',
      beforeDescription: 'Number of earlier neighbors',
      afterDescription: 'Number of later neighbors',
      modeDescription: 'scope (same workspace, default) or session (same conversation only)',
      getObsDescription: 'Fetch full observation details by ID, including source-turn metadata.',
      idsDescription: 'List of observation IDs',
      pinDescription: 'Mark or unmark an observation as high-value for later context.',
      pinnedDescription: 'true = pin, false = unpin',
      hint: 'Use get_observations to fetch full details; timeline to see surrounding work',
      missingScope:
        'Current workspace could not be resolved. Retry with repo or cwd, or set all_scopes=true explicitly.',
    }
  : {
      searchDescription:
        '搜索历史原子观察（每个 closed turn 一条）。返回紧凑索引；未传 repo/cwd 时按当前 workspace 隔离。',
      queryDescription: '搜索关键词',
      typeDescription: '按类型过滤',
      repoDescription: '按 git repo 根过滤（显式 scope）',
      cwdDescription: '当前工作目录——未传 repo 时按此 workspace 隔离结果',
      daysDescription: '最近 N 天内',
      limitDescription: '最大返回数',
      allScopesDescription:
        '跨所有 workspace 搜索；当用户要求搜索其他项目、跨项目、所有项目或全局历史时设为 true（默认 false）',
      timelineDescription:
        '给定一条观察，按其 source-turn 真实时间线返回前后相邻的观察（默认同 workspace scope，或同 session）。',
      obsIdDescription: '观察 ID（锚点）',
      beforeDescription: '向前取 N 条相邻',
      afterDescription: '向后取 N 条相邻',
      modeDescription: 'scope（同 workspace，默认）或 session（仅同一会话）',
      getObsDescription: '按 ID 获取观察完整详情，含来源 turn 元数据。',
      idsDescription: '观察 ID 列表',
      pinDescription: '标记/取消标记某条观察为高价值，供后续上下文优先使用。',
      pinnedDescription: 'true=标记, false=取消',
      hint: '用 get_observations 获取完整详情；用 timeline 查看前后工作',
      missingScope:
        '无法确定当前 workspace。请传入 repo 或 cwd；只有明确需要全局检索时才设置 all_scopes=true。',
    };

function compactCard(o: Observation & { match_source?: string; semantic_score?: number | null }) {
  return {
    id: o.id,
    title: o.title,
    type: o.memory_type,
    date: o.turn_stopped_at?.slice(0, 10),
    files: safeArr(o.files_touched_json),
    is_pinned: !!o.is_pinned,
    ...(o.match_source ? { match_source: o.match_source } : {}),
    ...(o.semantic_score != null ? { semantic_score: Number(o.semantic_score.toFixed(3)) } : {}),
    has_next_steps: !!(o.next_steps && o.next_steps.trim()),
    confidence: o.confidence_score,
  };
}

function safeArr(json: string): string[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: T.searchDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: T.queryDescription },
          type: { type: 'string', enum: ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'], description: T.typeDescription },
          repo: { type: 'string', description: T.repoDescription },
          cwd: { type: 'string', description: T.cwdDescription },
          days: { type: 'number', description: T.daysDescription, default: 90 },
          limit: { type: 'number', description: T.limitDescription, default: 20 },
          all_scopes: { type: 'boolean', description: T.allScopesDescription, default: false },
        },
        required: ['query'],
      },
    },
    {
      name: 'timeline',
      description: T.timelineDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          observation_id: { type: 'number', description: T.obsIdDescription },
          before: { type: 'number', description: T.beforeDescription, default: 3 },
          after: { type: 'number', description: T.afterDescription, default: 3 },
          mode: { type: 'string', enum: ['scope', 'session'], description: T.modeDescription, default: 'scope' },
        },
        required: ['observation_id'],
      },
    },
    {
      name: 'get_observations',
      description: T.getObsDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          ids: { type: 'array', items: { type: 'number' }, description: T.idsDescription, maxItems: 20 },
        },
        required: ['ids'],
      },
    },
    {
      name: 'pin',
      description: T.pinDescription,
      inputSchema: {
        type: 'object' as const,
        properties: {
          observation_id: { type: 'number', description: T.obsIdDescription },
          pinned: { type: 'boolean', description: T.pinnedDescription, default: true },
        },
        required: ['observation_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search') {
    const a = args as { query: string; type?: string; repo?: string; cwd?: string; days?: number; limit?: number; all_scopes?: boolean };
    let scopeKey: string | undefined;
    try {
      scopeKey = resolveScopeKey(a, { sessionScope: sessionScopeKey });
    } catch (error) {
      if (error instanceof MissingSearchScopeError) {
        return {
          content: [{ type: 'text', text: T.missingScope }],
          isError: true,
        };
      }
      throw error;
    }
    const startedAt = Date.now();
    let degraded = false;
    const results = await hybridSearchObservations(db, a.query, {
      scopeKey, type: a.type, days: a.days, limit: a.limit,
    }, { onDegrade: () => { degraded = true; } });
    db.recordSearchMetric({ latencyMs: Date.now() - startedAt, degraded });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          results: results.map(compactCard),
          total: results.length,
          hint: T.hint,
        }, null, 2),
      }],
    };
  }

  if (name === 'timeline') {
    const a = args as { observation_id: number; before?: number; after?: number; mode?: 'scope' | 'session' };
    const tl = db.observationTimeline(a.observation_id, { before: a.before ?? 3, after: a.after ?? 3, mode: a.mode ?? 'scope' });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          anchor: tl.anchor ? compactCard(tl.anchor) : null,
          before: tl.before.map(compactCard),
          after: tl.after.map(compactCard),
          mode: a.mode ?? 'scope',
        }, null, 2),
      }],
    };
  }

  if (name === 'get_observations') {
    const { ids } = args as { ids: number[] };
    const observations = db.getObservationsByIds(ids);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          observations: observations.map((o) => {
            const turn = db.getTurn(o.turn_id);
            return {
              id: o.id, title: o.title, summary: o.summary,
              request: o.request, outcome: o.outcome, learned: o.learned, next_steps: o.next_steps,
              type: o.memory_type, quality: o.quality,
              files: safeArr(o.files_touched_json),
              concepts: safeArr(o.concepts_json),
              evidence: safeArr(o.evidence_json),
              is_pinned: !!o.is_pinned,
              importance: o.importance_score, confidence: o.confidence_score, unresolved: o.unresolved_score,
              turn_started_at: o.turn_started_at, turn_stopped_at: o.turn_stopped_at,
              source_turn: turn ? {
                turn_id: turn.id, seq: turn.seq,
                prompt: turn.prompt_text?.slice(0, 200) ?? null,
                started_at: turn.started_at, stopped_at: turn.stopped_at,
                tool_event_count: turn.tool_event_count,
              } : null,
            };
          }),
        }, null, 2),
      }],
    };
  }

  if (name === 'pin') {
    const { observation_id, pinned } = args as { observation_id: number; pinned?: boolean };
    db.pinObservation(observation_id, pinned ?? true);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, observation_id, pinned: pinned ?? true }) }],
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
