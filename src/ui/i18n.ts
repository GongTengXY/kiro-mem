/** @jsxImportSource preact */
/**
 * Viewer strings (zh / en), one language at a time, chosen by `config.language`
 * and delivered in the bootstrap response.
 *
 * Deliberately separate from `src/i18n.ts`: that file is CLI and compressor
 * wording and imports server config types, neither of which belongs in a browser
 * bundle.
 *
 * Interpolating strings are functions, so a translation can place the value where
 * its own grammar needs it instead of following English word order.
 */

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export type ViewerLang = 'zh' | 'en';

export interface ViewerStrings {
  // --- top bar ---
  allWorkspaces: string;
  workspaceScope: string;
  workspacesCount: (n: number) => string;
  allWorkspacesHint: string;
  thisWorkspace: string;
  searchAll: string;
  searchThis: string;
  searchAria: string;
  panelContext: string;
  panelContextTitle: string;
  panelRetrieval: string;
  panelRetrievalTitle: string;
  panelLogs: string;
  panelLogsTitle: string;
  streamConnecting: string;
  streamOpen: string;
  streamClosed: string;
  streamUnauthorized: string;
  queueTitle: string;
  globalWarning: string;

  // --- feed ---
  observationsAria: string;
  searchNote: (n: number) => string;
  clear: string;
  emptyFeed: (allScopes: boolean) => string;
  emptyFeedHint: string;
  emptySearch: (allScopes: boolean) => string;
  emptySearchHint: string;
  loadMore: string;
  loading: string;

  // --- card ---
  openObservation: (id: number) => string;
  pin: string;
  unpin: string;
  pinAria: (id: number) => string;
  unpinAria: (id: number) => string;
  deleteTitle: string;
  deleteAria: (id: number) => string;
  filesCount: (n: number) => string;
  evidenceCount: (n: number) => string;
  matchFts: string;
  matchHybrid: string;
  matchSemantic: string;
  matchBigram: string;

  // --- detail ---
  detailAria: string;
  selectObservation: string;
  selectObservationHint: string;
  delete: string;
  close: string;
  pinnedChip: string;
  generatedMemory: string;
  sourceTurn: string;
  fSummary: string;
  fRequest: string;
  fOutcome: string;
  fLearned: string;
  fNextSteps: string;
  fScores: string;
  scoresValue: (importance: string, confidence: string, unresolved: string) => string;
  fFiles: (n: number) => string;
  fConcepts: (n: number) => string;
  fEvidence: (n: number) => string;
  fSemantic: string;
  noDerivedValue: string;
  fEmbeddings: string;
  noEmbeddings: string;
  fWorkspace: string;
  fSession: string;
  fCwd: string;
  fTime: string;
  fPrompt: string;
  noPrompt: string;
  promptTruncated: string;
  fRawEvents: string;
  rawEventsValue: (count: number, bytes: string) => string;
  fArtifactFiles: string;
  fCommands: string;
  fErrors: string;
  fDecisions: string;
  fFacts: string;
  fArtifacts: string;
  noArtifacts: string;
  fRelatedJobs: string;
  rawPayloads: (n: number) => string;
  hide: string;
  load: string;
  payloadsOnDemand: string;
  noRawEvents: string;
  byteBudgetReached: string;
  loadMoreEvents: string;
  payloadTruncated: string;

  // --- delete dialog ---
  deleteHeading: string;
  dObservation: string;
  dWorkspace: string;
  dTurn: string;
  dTruthLayer: string;
  truthLayerValue: (count: number, bytes: string) => string;
  deleteWarning: string;
  errLeased: string;
  errNotFound: string;
  errDelete: (code: string) => string;
  cancel: string;
  deleting: string;
  confirmDelete: string;

  // --- toasts ---
  toastPinned: (id: number) => string;
  toastUnpinned: (id: number) => string;
  toastPinFailed: (id: number, code: string) => string;
  dismiss: string;

