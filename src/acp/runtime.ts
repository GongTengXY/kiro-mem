/**
 * High-level ACP session runtime.
 * Wraps ACPClient to provide: initialize, create session, send prompt, collect
 * output from session/update notifications, then await the final stopReason.
 *
 * Purity contract for the kiro-mem internal compressor:
 * - The session must run as the configured agent (passed via `kiro-cli acp --agent`).
 * - The session must NOT receive any ToolCall / ToolCallUpdate notifications.
 *   If it does, the runtime is considered contaminated, the current prompt
 *   fails immediately, and all subsequent calls reject until the runtime
 *   is recycled.
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

  // Purity state. Once contaminated, the runtime is fatal.
  private contamination: { type: string; tool: string } | null = null;

  constructor(opts: ACPRuntimeOptions = {}) {
    this.opts = {
      kiroCliPath: opts.kiroCliPath ?? 'kiro-cli',
      kiroHome: opts.kiroHome ?? '',
      timeoutMs: opts.timeoutMs ?? 30000,
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

    // Use the official `kiro-cli acp --agent <name>` flag to select the agent
    // for the first session. This is stronger than passing `params.agent` in
    // session/new and matches the documented CLI contract.
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
        // Silently capture stderr; could log in debug mode
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

  /** Start process and initialize ACP protocol. */
  async start(): Promise<InitializeResult> {
    this.client.start();
    const result = await this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'kiro-mem', version: PACKAGE_VERSION },
    }, 15000) as InitializeResult;
    this.initialized = true;
    return result;
  }

  /** Create a new session. */
  async createSession(cwd?: string): Promise<string> {
    if (!this.initialized) throw new Error('ACPRuntime not initialized');
    this.throwIfContaminated();
    const params: Record<string, unknown> = {
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
    };
    const result = await this.client.request('session/new', params, 20000) as SessionNewResult;
    this.sessionId = result.sessionId;
    return result.sessionId;
  }

  /**
   * Send a prompt and collect streamed output until the prompt request
   * completes with a stopReason.
   */
  async prompt(text: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<PromptResult> {
    if (!this.sessionId) throw new Error('No active session');
    this.throwIfContaminated();

    // Reset collection state
    this.chunks = [];
    this.collectedBytes = 0;
    this.truncated = false;
    this.currentMaxOutputBytes = opts?.maxOutputBytes ?? this.opts.maxOutputBytes;

    const timeout = opts?.timeoutMs ?? this.opts.timeoutMs;

    const result = await this.client.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }] satisfies TextContentBlock[],
    }, timeout) as SessionPromptResult;

    // Contamination check takes precedence over truncation: if we saw a tool
    // event, the run was unsafe regardless of how much text leaked through.
    this.throwIfContaminated();
    if (this.truncated) {
      throw new Error(`ACP output exceeded ${this.currentMaxOutputBytes} bytes limit`);
    }

    return {
      text: this.chunks.join(''),
      stopReason: result.stopReason,
    };
  }

  /** Close the runtime and kill the process. */
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
        // The internal compressor agent declares `tools: []` and the prompt
        // explicitly forbids tool use. If we see a tool event, the session
        // is not running on the expected pure agent — either the agent was
        // wrong, or the agent config drifted. Either way the result is
        // unsafe to use. Mark as contaminated so this and all subsequent
        // calls fail loudly, and let the pool recycle the slot.
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
