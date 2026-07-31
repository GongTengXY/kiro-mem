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

const RRF_K = 60;
/**
 * Pure-semantic candidates below this cosine similarity are dropped as noise.
 *
 * This is a noise trim, NOT a relevance guarantee, and it cannot be turned into
 * one by raising the number.
 *
 * The calibration behind the current value was measured on `raw-v1` ONLY —
 * Chinese Observation text fed straight to MiniLM (30 turns, real vectors):
 * annotated true positives span cosine 0.080 … 0.607 (median 0.322) while the
 * worst noise on a query with no relevant memory at all reaches 0.431. The two
 * distributions overlap, so under `raw-v1` any threshold that clears the noise
 * (≥0.45) also discards most true positives.
 *
 * That overlap is a property of THAT protocol, not of hybrid retrieval. Do not
 * carry the conclusion over: under `semantic-en-v1` the same 26 records and the
 * same 18 calibration queries separate with AUC 0.998 — positives median 0.455,
 * true-negative p99 0.254 — i.e. working points exist there that do not exist
 * here. Both numbers are pair-level readings and neither licenses removing the
 * lexical-anchor rule below; that requires running the full pipeline per
 * candidate threshold (plan §6.2), which is phase 2, not this one.
 */
const SEMANTIC_FLOOR = 0.2;

/** Shared empty rank map for the early-return observation payload. */
const EMPTY_RANKS: ReadonlyMap<number, number> = new Map();

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
  /** Hard scope filter (frozen scope_key). Omit only for explicit all-scopes. */
  scopeKey?: string;
  type?: string;
  days?: number;
  limit?: number;
  /**
   * Caller-supplied English normalization of `query` (`semantic-en-v1`).
   *
   * Present => the semantic leg runs in the English space, against records whose
   * own derived value passed the same protocol. Absent or refused by
   * `checkSemanticEnQuery` => the leg falls back to the `raw-v1` space.
   *
   * There is no third option, and in particular the raw Chinese query is never
   * embedded into the English space: that exact pairing was measured at MRR
   * 0.437 against the 0.529 raw baseline — worse than doing nothing, and
   * invisible at read time.
   *
   * It is a parameter rather than something computed here because computing it
   * would mean a second LLM round trip on the interactive path. The agent that
   * calls `search` has already read the user's question; it supplies the English
   * form in the same tool call.
   */
  semanticQueryEn?: string;
}

export interface ObservationSearchDeps {
  /** Injectable for tests; defaults to the local MiniLM embedder. */
  generateEmbedding?: (text: string) => Promise<Float32Array>;
  /**
   * Identity of the vector space `generateEmbedding` produces. Stored vectors
   * from any other model are skipped, because a cosine score across two
   * different embedding spaces is meaningless but looks authoritative.
   *
   * These travel WITH the embedder rather than being hard-coded: a test that
   * injects a fake embedder is describing a different vector space, and forcing
   * it to claim the production model name would make the fixture lie about
   * which space it is in.
   */
  embeddingModel?: string;
  embeddingDimensions?: number;
  /** Query embedding deadline; defaults to the interactive MCP budget. */
  embeddingTimeoutMs?: number;
  /**
   * Called once when the semantic step fails and the search degrades to
   * FTS-only (query embedding unavailable). Lets the caller record an
   * observability metric without coupling this pure kernel to the DB.
   */
  onDegrade?: () => void;
  /**
   * Candidate-level observation exit. READ-ONLY: nothing here feeds back into
   * ranking, so it cannot change a result.
   *
   * It exists because the four ways a query can miss are indistinguishable from
   * the returned page: FTS recalled nothing / semantic recalled nothing / both
   * recalled it but fusion ranked it badly / it was cut by the result limit.
   * The retrieval benchmark has to tell them apart to attribute a regression to
   * a stage, and the alternative — re-running `searchObservationsFts` inside the
   * harness with a hand-copied `limit: 50` and opts — is a second source of
   * truth that would drift away from this one.
   *
   * Fires exactly once per executed search, including on the lexical-anchor
   * early return. On that path the semantic step never runs, so `semanticCount`
   * is 0 by construction rather than by scoring — which is precisely the fact
   * the `heldoutNoAnchor` metric needs to state. A blank query is not an
   * executed search and does not fire.
   */
  onCandidates?: (info: {
    /** FTS candidate count (capped by the internal FTS limit), NOT the returned count. */
    ftsCount: number;
    /** Semantic candidates above SEMANTIC_FLOOR. */
    semanticCount: number;
    /** observation id -> 1-based FTS rank. */
    ftsRank: ReadonlyMap<number, number>;
    /** observation id -> 1-based semantic rank. */
    semanticRank: ReadonlyMap<number, number>;
    /**
     * Which vector space this search used. Without it, an English-normalized
     * search and a silently degraded raw one are indistinguishable in the
     * benchmark — and "the caller forgot semantic_query_en" would read as "the
     * protocol did not help".
     */
    protocol: NormalizationProtocol;
    /** Why a supplied `semanticQueryEn` was refused, if it was. */
    semanticQueryRejected: NormalizationRejectReason | null;
  }) => void;
}

export type ScoredObservation = Observation & {
  match_source: 'fts' | 'semantic' | 'hybrid';
  semantic_score: number | null;
};

