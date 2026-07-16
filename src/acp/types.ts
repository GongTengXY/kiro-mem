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
   * Best-effort observability hook (§12.4). Fired on each JSON-repair attempt
   * ('repair') and each contamination-driven runtime recycle ('contamination').
   * The worker wires this to persist a metric_events row.
   */
  onMetric?: (kind: ACPMetricKind) => void;
}
