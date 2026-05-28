/**
 * Memory compressor abstraction.
 *
 * The production implementation is `ACPCompressor` in `./acp/compressor`,
 * which routes compression prompts through `kiro-cli acp`. This file owns the
 * public interface and the result types that the worker's job runner depends
 * on, plus a thin `Compressor` class that adapts a synchronous JSON-string
 * `CompressorProvider` into the same `MemoryCompressor` interface — used only
 * by tests (with `FakeCompressorProvider`) so the synthesis pipeline can be
 * exercised without spawning real ACP processes.
 */

import { logError } from './logger';

// --- Result types ---

/** Turn summary output (V2) — maps directly to a `memory` row. */
export interface TurnSummaryResult {
  title: string;
  summary: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  memory_type: string;
  files_touched: string[];
  concepts: string[];
  topic_candidate: string;
  importance_score: number;
  confidence_score: number;
  unresolved_score: number;
}

/** Topic normalization output. */
export interface NormalizeTopicResult {
  action: 'existing' | 'new';
  canonical_label: string;
  aliases: string[];
}

/** Topic summary output — written back to topics.summary / topics.unresolved_summary. */
export interface TopicSummaryResult {
  summary: string;
  unresolved_summary: string;
}

/** Low-level provider hook used by tests' `FakeCompressorProvider`. */
export interface CompressorProvider {
  compress(system: string, prompt: string): Promise<string>;
}

/** Abstract interface for memory compression. The worker depends on this, not concrete impl. */
export interface MemoryCompressor {
  summarizeTurn(input: {
    prompt_text: string;
    artifacts: {
      tool_names: string[];
      files_touched: string[];
      commands: string[];
      error_signals: string[];
    };
    event_digest?: string;
  }): Promise<TurnSummaryResult>;

  normalizeTopic(input: {
    candidate: string;
    existing_topics: Array<{ canonical_label: string; aliases: string[] }>;
    memory_title: string;
  }): Promise<NormalizeTopicResult>;

  summarizeTopic(input: {
    topic_label: string;
    memories: Array<{
      title: string;
      summary: string;
      learned?: string;
      next_steps?: string;
    }>;
  }): Promise<TopicSummaryResult>;

  mergeTurnMemories(input: {
    memories: Array<{
      title: string;
      summary: string;
      learned?: string;
      next_steps?: string;
    }>;
    topic_label: string;
  }): Promise<TurnSummaryResult>;

  close?(): Promise<void>;
}

// =============================================================
// Test-only Compressor (provider-backed)
// =============================================================

