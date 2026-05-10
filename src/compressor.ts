import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, resolveEnvValue, type Config, type Language } from './config';
import { logError } from './logger';

// --- Types ---

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

export interface CompressorProvider {
  compress(system: string, prompt: string): Promise<string>;
}

// --- Prompts ---

// --- Providers ---

class AnthropicProvider implements CompressorProvider {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: Config['compression']) {
    const apiKey = resolveEnvValue(config.apiKey);
    this.client = new Anthropic({ apiKey });
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
  }

  async compress(system: string, prompt: string): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = msg.content[0];
    return block?.type === 'text' ? block.text : '';
  }
}

class OpenAICompatibleProvider implements CompressorProvider {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: Config['compression']) {
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.apiKey = resolveEnvValue(config.apiKey);
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;
  }

  async compress(system: string, prompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const json = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return json.choices?.[0]?.message?.content || '';
  }
}

// --- Main Compressor ---

export class Compressor {
  private provider: CompressorProvider;
  private language: Language;

  constructor(provider?: CompressorProvider) {
    const config = loadConfig();
    this.language = config.language;
    if (provider) {
      this.provider = provider;
      return;
    }
    switch (config.compression.provider) {
      case 'anthropic':
        this.provider = new AnthropicProvider(config.compression);
        break;
      case 'openai':
      case 'ollama':
      case 'custom':
        this.provider = new OpenAICompatibleProvider(config.compression);
        break;
      default:
        throw new Error(`Unknown provider: ${config.compression.provider}`);
    }
  }