  // --- context preview ---
  contextPreview: string;
  ctxUnknownScope: string;
  ctxScopeRequired: string;
  ctxFailed: (code: string) => string;
  ctxErrorHint: string;
  noPreview: string;
  bytesUsed: (used: number, max: number, pct: string) => string;
  contextBudgetAria: string;
  rebuild: string;
  rebuilding: string;
  useConfig: (bytes: number) => string;
  cappedAt: (requested: number, effective: number) => string;
  budgetTooSmall: string;
  colSection: string;
  colItems: string;
  colBytes: string;
  sectionDropped: string;
  injectedCounts: (pinned: number, detail: number, index: number) => string;
  sectionLabel: Record<string, string>;

  // --- retrieval health ---
  retrievalHealth: string;
  retrievalHealth24h: string;
  failedToLoad: (code: string) => string;
  noData: string;
  rProfile: string;
  profileValue: (profile: string, floor: number, cap: number | 'none', tieBreak: string) => string;
  rSearches: string;
  searchesValue: (requests: number, p50: number, p95: number) => string;
  rEnglishReach: string;
  englishReachValue: (hit: number, total: number, pct: string) => string;
  rSemanticIssues: string;
  rDegraded: string;
  degradedValue: (n: number, pct: string) => string;
  rZeroKeyword: string;
  zeroKeywordValue: (zero: number, recalled: number) => string;
  rSemanticOnly: string;
  semanticOnlyValue: (total: number, perRequest: string, max: number) => string;
  rVectors: string;
  vectorsValue: (avg: string, min: number, measured: number, empty: number) => string;
  rCoverage: string;
  coverageValue: (ready: number, pct: string, en: number, pending: number, failed: number) => string;
  countersNote: string;

  // --- logs ---
  workerErrorLog: string;
  filterComponent: string;
  noErrors: string;
  noErrorsHint: string;
  loadOlder: string;

  // --- fatal ---
  unauthorized: string;
  unauthorizedHint: string;
}

