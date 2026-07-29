import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../config';
import { MemoryDB, computeScopeKey } from '../db';
import type { Observation } from '../db/types';
import { prewarmEmbeddingModel } from '../embedding';
import { logError } from '../logger';
import { PACKAGE_VERSION } from '../version';
import { hybridSearchObservations } from './observation-search';
import { MissingSearchScopeError, resolveScopeKey } from './mcp-scope';

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
  { name: 'kiro-mem', version: PACKAGE_VERSION },
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
      outOfScope:
        'belongs to another workspace. Pass repo/cwd for that workspace, or all_scopes=true, to read it.',
      budgetExhausted:
        'omitted to stay within the response budget. Request these IDs in a separate call.',
      pinOutOfScope:
        'belongs to another workspace. pin only applies to the current workspace, because a pinned observation is injected into its own workspace context.',
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
      outOfScope:
        '属于其他 workspace。要读取它，请传入该 workspace 的 repo/cwd，或设置 all_scopes=true。',
      budgetExhausted:
        '为控制响应体积被省略。请在单独一次调用里获取这些 ID。',
      pinOutOfScope:
        '属于其他 workspace。pin 只作用于当前 workspace，因为置顶的观察只会注入它自身 workspace 的上下文。',
    };

function compactCard(o: Observation & { match_source?: string; semantic_score?: number | null }) {
  return {
    id: o.id,
    title: o.title,
    type: o.memory_type,
    date: o.turn_stopped_at?.slice(0, 10),
    // Source-turn identity travels with every card, not just with
    // get_observations: a timeline is only auditable if each entry can be traced
    // back to the turn it was projected from.
    turn_id: o.turn_id,
    turn_seq: o.turn_seq,
    files: safeArr(o.files_touched_json),
    is_pinned: !!o.is_pinned,
    ...(o.match_source ? { match_source: o.match_source } : {}),
    ...(o.semantic_score != null ? { semantic_score: Number(o.semantic_score.toFixed(3)) } : {}),
    has_next_steps: !!(o.next_steps && o.next_steps.trim()),
    confidence: o.confidence_score,
  };
}

// --- get_observations response budget (P1-3) ---
//
// The injected bootstrap index is byte-budgeted, but the PULL side was not, so
// a single `get_observations` call could put far more text into the agent's
// context than the whole injection budget allows — which makes progressive
// disclosure decorative rather than real. Three bounds, all reported when hit:
// per prose field, per array field, and one total response budget.

/** Per-field character cap for the long prose fields. */
const DETAIL_FIELD_CHARS = 1500;
/** Array fields (evidence, files, concepts): item count and per-item length. */
const DETAIL_ARRAY_ITEMS = 20;
const DETAIL_ARRAY_ITEM_CHARS = 300;
/** Total serialized response budget. Kept well under a typical context slice. */
const DETAIL_RESPONSE_BYTES = 32 * 1024;

function clipDetail(s: string | null | undefined, max = DETAIL_FIELD_CHARS): string | null {
  if (s == null) return null;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function clipDetailArray(items: string[]): string[] {
  return items.slice(0, DETAIL_ARRAY_ITEMS).map((s) =>
    s.length > DETAIL_ARRAY_ITEM_CHARS ? s.slice(0, DETAIL_ARRAY_ITEM_CHARS) + '…' : s,
  );
}

/** Names the fields that were shortened, so the agent knows it has a partial read. */
function truncatedFields(o: Observation): string[] {
  const cut: string[] = [];
  for (const [name, value] of [
    ['summary', o.summary], ['request', o.request], ['outcome', o.outcome],
    ['learned', o.learned], ['next_steps', o.next_steps],
  ] as const) {
    if (value && value.length > DETAIL_FIELD_CHARS) cut.push(name);
  }
  for (const [name, json] of [
    ['files', o.files_touched_json], ['concepts', o.concepts_json], ['evidence', o.evidence_json],
  ] as const) {
    const arr = safeArr(json);
    if (arr.length > DETAIL_ARRAY_ITEMS || arr.some((s) => s.length > DETAIL_ARRAY_ITEM_CHARS)) {
      cut.push(name);
    }
  }
  return cut;
}

function safeArr(json: string): string[] {
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function boundedInteger(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
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
          days: { type: 'integer', minimum: 1, maximum: 3650, description: T.daysDescription, default: 90 },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: T.limitDescription, default: 20 },
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
          observation_id: { type: 'integer', minimum: 1, description: T.obsIdDescription },
          before: { type: 'integer', minimum: 0, maximum: 20, description: T.beforeDescription, default: 3 },
          after: { type: 'integer', minimum: 0, maximum: 20, description: T.afterDescription, default: 3 },
          mode: { type: 'string', enum: ['scope', 'session'], description: T.modeDescription, default: 'scope' },
          repo: { type: 'string', description: T.repoDescription },
          cwd: { type: 'string', description: T.cwdDescription },
          all_scopes: { type: 'boolean', description: T.allScopesDescription, default: false },
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
          ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: T.idsDescription, minItems: 1, maxItems: 20 },
          repo: { type: 'string', description: T.repoDescription },
          cwd: { type: 'string', description: T.cwdDescription },
          all_scopes: { type: 'boolean', description: T.allScopesDescription, default: false },
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
          observation_id: { type: 'integer', minimum: 1, description: T.obsIdDescription },
          pinned: { type: 'boolean', description: T.pinnedDescription, default: true },
        },
        required: ['observation_id'],
      },
    },
  ],
}));

