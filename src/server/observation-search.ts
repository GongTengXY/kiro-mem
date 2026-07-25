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
  generateEmbedding as defaultGenerateEmbedding,
  cosineSimilarity,
  blobToEmbedding,
  withEmbeddingTimeout,
  DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS,
} from '../embedding';

const RRF_K = 60;
/** Pure-semantic candidates below this cosine similarity are dropped as noise. */
const SEMANTIC_FLOOR = 0.2;

export interface ObservationSearchOpts {
  /** Hard scope filter (frozen scope_key). Omit only for explicit all-scopes. */
  scopeKey?: string;
  type?: string;
  days?: number;
  limit?: number;
}

export interface ObservationSearchDeps {
  /** Injectable for tests; defaults to the local MiniLM embedder. */
  generateEmbedding?: (text: string) => Promise<Float32Array>;
  /** Query embedding deadline; defaults to the interactive MCP budget. */
  embeddingTimeoutMs?: number;
  /**
   * Called once when the semantic step fails and the search degrades to
   * FTS-only (query embedding unavailable). Lets the caller record an
   * observability metric without coupling this pure kernel to the DB.
   */
  onDegrade?: () => void;
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
  const generateEmbedding = deps?.generateEmbedding ?? defaultGenerateEmbedding;
  const embeddingTimeoutMs = deps?.embeddingTimeoutMs ?? DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS;

  // --- FTS candidates ---
  const ftsResults = db.searchObservationsFts(normalizedQuery, { scopeKey, type: opts?.type, days, limit: 50 });
  const ftsRankMap = new Map<number, number>();
  ftsResults.forEach((o, idx) => ftsRankMap.set(o.id, idx + 1));

  // --- Semantic candidates (best-effort; FTS-only on failure/timeout) ---
  const semanticRank = new Map<number, number>();
  const semanticScore = new Map<number, number>();
  try {
    const queryEmbedding = await withEmbeddingTimeout(
      generateEmbedding(normalizedQuery),
      embeddingTimeoutMs,
    );
    const recentIds = db.getRecentObservationIds({
      scopeKey,
      type: opts?.type,
      days,
      limit: 200,
    });
    const candidateIds = [...new Set<number>([...ftsRankMap.keys(), ...recentIds])];
    const embeddings = db.getObservationEmbeddingsByIds(candidateIds);
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