  /**
   * Summarize a single turn into a memory object.
   * Input: prompt text + deterministic artifacts + optional event digest.
   */
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
    const prompt = buildTurnSummaryPrompt(input, this.language);
    const raw = await this.provider.compress(TURN_SUMMARY_SYSTEM[this.language], prompt);
    return parseJSON<TurnSummaryResult>(raw, {
      title: '', summary: '', request: '', investigated: '', learned: '',
      completed: '', next_steps: '', memory_type: 'change', files_touched: [],
      concepts: [], topic_candidate: '', importance_score: 0.5,
      confidence_score: 0, unresolved_score: 0,
    }, 'summarizeTurn');
  }

  /**
   * Normalize a topic candidate against existing topics.
   *
   * `existing_topics` should include both the canonical label and the known
   * aliases for each topic. Surfacing aliases in the prompt lets the LLM
   * recognize that e.g. "用户认证链路" is equivalent to a topic whose
   * canonical label is "auth 登录链路" when one of its aliases is exactly
   * that string — which cuts down on the long-tail semantic drift caused by
   * only showing canonical labels.
   */
  async normalizeTopic(input: {
    candidate: string;
    existing_topics: Array<{ canonical_label: string; aliases: string[] }>;
    memory_title: string;
  }): Promise<NormalizeTopicResult> {
    const lang = this.language;
    const existingLines = input.existing_topics
      .slice(0, 30)
      .map((t) => {
        const aliasList = t.aliases.filter((a) => a && a !== t.canonical_label).slice(0, 8);
        return aliasList.length
          ? `- ${t.canonical_label} (aliases: ${aliasList.join(', ')})`
          : `- ${t.canonical_label}`;
      })
      .join('\n');
    const existing = existingLines || (lang === 'en' ? '(none)' : '（无）');
    const system = lang === 'en'
      ? 'You normalize topic labels. Output pure JSON only.'
      : '你负责归一化主题标签。输出纯 JSON，不要额外文字。';
    const prompt = lang === 'en'
      ? `Candidate topic: "${input.candidate}"
Memory title: "${input.memory_title}"
Existing topics (with known aliases):
${existing}

If the candidate matches one of the existing topics — either the canonical label or any listed alias, same meaning with different wording — return:
{"action":"existing","canonical_label":"<the existing canonical label>","aliases":["${input.candidate}"]}
Otherwise return:
{"action":"new","canonical_label":"${input.candidate}","aliases":[]}`
      : `候选主题: "${input.candidate}"
记忆标题: "${input.memory_title}"
已有主题（含已知别名）：
${existing}

如果候选与已有主题等价——无论匹配 canonical label 还是任一列出的 alias，语义相同只是措辞不同——返回：
{"action":"existing","canonical_label":"<已有 canonical label>","aliases":["${input.candidate}"]}
否则返回：
{"action":"new","canonical_label":"${input.candidate}","aliases":[]}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<NormalizeTopicResult>(raw, {
      action: 'new', canonical_label: input.candidate, aliases: [],
    }, 'normalizeTopic');
  }

  /**
   * Summarize a topic's recent active memories into a compact narrative used
   * by context injection and MCP `topics`. Produces both:
   *   - summary: 2-3 sentence rolling progress line
   *   - unresolved_summary: <= 80 chars of what's still outstanding
   *
   * `memories` should be pre-filtered to active rows under the topic,
   * ordered by recency (last_turn_at DESC) and truncated to a manageable
   * count. Keeping this contract narrow lets the handler stay simple.
   */
  async summarizeTopic(input: {
    topic_label: string;
    memories: Array<{
      title: string;
      summary: string;
      learned?: string;
      next_steps?: string;
    }>;
  }): Promise<TopicSummaryResult> {
    const lang = this.language;
    const system = lang === 'en'
      ? 'You summarize a topic thread in a developer memory system. Output pure JSON only.'
      : '你负责总结一个主题在代码记忆系统中的当前进展。输出纯 JSON，不要额外文字。';
    const items = input.memories
      .slice(0, 20)
      .map((m, i) => {
        const learned = m.learned ? ` | Learned: ${m.learned.slice(0, 120)}` : '';
        const next = m.next_steps ? ` | Next: ${m.next_steps.slice(0, 120)}` : '';
        return `${i + 1}. ${m.title}: ${m.summary.slice(0, 160)}${learned}${next}`;
      })
      .join('\n');
    const prompt = lang === 'en'
      ? `Topic: ${input.topic_label}

Recent active memories under this topic (newest first):
${items}

Produce a compact topic status object.
- "summary": 2-3 sentences capturing overall progress across these memories.
- "unresolved_summary": single line <= 80 chars listing what's still outstanding or blocked. Empty string if everything is done.

Return JSON only:
{"summary":"...","unresolved_summary":"..."}`
      : `主题: ${input.topic_label}

该主题下最近的 active 记忆（最新在前）:
${items}

请产出紧凑的主题进展对象。
- "summary": 2-3 句话概括该主题整体进展。
- "unresolved_summary": 单行不超过 80 字，列出当前仍未完成/被阻塞的关键事项；若全部完成返回空串。

只返回 JSON:
{"summary":"...","unresolved_summary":"..."}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<TopicSummaryResult>(raw, {
      summary: '',
      unresolved_summary: '',
    }, 'summarizeTopic');
  }

  /**
   * Merge 2-6 turn memories into a higher-level merged memory.
   */
  async mergeTurnMemories(input: {
    memories: Array<{ title: string; summary: string; learned?: string; next_steps?: string }>;
    topic_label: string;
  }): Promise<TurnSummaryResult> {
    const lang = this.language;
    const system = lang === 'en'
      ? 'You merge multiple turn memories into one cohesive memory. Output pure JSON only.'
      : '你将多条 turn 记忆合并为一条完整记忆。输出纯 JSON，不要额外文字。';
    const items = input.memories.map((m, i) => `${i + 1}. ${m.title}: ${m.summary}${m.learned ? ' | Learned: ' + m.learned : ''}${m.next_steps ? ' | Next: ' + m.next_steps : ''}`).join('\n');
    const prompt = lang === 'en'
      ? `Topic: ${input.topic_label}\n\nTurn memories to merge:\n${items}\n\nReturn JSON:\n{"title":"Merged title","summary":"Cohesive 3-5 sentence summary","request":"Overall goal","investigated":"What was explored across turns","learned":"Key consolidated findings","completed":"What was accomplished","next_steps":"Remaining items","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":[],"concepts":[],"topic_candidate":"${input.topic_label}","importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`
      : `主题: ${input.topic_label}\n\n待合并的 turn 记忆:\n${items}\n\n返回 JSON：\n{"title":"合并标题","summary":"3-5句完整摘要","request":"总体目标","investigated":"跨轮探索了什么","learned":"关键发现汇总","completed":"完成了什么","next_steps":"剩余事项","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":[],"concepts":[],"topic_candidate":"${input.topic_label}","importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<TurnSummaryResult>(raw, {
      title: '', summary: '', request: '', investigated: '', learned: '',
      completed: '', next_steps: '', memory_type: 'change', files_touched: [],
      concepts: [], topic_candidate: input.topic_label, importance_score: 0.5,
      confidence_score: 0, unresolved_score: 0,
    }, 'mergeTurnMemories');
  }
}

function parseJSON<T>(raw: string, fallback: T, context: string): T {
  try {
    const cleaned = raw.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as T;
  } catch (error) {
    logError(`compressor/parseJSON/${context}`, JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      raw: raw.slice(0, 500),
    }));
    return fallback;
  }
}

// --- V2 Turn Summary Prompts ---

const TURN_SUMMARY_SYSTEM: Record<Language, string> = {
  zh: '你是一个代码会话记忆压缩器。将单轮对话压缩为结构化记忆对象。\n输出纯 JSON，不要 markdown 代码块，不要额外文字。',
  en: 'You are a code session memory compressor. Compress a single turn into a structured memory object.\nOutput pure JSON only. No markdown code blocks, no extra text.',
};

function buildTurnSummaryPrompt(input: {
  prompt_text: string;
  artifacts: {
    tool_names: string[];
    files_touched: string[];
    commands: string[];
    error_signals: string[];
  };
  event_digest?: string;
}, lang: Language): string {
  const a = input.artifacts;
  const tools = a.tool_names.join(', ') || 'none';
  const files = a.files_touched.slice(0, 10).join(', ') || 'none';
  const cmds = a.commands.slice(0, 5).join('; ') || 'none';
  const errors = a.error_signals.slice(0, 3).join('; ') || 'none';
  const digest = input.event_digest ? `\n- Event digest: ${input.event_digest}` : '';

  if (lang === 'en') {
    return `## Turn Input
- User prompt: ${input.prompt_text.slice(0, 2000)}
- Tools used: ${tools}
- Files touched: ${files}
- Commands: ${cmds}
- Errors: ${errors}${digest}

## Output
Return JSON:
{"title":"One-line title (<80 chars)","summary":"2-4 sentence summary","request":"What the user asked","investigated":"What was explored","learned":"Key findings/decisions","completed":"What was done","next_steps":"Remaining items","memory_type":"decision|bugfix|feature|refactor|discovery|change","files_touched":["paths"],"concepts":["tags, both EN and ZH"],"topic_candidate":"normalized topic label","importance_score":0.0-1.0,"confidence_score":0.0-1.0,"unresolved_score":0.0-1.0}`;
  }

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
