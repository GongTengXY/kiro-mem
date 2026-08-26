/**
 * Wire contract for the Web Viewer, shared by the Worker routes and the browser
 * bundle (plan §7).
 *
 * Deliberately dependency-free: the browser bundle imports it, so a single
 * `import { MemoryDB }` here would drag SQLite and the embedding runtime into
 * `viewer.js`. Types plus frozen numeric limits only.
 */

// --- Limits (server enforces, client displays) ---

/** Feed / search page size ceiling (plan §7). */
export const VIEWER_PAGE_LIMIT = 50;
/** Raw turn events per page. */
export const VIEWER_EVENTS_PAGE_LIMIT = 20;
/** Per-event payload bytes returned to the Viewer before inline truncation. */
export const VIEWER_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
/** Total payload bytes one events page may carry. */
export const VIEWER_EVENTS_RESPONSE_MAX_BYTES = 192 * 1024;
/** Log lines per page. */
export const VIEWER_LOGS_PAGE_LIMIT = 100;
/** Longest search query the Viewer will send. */
export const VIEWER_QUERY_MAX_CHARS = 512;
/** Hard ceiling for a context-preview budget request (plan §3.4). */
export const VIEWER_CONTEXT_MAX_BYTES = 9500;
/** Floor for a context-preview budget request. */
export const VIEWER_CONTEXT_MIN_BYTES = 512;
/** Bounded string/array sizes in projected cards, so one row cannot flood a page. */
export const VIEWER_TEXT_CLIP = 400;
export const VIEWER_LIST_CLIP = 12;

// --- Scope selection ---

/**
 * Every data request carries this. `allScopes` must be strictly `true` to lift
 * the scope filter; a missing scope with `allScopes !== true` fails closed.
 */
export interface ViewerScopeInput {
  scopeKey?: string;
  allScopes?: boolean;
}

export interface ViewerScope {
  scopeKey: string;
  observations: number;
  lastActivityAt: string | null;
}

// --- Bootstrap ---

export interface ViewerBootstrap {
  version: string;
  /** UI language for the Viewer chrome, taken from `config.language`. */
  language: 'zh' | 'en';
  scopes: ViewerScope[];
  queue: ViewerQueueStatus;
  retrieval: {
    semanticDiscovery: boolean;
    profile: string;
    semanticFloor: number;
    semanticOnlyLimit: number | 'none';
  };
  observations: { total: number; normal: number; fallback: number; pinned: number };
  context: { maxOutputBytes: number };
  startedAt: string;
}

export interface ViewerQueueStatus {
  pending: number;
  leased: number;
  dead: number;
  succeeded24h: number;
}

// --- Observation cards ---

export type ViewerMatchSource = 'fts' | 'semantic' | 'hybrid' | 'bigram';

export interface ViewerObservationCard {
  id: number;
  scopeKey: string;
  title: string;
  memoryType: string;
  quality: 'normal' | 'fallback';
  pinned: boolean;
  summary: string;
  outcome: string | null;
  nextSteps: string | null;
  turnStoppedAt: string;
  turnId: number;
  sessionId: string;
  turnSeq: number;
  files: string[];
  concepts: string[];
  evidence: string[];
  counts: { files: number; concepts: number; evidence: number };
  scores: { importance: number; confidence: number; unresolved: number };
  /** Present on search results only. */
  matchSource?: ViewerMatchSource;
  semanticScore?: number | null;
}

export interface ViewerListResponse {
  items: ViewerObservationCard[];
  nextCursor: string | null;
  scopeKey: string | null;
  allScopes: boolean;
}

export interface ViewerSearchResponse {
  items: ViewerObservationCard[];
  scopeKey: string | null;
  allScopes: boolean;
  /** True when the query was too short for FTS and fell back to LIKE upstream. */
  query: string;
}

// --- Detail (memory side + truth side) ---

