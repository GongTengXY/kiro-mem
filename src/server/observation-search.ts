/**
 * Scope-aware hybrid retrieval over Observations.
 *
 * This is the shared retrieval kernel (design §7.1): FTS candidates fused with
 * local semantic candidates via Reciprocal Rank Fusion (RRF), then ordered
 * with a stable tie-break. It serves the MCP `search` pull path today and the
 * optional auto-push enhancement later.
 *
 * Pulled out of the MCP server module so it has NO import side effects (the
 * server constructs a DB singleton) and can be unit-tested with an injected
 * embedder and an in-memory DB.
 */

import type { MemoryDB } from '../db';
// A pure string function about FTS tokenization granularity, so it lives next to
// `extractFtsSearchUnits` in the db layer rather than being duplicated here. The
// module has no import side effects — the DB singleton is constructed by the
// caller and passed in, which is the property this file's header protects.
import { extractCjkBigrams, DEFAULT_SEARCH_DAYS } from '../db';
import type { Observation } from '../db/types';
import {
  cosineSimilarity,
  blobToEmbedding,
  withEmbeddingTimeout,
  DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS,
  DIMENSIONS,
} from '../embedding-space';
import {
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
  checkSemanticEnQuery,
  embeddingSpaceKey,
  type NormalizationProtocol,
  type NormalizationRejectReason,
} from '../semantic-en';

/** Server-owned retrieval policy. It is injectable for evaluation, not MCP input. */
export interface RetrievalPolicy {
  /**
   * Allow semantic candidates without an FTS match. This is effective only for a
   * valid `semantic-en-v1` query; otherwise the request is FTS-only.
   */
  semanticDiscovery: boolean;
  /**
   * Strict cosine lower bound (`score > floor`) for `semantic-en-v1` candidates.
   * The value is protocol-specific and must not be reused for raw vectors.
   */
  semanticFloor: number;
  /**
   * Post-fusion quota for `match_source: "semantic"`. It does not bound `fts` or
   * `hybrid`, so it is not a whole-page false-recall guardrail.
   */
  semanticOnlyLimit: number;
  /** RRF rank-fusion constant. */
  rrfK: number;
  ftsWeight: number;
  semanticWeight: number;
  /**
   * Exact-score tie-break. `semantic-rank` orders source confidence first
   * (`hybrid > semantic > fts`), then semantic rank, recency and id.
   */
  tieBreak: 'recency' | 'source-confidence' | 'semantic-rank';
  /** Recent semantic pool size; `Infinity` scans the full filtered scope. */
  semanticCandidatePool: number;
  /**
   * Optional CJK two-character discovery leg. It remains off: the measured arms
   * improved recall but exceeded false-recall bounds.
   */
  bigramAux: boolean;
  /** Maximum `document frequency / scope size` for an admitted bigram. */
  bigramDfRatioCeiling: number;
  /** Minimum number of distinct admitted bigrams a record must match. */
  bigramMinMatches: number;
  /** Post-fusion quota for results found only by the bigram leg. */
  bigramOnlyLimit: number;
  /** RRF weight of the bigram leg. */
  bigramWeight: number;
  /**
   * `always` votes for every bigram match. `discovery-only` votes only when FTS
   * and semantic search did not already find the record.
   */
  bigramVote: 'always' | 'discovery-only';
  /**
   * Number of top semantic candidates retained by the streaming scorer. Lexical
   * candidates are always retained and keep their true global semantic rank.
   */
  semanticTopK: number;
}

/**
 * Frozen production policy. Quality changes require a new calibrated evaluation;
 * benchmark history belongs in reports, not in this runtime definition.
 */
export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  semanticDiscovery: true,
  semanticFloor: 0.197,
  semanticOnlyLimit: 2,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: 'semantic-rank',
  semanticCandidatePool: Number.POSITIVE_INFINITY,
  // The measured bigram arms exceeded false-recall bounds.
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  bigramVote: 'always',
  // Full-scope vectors are streamed; only the best 1,000 semantic ranks survive.
  semanticTopK: 1000,
};

/**
 * Explicit lexical-anchor rollback for valid English queries. Missing or rejected
 * English forms remain FTS-only; unsafe raw-vector reranking is not restored.
 */
export const LEXICAL_ANCHOR_ROLLBACK_POLICY: RetrievalPolicy = {
  semanticDiscovery: false,
  semanticFloor: 0.2,
  semanticOnlyLimit: Number.POSITIVE_INFINITY,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: 'recency',
  semanticCandidatePool: 200,
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  bigramVote: 'always',
  semanticTopK: Number.POSITIVE_INFINITY,
};