/**
 * Adapts a string-in/string-out `CompressorProvider` into the
 * `MemoryCompressor` interface. Used by tests (with FakeCompressorProvider) so
 * the synthesis pipeline can be exercised without standing up a real ACP
 * runtime. Production paths must use `ACPCompressor` instead.
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

  async summarizeTurn(input: {
    prompt_text: string;
    artifacts: {
      tool_names: string[];
      files_touched: string[];
      commands: string[];
      error_signals: string[];
    };
    event_digest?: string;
  }): Promise<TurnSummaryResult> {
    const prompt = buildTurnSummaryPrompt(input);
    const raw = await this.provider.compress(TURN_SUMMARY_SYSTEM, prompt);
    return parseJSON<TurnSummaryResult>(
      raw,
      {
        title: '',
        summary: '',
        request: '',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        memory_type: 'change',
        files_touched: [],
        concepts: [],
        topic_candidate: '',
        importance_score: 0.5,
        confidence_score: 0,
        unresolved_score: 0,
      },
      'summarizeTurn',
    );
  }

  async normalizeTopic(input: {
    candidate: string;
    existing_topics: Array<{ canonical_label: string; aliases: string[] }>;
    memory_title: string;
  }): Promise<NormalizeTopicResult> {
    const existingLines = input.existing_topics
      .slice(0, 30)
      .map((tEntry) => {
        const aliasList = tEntry.aliases
          .filter((a) => a && a !== tEntry.canonical_label)
          .slice(0, 8);
        return aliasList.length
          ? `- ${tEntry.canonical_label} (aliases: ${aliasList.join(', ')})`
          : `- ${tEntry.canonical_label}`;
      })
      .join('\n');
    const existing = existingLines || '（无）';
    const system = '你负责归一化主题标签。输出纯 JSON，不要额外文字。';
    const prompt = `候选主题: "${input.candidate}"
记忆标题: "${input.memory_title}"
已有主题（含已知别名）：
${existing}

如果候选与已有主题等价——无论匹配 canonical label 还是任一列出的 alias，语义相同只是措辞不同——返回：
{"action":"existing","canonical_label":"<已有 canonical label>","aliases":["${input.candidate}"]}
否则返回：
{"action":"new","canonical_label":"${input.candidate}","aliases":[]}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<NormalizeTopicResult>(
      raw,
      { action: 'new', canonical_label: input.candidate, aliases: [] },
      'normalizeTopic',
    );
  }

  async summarizeTopic(input: {
    topic_label: string;
    memories: Array<{
      title: string;
      summary: string;
      learned?: string;
      next_steps?: string;
    }>;
  }): Promise<TopicSummaryResult> {
    const system =
      '你负责总结一个主题在代码记忆系统中的当前进展。输出纯 JSON，不要额外文字。';
    const items = input.memories
      .slice(0, 20)
      .map((mEntry, i) => {
        const learned = mEntry.learned
          ? ` | Learned: ${mEntry.learned.slice(0, 120)}`
          : '';
        const next = mEntry.next_steps
          ? ` | Next: ${mEntry.next_steps.slice(0, 120)}`
          : '';
        return `${i + 1}. ${mEntry.title}: ${mEntry.summary.slice(0, 160)}${learned}${next}`;
      })
      .join('\n');
    const prompt = `主题: ${input.topic_label}

该主题下最近的 active 记忆（最新在前）:
${items}

请产出紧凑的主题进展对象。
- "summary": 2-3 句话概括该主题整体进展。
- "unresolved_summary": 单行不超过 80 字，列出当前仍未完成/被阻塞的关键事项；若全部完成返回空串。

只返回 JSON:
{"summary":"...","unresolved_summary":"..."}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<TopicSummaryResult>(
      raw,
      { summary: '', unresolved_summary: '' },
      'summarizeTopic',
    );
  }

  async mergeTurnMemories(input: {
    memories: Array<{
      title: string;
      summary: string;
      learned?: string;
      next_steps?: string;
    }>;
    topic_label: string;
  }): Promise<TurnSummaryResult> {
    const system =
      '你将多条 turn 记忆合并为一条完整记忆。输出纯 JSON，不要额外文字。';
    const items = input.memories
      .map(
        (mEntry, i) =>
          `${i + 1}. ${mEntry.title}: ${mEntry.summary}${mEntry.learned ? ' | Learned: ' + mEntry.learned : ''}${mEntry.next_steps ? ' | Next: ' + mEntry.next_steps : ''}`,
      )
      .join('\n');
    const prompt = `主题: ${input.topic_label}\n\n待合并的 turn 记忆:\n${items}\n\n返回 JSON：\n{"title":"合并标题","summary":"3-5句完整摘要","request":"总体目标","investigated":"跨轮探索了什么","learned":"关键发现汇总","completed":"完成了什么","next_steps":"剩余事项","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":[],"concepts":[],"topic_candidate":"${input.topic_label}","importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<TurnSummaryResult>(
      raw,
      {
        title: '',
        summary: '',
        request: '',
        investigated: '',
        learned: '',
        completed: '',
        next_steps: '',
        memory_type: 'change',
        files_touched: [],
        concepts: [],
        topic_candidate: input.topic_label,
        importance_score: 0.5,
        confidence_score: 0,
        unresolved_score: 0,
      },
      'mergeTurnMemories',
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
    logError(
      `compressor/parseJSON/${context}`,
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        raw: raw.slice(0, 500),
      }),
    );
    return fallback;
  }
}

// --- V2 Turn Summary Prompts (kept for the test-only Compressor path) ---

const TURN_SUMMARY_SYSTEM =
  '你是一个代码会话记忆压缩器。将单轮对话压缩为结构化记忆对象。\n输出纯 JSON，不要 markdown 代码块，不要额外文字。';

function buildTurnSummaryPrompt(input: {
  prompt_text: string;
  artifacts: {
    tool_names: string[];
    files_touched: string[];
    commands: string[];
    error_signals: string[];
  };
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