export interface ViewerObservationDetail {
  memory: ViewerObservationCard & {
    request: string | null;
    learned: string | null;
    createdAt: string;
    semantic: {
      protocol: string;
      status: string;
      attempts: number;
      failureReason: string | null;
      updatedAt: string;
    } | null;
    embeddings: { model: string; dimensions: number }[];
  };
  source: {
    turnId: number;
    sessionId: string;
    turnSeq: number;
    scopeKey: string;
    repo: string | null;
    cwd: string;
    state: string;
    startedAt: string;
    stoppedAt: string | null;
    promptText: string | null;
    promptTruncated: boolean;
    toolEventCount: number;
    events: { count: number; payloadBytes: number; byHook: { hookEventName: string; count: number }[] };
    artifacts: {
      toolNames: string[];
      files: string[];
      commands: string[];
      errorSignals: string[];
      decisionSignals: string[];
      facts: string[];
    } | null;
  };
  jobs: { id: number; jobType: string; state: string; attempts: number; updatedAt: string }[];
}

// --- Raw events ---

export interface ViewerTurnEvent {
  id: number;
  eventSeq: number;
  hookEventName: string;
  toolName: string | null;
  payloadSize: number;
  createdAt: string;
  /** Pretty-printed JSON when parseable, otherwise the raw string. */
  payload: string;
  payloadTruncated: boolean;
}

export interface ViewerEventsResponse {
  items: ViewerTurnEvent[];
  nextCursor: string | null;
  /** True when the response byte budget stopped the page early. */
  truncated: boolean;
}

// --- Context preview ---

export interface ViewerContextSection {
  kind: string;
  bytes: number;
  itemCount: number;
  dropped: boolean;
}

export interface ViewerContextPreview {
  scopeKey: string;
  text: string;
  usedBytes: number;
  effectiveMaxBytes: number;
  requestedMaxBytes: number;
  configuredMaxBytes: number;
  sections: ViewerContextSection[];
  observationIds: { pinned: number[]; detail: number[]; index: number[] };
  degraded: boolean;
}

// --- Retrieval health ---

export interface ViewerRetrievalHealth {
  retrieval: ViewerBootstrap['retrieval'] & { tieBreak: string };
  search24h: {
    requests: number;
    latencyMsP50: number;
    latencyMsP95: number;
    protocolSemanticEn: number;
    semanticEnRate: number;
    semanticQueryIssues: Record<string, number>;
    ftsOnly: number;
    degradeRate: number;
    zeroFts: number;
    zeroFtsRecalled: number;
    semanticOnlyTotal: number;
    semanticOnlyPerRequest: number;
    semanticOnlyMax: number;
    comparableVectorsAvg: number;
    scopeVectorsAvg: number;
    scopeVectorsMin: number;
    scopeVectorsMeasured: number;
    emptyScopeRequests: number;
  };
  embeddings: {
    ready: number;
    coverage: number;
    semanticEn: { ready: number; pending: number; failed: number };
  };
}

// --- Logs ---

export interface ViewerLogLine {
  at: string | null;
  component: string;
  message: string;
}

export interface ViewerLogsResponse {
  items: ViewerLogLine[];
  nextCursor: string | null;
}

// --- Delete ---

export interface ViewerDeleteResponse {
  ok: true;
  observationId: number;
  turnId: number;
  scopeKey: string;
}

// --- SSE ---

export type ViewerStreamEvent =
  | { type: 'initial_state'; scopeKey: string | null; allScopes: boolean; queue: ViewerQueueStatus; serverTime: string }
  | { type: 'observation_created'; scopeKey: string; observationId: number }
  | { type: 'observation_updated'; scopeKey: string; observationId: number; reason: string }
  | { type: 'observation_deleted'; scopeKey: string; observationId: number; turnId: number }
  | { type: 'processing_status'; queue: ViewerQueueStatus }
  | { type: 'heartbeat'; serverTime: string };

export interface ViewerErrorResponse {
  ok: false;
  error: string;
}