/**
 * Map the gray-release switch onto one of the two frozen profiles.
 *
 * Takes a boolean rather than the `Config` object so the retrieval kernel keeps
 * no dependency on the config file layout, and so a benchmark or test can select
 * a profile without writing a config. The MCP server calls it once per process
 * with `config.retrieval.semanticDiscovery`.
 *
 * There is deliberately no third state and no partial merge: the two profiles
 * are the only two combinations that have been measured end to end.
 */
export function resolveRetrievalPolicy(semanticDiscoveryEnabled: boolean): RetrievalPolicy {
  return semanticDiscoveryEnabled ? DEFAULT_RETRIEVAL_POLICY : LEXICAL_ANCHOR_ROLLBACK_POLICY;
}

/**
 * How many candidate ids one streaming chunk fetches and scores.
 *
 * Implementation constant, not a strategy field: it bounds peak memory
 * (`4096 × 384 × 4B ≈ 6.3MB` of vector payload per chunk) and keeps the bound
 * parameter count far below SQLite's 65,535 ceiling. Changing it must not change
 * any returned result — `topk-criteria.md` §3.3 and the chunk-boundary tests pin
 * that.
 */
const SEMANTIC_STREAM_CHUNK = 4096;

/**
 * Score candidate vectors in chunks, retaining only a bounded top set.
 *
 * Replaces "fetch every blob → convert every one → aggregate every above-floor
 * candidate → sort". That path is what made scope-wide scoring cost +720MB at
 * 50,000 records while passing the latency budget (pool round §9).
 *
 * Two properties make this equivalent to the old path rather than an approximation:
 *
 *  - `ids` arrive ascending and the comparator is `(score desc, id asc)`, which is
 *    exactly the order a stable sort over SQLite's ascending rows produced;
 *  - `mustKeep` candidates are retained regardless of rank, and every retained
 *    candidate carries its TRUE global rank — including one that fell outside the
 *    top set, whose rank comes from an exact "how many outrank me" counter rather
 *    than from its position in the retained array.
 *
 * `topK = Infinity` retains everything above the floor, i.e. the pre-streaming
 * behavior, which is what phase 1 ships.
 */
