/** ACP protocol subset types used by kiro-mem compression runtime. */

// --- JSON-RPC 2.0 ---

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// --- ACP Initialize ---

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: Record<string, unknown>;
  agentInfo: { name: string; version: string };
}

// --- ACP Session ---

export interface SessionNewParams {
  cwd: string;
  mcpServers?: unknown[];
}

export interface SessionNewResult {
  sessionId: string;
}

export interface TextContentBlock {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: TextContentBlock[];
}

export interface SessionPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

// --- ACP Session Notifications ---

export type SessionUpdateType =
  | 'agent_message_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'AgentMessageChunk'
  | 'ToolCall'
  | 'ToolCallUpdate'
  | 'TurnEnd';

export interface SessionUpdateNotificationParams {
  sessionId: string;
  update: {
    sessionUpdate?: SessionUpdateType;
    type?: SessionUpdateType;
    content?: unknown;
    text?: string;
    [key: string]: unknown;
  };
}

// --- Pool/Runtime config ---

export interface ACPRuntimeOptions {
  kiroCliPath?: string;
  kiroHome?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  agentName?: string;
}

export type ACPMetricKind = 'repair' | 'contamination';

export interface ACPPoolOptions extends ACPRuntimeOptions {
  concurrency?: number;
  maxJobsPerProcess?: number;
  /**
   * Floor on runtimes idle-TTL retirement may take away, clamped to
   * `[0, concurrency]`. Not a target: a Worker that has never compressed holds
   * zero. Only slot-reducing retirement is gated — an in-place recycle leaves
   * the count unchanged.
   */
  minWarmRuntimes?: number;
  /**
   * Idle milliseconds before a released runtime is retired. `0` disables idle
   * retirement entirely (and its housekeeping timer); it never means "kill
   * immediately".
   */
  idleTtlMs?: number;
  /** Observability hook (§12.4): one call per JSON-repair attempt ('repair')
   * and per contamination recycle ('contamination'). The worker persists a
   * metric_events row. */
  onMetric?: (kind: ACPMetricKind) => void;
}
