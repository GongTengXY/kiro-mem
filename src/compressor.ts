/**
 * Memory compressor abstraction.
 *
 * The production implementation is `ACPCompressor` in `./acp/compressor`,
 * which routes compression prompts through `kiro-cli acp`. This file owns the
 * public interface and result type, plus a thin `Compressor` class that adapts
 * a synchronous JSON-string `CompressorProvider` into the same
 * `MemoryCompressor` interface — used only by tests (with
 * `FakeCompressorProvider`) so the pipeline can be exercised without spawning
 * real ACP processes.
 */

import { logError } from './logger';

/** Observation summary output — maps directly to an `observations` row. */
export interface ObservationSummaryResult {
  title: string;
  summary: string;
  request: string;
  /** What actually happened / was verified / left incomplete. */
  outcome: string;
  learned: string;
  next_steps: string;
  memory_type: string;
  files_touched: string[];
  concepts: string[];
  /** Bounded, explainable proof: commands, errors, tests. */
  evidence: string[];
  importance_score: number;
  confidence_score: number;
  unresolved_score: number;
}

/** Low-level provider hook used by tests' `FakeCompressorProvider`. */
export interface CompressorProvider {
  compress(system: string, prompt: string): Promise<string>;
}

/**
 * Runtime counters exposed by the ACP-backed compressor for observability
 * (design §12.4). Cumulative since worker start. Optional on the interface
 * because the test-only provider-backed `Compressor` does not track them.
 */
export interface CompressorStats {
  /** ACP runtime pool size. */
  total: number;
  busy: number;
  queued: number;
  /** Runtime restarts (over-job-limit recycles + error/contamination recycles). */
  restarts: number;
  /** Recycles caused by tool-call contamination of the pure compressor session. */
  contaminations: number;
  /** JSON-repair prompt attempts. */
  repairs: number;
  /** Times repair was exhausted and the job degraded to a fallback Observation. */
  parseFallbacks: number;
}

/** Abstract interface for memory compression. The worker depends on this, not concrete impl. */
export interface MemoryCompressor {
  /**
   * Compress one closed turn into an atomic Observation. Consumes the user
   * prompt, the assistant's final response, and deterministic artifacts. Must
   * not categorize into a topic or merge other history.
   */
  summarizeObservation(input: {
    user_prompt: string;
    assistant_response: string;
    artifacts: {
      files_touched: string[];
      commands: string[];
      test_signals: string[];
      error_signals: string[];
      facts: string[];
    };
  }): Promise<ObservationSummaryResult>;

  /** Observability counters (ACP impl only). */
  readonly stats?: CompressorStats;

  close?(): Promise<void>;
}

// =============================================================
// Test-only Compressor (provider-backed)
// =============================================================

/**
 * Adapts a string-in/string-out `CompressorProvider` into the
 * `MemoryCompressor` interface. Used by tests (with FakeCompressorProvider) so
 * the pipeline can be exercised without standing up a real ACP runtime.
 * Production paths must use `ACPCompressor` instead.
 */
export class Compressor implements MemoryCompressor {
  private provider: CompressorProvider;

  constructor(provider?: CompressorProvider) {
    if (provider) {
      this.provider = provider;
      return;
    }
    throw new Error(
      'Compressor requires an explicit provider. Production code should use ACPCompressor instead.',
    );
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
    const raw = await this.provider.compress(OBSERVATION_SUMMARY_SYSTEM, prompt);
    return parseJSON<ObservationSummaryResult>(
      raw,
      {
        title: '',
        summary: '',
        request: '',
        outcome: '',
        learned: '',
        next_steps: '',
        memory_type: 'change',
        files_touched: [],
        concepts: [],
        evidence: [],
        importance_score: 0,
        confidence_score: 0,
        unresolved_score: 0,
      },
      'summarizeObservation',
    );
  }
}

function parseJSON<T>(raw: string, fallback: T, context: string): T {
  try {
    const cleaned = raw
      .replace(/^```json?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch (error) {
    logError(`compressor/parseJSON/${context}`, {
      error_type: error instanceof Error ? error.name : 'UnknownError',
      output_bytes: Buffer.byteLength(raw, 'utf8'),
    });
    return fallback;
  }
}

// --- Observation summary prompt (test-only Compressor path) ---
//
// Kept byte-for-byte in sync with the production builder in
// `src/acp/compressor.ts`. The distinctive "本轮事实来源" marker lets tests
// script FakeCompressorProvider responses by substring.

const OBSERVATION_SUMMARY_SYSTEM =
  '你是一个代码会话记忆压缩器。将单个 turn 压缩为一条原子 Observation。\n工具结果与命令退出优先于助手自然语言声明。只描述本轮，不归类主题，不合并历史。\n输出纯 JSON，不要 markdown 代码块，不要额外文字，不要调用工具。';

function clampText(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = Math.max(0, max - head - 3);
  return `${s.slice(0, head)}\n…\n${s.slice(s.length - tail)}`;
}

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