function streamScoreCandidates(
  db: MemoryDB,
  ids: number[],
  mustKeep: ReadonlySet<number>,
  queryEmbedding: Float32Array,
  opts: { spaceKey: string; dimensions: number; floor: number; topK: number },
): {
  scored: { id: number; score: number; rank: number }[];
  comparableVectors: number;
  aboveFloor: number;
} {
  const { spaceKey, dimensions, floor, topK } = opts;
  /** `true` when a ranks strictly worse than b — the eviction order. */
  const worse = (a: { id: number; score: number }, b: { id: number; score: number }): boolean =>
    a.score < b.score || (a.score === b.score && a.id > b.id);

  // Min-heap keyed by the eviction order, so the root is the first candidate to
  // drop. An array + full sort per insert would be O(N·K); this is O(N·log K).
  const heap: { id: number; score: number }[] = [];
  const siftUp = (start: number): void => {
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (worse(heap[i]!, heap[parent]!)) { const t = heap[i]!; heap[i] = heap[parent]!; heap[parent] = t; i = parent; }
      else break;
    }
  };
  const siftDown = (start: number): void => {
    let i = start;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && worse(heap[l]!, heap[m]!)) m = l;
      if (r < heap.length && worse(heap[r]!, heap[m]!)) m = r;
      if (m === i) break;
      const t = heap[i]!; heap[i] = heap[m]!; heap[m] = t; i = m;
    }
  };

  // Scores of the must-keep candidates, plus "how many candidates outrank me".
  // Filled in a first pass over the must-keep ids only (≤ FTS limit + bigram cap
  // entries), because a counter can only count items seen AFTER it exists — and a
  // must-keep candidate may be scored late in the stream.
  const keepScore = new Map<number, number>();
  const outranked = new Map<number, number>();
  let comparableVectors = 0;
  let aboveFloor = 0;

  const fetch = (chunk: number[]): { observation_id: number; embedding: Buffer }[] =>
    // Version-filtered: a blob written by another model OR another text
    // normalization protocol (or a corrupted one) is dropped here, so it degrades
    // to keyword-only reachability instead of producing a confident-looking but
    // meaningless similarity score. `raw-v1` and `semantic-en-v1` are both 384
    // dimensions of the same model, which is why the filter is the full space key.
    db.getObservationEmbeddingsByIds(chunk, { model: spaceKey, dimensions });

  const keepIds = ids.filter((id) => mustKeep.has(id));
  for (let i = 0; i < keepIds.length; i += SEMANTIC_STREAM_CHUNK) {
    for (const row of fetch(keepIds.slice(i, i + SEMANTIC_STREAM_CHUNK))) {
      const score = cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding));
      if (score > floor) { keepScore.set(row.observation_id, score); outranked.set(row.observation_id, 0); }
    }
  }

  for (let i = 0; i < ids.length; i += SEMANTIC_STREAM_CHUNK) {
    for (const row of fetch(ids.slice(i, i + SEMANTIC_STREAM_CHUNK))) {
      comparableVectors++;
      const id = row.observation_id;
      const score = cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding));
      if (score <= floor) continue;
      aboveFloor++;
      const item = { id, score };
      // Exact global rank bookkeeping for must-keep candidates: count everything
      // that outranks them, whether or not it survives in the heap.
      for (const [keepId, keepSc] of keepScore) {
        if (keepId !== id && worse({ id: keepId, score: keepSc }, item)) {
          outranked.set(keepId, outranked.get(keepId)! + 1);
        }
      }
      if (heap.length < topK) { heap.push(item); siftUp(heap.length - 1); }
      else if (topK > 0 && worse(heap[0]!, item)) { heap[0] = item; siftDown(0); }
    }
  }

  // The heap holds the top `min(topK, aboveFloor)` candidates. Sorting them by the
  // same comparator yields positions that ARE global ranks, because every candidate
  // ranking above a retained one is also retained.
  const top = heap.slice().sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : 0));
  const scored: { id: number; score: number; rank: number }[] = top.map((item, idx) => ({
    id: item.id,
    score: item.score,
    rank: idx + 1,
  }));
  // Must-keep candidates that the heap dropped: rank from the exact counter, never
  // `topK + 1`.
  const retained = new Set(top.map((x) => x.id));
  for (const [id, score] of keepScore) {
    if (!retained.has(id)) scored.push({ id, score, rank: outranked.get(id)! + 1 });
  }
  return { scored, comparableVectors, aboveFloor };
}

/** Shared empty rank map for the early-return observation payload. */
const EMPTY_RANKS: ReadonlyMap<number, number> = new Map();
/** Same, for the bigram attribution map. */
const EMPTY_MATCHED: ReadonlyMap<number, readonly string[]> = new Map();

/**
 * Range-check a retrieval policy. Returns human-readable errors; empty = valid.
 *
 * Centralized here rather than at each injection site so a benchmark arm, a test
 * fixture and any future config path all agree on what "valid" means. The caller
 * decides how to fail — `benchmark/run.ts` exits 2 BEFORE seeding, because a
 * silently coerced value produces a full report whose provenance names a policy
 * that never ran, and that report is indistinguishable from a real one.
 *
 * The bounds are not stylistic:
 *
 *  - `semanticFloor` outside [-1, 1] is unreachable for cosine similarity, so it
 *    silently means "keep everything" or "keep nothing" while reading like a
 *    threshold. `NaN` is worse: every `score > NaN` is false, so the semantic leg
 *    goes silently empty and the arm looks like a floor result.
 *  - `semanticOnlyLimit` must be a non-negative integer or `Infinity`. A
 *    fractional cap makes `min(cap, limit)` compare against a value no integer
 *    count can equal, so the reported cap and the enforced cap differ.
 *  - `rrfK` must be a positive integer: 0 makes rank 1 contribute `w/1` and
 *    a negative K can make `rrfK + rank` zero (division by zero → Infinity) or
 *    flip the sign so worse ranks score higher.
 *  - Weights must be finite and positive. Zero silently disables a whole leg
 *    while the report still claims two-leg fusion; negative inverts it.
 */