/**
 * Returns Observations ranked by RRF over FTS + semantic candidate lists,
 * hard-scoped by `opts.scopeKey`. If embeddings are unavailable the search
 * degrades gracefully to FTS-only. Ties break toward the more recent
 * `turn_stopped_at`, then the smaller `id`, for a stable deterministic order.
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
  const days = opts?.days ?? 90;
  const scopeKey = opts?.scopeKey;
  const generateEmbedding = deps?.generateEmbedding ?? localEmbedding;
  const embeddingTimeoutMs = deps?.embeddingTimeoutMs ?? DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS;

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

  // Lexical anchor required: no FTS hit in this scope => no results.
  //
  // The semantic step below has two different jobs, and only one of them is
  // trustworthy. Reranking things FTS already matched is safe — the lexical hit
  // vouches for topical relevance. Pulling in records FTS never matched is
  // discovery, and it has no relevance evidence behind it: the candidate pool is
  // "the most recent 200 Observations in this scope", every one of them gets a
  // cosine score, and anything over SEMANTIC_FLOOR earns a positive RRF score
  // because fusion has no absolute cutoff. On a query about work that simply
  // never happened here, that filled the entire result page with noise:
  // benchmark expected-empty queries returned a mean of 8.4 records (worst 10 =
  // the limit) while FTS alone correctly returned 0 for every one of them.
  //
  // Discovery is therefore gated on the query having at least one lexical anchor
  // in this scope rather than on a higher cosine threshold — the calibration
  // above shows no threshold separates signal from noise. Cost, measured: a
  // query with zero lexical overlap now returns nothing instead of a page of
  // plausible-looking noise. Paraphrase-only recall would need a calibration set
  // that actually separates the two distributions, not a constant parked just
  // above the noise we happen to have measured.
  if (ftsResults.length === 0) {
    deps?.onCandidates?.({
      ftsCount: 0,
      semanticCount: 0,
      ftsRank: EMPTY_RANKS,
      semanticRank: EMPTY_RANKS,
      protocol,
      semanticQueryRejected,
    });
    return [];
  }

  // --- Semantic candidates (best-effort; FTS-only on failure/timeout) ---
  const semanticRank = new Map<number, number>();
  const semanticScore = new Map<number, number>();
  try {
    const queryEmbedding = await withEmbeddingTimeout(
      generateEmbedding(queryTextForEmbedding),
      embeddingTimeoutMs,
    );
    const recentIds = db.getRecentObservationIds({
      scopeKey,
      type: opts?.type,
      days,
      limit: 200,
    });
    const candidateIds = [...new Set<number>([...ftsRankMap.keys(), ...recentIds])];
    // Version-filtered: a blob written by another model OR another text
    // normalization protocol (or a corrupted one) is dropped here, so it degrades
    // to keyword-only reachability instead of producing a confident-looking but
    // meaningless similarity score. `raw-v1` and `semantic-en-v1` are both 384
    // dimensions of the same model, which is exactly why the filter has to be the
    // full space key and not the model name.
    const embeddings = db.getObservationEmbeddingsByIds(candidateIds, {
      model: spaceKey,
      dimensions: deps?.embeddingDimensions ?? DIMENSIONS,
    });
    const scored: { id: number; score: number }[] = [];
    for (const row of embeddings) {
      const score = cosineSimilarity(queryEmbedding, blobToEmbedding(row.embedding));
      if (score > SEMANTIC_FLOOR) scored.push({ id: row.observation_id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    scored.forEach((item, idx) => {
      semanticRank.set(item.id, idx + 1);
      semanticScore.set(item.id, item.score);
    });
  } catch {
    // embedding unavailable — FTS-only fusion below. Signal the degradation so
    // the caller can record it (§12.4 FTS-only rate).
    deps?.onDegrade?.();
  }

  // Both candidate lists are final here; fusion below only reorders and slices
  // them, so this is the one point where the two legs can be reported honestly.
  deps?.onCandidates?.({
    ftsCount: ftsResults.length,
    semanticCount: semanticRank.size,
    ftsRank: ftsRankMap,
    semanticRank,
    protocol,
    semanticQueryRejected,
  });

  // --- RRF fusion ---
  const allIds = new Set<number>([...ftsRankMap.keys(), ...semanticRank.keys()]);
  if (allIds.size === 0) return [];

  // Fetch all candidate rows once for tie-break fields + final projection.
  const rows = db.getObservationsByIds([...allIds]);
  const rowById = new Map(rows.map((o) => [o.id, o]));

  const scored = [...allIds].map((id) => {
    const ftsRank = ftsRankMap.get(id) ?? null;
    const semRank = semanticRank.get(id) ?? null;
    let score = 0;
    if (ftsRank !== null) score += 1 / (RRF_K + ftsRank);
    if (semRank !== null) score += 1 / (RRF_K + semRank);
    const matchSource: ScoredObservation['match_source'] =
      ftsRank !== null && semRank !== null ? 'hybrid' : ftsRank !== null ? 'fts' : 'semantic';
    return { id, score, matchSource };
  });

  // Rank by RRF score, then stable tie-break: newer turn_stopped_at, smaller id.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const oa = rowById.get(a.id)!;
    const ob = rowById.get(b.id)!;
    if (oa.turn_stopped_at !== ob.turn_stopped_at) {
      return oa.turn_stopped_at < ob.turn_stopped_at ? 1 : -1; // newer first
    }
    return a.id - b.id; // smaller id first
  });

  return scored.slice(0, limit).flatMap((s) => {
    const obs = rowById.get(s.id);
    if (!obs) return [];
    return [{
      ...obs,
      match_source: s.matchSource,
      semantic_score: semanticScore.get(s.id) ?? null,
    }];
  });
}
