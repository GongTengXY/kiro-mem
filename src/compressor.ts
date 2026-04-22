import Anthropic from '@anthropic-ai/sdk';
import { loadConfig, resolveEnvValue, type Config } from './config';

// --- Types ---

export interface CompressedObservation {
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  type: string;
  files: string[];
}

export interface SessionSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  files_touched: string[];
}

export interface CompressorProvider {
  compress(prompt: string): Promise<string>;
}

// --- Prompts ---

const OBS_SYSTEM = `你是一个代码会话记忆压缩器。将工具调用事件压缩为结构化观察记录。
输出纯 JSON，不要 markdown 代码块，不要额外文字。`;

function buildObsPrompt(event: {
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  cwd: string;
}): string {
  const input = JSON.stringify(event.tool_input, null, 0).slice(0, 3000);
  const response = JSON.stringify(event.tool_response, null, 0).slice(0, 3000);
  return `## 输入
- 工具名称: ${event.tool_name}
- 工具输入: ${input}
- 工具输出: ${response}
- 工作目录: ${event.cwd}

## 输出要求
返回 JSON：
{"title":"一句话描述(<20字)","narrative":"2-3句详细说明","facts":["关键事实,3-5条"],"concepts":["概念标签,中英文都要,3-8个"],"type":"decision|bugfix|feature|refactor|discovery|change","files":["涉及的文件路径"]}

## 压缩原则
- 保留：决策原因、错误原因、关键配置值、接口约定、边界条件
- 丢弃：完整代码内容、冗长日志、重复信息
- concepts 同时包含中文和英文标签`;
}

const SUMMARY_SYSTEM = `你是一个代码会话摘要生成器。基于会话信息生成结构化摘要。
输出纯 JSON，不要 markdown 代码块，不要额外文字。`;

function buildSummaryPrompt(data: {
  prompts: string[];
  observations: string[];
  assistant_response: string;
}): string {
  const prompts = data.prompts.join('\n- ');
  const obs = data.observations.join('\n- ');
  const response = data.assistant_response.slice(0, 2000);
  return `## 会话信息
- 用户 Prompt: ${prompts}
- Observations: ${obs}
- AI 最终回复: ${response}

## 输出要求
返回 JSON：
{"request":"用户请求了什么(1-2句)","investigated":"AI探索了什么(2-3句)","learned":"关键发现和决策(3-5条,用分号分隔)","completed":"完成了什么(1-2句)","next_steps":"后续建议(1-3条,用分号分隔)","files_touched":["涉及的文件路径"]}

## 摘要原则
- 聚焦对未来有用的信息
- 保留关键决策和原因
- 保留未完成事项`;
}

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

  async compress(prompt: string): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: prompt.includes('工具名称') ? OBS_SYSTEM : SUMMARY_SYSTEM,
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

  async compress(prompt: string): Promise<string> {
    const system = prompt.includes('工具名称') ? OBS_SYSTEM : SUMMARY_SYSTEM;
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

  constructor(provider?: CompressorProvider) {
    if (provider) {
      this.provider = provider;
      return;
    }
    const config = loadConfig().compression;
    switch (config.provider) {
      case 'anthropic':
        this.provider = new AnthropicProvider(config);
        break;
      case 'openai':
      case 'ollama':
      case 'custom':
        this.provider = new OpenAICompatibleProvider(config);
        break;
      default:
        throw new Error(`Unknown provider: ${config.provider}`);
    }
  }

  async compressObservation(event: {
    tool_name: string;
    tool_input: unknown;
    tool_response: unknown;
    cwd: string;
  }): Promise<CompressedObservation> {
    const prompt = buildObsPrompt(event);
    const raw = await this.provider.compress(prompt);
    return parseJSON<CompressedObservation>(raw, {
      title: '',
      narrative: '',
      facts: [],
      concepts: [],
      type: 'change',
      files: [],
    });
  }

  async compressSession(data: {
    prompts: string[];
    observations: string[];
    assistant_response: string;
  }): Promise<SessionSummary> {
    const prompt = buildSummaryPrompt(data);
    const raw = await this.provider.compress(prompt);
    return parseJSON<SessionSummary>(raw, {
      request: '',
      investigated: '',
      learned: '',
      completed: '',
      next_steps: '',
      files_touched: [],
    });
  }
}

function parseJSON<T>(raw: string, fallback: T): T {
  try {
    // 去掉可能的 markdown 代码块包裹
    const cleaned = raw
      .replace(/^```json?\n?/m, '')
      .replace(/\n?```$/m, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return fallback;
  }
}