const EN: ViewerStrings = {
  allWorkspaces: 'All workspaces',
  workspaceScope: 'Workspace scope',
  workspacesCount: (n) => `${n} ${n === 1 ? 'workspace' : 'workspaces'}`,
  allWorkspacesHint: 'Memory from every project on this machine',
  thisWorkspace: 'this workspace',
  searchAll: 'Search all workspaces (keyword)',
  searchThis: 'Search this workspace (keyword)',
  searchAria: 'Search observations',
  panelContext: 'Context',
  panelContextTitle: 'Preview the context the next session will receive',
  panelRetrieval: 'Retrieval',
  panelRetrievalTitle: 'Retrieval health (last 24h)',
  panelLogs: 'Logs',
  panelLogsTitle: 'Worker error log',
  streamConnecting: 'connecting',
  streamOpen: 'live',
  streamClosed: 'reconnecting',
  streamUnauthorized: 'unauthorized',
  queueTitle: 'pending / leased / dead jobs',
  globalWarning: 'Browsing every workspace on this machine. Memory from other projects is visible.',

  observationsAria: 'Observations',
  searchNote: (n) =>
    `${n} keyword matches. Viewer search is keyword-only; results labelled "semantic only" are unverified leads.`,
  clear: 'Clear',
  emptyFeed: (all) => `No memory recorded for ${all ? 'any workspace' : 'this workspace'} yet.`,
  emptyFeedHint: 'Observations appear here one per closed turn, once compression finishes.',
  emptySearch: (all) => `No keyword match in ${all ? 'any workspace' : 'this workspace'}.`,
  emptySearchHint: 'Try a longer or different term — search here does not use the semantic leg.',
  loadMore: 'Load more',
  loading: 'Loading…',

  openObservation: (id) => `Open observation ${id}`,
  pin: 'Pin for later context',
  unpin: 'Unpin',
  pinAria: (id) => `Pin observation ${id}`,
  unpinAria: (id) => `Unpin observation ${id}`,
  deleteTitle: 'Permanently delete this memory and its source turn',
  deleteAria: (id) => `Permanently delete observation ${id}`,
  filesCount: (n) => `${n} files`,
  evidenceCount: (n) => `${n} evidence`,
  matchFts: 'keyword',
  matchHybrid: 'keyword + semantic',
  matchSemantic: 'semantic only — unverified',
  matchBigram: 'bigram — unverified',

  detailAria: 'Observation detail',
  selectObservation: 'Select an observation',
  selectObservationHint:
    'Each card opens the generated memory next to the prompt, artifacts and raw events it came from.',
  delete: 'Delete',
  close: 'Close',
  pinnedChip: 'pinned',
  generatedMemory: 'Generated memory',
  sourceTurn: 'Source turn (truth layer)',
  fSummary: 'summary',
  fRequest: 'request',
  fOutcome: 'outcome',
  fLearned: 'learned',
  fNextSteps: 'next steps',
  fScores: 'scores',
  scoresValue: (i, c, u) => `importance ${i} · confidence ${c} · unresolved ${u}`,
  fFiles: (n) => `files (${n})`,
  fConcepts: (n) => `concepts (${n})`,
  fEvidence: (n) => `evidence (${n})`,
  fSemantic: 'semantic normalization',
  noDerivedValue: 'no derived value',
  fEmbeddings: 'embeddings',
  noEmbeddings: 'none — not semantically reachable yet',
  fWorkspace: 'workspace',
  fSession: 'session',
  fCwd: 'cwd',
  fTime: 'time',
  fPrompt: 'prompt',
  noPrompt: 'no prompt recorded',
  promptTruncated: 'prompt truncated for display',
  fRawEvents: 'raw events',
  rawEventsValue: (count, bytes) => `${count} events · ${bytes} original`,
  fArtifactFiles: 'artifact files',
  fCommands: 'commands',
  fErrors: 'errors',
  fDecisions: 'decisions',
  fFacts: 'facts',
  fArtifacts: 'artifacts',
  noArtifacts: 'no deterministic artifacts stored',
  fRelatedJobs: 'related jobs',
  rawPayloads: (n) => `Raw event payloads (${n})`,
  hide: 'Hide',
  load: 'Load',
  payloadsOnDemand: 'Loaded on demand — a single turn can hold megabytes of tool output.',
  noRawEvents: 'No raw events stored for this turn.',
  byteBudgetReached: 'Response byte budget reached; load more to continue.',
  loadMoreEvents: 'Load more events',
  payloadTruncated: 'payload truncated for display',

  deleteHeading: 'Permanent delete',
  dObservation: 'Observation',
  dWorkspace: 'Workspace',
  dTurn: 'Turn',
  dTruthLayer: 'Truth layer to be destroyed',
  truthLayerValue: (count, bytes) => `${count} raw events · ${bytes} captured`,
  deleteWarning:
    'This permanently deletes the generated memory, the raw conversation events and the related indexes. It cannot be undone.',
  errLeased: 'A related job is running (leased); nothing was deleted. Retry once it finishes.',
  errNotFound: 'This memory no longer exists.',
  errDelete: (code) => `Delete failed: ${code}`,
  cancel: 'Cancel',
  deleting: 'Deleting…',
  confirmDelete: 'Permanently delete',

  toastPinned: (id) => `Pinned #O${id} — injected first in the next session`,
  toastUnpinned: (id) => `Unpinned #O${id}`,
  toastPinFailed: (id, code) => `Failed, reverted · #O${id} (${code})`,
  dismiss: 'Dismiss',

  contextPreview: 'Context preview',
  ctxUnknownScope: 'This workspace is not known to the database yet.',
  ctxScopeRequired: 'Select a workspace to preview its injected context.',
  ctxFailed: (code) => `Preview failed: ${code}`,
  ctxErrorHint: 'Context injection is per-workspace; pick a workspace that has memory or session history.',
  noPreview: 'No preview yet.',
  bytesUsed: (used, max, pct) => `${used} / ${max} bytes (${pct}%)`,
  contextBudgetAria: 'Context budget in bytes',
  rebuild: 'Rebuild preview',
  rebuilding: 'Rebuilding…',
  useConfig: (bytes) => `Use config (${bytes})`,
  cappedAt: (requested, effective) =>
    `Requested ${requested} bytes; the server caps injection at ${effective}.`,
  budgetTooSmall: 'Budget too small for any content — only the frame would be injected.',
  colSection: 'section',
  colItems: 'items',
  colBytes: 'bytes',
  sectionDropped: ' (dropped)',
  injectedCounts: (pinned, detail, index) =>
    `Injected observations — pinned: ${pinned}, detail: ${detail}, index: ${index}`,
  sectionLabel: {
    'frame-open': 'frame',
    'trust-boundary': 'trust boundary',
    usage: 'usage note',
    pinned: 'pinned',
    'recent-detail': 'recent (detail)',
    'recent-index': 'recent (index)',
    'frame-close': 'frame close',
  },

  retrievalHealth: 'Retrieval health',
  retrievalHealth24h: 'Retrieval health (last 24h)',
  failedToLoad: (code) => `Failed to load: ${code}`,
  noData: 'No data.',
  rProfile: 'profile',
  profileValue: (profile, floor, cap, tieBreak) =>
    `${profile} · floor ${floor} · semantic-only cap ${cap} · tie-break ${tieBreak}`,
  rSearches: 'agent searches',
  searchesValue: (requests, p50, p95) => `${requests} requests · p50 ${p50}ms · p95 ${p95}ms`,
  rEnglishReach: 'English space reach',
  englishReachValue: (hit, total, pct) =>
    `${hit} of ${total} (${pct}) — independent semantic recall only works there`,
  rSemanticIssues: 'semantic_query_en issues',
  rDegraded: 'degraded to keyword-only',
  degradedValue: (n, pct) => `${n} (${pct}) — embedding unavailable`,
  rZeroKeyword: 'zero-keyword queries',
  zeroKeywordValue: (zero, recalled) => `${zero}, recalled semantically ${recalled}`,
  rSemanticOnly: 'unverified semantic-only leads',
  semanticOnlyValue: (total, perRequest, max) =>
    `${total} total · ${perRequest}/request · worst page ${max}`,
  rVectors: 'vectors',
  vectorsValue: (avg, min, measured, empty) =>
    `scope avg ${avg} · min ${min} · measured on ${measured} requests · empty-scope requests ${empty}`,
  rCoverage: 'embedding coverage',
  coverageValue: (ready, pct, en, pending, failed) =>
    `${ready} ready (${pct}) · semantic-en ready ${en}, pending ${pending}, failed ${failed}`,
  countersNote:
    'Counters cover agent searches through MCP. Viewer search is keyword-only and is deliberately not counted here.',

  workerErrorLog: 'Worker error log',
  filterComponent: 'filter component',
  noErrors: 'No errors logged.',
  noErrorsHint: 'This log only records failures; an empty drawer is the healthy state.',
  loadOlder: 'Load older',

  unauthorized: 'This Viewer session is no longer authorized.',
  unauthorizedHint:
    'Run `kiro-mem viewer` again in your terminal to open a fresh session. The token lives only in this browser tab.',
};