export function validateRetrievalPolicy(policy: RetrievalPolicy): string[] {
  const errors: string[] = [];
  const { semanticFloor, semanticOnlyLimit, rrfK, ftsWeight, semanticWeight } = policy;

  if (!Number.isFinite(semanticFloor) || semanticFloor < -1 || semanticFloor > 1) {
    errors.push(`semanticFloor=${semanticFloor} 必须是 [-1, 1] 内的有限数（cosine 值域）`);
  }
  if (
    semanticOnlyLimit !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(semanticOnlyLimit) || semanticOnlyLimit < 0)
  ) {
    errors.push(`semanticOnlyLimit=${semanticOnlyLimit} 必须是非负整数或 Infinity（无上限）`);
  }
  if (!Number.isInteger(rrfK) || rrfK <= 0) {
    errors.push(`rrfK=${rrfK} 必须是正整数`);
  }
  for (const [name, w] of [['ftsWeight', ftsWeight], ['semanticWeight', semanticWeight]] as const) {
    if (!Number.isFinite(w) || w <= 0) {
      errors.push(`${name}=${w} 必须是有限正数（0 会静默关掉一整条腿）`);
    }
  }
  if (
    policy.tieBreak !== 'recency' &&
    policy.tieBreak !== 'source-confidence' &&
    policy.tieBreak !== 'semantic-rank'
  ) {
    errors.push(
      `tieBreak=${String(policy.tieBreak)} 只接受 recency | source-confidence | semantic-rank`,
    );
  }
  if (typeof policy.semanticDiscovery !== 'boolean') {
    errors.push(`semanticDiscovery=${String(policy.semanticDiscovery)} 必须是布尔值`);
  }
  // --- phase 3B candidate pool ---
  //
  // Must be a POSITIVE integer or Infinity. 0 empties the semantic pool while the
  // report still claims two-leg fusion — the FTS union would keep results coming,
  // so the arm would look like a floor or cap result instead of a pool result.
  // A fractional value is worse than wrong: SQLite coerces it, so the enforced
  // pool and the reported pool differ with no error anywhere.
  if (
    policy.semanticCandidatePool !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(policy.semanticCandidatePool) || policy.semanticCandidatePool < 1)
  ) {
    errors.push(
      `semanticCandidatePool=${policy.semanticCandidatePool} 必须是 ≥1 的整数或 Infinity（全 scope）`,
    );
  }
  if (
    policy.semanticTopK !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(policy.semanticTopK) || policy.semanticTopK < 1)
  ) {
    errors.push(
      `semanticTopK=${policy.semanticTopK} 必须是 ≥1 的整数或 Infinity（不截断）`,
    );
  }
  // --- phase 3A bigram leg ---
  //
  // Same reasoning as above: a silently coerced value produces a full report
  // whose provenance names a policy that never ran.
  if (typeof policy.bigramAux !== 'boolean') {
    errors.push(`bigramAux=${String(policy.bigramAux)} 必须是布尔值`);
  }
  if (
    !Number.isFinite(policy.bigramDfRatioCeiling) ||
    policy.bigramDfRatioCeiling <= 0 ||
    policy.bigramDfRatioCeiling > 1
  ) {
    // 0 would drop every bigram while the report still claims the leg ran; >1 is
    // not expressible as a document fraction. `1` is the legal "no ceiling".
    errors.push(`bigramDfRatioCeiling=${policy.bigramDfRatioCeiling} 必须落在 (0, 1]（文档频率比例）`);
  }
  if (!Number.isInteger(policy.bigramMinMatches) || policy.bigramMinMatches < 1) {
    errors.push(`bigramMinMatches=${policy.bigramMinMatches} 必须是 ≥1 的整数`);
  }
  if (
    policy.bigramOnlyLimit !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(policy.bigramOnlyLimit) || policy.bigramOnlyLimit < 0)
  ) {
    errors.push(`bigramOnlyLimit=${policy.bigramOnlyLimit} 必须是非负整数或 Infinity（无上限）`);
  }
  if (!Number.isFinite(policy.bigramWeight) || policy.bigramWeight <= 0) {
    errors.push(`bigramWeight=${policy.bigramWeight} 必须是有限正数（0 会静默关掉这条腿）`);
  }
  if (policy.bigramVote !== 'always' && policy.bigramVote !== 'discovery-only') {
    errors.push(`bigramVote=${String(policy.bigramVote)} 只接受 always | discovery-only`);
  }
  return errors;
}

/**
 * Default embedder: the bundled local model, loaded LAZILY.
 *
 * The import is dynamic on purpose. Statically importing `../embedding` pulls
 * `@huggingface/transformers` into every process that touches this module —
 * measured at 54MB RSS / 128ms even when no model is instantiated — and after
 * phase 1b the MCP server must hold neither the runtime nor a model: it passes
 * a Worker-backed embedder instead, so exactly one model instance serves every
 * repo sharing a dataDir. Callers that DO want in-process inference (the
 * benchmark harness, offline probes) keep working unchanged.
 */
