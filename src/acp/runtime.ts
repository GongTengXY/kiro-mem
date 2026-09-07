/**
 * High-level ACP session runtime: initialize, create session, prompt, collect
 * output from session/update notifications, await the final stopReason.
 *
 * Purity contract for the internal compressor: the session runs as the
 * configured agent (`kiro-cli acp --agent`) and must receive no ToolCall /
 * ToolCallUpdate notification. One marks the runtime contaminated — the current
 * prompt fails immediately and every later call rejects until the pool recycles
 * it.
 */

import { ACPClient } from './client';
import type {
  InitializeResult,
  SessionNewResult,
  SessionPromptResult,
  SessionUpdateNotificationParams,
  ACPRuntimeOptions,
  TextContentBlock,
} from './types';
import { logError } from '../logger';
import { PACKAGE_VERSION } from '../version';

export interface PromptResult {
  text: string;
  stopReason?: string;
}

/** Thrown when the internal compressor session receives a tool event. */
export class ACPContaminationError extends Error {
  readonly toolEventType: string;
  readonly toolName: string;
  constructor(toolEventType: string, toolName: string) {
    super(
      `ACP runtime contaminated: received ${toolEventType} (tool=${toolName}). ` +
        `The internal compressor agent must have tools: [] and must not invoke any tools.`,
    );
    this.name = 'ACPContaminationError';
    this.toolEventType = toolEventType;
    this.toolName = toolName;
  }
}

export class ACPRuntime {
  private client: ACPClient;
  private initialized = false;
  private sessionId: string | null = null;
  private opts: Required<ACPRuntimeOptions>;

  // Notification collection state for the active prompt turn
  private chunks: string[] = [];
  private collectedBytes = 0;
  private truncated = false;
  private currentMaxOutputBytes = 16384;

  // Purity state. Fatal once set.
  private contamination: { type: string; tool: string } | null = null;

  constructor(opts: ACPRuntimeOptions = {}) {
    this.opts = {
      kiroCliPath: opts.kiroCliPath ?? 'kiro-cli',
      kiroHome: opts.kiroHome ?? '',
      timeoutMs: opts.timeoutMs ?? 30000,
      startupTimeoutMs: opts.startupTimeoutMs ?? 30000,
      maxOutputBytes: opts.maxOutputBytes ?? 16384,
      agentName: opts.agentName ?? '',
    };

    const env: Record<string, string> = {
      KIRO_MEMORY_DISABLE_HOOKS: '1',
      KIRO_MEMORY_INTERNAL: '1',
    };
    if (this.opts.kiroHome) {
      env.KIRO_HOME = this.opts.kiroHome;
    }

    // `--agent` on the CLI rather than `params.agent` in session/new: it is the
    // documented contract and is the stronger binding for the first session.
    const args: string[] = ['acp'];
    if (this.opts.agentName) {
      args.push('--agent', this.opts.agentName);
    }

    this.client = new ACPClient({
      command: this.opts.kiroCliPath,
      args,
      env,
      onNotification: this.handleNotification.bind(this),
      onStderr: () => {
        // stderr is dropped.
      },
    });
  }

  get alive(): boolean {
    return this.client.alive && this.contamination == null;
  }

  /** True once a tool event has been observed on this runtime. Fatal. */
  get isContaminated(): boolean {
    return this.contamination != null;
  }

  /** PID of the underlying `kiro-cli acp` process, for RSS attribution only. */
  get pid(): number | null {
    return this.client.pid;
  }

