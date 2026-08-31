/** ACP-backed MemoryCompressor: sends compression prompts through Kiro CLI ACP. */

import { ACPPool } from './pool';
import type { ACPPoolOptions } from './types';
import type { MemoryCompressor, ObservationSummaryResult } from '../compressor';
import {
  coerceSemanticEnRecord,
  type SemanticEnRecord,
  type SemanticEnRecordSource,
} from '../semantic-en';
import { logError } from '../logger';

// Empty Observation result: the empty title/summary is what tells the
// `summarize_turn` job, once repair retries are exhausted, to write a
// `quality='fallback'` Observation from deterministic artifacts — never a
// fabricated one.
const OBSERVATION_SUMMARY_FALLBACK: ObservationSummaryResult = {
  title: '', summary: '', request: '', outcome: '', learned: '',
  next_steps: '', memory_type: 'change', files_touched: [], concepts: [],
  evidence: [], importance_score: 0, confidence_score: 0, unresolved_score: 0,
  semantic_en: null,
};

export interface ACPCompressorOptions extends ACPPoolOptions {
  maxRetries?: number;
}

type ACPPoolLike = Pick<ACPPool, 'run' | 'close' | 'stats'>;

export class ACPCompressor implements MemoryCompressor {
  private pool: ACPPoolLike;
  private maxRetries: number;
  private _repairCount = 0;
  private _fallbackCount = 0;
  private onMetric: (kind: 'repair' | 'contamination') => void;

  constructor(opts: ACPCompressorOptions = {}, pool?: ACPPoolLike) {
    // Matches the documented `compression.maxRetries` default: diverging here
    // meant a direct `new ACPCompressor()` retried once against a promised two.
    this.maxRetries = opts.maxRetries ?? 2;
    this.onMetric = opts.onMetric ?? (() => {});
    this.pool = pool ?? new ACPPool(opts);
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

  /**
   * Second attempt at the English derived value, translation only. Returns null
   * rather than throwing on any failure: the Observation is already being
   * written, and the caller's contract is "no English vector", never "fail the
   * whole turn because a derived value could not be produced".
   */
  async normalizeSemanticEn(source: SemanticEnRecordSource): Promise<SemanticEnRecord | null> {
    try {
      const raw = await this.runWithRetry(buildSemanticEnPrompt(source), 8192);
      const cleaned = raw.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
      return boundedSemanticEn(JSON.parse(cleaned));
    } catch (error) {
      logError('acp-compressor/semantic-en', {
        error_type: error instanceof Error ? error.name : 'UnknownError',
      });
      return null;
    }
  }

  // --- Internal ---

  private async runWithRetry(prompt: string, maxBytes: number): Promise<string> {
    const fullPrompt = SYSTEM_PROMPT + '\n\n' + prompt;
    const result = await this.pool.run(fullPrompt, { maxOutputBytes: maxBytes });
    return result.text;
  }

  /** Run prompt, parse JSON, validate schema; on failure send a repair prompt,
   * and fall back once retries are exhausted. */
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

    let lastOutputBytes = Buffer.byteLength(raw, 'utf8');
    let lastErrorType = first.error;
    for (let i = 0; i < this.maxRetries; i++) {
      this._repairCount++;
      this.onMetric('repair');
      const repairPrompt = buildRepairPrompt(schema, raw, first.error);
      const repairRaw = await this.runWithRetry(repairPrompt, maxBytes);
      lastOutputBytes = Buffer.byteLength(repairRaw, 'utf8');
      const retry = tryParseAndValidate<T>(repairRaw, fallback, context);
      if (retry.ok) return retry.value;
      lastErrorType = retry.error;
    }

    logError(`acp-compressor/repair-exhausted/${context}`, {
      error_type: lastErrorType,
      repair_attempts: this.maxRetries,
      output_bytes: lastOutputBytes,
    });
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
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    logError(`acp-compressor/parse/${context}`, {
      error_type: errorType,
      output_bytes: Buffer.byteLength(raw, 'utf8'),
    });
    return { ok: false, error: errorType, value: fallback };
  }
}

function buildRepairPrompt(schema: string, invalidOutput: string, error: string): string {
  return `The previous output was invalid JSON for this schema.
Return only corrected JSON. Do not include markdown.

Schema: ${schema}
Invalid output: ${invalidOutput.slice(0, 1000)}
Validation error: ${error}`;
}

const OBSERVATION_SUMMARY_SCHEMA = '{"title":"string","summary":"string","request":"string","outcome":"string","learned":"string","next_steps":"string","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["string"],"concepts":["string"],"evidence":["string"],"importance_score":0-1,"confidence_score":0-1,"unresolved_score":0-1,"semantic_en":{"title":"string","summary":"string","outcome":"string","learned":"string","concepts":["string"]}}';

const SEMANTIC_EN_SCHEMA = '{"title":"string","summary":"string","outcome":"string","learned":"string","concepts":["string"]}';

// --- Output size bounds (S2) ---
//
// The only cap was the 16KB ACP read limit, so one verbose Observation could carry
// multi-KB prose into storage: disk cost, an inflated FTS trigram index, a skewed
// read-cost estimate in the injected index, an eaten pull-side response budget.

const FIELD_MAX_CHARS = 2000;
/** `title` is rendered in the injected index, so it is far tighter. */
const TITLE_MAX_CHARS = 200;
/** Array fields: item count and per-item length. */
const ARRAY_MAX_ITEMS = 30;
const ARRAY_ITEM_MAX_CHARS = 400;