async function localEmbedding(text: string): Promise<Float32Array> {
  const { generateEmbedding } = await import('../embedding');
  return generateEmbedding(text);
}

export interface ObservationSearchOpts {
  /** Omit only for an explicit all-scopes search. */
  scopeKey?: string;
  type?: string;
  /** Omitted means the unbounded default. */
  days?: number;
  limit?: number;
  /** Valid English form enables the semantic leg; missing or rejected means FTS-only. */
  semanticQueryEn?: string;
}

export interface ObservationSearchDeps {
  /** Evaluation/test override. Production passes a frozen complete profile. */
  policy?: Partial<RetrievalPolicy>;
  generateEmbedding?: (text: string) => Promise<Float32Array>;
  /** Must identify the vector space produced by the injected embedder. */
  embeddingModel?: string;
  embeddingDimensions?: number;
  embeddingTimeoutMs?: number;
  onDegrade?: () => void;
  /** Read-only candidate diagnostics; fires once for every non-blank search. */
  onCandidates?: (info: {
    ftsCount: number;
    /** Retained semantic candidates; may be smaller than `aboveFloorCount`. */
    semanticCount: number;
    /** Exact number of candidates above the floor before Top-K retention. */
    aboveFloorCount: number;
    /** Stored vectors actually scored in the filtered candidate pool. */
    comparableVectors: number;
    /** Active-space vectors in the scope; null when the semantic step did not run. */
    scopeVectors: number | null;
    ftsRank: ReadonlyMap<number, number>;
    semanticRank: ReadonlyMap<number, number>;
    protocol: NormalizationProtocol;
    semanticQueryRejected: NormalizationRejectReason | null;
    policy: RetrievalPolicy;
    discoveryRequested: boolean;
    discoveryEffective: boolean;
    bigramCount: number;
    bigramRank: ReadonlyMap<number, number>;
    /** Benchmark-only attribution; runtime metrics must not persist these strings. */
    bigramMatched: ReadonlyMap<number, readonly string[]>;
    bigramUnits: {
      probed: number;
      dropped: { bigram: string; df: number }[];
      zeroDf: number;
      scopeSize: number;
    };
  }) => void;
  /** Read-only diagnostics after fusion and before result projection. */
  onFusion?: (info: {
    semanticOnlyDropped: number;
    semanticOnlyReturned: number;
    bigramOnlyDropped: number;
    bigramOnlyReturned: number;
    bigramVoteMode: RetrievalPolicy['bigramVote'];
    bigramVotesSuppressed: number;
    /** Full fused order before source quotas and request limit. */
    ranked: readonly {
      id: number;
      score: number;
      matchSource: 'fts' | 'semantic' | 'hybrid' | 'bigram';
      semRank: number | null;
      bigramRank: number | null;
    }[];
  }) => void;
}

export type ScoredObservation = Observation & {
  /** `hybrid` means semantic plus trigram FTS; bigram alone is not strong evidence. */
  match_source: 'fts' | 'semantic' | 'hybrid' | 'bigram';
  semantic_score: number | null;
};

/**
 * Returns Observations ranked by weighted RRF over FTS + semantic candidate
 * lists, hard-scoped by `opts.scopeKey`. If embeddings are unavailable the
 * search degrades gracefully to FTS-only.
 *
 * Floor, semantic-only cap, fusion weights, RRF K, tie-break and whether the
 * semantic leg may discover unanchored records all come from
 * {@link RetrievalPolicy}: {@link DEFAULT_RETRIEVAL_POLICY} in production,
 * {@link LEXICAL_ANCHOR_ROLLBACK_POLICY} when the gray-release switch is off, and
 * arbitrary overrides only from benchmark arms and tests via `deps.policy`.
 */
