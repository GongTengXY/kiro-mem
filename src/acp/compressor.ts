/**
 * ACP-backed MemoryCompressor implementation.
 * Uses ACPPool to send compression prompts through Kiro CLI ACP.
 */

import { ACPPool } from './pool';
import type { ACPPoolOptions } from './types';
import type { MemoryCompressor, ObservationSummaryResult } from '../compressor';
import { logError } from '../logger';

// An empty Observation result. When the model exhausts repair retries the job
// (summarize_turn) detects the empty title/summary and writes a
// quality='fallback' Observation composed from deterministic artifacts.
const OBSERVATION_SUMMARY_FALLBACK: ObservationSummaryResult = {
  title: '', summary: '', request: '', outcome: '', learned: '',
  next_steps: '', memory_type: 'change', files_touched: [], concepts: [],
  evidence: [], importance_score: 0, confidence_score: 0, unresolved_score: 0,
};

export interface ACPCompressorOptions extends ACPPoolOptions {
  maxRetries?: number;
}

export class ACPCompressor implements MemoryCompressor {
  private pool: ACPPool;
  private maxRetries: number;
  private _repairCount = 0;
  private _fallbackCount = 0;
  private onMetric: (kind: 'repair' | 'contamination') => void;

  constructor(opts: ACPCompressorOptions = {}) {
    this.maxRetries = opts.maxRetries ?? 1;
    this.onMetric = opts.onMetric ?? (() => {});
    this.pool = new ACPPool(opts);
  }

  get stats() {
    return {
      ...this.pool.stats,
      repairs: this._repairCount,
      parseFallbacks: this._fallbackCount,
    };
  }

  async summarizeObservation(input: {
    user_prompt: string;
    assistant_response: string;
    artifacts: {
      files_touched: string[];
      commands: string[];
      test_signals: string[];
      error_signals: string[];
      facts: string[];
    };
  }): Promise<ObservationSummaryResult> {
    const prompt = buildObservationSummaryPrompt(input);
    return this.runAndParse(prompt, 16384, OBSERVATION_SUMMARY_FALLBACK, 'summarizeObservation', OBSERVATION_SUMMARY_SCHEMA);
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

    for (let i = 0; i < this.maxRetries; i++) {
      this._repairCount++;
      this.onMetric('repair');
      const repairPrompt = buildRepairPrompt(schema, raw, first.error);
      const repairRaw = await this.runWithRetry(repairPrompt, maxBytes);
      const retry = tryParseAndValidate<T>(repairRaw, fallback, context);
      if (retry.ok) return retry.value;
    }

    logError(`acp-compressor/repair-exhausted/${context}`, raw.slice(0, 500));
    this._fallbackCount++;
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

const OBSERVATION_SUMMARY_SCHEMA = '{"title":"string","summary":"string","request":"string","outcome":"string","learned":"string","next_steps":"string","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["string"],"concepts":["string"],"evidence":["string"],"importance_score":0-1,"confidence_score":0-1,"unresolved_score":0-1}';

/** Validate and coerce parsed JSON to match the Observation schema. */
function validateSchema<T>(parsed: any, fallback: T, context: string): T {
  if (!parsed || typeof parsed !== 'object') return fallback;

  if (context === 'summarizeObservation') {
    return {
      title: ensureString(parsed.title, ''),
      summary: ensureString(parsed.summary, ''),
      request: ensureString(parsed.request, ''),
      outcome: ensureString(parsed.outcome, ''),
      learned: ensureString(parsed.learned, ''),
      next_steps: ensureString(parsed.next_steps, ''),
      memory_type: ensureEnum(parsed.memory_type, ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'], 'change'),
      files_touched: ensureStringArray(parsed.files_touched),
      concepts: ensureStringArray(parsed.concepts),
      evidence: ensureStringArray(parsed.evidence),
      importance_score: clampScore(parsed.importance_score),
      confidence_score: clampScore(parsed.confidence_score),
      unresolved_score: clampScore(parsed.unresolved_score),
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

// --- Prompt builder ---
//
// Body language is intentionally Chinese to match upstream behavior validated
// against multiple Kiro models. Memory-level language follows the user's actual
// prompt language, so the body language here only affects the model's framing.

function clampText(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 3);
  return `${s.slice(0, head)}\n…\n${s.slice(s.length - tail)}`;
}

// Kept byte-for-byte in sync with the test-only copy in src/compressor.ts
// (distinctive "本轮事实来源" marker for test scripting).
function buildObservationSummaryPrompt(input: {
  user_prompt: string;
  assistant_response: string;
  artifacts: {
    files_touched: string[];
    commands: string[];
    test_signals: string[];
    error_signals: string[];
    facts: string[];
  };
}): string {
  const a = input.artifacts;
  const files = a.files_touched.slice(0, 12).join(', ') || 'none';
  const cmds = a.commands.slice(0, 8).join('; ') || 'none';
  const tests = a.test_signals.slice(0, 6).join('; ') || 'none';
  const errors = a.error_signals.slice(0, 4).join('; ') || 'none';
  const facts = a.facts.slice(0, 8).join('; ') || 'none';
  const prompt = clampText(input.user_prompt, 2000);
  const resp = clampText(input.assistant_response, 3000) || 'none';

  return `## 本轮事实来源（可信度：工具结果 > 命令退出 > 文件变更 > 明确错误 > 助手叙述）
- 用户请求: ${prompt}
- 涉及文件: ${files}
- 命令: ${cmds}
- 测试/构建/lint: ${tests}
- 错误信号: ${errors}
- 事实片段: ${facts}
- 助手最终回复(补足结论/理由/下一步，非无条件真相): ${resp}

## 规则
- 只描述"本轮"这一个 turn，不要归类到任何主题，不要合并或引用其它历史。
- outcome 必须与上面证据一致；没有成功证据时明确写"未验证/未完成"，不要虚构完成状态或证据中不存在的数字、文件、测试结论。
- assistant_response 用于补足最终结论/理由/下一步，但工具结果与命令退出优先。
- concepts 是可检索标签(中英文都要)，可重复可变化，不需要规范命名。
- evidence 是少量可解释证据(命令、错误、测试结果、关键文件)，不要复制完整输出。

## 输出（只返回 JSON）
{"title":"一句话工作标题(<40字)","summary":"2-4句紧凑事实摘要","request":"用户想完成什么","outcome":"实际完成/验证结果/未完成状态","learned":"可复用的技术事实或取舍","next_steps":"明确未完成项，没有则空串","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["文件路径"],"concepts":["标签"],"evidence":["证据"],"importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`;
}
