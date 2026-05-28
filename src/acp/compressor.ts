/**
 * ACP-backed MemoryCompressor implementation.
 * Uses ACPPool to send compression prompts through Kiro CLI ACP.
 */

import { ACPPool } from './pool';
import type { ACPPoolOptions } from './types';
import type {
  MemoryCompressor,
  TurnSummaryResult,
  NormalizeTopicResult,
  TopicSummaryResult,
} from '../compressor';
import { logError } from '../logger';

const TURN_SUMMARY_FALLBACK: TurnSummaryResult = {
  title: '', summary: '', request: '', investigated: '', learned: '',
  completed: '', next_steps: '', memory_type: 'change', files_touched: [],
  concepts: [], topic_candidate: '', importance_score: 0.5,
  confidence_score: 0, unresolved_score: 0,
};

export interface ACPCompressorOptions extends ACPPoolOptions {
  maxRetries?: number;
}

export class ACPCompressor implements MemoryCompressor {
  private pool: ACPPool;
  private maxRetries: number;

  constructor(opts: ACPCompressorOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 1;
    this.pool = new ACPPool(opts);
  }

  get stats() {
    return this.pool.stats;
  }

  async summarizeTurn(input: {
    prompt_text: string;
    artifacts: { tool_names: string[]; files_touched: string[]; commands: string[]; error_signals: string[] };
    event_digest?: string;
  }): Promise<TurnSummaryResult> {
    const prompt = buildTurnSummaryPrompt(input);
    return this.runAndParse(prompt, 16384, TURN_SUMMARY_FALLBACK, 'summarizeTurn', TURN_SUMMARY_SCHEMA);
  }

  async normalizeTopic(input: {
    candidate: string;
    existing_topics: Array<{ canonical_label: string; aliases: string[] }>;
    memory_title: string;
  }): Promise<NormalizeTopicResult> {
    const prompt = buildNormalizeTopicPrompt(input);
    return this.runAndParse(prompt, 4096, {
      action: 'new', canonical_label: input.candidate.trim() || input.memory_title.slice(0, 40) || 'untitled', aliases: [],
    }, 'normalizeTopic', NORMALIZE_TOPIC_SCHEMA);
  }

  async summarizeTopic(input: {
    topic_label: string;
    memories: Array<{ title: string; summary: string; learned?: string; next_steps?: string }>;
  }): Promise<TopicSummaryResult> {
    const prompt = buildSummarizeTopicPrompt(input);
    return this.runAndParse(prompt, 8192, {
      summary: '', unresolved_summary: '',
    }, 'summarizeTopic', SUMMARIZE_TOPIC_SCHEMA);
  }