function boundedString(val: unknown, max: number): string {
  const s = typeof val === 'string' ? val : '';
  return s.length > max ? s.slice(0, max) : s;
}

function boundedStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((x): x is string => typeof x === 'string')
    .slice(0, ARRAY_MAX_ITEMS)
    .map((s) => (s.length > ARRAY_ITEM_MAX_CHARS ? s.slice(0, ARRAY_ITEM_MAX_CHARS) : s));
}

/** Bound the English derived value with the same caps as the fields it mirrors.
 * `null` for an unusable shape: an absent derived value costs one Observation its
 * English vector, an unbounded one carries model prose into storage. */
function boundedSemanticEn(val: unknown): SemanticEnRecord | null {
  const coerced = coerceSemanticEnRecord(val);
  if (!coerced) return null;
  return {
    title: boundedString(coerced.title, TITLE_MAX_CHARS),
    summary: boundedString(coerced.summary, FIELD_MAX_CHARS),
    outcome: boundedString(coerced.outcome, FIELD_MAX_CHARS),
    learned: boundedString(coerced.learned, FIELD_MAX_CHARS),
    concepts: boundedStringArray(coerced.concepts),
  };
}

/** Validate and coerce parsed JSON to the Observation schema. Exported for tests:
 * the unknown-context branch is unreachable through the public API today, and an
 * invariant that cannot be observed quietly rots. */
export function validateSchema<T>(parsed: any, fallback: T, context: string): T {
  if (!parsed || typeof parsed !== 'object') return fallback;

  if (context === 'summarizeObservation') {
    return {
      title: boundedString(parsed.title, TITLE_MAX_CHARS),
      summary: boundedString(parsed.summary, FIELD_MAX_CHARS),
      request: boundedString(parsed.request, FIELD_MAX_CHARS),
      outcome: boundedString(parsed.outcome, FIELD_MAX_CHARS),
      learned: boundedString(parsed.learned, FIELD_MAX_CHARS),
      next_steps: boundedString(parsed.next_steps, FIELD_MAX_CHARS),
      memory_type: ensureEnum(parsed.memory_type, ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'], 'change'),
      files_touched: boundedStringArray(parsed.files_touched),
      concepts: boundedStringArray(parsed.concepts),
      evidence: boundedStringArray(parsed.evidence),
      importance_score: clampScore(parsed.importance_score),
      confidence_score: clampScore(parsed.confidence_score),
      unresolved_score: clampScore(parsed.unresolved_score),
      // Shape coercion only. Admission to the `semantic-en-v1` space is decided
      // later by `checkSemanticEnRecord()` against the fields actually stored.
      semantic_en: boundedSemanticEn(parsed.semantic_en),
    } as T;
  }

  // S8: an unrecognized context used to `return parsed as T` — the one path that
  // skips validation was also the silent one. Reaching here means a new call site
  // forgot its branch; fall back rather than pass unvalidated model output.
  return fallback;
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
// Body language is Chinese to match upstream behavior validated across multiple
// Kiro models; memory-level language still follows the user's prompt language.

function clampText(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 3);
  return `${s.slice(0, head)}\n…\n${s.slice(s.length - tail)}`;
}

// Single implementation; tests reach it through `ACPCompressor` with a fake pool
// (`tests/support/fake-acp-pool.ts`) keyed on the "本轮事实来源" marker.
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

## semantic_en（英文语义归一化，同一次响应内产出，不要另起解释）
- 把 title / summary / outcome / learned / concepts **忠实翻译成英文**，逐句对应。
- 不要摘要、不要补充背景、不要合并或拆分句子；原文该字段为空则英文也留空。
- 文件路径、标识符、函数名、命令、配置键、数字、错误码一律原样保留，不要翻译。
- concepts 逐项翻译，数量与顺序必须与上面的 concepts 完全一致。
- 原文本来就是英文时，照抄或仅规范措辞即可，不要改写标识符。
- 不允许输出 "..."、"N/A"、"unknown" 这类占位内容；写不出就说明上面的字段本身是空的。

## 输出（只返回 JSON）
{"title":"一句话工作标题(<40字)","summary":"2-4句紧凑事实摘要","request":"用户想完成什么","outcome":"实际完成/验证结果/未完成状态","learned":"可复用的技术事实或取舍","next_steps":"明确未完成项，没有则空串","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["文件路径"],"concepts":["标签"],"evidence":["证据"],"importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0,"semantic_en":{"title":"English title","summary":"English summary","outcome":"English outcome","learned":"English learned","concepts":["English tag"]}}`;
}

// --- Translation-only prompt (second and last derived-value attempt) ---
//
// Separate from the summary prompt: re-running the whole compression would
// re-roll Observation text that is immutable by then, so the two would disagree.

function buildSemanticEnPrompt(source: SemanticEnRecordSource): string {
  const input = {
    title: source.title,
    summary: source.summary,
    outcome: source.outcome ?? '',
    learned: source.learned ?? '',
    concepts: source.concepts,
  };
  return `把下面这条开发记忆的字段忠实翻译成英文。

规则：
- 逐句对应。不要摘要、不要补充、不要合并或拆分句子。
- 输入为空的字段，输出也必须为空字符串。
- 文件路径、标识符、函数名、命令、配置键、数字、错误码一律原样保留。
- concepts 逐项翻译，数量与顺序必须与输入完全一致。
- 不允许输出 "..."、"N/A"、"unknown" 这类占位内容。
- 只输出 JSON，不要 markdown 代码块，不要解释。

schema：
${SEMANTIC_EN_SCHEMA}

待翻译：
${JSON.stringify(input, null, 2)}`;
}
