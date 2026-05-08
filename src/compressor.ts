import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, resolveEnvValue, type Config, type Language } from './config';

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
      confidence_score: 0.5, unresolved_score: 0,
    });
  }

  /**
   * Normalize a topic candidate against existing topics.
   */
  async normalizeTopic(input: {
    candidate: string;
    existing_labels: string[];
    memory_title: string;
  }): Promise<NormalizeTopicResult> {
    const existing = input.existing_labels.slice(0, 30).join(', ') || '(none)';
    const lang = this.language;
    const system = lang === 'en'
      ? 'You normalize topic labels. Output pure JSON only.'
      : '你负责归一化主题标签。输出纯 JSON，不要额外文字。';
    const prompt = lang === 'en'
      ? `Candidate topic: "${input.candidate}"\nMemory title: "${input.memory_title}"\nExisting topics: [${existing}]\n\nIf the candidate matches an existing topic (same meaning, different wording), return:\n{"action":"existing","canonical_label":"<the existing label>","aliases":["${input.candidate}"]}\nOtherwise return:\n{"action":"new","canonical_label":"${input.candidate}","aliases":[]}`
      : `候选主题: "${input.candidate}"\n记忆标题: "${input.memory_title}"\n已有主题: [${existing}]\n\n如果候选与已有主题语义相同（只是措辞不同），返回：\n{"action":"existing","canonical_label":"<已有标签>","aliases":["${input.candidate}"]}\n否则返回：\n{"action":"new","canonical_label":"${input.candidate}","aliases":[]}`;
    const raw = await this.provider.compress(system, prompt);
    return parseJSON<NormalizeTopicResult>(raw, {
      action: 'new', canonical_label: input.candidate, aliases: [],
    });
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
      confidence_score: 0.5, unresolved_score: 0,
    });
  }
}

function parseJSON<T>(raw: string, fallback: T): T {
  try {
    const cleaned = raw.replace(/^```json?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
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