  async start(): Promise<InitializeResult> {
    this.client.start();
    // Configurable, not a literal: cold starts were measured from ~2s to over 20s,
    // and a handshake that loses the race costs the turn its summary.
    const result = await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kiro-mem', version: PACKAGE_VERSION },
    }, this.opts.startupTimeoutMs) as InitializeResult;
    this.initialized = true;
    return result;
  }

  async createSession(cwd?: string): Promise<string> {
    if (!this.initialized) throw new Error('ACPRuntime not initialized');
    this.throwIfContaminated();
    const params: Record<string, unknown> = {
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
    };
    // Same budget as `initialize`: on a cold pool it lands right after it, so its
    // own literal would just become the next ceiling.
    const result = await this.client.request(
      'session/new',
      params,
      this.opts.startupTimeoutMs,
    ) as SessionNewResult;
    this.sessionId = result.sessionId;
    return result.sessionId;
  }

  async prompt(text: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<PromptResult> {
    if (!this.sessionId) throw new Error('No active session');
    this.throwIfContaminated();

    this.chunks = [];
    this.collectedBytes = 0;
    this.truncated = false;
    this.currentMaxOutputBytes = opts?.maxOutputBytes ?? this.opts.maxOutputBytes;

    const timeout = opts?.timeoutMs ?? this.opts.timeoutMs;

    const result = await this.client.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }] satisfies TextContentBlock[],
    }, timeout) as SessionPromptResult;

    // Precedence over truncation: a tool event makes the run unsafe regardless
    // of how much text got through.
    this.throwIfContaminated();
    if (this.truncated) {
      throw new Error(`ACP output exceeded ${this.currentMaxOutputBytes} bytes limit`);
    }

    return {
      text: this.chunks.join(''),
      stopReason: result.stopReason,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
    this.initialized = false;
    this.sessionId = null;
  }

  // --- Internal ---

  private throwIfContaminated(): void {
    const c = this.contamination;
    if (c != null) {
      throw new ACPContaminationError(c.type, c.tool);
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update' && method !== 'session/notification') return;
    const p = params as unknown as SessionUpdateNotificationParams;
    if (p.sessionId !== this.sessionId) return;

    const updateType = this.normalizeUpdateType(p.update);
    switch (updateType) {
      case 'agent_message_chunk': {
        const text = this.extractTextChunk(p.update);
        if (text && !this.truncated) {
          const bytes = Buffer.byteLength(text, 'utf-8');
          if (this.collectedBytes + bytes > this.currentMaxOutputBytes) {
            this.truncated = true;
          } else {
            this.chunks.push(text);
            this.collectedBytes += bytes;
          }
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        // A tool event means the session is not on the pure `tools: []` agent —
        // wrong agent, or agent config drift — so the result is unsafe to use.
        const update = p.update as Record<string, unknown>;
        const toolCall = (update.toolCall as Record<string, unknown> | undefined) ?? undefined;
        const toolName =
          (toolCall?.name as string | undefined) ??
          (update.toolCallId as string | undefined) ??
          (update.name as string | undefined) ??
          (update.title as string | undefined) ??
          (update.id as string | undefined) ??
          'unknown';
        if (!this.contamination) {
          this.contamination = { type: updateType, tool: toolName };
          logError(
            'acp-runtime/contaminated',
            new Error(
              `Internal compressor session ${this.sessionId} received ${updateType} ` +
                `(tool=${toolName}, agent=${this.opts.agentName || '<default>'}, ` +
                `kiroHome=${this.opts.kiroHome || '<inherit>'}).`,
            ),
          );
        }
        break;
      }
    }
  }

  private normalizeUpdateType(update: Record<string, unknown>): 'agent_message_chunk' | 'tool_call' | 'tool_call_update' | null {
    const raw =
      (typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined) ??
      (typeof update.type === 'string' ? update.type : undefined);

    switch (raw) {
      case 'agent_message_chunk':
      case 'AgentMessageChunk':
        return 'agent_message_chunk';
      case 'tool_call':
      case 'ToolCall':
        return 'tool_call';
      case 'tool_call_update':
      case 'ToolCallUpdate':
        return 'tool_call_update';
      default:
        return null;
    }
  }

  private extractTextChunk(update: Record<string, unknown>): string {
    if (typeof update.text === 'string') {
      return update.text;
    }

    const content = update.content;
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      const block = content as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }

    if (Array.isArray(content)) {
      const texts = content
        .map((item) => {
          if (!item || typeof item !== 'object') return '';
          const record = item as Record<string, unknown>;
          if (record.type === 'text' && typeof record.text === 'string') {
            return record.text;
          }
          const nested = record.content;
          if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            const nestedRecord = nested as Record<string, unknown>;
            if (nestedRecord.type === 'text' && typeof nestedRecord.text === 'string') {
              return nestedRecord.text;
            }
          }
          return '';
        })
        .filter(Boolean);
      return texts.join('');
    }

    return '';
  }
}