const ZH: ViewerStrings = {
  allWorkspaces: '全部工作区',
  workspaceScope: '工作区范围',
  workspacesCount: (n) => `${n} 个工作区`,
  allWorkspacesHint: '本机所有项目的记忆',
  thisWorkspace: '当前工作区',
  searchAll: '搜索全部工作区（关键词）',
  searchThis: '搜索当前工作区（关键词）',
  searchAria: '搜索记忆',
  panelContext: '注入上下文',
  panelContextTitle: '预览下次会话会收到的上下文',
  panelRetrieval: '检索状态',
  panelRetrievalTitle: '检索健康度（近 24 小时）',
  panelLogs: '日志',
  panelLogsTitle: 'Worker 错误日志',
  streamConnecting: '连接中',
  streamOpen: '实时',
  streamClosed: '重连中',
  streamUnauthorized: '未授权',
  queueTitle: '排队中 / 执行中 / 已失败 任务',
  globalWarning: '正在浏览本机所有工作区，其他项目的记忆同样可见。',

  observationsAria: '记忆列表',
  searchNote: (n) => `匹配到 ${n} 条。此处只做关键词搜索，标为"仅语义"的结果属于未核实线索。`,
  clear: '清除',
  emptyFeed: (all) => (all ? '还没有任何工作区记录过记忆。' : '当前工作区还没有记录任何记忆。'),
  emptyFeedHint: '每一轮对话结束并完成压缩后，会在这里出现一条记忆。',
  emptySearch: (all) => (all ? '所有工作区都没有匹配的关键词。' : '当前工作区没有匹配的关键词。'),
  emptySearchHint: '换个更长或不同的词试试——这里的搜索不走语义检索。',
  loadMore: '加载更多',
  loading: '加载中…',

  openObservation: (id) => `打开记忆 ${id}`,
  pin: '置顶，供后续会话优先使用',
  unpin: '取消置顶',
  pinAria: (id) => `置顶记忆 ${id}`,
  unpinAria: (id) => `取消置顶记忆 ${id}`,
  deleteTitle: '永久删除这条记忆及其原始对话',
  deleteAria: (id) => `永久删除记忆 ${id}`,
  filesCount: (n) => `${n} 个文件`,
  evidenceCount: (n) => `${n} 条证据`,
  matchFts: '关键词',
  matchHybrid: '关键词 + 语义',
  matchSemantic: '仅语义 — 未核实',
  matchBigram: '双字组 — 未核实',

  detailAria: '记忆详情',
  selectObservation: '选择一条记忆',
  selectObservationHint: '点开任意卡片，左边是生成的记忆，右边是它来源的提示词、产物和原始事件。',
  delete: '删除',
  close: '关闭',
  pinnedChip: '已置顶',
  generatedMemory: '生成的记忆',
  sourceTurn: '来源对话（真相层）',
  fSummary: '摘要',
  fRequest: '用户请求',
  fOutcome: '结果',
  fLearned: '结论',
  fNextSteps: '后续事项',
  fScores: '评分',
  scoresValue: (i, c, u) => `重要性 ${i} · 置信度 ${c} · 未决 ${u}`,
  fFiles: (n) => `文件（${n}）`,
  fConcepts: (n) => `概念（${n}）`,
  fEvidence: (n) => `证据（${n}）`,
  fSemantic: '语义归一化',
  noDerivedValue: '无派生值',
  fEmbeddings: '向量',
  noEmbeddings: '无 — 尚不能被语义检索命中',
  fWorkspace: '工作区',
  fSession: '会话',
  fCwd: '工作目录',
  fTime: '时间',
  fPrompt: '提示词',
  noPrompt: '未记录提示词',
  promptTruncated: '提示词已截断显示',
  fRawEvents: '原始事件',
  rawEventsValue: (count, bytes) => `${count} 个事件 · 原始 ${bytes}`,
  fArtifactFiles: '涉及文件',
  fCommands: '执行命令',
  fErrors: '错误信号',
  fDecisions: '决策信号',
  fFacts: '事实',
  fArtifacts: '确定性产物',
  noArtifacts: '未存储确定性产物',
  fRelatedJobs: '关联任务',
  rawPayloads: (n) => `原始事件载荷（${n}）`,
  hide: '收起',
  load: '加载',
  payloadsOnDemand: '按需加载 —— 单轮对话的工具输出可能有几 MB。',
  noRawEvents: '这一轮没有存储原始事件。',
  byteBudgetReached: '已达到单次响应字节上限，继续加载查看余下内容。',
  loadMoreEvents: '加载更多事件',
  payloadTruncated: '载荷已截断显示',

  deleteHeading: '永久删除',
  dObservation: '记忆',
  dWorkspace: '工作区',
  dTurn: '来源对话',
  dTruthLayer: '将一并销毁的真相层',
  truthLayerValue: (count, bytes) => `${count} 个原始事件 · 已捕获 ${bytes}`,
  deleteWarning: '将永久删除这条生成记忆、原始对话事件和相关索引。删除后无法恢复。',
  errLeased: '有关联任务正在执行（leased），未删除任何数据。等它结束后重试。',
  errNotFound: '这条记忆已经不存在了。',
  errDelete: (code) => `删除失败：${code}`,
  cancel: '取消',
  deleting: '删除中…',
  confirmDelete: '永久删除',

  toastPinned: (id) => `已置顶 #O${id} —— 下次会话优先注入`,
  toastUnpinned: (id) => `已取消置顶 #O${id}`,
  toastPinFailed: (id, code) => `操作失败，已回滚 · #O${id}（${code}）`,
  dismiss: '点击关闭',

  contextPreview: '注入上下文预览',
  ctxUnknownScope: '数据库里还没有这个工作区。',
  ctxScopeRequired: '先选择一个工作区，才能预览它注入的上下文。',
  ctxFailed: (code) => `预览失败：${code}`,
  ctxErrorHint: '上下文按工作区注入，请选择一个已有记忆或会话记录的工作区。',
  noPreview: '暂无预览。',
  bytesUsed: (used, max, pct) => `${used} / ${max} 字节（${pct}%）`,
  contextBudgetAria: '上下文预算（字节）',
  rebuild: '重新生成预览',
  rebuilding: '生成中…',
  useConfig: (bytes) => `使用配置值（${bytes}）`,
  cappedAt: (requested, effective) => `请求 ${requested} 字节；服务端将注入上限压到 ${effective}。`,
  budgetTooSmall: '预算太小，放不下任何内容 —— 只会注入外层框架。',
  colSection: '区块',
  colItems: '条数',
  colBytes: '字节',
  sectionDropped: '（已丢弃）',
  injectedCounts: (pinned, detail, index) =>
    `注入的记忆 —— 置顶 ${pinned} 条，详情 ${detail} 条，索引 ${index} 条`,
  sectionLabel: {
    'frame-open': '外层框架',
    'trust-boundary': '信任边界',
    usage: '使用说明',
    pinned: '置顶',
    'recent-detail': '近期（详情）',
    'recent-index': '近期（索引）',
    'frame-close': '框架结束',
  },

  retrievalHealth: '检索健康度',
  retrievalHealth24h: '检索健康度（近 24 小时）',
  failedToLoad: (code) => `加载失败：${code}`,
  noData: '暂无数据。',
  rProfile: '当前档位',
  profileValue: (profile, floor, cap, tieBreak) =>
    `${profile} · 相似度下限 ${floor} · 纯语义结果上限 ${cap} · 同分排序 ${tieBreak}`,
  rSearches: 'Agent 搜索',
  searchesValue: (requests, p50, p95) => `${requests} 次 · p50 ${p50}ms · p95 ${p95}ms`,
  rEnglishReach: '英文向量空间覆盖率',
  englishReachValue: (hit, total, pct) => `${total} 次中 ${hit} 次（${pct}）—— 独立语义召回只在该空间生效`,
  rSemanticIssues: 'semantic_query_en 问题',
  rDegraded: '降级为纯关键词',
  degradedValue: (n, pct) => `${n} 次（${pct}）—— 向量不可用`,
  rZeroKeyword: '关键词零命中',
  zeroKeywordValue: (zero, recalled) => `${zero} 次，其中 ${recalled} 次靠语义救回`,
  rSemanticOnly: '未核实的纯语义线索',
  semanticOnlyValue: (total, perRequest, max) => `共 ${total} 条 · 每次 ${perRequest} 条 · 单页最多 ${max} 条`,
  rVectors: '向量',
  vectorsValue: (avg, min, measured, empty) =>
    `范围内平均 ${avg} · 最少 ${min} · 有 ${measured} 次被统计 · 空范围请求 ${empty} 次`,
  rCoverage: '向量覆盖',
  coverageValue: (ready, pct, en, pending, failed) =>
    `${ready} 条就绪（${pct}）· 英文空间就绪 ${en}，待处理 ${pending}，失败 ${failed}`,
  countersNote: '这些计数只统计 Agent 通过 MCP 发起的搜索。Viewer 自身的搜索是纯关键词，刻意不计入。',

  workerErrorLog: 'Worker 错误日志',
  filterComponent: '按组件过滤',
  noErrors: '没有记录到错误。',
  noErrorsHint: '这里只记录失败；空的就是健康状态。',
  loadOlder: '加载更早',

  unauthorized: '这个 Viewer 会话已失去授权。',
  unauthorizedHint: '在终端重新执行 `kiro-mem viewer` 打开新会话。令牌只存在于当前浏览器标签页。',
};

export const VIEWER_STRINGS: Record<ViewerLang, ViewerStrings> = { en: EN, zh: ZH };

/** English until the bootstrap response says otherwise. */
export const LangContext = createContext<ViewerStrings>(EN);

export function useT(): ViewerStrings {
  return useContext(LangContext);
}