  async mergeTurnMemories(input: {
    memories: Array<{ title: string; summary: string; learned?: string; next_steps?: string }>;
    topic_label: string;
  }): Promise<TurnSummaryResult> {
    const prompt = buildMergePrompt(input);
    return this.runAndParse(prompt, 16384, {
      ...TURN_SUMMARY_FALLBACK, topic_candidate: input.topic_label,
    }, 'mergeTurnMemories', TURN_SUMMARY_SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  // --- Internal ---

  private async runWithRetry(prompt: string, maxBytes: number): Promise<string> {
    const fullPrompt = SYSTEM_PROMPT + '\n\n' + prompt;
    const result = await this.pool.run(fullPrompt, { maxOutputBytes: maxBytes });
    return result.text;
  }

  /**
   * Run prompt, parse JSON, validate schema. On failure, send a repair prompt and retry.
   * Falls back to `fallback` if all retries exhausted.
   */
  private async runAndParse<T>(
    prompt: string,
    maxBytes: number,
    fallback: T,
    context: string,
    schema: string,
  ): Promise<T> {
    const raw = await this.runWithRetry(prompt, maxBytes);
    const first = tryParseAndValidate<T>(raw, fallback, context);
    if (first.ok) return first.value;

    // Repair retry
    for (let i = 0; i < this.maxRetries; i++) {
      const repairPrompt = buildRepairPrompt(schema, raw, first.error);
      const repairRaw = await this.runWithRetry(repairPrompt, maxBytes);
      const retry = tryParseAndValidate<T>(repairRaw, fallback, context);
      if (retry.ok) return retry.value;
    }

    logError(`acp-compressor/repair-exhausted/${context}`, raw.slice(0, 500));
    return fallback;
  }
}

// --- System prompt ---

const SYSTEM_PROMPT = `You are an internal JSON transformation agent for kiro-mem.
Rules:
- Return valid JSON only.
- Do not use markdown code fences.
- Do not explain your answer.
- Do not call tools.
- Follow the schema in the user message exactly.
- If information is missing, use empty strings, empty arrays, or conservative low scores.
- Never invent file paths or completed work.
- Keep output concise.`;

// --- Parse + validate ---

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; value: T };

function tryParseAndValidate<T>(raw: string, fallback: T, context: string): ParseResult<T> {
  try {
    const cleaned = raw.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    const validated = validateSchema(parsed, fallback, context);
    // For normalizeTopic, reject empty canonical_label as invalid
    if (context === 'normalizeTopic' && !(validated as any).canonical_label?.trim()) {
      return { ok: false, error: 'empty canonical_label', value: fallback };
    }
    return { ok: true, value: validated };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logError(`acp-compressor/parse/${context}`, JSON.stringify({ error: msg, raw: raw.slice(0, 500) }));
    return { ok: false, error: msg, value: fallback };
  }
}

function buildRepairPrompt(schema: string, invalidOutput: string, error: string): string {
  return `The previous output was invalid JSON for this schema.
Return only corrected JSON. Do not include markdown.

Schema: ${schema}
Invalid output: ${invalidOutput.slice(0, 1000)}
Validation error: ${error}`;
}

// --- Schema descriptions for repair prompts ---

const TURN_SUMMARY_SCHEMA = '{"title":"string","summary":"string","request":"string","investigated":"string","learned":"string","completed":"string","next_steps":"string","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["string"],"concepts":["string"],"topic_candidate":"string","importance_score":0-1,"confidence_score":0-1,"unresolved_score":0-1}';

const NORMALIZE_TOPIC_SCHEMA = '{"action":"existing|new","canonical_label":"string (non-empty)","aliases":["string"]}';

const SUMMARIZE_TOPIC_SCHEMA = '{"summary":"string","unresolved_summary":"string"}';

/** Validate and coerce parsed JSON to match expected schema. */
function validateSchema<T>(parsed: any, fallback: T, context: string): T {
  if (!parsed || typeof parsed !== 'object') return fallback;

  if (context === 'summarizeTurn' || context === 'mergeTurnMemories') {
    return {
      title: ensureString(parsed.title, (fallback as any).title ?? ''),
      summary: ensureString(parsed.summary, ''),
      request: ensureString(parsed.request, ''),
      investigated: ensureString(parsed.investigated, ''),
      learned: ensureString(parsed.learned, ''),
      completed: ensureString(parsed.completed, ''),
      next_steps: ensureString(parsed.next_steps, ''),
      memory_type: ensureEnum(parsed.memory_type, ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'], 'change'),
      files_touched: ensureStringArray(parsed.files_touched),
      concepts: ensureStringArray(parsed.concepts),
      topic_candidate: ensureString(parsed.topic_candidate, (fallback as any).topic_candidate ?? ''),
      importance_score: clampScore(parsed.importance_score),
      confidence_score: clampScore(parsed.confidence_score),
      unresolved_score: clampScore(parsed.unresolved_score),
    } as T;
  }

  if (context === 'normalizeTopic') {
    const label = ensureString(parsed.canonical_label, (fallback as any).canonical_label ?? '');
    if (!label.trim()) return fallback; // Reject empty label
    return {
      action: ensureEnum(parsed.action, ['existing', 'new'], 'new'),
      canonical_label: label,
      aliases: ensureStringArray(parsed.aliases),
    } as T;
  }

  if (context === 'summarizeTopic') {
    return {
      summary: ensureString(parsed.summary, ''),
      unresolved_summary: ensureString(parsed.unresolved_summary, ''),
    } as T;
  }

  return parsed as T;
}

function ensureString(val: unknown, fallback: string): string {
  return typeof val === 'string' ? val : fallback;
}

function ensureStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((x): x is string => typeof x === 'string');
}

function ensureEnum<T extends string>(val: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(val as T) ? (val as T) : fallback;
}

function clampScore(val: unknown): number {
  const n = typeof val === 'number' ? val : 0;
  return Math.max(0, Math.min(1, n));
}

// --- Prompt builders ---
//
// Body language is intentionally Chinese to match upstream (private fork)
// behavior that has been validated against multiple Kiro models. Memory-level
// language follows the user's actual prompt language (the model copies it
// into title/summary/etc.), so the body language here only affects the
// model's "thinking" framing, not what users see in their memory entries.

function buildTurnSummaryPrompt(input: {
  prompt_text: string;
  artifacts: { tool_names: string[]; files_touched: string[]; commands: string[]; error_signals: string[] };
  event_digest?: string;
}): string {
  const a = input.artifacts;
  const tools = a.tool_names.join(', ') || 'none';
  const files = a.files_touched.slice(0, 10).join(', ') || 'none';
  const cmds = a.commands.slice(0, 5).join('; ') || 'none';
  const errors = a.error_signals.slice(0, 3).join('; ') || 'none';
  const digest = input.event_digest ? `\n- Event digest: ${input.event_digest}` : '';

  return `## 本轮输入
- 用户 Prompt: ${input.prompt_text.slice(0, 2000)}
- 使用工具: ${tools}
- 涉及文件: ${files}
- 命令: ${cmds}
- 错误: ${errors}${digest}

## 输出要求
返回 JSON：
{"title":"一句话标题(<40字)","summary":"2-4句摘要","request":"用户要什么","investigated":"探索了什么","learned":"关键发现/决策","completed":"完成了什么","next_steps":"后续事项","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["文件路径"],"concepts":["标签,中英文都要"],"topic_candidate":"规范化主题","importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`;
}

function buildNormalizeTopicPrompt(input: {
  candidate: string;
  existing_topics: Array<{ canonical_label: string; aliases: string[] }>;
  memory_title: string;
}): string {
  const existingLines = input.existing_topics
    .slice(0, 30)
    .map((t) => {
      const aliasList = t.aliases.filter((a) => a && a !== t.canonical_label).slice(0, 8);
      return aliasList.length
        ? `- ${t.canonical_label} (aliases: ${aliasList.join(', ')})`
        : `- ${t.canonical_label}`;
    })
    .join('\n');
  const existing = existingLines || '（无）';

  return `候选主题: "${input.candidate}"
记忆标题: "${input.memory_title}"
已有主题（含已知别名）：
${existing}

如果候选与已有主题等价——无论匹配 canonical label 还是任一列出的 alias，语义相同只是措辞不同——返回：
{"action":"existing","canonical_label":"<已有 canonical label>","aliases":["${input.candidate}"]}
否则返回：
{"action":"new","canonical_label":"${input.candidate}","aliases":[]}`;
}

function buildSummarizeTopicPrompt(input: {
  topic_label: string;
  memories: Array<{ title: string; summary: string; learned?: string; next_steps?: string }>;
}): string {
  const items = input.memories
    .slice(0, 20)
    .map((m, i) => {
      const learned = m.learned ? ` | Learned: ${m.learned.slice(0, 120)}` : '';
      const next = m.next_steps ? ` | Next: ${m.next_steps.slice(0, 120)}` : '';
      return `${i + 1}. ${m.title}: ${m.summary.slice(0, 160)}${learned}${next}`;
    })
    .join('\n');

  return `主题: ${input.topic_label}

该主题下最近的 active 记忆（最新在前）:
${items}

请产出紧凑的主题进展对象。
- "summary": 2-3 句话概括该主题整体进展。
- "unresolved_summary": 单行不超过 80 字，列出当前仍未完成/被阻塞的关键事项；若全部完成返回空串。

只返回 JSON:
{"summary":"...","unresolved_summary":"..."}`;
}

function buildMergePrompt(input: {
  memories: Array<{ title: string; summary: string; learned?: string; next_steps?: string }>;
  topic_label: string;
}): string {
  const items = input.memories.map((m, i) =>
    `${i + 1}. ${m.title}: ${m.summary}${m.learned ? ' | Learned: ' + m.learned : ''}${m.next_steps ? ' | Next: ' + m.next_steps : ''}`,
  ).join('\n');

  return `主题: ${input.topic_label}\n\n待合并的 turn 记忆:\n${items}\n\n返回 JSON：\n{"title":"合并标题","summary":"3-5句完整摘要","request":"总体目标","investigated":"跨轮探索了什么","learned":"关键发现汇总","completed":"完成了什么","next_steps":"剩余事项","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":[],"concepts":[],"topic_candidate":"${input.topic_label}","importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`;
}