export async function hybridSearchObservations(
  db: MemoryDB,
  query: string,
  opts?: ObservationSearchOpts,
  deps?: ObservationSearchDeps,
): Promise<ScoredObservation[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const limit = opts?.limit ?? 20;
  // Phase 3C: unbounded by default, matching bootstrap's visible range. The
  // value is imported rather than repeated because the old `?? 90` existed in
  // four separate layers (kernel, two db methods, MCP), and any one of them left
  // behind would keep filtering while every other layer read as unbounded.
  const days = opts?.days ?? DEFAULT_SEARCH_DAYS;
  const scopeKey = opts?.scopeKey;
  const generateEmbedding = deps?.generateEmbedding ?? localEmbedding;
  const embeddingTimeoutMs = deps?.embeddingTimeoutMs ?? DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS;
  const policy: RetrievalPolicy = { ...DEFAULT_RETRIEVAL_POLICY, ...deps?.policy };

  // --- Which vector space are we in? ---
  //
  // Decided once, here, and used for BOTH the text we embed and the stored rows
  // we read. That single point is what makes a cross-protocol comparison
  // unrepresentable rather than merely discouraged: there is no code path where
  // the query text comes from one protocol and the space key from another.
  const supplied = opts?.semanticQueryEn?.trim() ?? '';
  const check = supplied ? checkSemanticEnQuery(supplied, normalizedQuery) : null;
  const useEnglish = check?.ok === true;
  const protocol: NormalizationProtocol = useEnglish ? SEMANTIC_EN_PROTOCOL : RAW_PROTOCOL;
  const semanticQueryRejected = check && !check.ok ? check.reason : null;
  const queryTextForEmbedding = useEnglish ? supplied : normalizedQuery;
  const spaceKey = deps?.embeddingModel ?? embeddingSpaceKey(protocol);

  // --- FTS candidates ---
  const ftsResults = db.searchObservationsFts(normalizedQuery, { scopeKey, type: opts?.type, days, limit: 50 });
  const ftsRankMap = new Map<number, number>();
  ftsResults.forEach((o, idx) => ftsRankMap.set(o.id, idx + 1));

  // --- Auxiliary CJK bigram candidates (phase 3A) ---
  //
  // A separate leg, deliberately, not extra rows in `ftsRankMap`. Plan §10 item 3
  // proposed merging them into the FTS rank; merged, a bigram candidate reads as
  // `match_source: 'fts'`, no cap can single it out, and FTS candidates are never
  // dropped. Measured consequence of that literal reading: one expected-empty
  // query returned 15 records against a registered hard bound of 3
  // (`benchmark/reports/phase3a-bigram-probe.md`).
  const bigramUnits = policy.bigramAux ? extractCjkBigrams(normalizedQuery) : [];
  const bigramLeg = bigramUnits.length
    ? db.searchObservationsByCjkBigrams(bigramUnits, {
        scopeKey,
        type: opts?.type,
        days,
        dfRatioCeiling: policy.bigramDfRatioCeiling,
        minMatches: policy.bigramMinMatches,
        limit: 50,
      })
    : { candidates: [], unitsProbed: 0, droppedByDf: [], zeroDf: 0, scopeSize: 0 };
  const bigramRankMap = new Map<number, number>();
  const bigramMatched = new Map<number, readonly string[]>();
  bigramLeg.candidates.forEach((c, idx) => {
    bigramRankMap.set(c.id, idx + 1);
    bigramMatched.set(c.id, c.bigrams);
  });
  const bigramUnitsInfo = {
    probed: bigramLeg.unitsProbed,
    dropped: bigramLeg.droppedByDf,
    zeroDf: bigramLeg.zeroDf,
    scopeSize: bigramLeg.scopeSize,
  };

  // Independent semantic discovery is calibrated only for valid English queries.
  // Missing or rejected English forms remain FTS-only.
  const discoveryRequested = policy.semanticDiscovery;
  const discoveryEffective = discoveryRequested && protocol === SEMANTIC_EN_PROTOCOL;

  // Rollback and non-English-space requests require lexical evidence. A bigram
  // match counts as lexical evidence when that optional leg is enabled.
  if (!discoveryEffective && ftsResults.length === 0 && bigramRankMap.size === 0) {
    deps?.onCandidates?.({
      ftsCount: 0,
      semanticCount: 0,
      aboveFloorCount: 0,
      comparableVectors: 0,
      scopeVectors: null,
      ftsRank: EMPTY_RANKS,
      semanticRank: EMPTY_RANKS,
      protocol,
      semanticQueryRejected,
      policy,
      discoveryRequested,
      discoveryEffective,
      bigramCount: 0,
      bigramRank: EMPTY_RANKS,
      bigramMatched: EMPTY_MATCHED,
      bigramUnits: bigramUnitsInfo,
    });
    return [];
  }

  // --- Semantic candidates (best-effort; FTS-only on failure/timeout) ---
  const semanticRank = new Map<number, number>();
  const semanticScore = new Map<number, number>();
  let comparableVectors = 0;
  // Exact count of candidates above the floor. Distinct from `semanticRank.size`
  // once `semanticTopK` truncates: the map then holds the retained set, while this
  // stays the true population.
  let aboveFloorCount = 0;
  // Counted BEFORE the embedding attempt and outside its try block: a degraded
  // request (Worker down, timeout) still has to answer "does this scope have
  // vectors under this protocol?", and that answer does not depend on whether we
  // managed to embed the query. Its own failure degrades to `null`, never to 0.
  let scopeVectors: number | null = null;

  // Raw vectors are never scored: their positive and noise distributions overlap,
  // while every active semantic policy value was calibrated in the English space.
  const semanticLegEligible = protocol === SEMANTIC_EN_PROTOCOL;
  if (semanticLegEligible) {
  try {
    scopeVectors = db.countScopeVectors({
      ...(scopeKey === undefined ? {} : { scopeKey }),
      model: spaceKey,
      dimensions: deps?.embeddingDimensions ?? DIMENSIONS,
    });
  } catch {
    scopeVectors = null;
  }
  try {
    const queryEmbedding = await withEmbeddingTimeout(
      generateEmbedding(queryTextForEmbedding),
      embeddingTimeoutMs,
    );
    const recentIds = db.getRecentObservationIds({
      scopeKey,
      type: opts?.type,
      days,
      limit: policy.semanticCandidatePool,
    });
    const candidateIds = [...new Set<number>([...ftsRankMap.keys(), ...bigramRankMap.keys(), ...recentIds])];
    // Preserve the old stable equal-score order across streaming chunks.
    candidateIds.sort((a, b) => a - b);
    // Lexical candidates survive semantic Top-K so their source cannot change.
    const mustKeep = new Set<number>([...ftsRankMap.keys(), ...bigramRankMap.keys()]);
    const {
      scored,
      comparableVectors: comparable,
      aboveFloor,
    } = streamScoreCandidates(db, candidateIds, mustKeep, queryEmbedding, {
      spaceKey,
      dimensions: deps?.embeddingDimensions ?? DIMENSIONS,
      floor: policy.semanticFloor,
      topK: policy.semanticTopK,
    });
    comparableVectors = comparable;
    aboveFloorCount = aboveFloor;
    for (const item of scored) {
      semanticRank.set(item.id, item.rank);
      semanticScore.set(item.id, item.score);
    }
  } catch {
    // embedding unavailable — FTS-only fusion below. Signal the degradation so
    // the caller can record it (§12.4 FTS-only rate).
    deps?.onDegrade?.();
  }
  }

  // Both candidate lists are final here; fusion below only reorders and slices
  // them, so this is the one point where the two legs can be reported honestly.
  deps?.onCandidates?.({
    ftsCount: ftsResults.length,
    semanticCount: semanticRank.size,
    aboveFloorCount,
    comparableVectors,
    scopeVectors,
    ftsRank: ftsRankMap,
    semanticRank,
    protocol,
    semanticQueryRejected,
    policy,
    discoveryRequested,
    discoveryEffective,
    bigramCount: bigramRankMap.size,
    bigramRank: bigramRankMap,
    bigramMatched,
    bigramUnits: bigramUnitsInfo,
  });

  // --- RRF fusion ---
  const allIds = new Set<number>([...ftsRankMap.keys(), ...semanticRank.keys(), ...bigramRankMap.keys()]);
  if (allIds.size === 0) return [];

  // Fetch all candidate rows once for tie-break fields + final projection.
  const rows = db.getObservationsByIds([...allIds]);
  const rowById = new Map(rows.map((o) => [o.id, o]));

  let bigramVotesSuppressed = 0;
  const scored = [...allIds].map((id) => {
    const ftsRank = ftsRankMap.get(id) ?? null;
    const semRank = semanticRank.get(id) ?? null;
    const bigramRank = bigramRankMap.get(id) ?? null;

    // --- Does the bigram leg get a vote on THIS candidate? (phase 3A-R2) ---
    //
    // `discovery-only` suppresses the vote when another leg already found the
    // record. Decided HERE, before scoring, not by deducting afterwards: a
    // post-hoc deduction would leave the candidate's rank already shifted by a
    // term the policy says it should not have had.
    const foundByAnotherLeg = ftsRank !== null || semRank !== null;
    const bigramVotes =
      bigramRank !== null && (policy.bigramVote === 'always' || !foundByAnotherLeg);
    if (bigramRank !== null && !bigramVotes) bigramVotesSuppressed++;

    let score = 0;
    if (ftsRank !== null) score += policy.ftsWeight / (policy.rrfK + ftsRank);
    if (semRank !== null) score += policy.semanticWeight / (policy.rrfK + semRank);
    if (bigramVotes) score += policy.bigramWeight / (policy.rrfK + bigramRank);

    // A suppressed bigram vote is not evidence. Under `discovery-only`,
    // semantic+bigram stays `semantic` and remains inside the semantic quota.
    const lexical = ftsRank !== null || bigramVotes;
    const matchSource: ScoredObservation['match_source'] =
      lexical && semRank !== null
        ? 'hybrid'
        : ftsRank !== null
          ? 'fts' // trigram is the strong lexical signal, with or without bigram
          : bigramVotes
            ? 'bigram'
            : 'semantic';
    return { id, score, semRank, bigramRank, matchSource };
  });

  // Lower is stronger. Bigram-only remains the weakest evidence bucket.
  const confidenceOf = (s: ScoredObservation['match_source']): number =>
    s === 'hybrid' ? 0 : s === 'semantic' ? 1 : s === 'fts' ? 2 : 3;

  // Tie-breaks apply only when fused scores are exactly equal.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (policy.tieBreak === 'source-confidence' || policy.tieBreak === 'semantic-rank') {
      const ca = confidenceOf(a.matchSource);
      const cb = confidenceOf(b.matchSource);
      if (ca !== cb) return ca - cb;
    }
    if (policy.tieBreak === 'semantic-rank') {
      // Only reached when both candidates are in the SAME bucket, so this is the
      // transposed-hybrid case (or two single-leg candidates of the same kind,
      // which cannot tie because ranks within a leg are unique). No semantic rank
      // sorts last: the candidate never cleared the floor (or has no vector in
      // this space), so there is no semantic evidence to prefer.
      const ra = a.semRank ?? Number.POSITIVE_INFINITY;
      const rb = b.semRank ?? Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
    }
    const oa = rowById.get(a.id)!;
    const ob = rowById.get(b.id)!;
    if (oa.turn_stopped_at !== ob.turn_stopped_at) {
      return oa.turn_stopped_at < ob.turn_stopped_at ? 1 : -1; // newer first
    }
    return a.id - b.id; // smaller id first
  });

  // Apply source quotas after ranking and backfill with later eligible results.
  const capSemanticOnly = Math.min(policy.semanticOnlyLimit, limit);
  const capBigramOnly = Math.min(policy.bigramOnlyLimit, limit);
  const picked: typeof scored = [];
  let semanticOnlyKept = 0;
  let semanticOnlyDropped = 0;
  let bigramOnlyKept = 0;
  let bigramOnlyDropped = 0;
  for (const s of scored) {
    if (picked.length >= limit) break;
    if (s.matchSource === 'semantic') {
      if (semanticOnlyKept >= capSemanticOnly) {
        semanticOnlyDropped++;
        continue;
      }
      semanticOnlyKept++;
    }
    // Two independent caps, not a shared budget. They bound two different kinds
    // of unverified lead — one from meaning, one from a two-character substring —
    // and a shared budget would make each one's measured worst case depend on how
    // many of the other kind happened to rank above it.
    if (s.matchSource === 'bigram') {
      if (bigramOnlyKept >= capBigramOnly) {
        bigramOnlyDropped++;
        continue;
      }
      bigramOnlyKept++;
    }
    picked.push(s);
  }
  deps?.onFusion?.({
    semanticOnlyDropped,
    semanticOnlyReturned: semanticOnlyKept,
    bigramOnlyDropped,
    bigramOnlyReturned: bigramOnlyKept,
    bigramVoteMode: policy.bigramVote,
    bigramVotesSuppressed,
    ranked: scored.map((s) => ({
      id: s.id,
      score: s.score,
      matchSource: s.matchSource,
      semRank: s.semRank,
      bigramRank: s.bigramRank,
    })),
  });

  return picked.flatMap((s) => {
    const obs = rowById.get(s.id);
    if (!obs) return [];
    return [{
      ...obs,
      match_source: s.matchSource,
      semantic_score: semanticScore.get(s.id) ?? null,
    }];
  });
}