const MEMORY_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'] as const;

interface ScopeInput { repo?: unknown; cwd?: unknown; all_scopes?: unknown }

/**
 * Resolve the caller's authorized scope for ANY tool, not just `search`.
 *
 * Every tool that reaches an Observation — by query or by ID — must go through
 * this. `get_observations`, `timeline` and `pin` address rows by global ID, so
 * skipping it means an ID is enough to read (or, for `pin`, mutate) another
 * workspace's memory. `allowAllScopes: false` is used by `pin`, which has no
 * legitimate cross-workspace use: a pinned Observation is only ever injected
 * into its own workspace (design §14.3).
 */
function resolveToolScope(
  a: ScopeInput,
  opts?: { allowAllScopes?: boolean },
): { ok: true; scopeKey: string | undefined } | { ok: false; error: ReturnType<typeof toolError> } {
  if (a.repo !== undefined && typeof a.repo !== 'string') {
    return { ok: false, error: toolError('repo must be a string') };
  }
  if (a.cwd !== undefined && typeof a.cwd !== 'string') {
    return { ok: false, error: toolError('cwd must be a string') };
  }
  if (a.all_scopes !== undefined && typeof a.all_scopes !== 'boolean') {
    return { ok: false, error: toolError('all_scopes must be a boolean') };
  }
  const allowAllScopes = opts?.allowAllScopes ?? true;
  if (a.all_scopes === true && !allowAllScopes) {
    return { ok: false, error: toolError('all_scopes is not supported by this tool') };
  }
  try {
    const scopeKey = resolveScopeKey(
      {
        repo: a.repo as string | undefined,
        cwd: a.cwd as string | undefined,
        all_scopes: allowAllScopes ? (a.all_scopes as boolean | undefined) : false,
      },
      { sessionScope: sessionScopeKey },
    );
    return { ok: true, scopeKey };
  } catch (error) {
    if (error instanceof MissingSearchScopeError) {
      return { ok: false, error: { content: [{ type: 'text', text: T.missingScope }], isError: true } };
    }
    throw error;
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'search') {
    const a = (args ?? {}) as { query?: unknown; type?: unknown; repo?: unknown; cwd?: unknown; days?: unknown; limit?: unknown; all_scopes?: unknown };
    if (typeof a.query !== 'string') return toolError('search.query must be a string');
    if (a.type !== undefined && !MEMORY_TYPES.includes(a.type as (typeof MEMORY_TYPES)[number])) {
      return toolError(`search.type must be one of: ${MEMORY_TYPES.join(', ')}`);
    }
    const days = boundedInteger(a.days, 90, 1, 3650);
    const limit = boundedInteger(a.limit, 20, 1, 50);
    if (days == null) return toolError('search.days must be an integer between 1 and 3650');
    if (limit == null) return toolError('search.limit must be an integer between 1 and 50');

    const scope = resolveToolScope(a);
    if (!scope.ok) return scope.error;
    const scopeKey = scope.scopeKey;
    const startedAt = Date.now();
    let degraded = false;
    const results = await hybridSearchObservations(db, a.query, {
      scopeKey, type: a.type as string | undefined, days, limit,
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
    const a = (args ?? {}) as { observation_id?: unknown; before?: unknown; after?: unknown; mode?: unknown; repo?: unknown; cwd?: unknown; all_scopes?: unknown };
    const observationId = boundedInteger(a.observation_id, null, 1, Number.MAX_SAFE_INTEGER);
    const before = boundedInteger(a.before, 3, 0, 20);
    const after = boundedInteger(a.after, 3, 0, 20);
    if (observationId == null) return toolError('timeline.observation_id must be a positive integer');
    if (before == null || after == null) return toolError('timeline.before/after must be integers between 0 and 20');
    if (a.mode !== undefined && a.mode !== 'scope' && a.mode !== 'session') {
      return toolError("timeline.mode must be 'scope' or 'session'");
    }
    const mode = (a.mode as 'scope' | 'session' | undefined) ?? 'scope';

    // The anchor is addressed by global ID, so authorize it before reading:
    // otherwise a foreign ID leaks that Observation plus its neighbours.
    const scope = resolveToolScope(a);
    if (!scope.ok) return scope.error;
    const anchor = db.getObservation(observationId);
    if (!anchor) return toolError(`Observation #${observationId} does not exist`);
    if (scope.scopeKey && anchor.scope_key !== scope.scopeKey) {
      return toolError(`Observation #${observationId} ${T.outOfScope}`);
    }

    const tl = db.observationTimeline(observationId, { before, after, mode });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          anchor: tl.anchor ? compactCard(tl.anchor) : null,
          before: tl.before.map(compactCard),
          after: tl.after.map(compactCard),
          mode,
        }, null, 2),
      }],
    };
  }

  if (name === 'get_observations') {
    const a = (args ?? {}) as { ids?: unknown; repo?: unknown; cwd?: unknown; all_scopes?: unknown };
    const { ids } = a;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
        !ids.every((id) => typeof id === 'number' && Number.isInteger(id) && id > 0)) {
      return toolError('get_observations.ids must contain 1 to 20 positive integer IDs');
    }
    const scope = resolveToolScope(a);
    if (!scope.ok) return scope.error;
    const observations = db.getObservationsByIds(ids as number[], { scopeKey: scope.scopeKey });
    // Report IDs the caller is not authorized for (or that do not exist)
    // explicitly, so a scope denial never looks like "no such memory".
    const returned = new Set(observations.map((o) => o.id));
    const unavailable = (ids as number[]).filter((id) => !returned.has(id));

    // Field-level caps first, then a running total: an over-budget call returns
    // fewer FULL records rather than many silently mangled ones.
    const details: unknown[] = [];
    const omitted: number[] = [];
    let usedBytes = 0;
    for (const o of observations) {
      const turn = db.getTurn(o.turn_id);
      const cut = truncatedFields(o);
      const record = {
        id: o.id, title: o.title,
        summary: clipDetail(o.summary),
        request: clipDetail(o.request),
        outcome: clipDetail(o.outcome),
        learned: clipDetail(o.learned),
        next_steps: clipDetail(o.next_steps),
        type: o.memory_type, quality: o.quality,
        files: clipDetailArray(safeArr(o.files_touched_json)),
        concepts: clipDetailArray(safeArr(o.concepts_json)),
        evidence: clipDetailArray(safeArr(o.evidence_json)),
        is_pinned: !!o.is_pinned,
        importance: o.importance_score, confidence: o.confidence_score, unresolved: o.unresolved_score,
        turn_started_at: o.turn_started_at, turn_stopped_at: o.turn_stopped_at,
        source_turn: turn ? {
          turn_id: turn.id, seq: turn.seq,
          prompt: turn.prompt_text?.slice(0, 200) ?? null,
          started_at: turn.started_at, stopped_at: turn.stopped_at,
          tool_event_count: turn.tool_event_count,
        } : null,
        ...(cut.length ? { truncated_fields: cut } : {}),
      };
      const size = Buffer.byteLength(JSON.stringify(record), 'utf-8');
      // Always return at least one record, otherwise a single oversized
      // Observation would make the tool useless rather than merely bounded.
      if (details.length > 0 && usedBytes + size > DETAIL_RESPONSE_BYTES) {
        omitted.push(o.id);
        continue;
      }
      usedBytes += size;
      details.push(record);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          observations: details,
          ...(unavailable.length ? { unavailable, unavailable_reason: T.outOfScope } : {}),
          ...(omitted.length ? { omitted, omitted_reason: T.budgetExhausted } : {}),
        }, null, 2),
      }],
    };
  }

  if (name === 'pin') {
    const a = (args ?? {}) as { observation_id?: unknown; pinned?: unknown; repo?: unknown; cwd?: unknown; all_scopes?: unknown };
    const observationId = boundedInteger(a.observation_id, null, 1, Number.MAX_SAFE_INTEGER);
    if (observationId == null) return toolError('pin.observation_id must be a positive integer');
    if (a.pinned !== undefined && typeof a.pinned !== 'boolean') {
      return toolError('pin.pinned must be a boolean');
    }
    // pin MUTATES another workspace's injected context if left unscoped, so it
    // never accepts all_scopes — the caller must be in the owning workspace.
    const scope = resolveToolScope(a, { allowAllScopes: false });
    if (!scope.ok) return scope.error;
    const observation = db.getObservation(observationId);
    if (!observation) return toolError(`Observation #${observationId} does not exist`);
    if (scope.scopeKey && observation.scope_key !== scope.scopeKey) {
      return toolError(`Observation #${observationId} ${T.pinOutOfScope}`);
    }
    const pinned = (a.pinned as boolean | undefined) ?? true;
    db.pinObservation(observationId, pinned);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, observation_id: observationId, pinned }) }],
    };
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
});

export async function startMcpServer() {
  if (process.env.KIRO_MEMORY_DISABLE_EMBEDDING_PREWARM !== '1') {
    void prewarmEmbeddingModel().catch((error) => {
      logError('embedding/prewarm', {
        error_type: error instanceof Error ? error.name : 'UnknownError',
      });
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  startMcpServer();
}
