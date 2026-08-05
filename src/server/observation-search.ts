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
import { extractCjkBigrams } from '../db';
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

/**
 * Server-side retrieval strategy. NOT user input.
 *
 * Every knob here changes what the retrieval kernel considers relevant, so they
 * are deliberately absent from the MCP tool schema: a caller that could raise
 * its own floor or cap could manufacture whatever result page it wanted, and the
 * quality gates in the benchmark would be measuring a strategy nobody shipped.
 * The injection channel is `ObservationSearchDeps.policy`, which benchmark arms
 * and tests use; production passes exactly one of the two frozen profiles picked
 * by {@link resolveRetrievalPolicy} from the gray-release switch.
 */
export interface RetrievalPolicy {
  /**
   * Whether the semantic leg may recall records FTS never matched.
   *
   * `true` is the production default since phase 2C: zero FTS candidates no
   * longer short-circuit the search, so a query that shares no word with the
   * work it is looking for can still find it. `false` restores the phase 1b
   * lexical-anchor rule — zero FTS candidates in this scope => return empty
   * WITHOUT computing a query embedding — and is reachable ONLY through the
   * explicit rollback profile ({@link LEXICAL_ANCHOR_ROLLBACK_POLICY}); nothing
   * in the code switches it back on its own.
   *
   * IT IS A REQUEST, NOT A GUARANTEE. Discovery additionally requires the search
   * to be in the `semantic-en-v1` space — see the protocol boundary at the gate.
   * `true` on a query with no legal `semantic_query_en` does NOT enable raw-v1
   * discovery, because the only floor calibration that separates signal from
   * noise is the English one. Plan §2.3 puts a missing or refused derived value
   * in the "capability degraded" row, not the "normal recall topology" row.
   */
  semanticDiscovery: boolean;
  /**
   * Cosine floor for semantic candidates. Compared with STRICT `>` — fixed here
   * and mirrored in the tests and reports so the boundary case cannot mean one
   * thing in a benchmark arm and another in a unit test (plan §4.2 item 5).
   *
   * The default `0.197` is the phase 2B selection: a full-pipeline scan of
   * floor ∈ {0.197, 0.223, 0.275} × cap ∈ {1, 2, 3, 5} over 121 frozen
   * `ftsCount=0` calibration queries, picked by a rule written down before any
   * arm ran (`benchmark/reports/phase2b-selection.md`). It is a `semantic-en-v1`
   * number and is meaningless in the `raw-v1` space, which is why the protocol
   * boundary below refuses discovery outside the English space: under `raw-v1`
   * annotated positives span cosine 0.080…0.607 while the worst noise on a query
   * about work that never happened reaches 0.431 — overlapping distributions, no
   * separating threshold. Under `semantic-en-v1` the same records and queries
   * separate at AUC 0.998.
   *
   * Raising it is not "safer" in any free sense: at 0.223 the same calibration
   * set loses ~10 points of hit@5 (50.0% → 40.3% at cap=2), at 0.275 it loses
   * ~24. Lowering it below 0.197 was never calibrated.
   */
  semanticFloor: number;
  /**
   * Max semantic-only results per request, applied AFTER fusion. Default `2`
   * (phase 2B selection). A non-finite value means no cap, which is phase 1b
   * behavior — note that is NOT the same as "no semantic-only results": even
   * with `semanticDiscovery: false` the semantic leg extends an FTS-anchored
   * page (phase 1b measured 80 such results across 42 queries), so the cap is
   * live on the anchored path too, not just on discovery.
   *
   * The cap is the only bound on false recall once the keyword gate is gone. At
   * cap=3 the historical expected-empty mean crosses the ≤1 threshold (1.20), so
   * this number is a release gate, not a preference.
   */
  semanticOnlyLimit: number;
  /** RRF rank-fusion constant. */
  rrfK: number;
  ftsWeight: number;
  semanticWeight: number;
  /**
   * Order among candidates with an EXACTLY equal fused score.
   *
   * `recency` — newer `turn_stopped_at`, then smaller id. Phase 1b behavior.
   * `source-confidence` — hybrid > semantic-only > fts-only, then recency, then
   *   id. Registered in the plan because equal weights make `1/(60+1)` reachable
   *   from both legs: a record ranked semantic #1 ties exactly with an unrelated
   *   record ranked FTS #1, and recency then decides.
   * `semantic-rank` — the phase 2D selection. `source-confidence`'s bucket order
   *   FIRST, then better (smaller) semantic rank, then recency, then id.
   *
   * Why the extra step: the ties that actually cost a query its top spot are
   * *same-bucket*. A target at (ftsRank 2, semRank 1) scores `1/62 + 1/61`, which
   * is EXACTLY what a record at (ftsRank 1, semRank 2) scores — both are `hybrid`,
   * so bucketing by match_source cannot separate them and recency decides after
   * all. Measured on the 2D grid: `source-confidence` moves 2 of 145 benchmark
   * rows and changes no metric, while resolving those transposed ties recovers
   * q03/q14 from rank 2 to rank 1.
   *
   * Why the bucket step is kept AHEAD of semantic rank rather than replaced by it:
   * cross-arity ties are reachable, contrary to what this comment claimed before
   * Gate D. With `rrfK=60`, `1/93 + 1/186 === 1/62` in float64, i.e. a hybrid at
   * (ftsRank 33, semRank 126) ties a single-leg candidate at rank 2 exactly; a scan
   * of `ftsRank ≤ 50` (the internal FTS limit) × `semRank ≤ 250` (the candidate
   * pool bound) finds 17 such solutions. Ordering by semantic rank first would
   * hand those to the semantic-only candidate and thereby CONTRADICT the profile
   * the plan registered — an uncalibrated new boundary. With the bucket first,
   * `semantic-rank` decides every tie `source-confidence` decides, identically,
   * and only adds an answer where `source-confidence` had none.
   *
   * Why semantic rank rather than FTS rank breaks the remaining ties: measured leg
   * quality. The `semantic-en-v1` leg ranks at offline MRR 0.972 tuned / 0.833
   * heldout (`benchmark/reports/phase1a-en-normalization-eval.md`), while an FTS
   * rank is bm25 over trigram units — "lexical hit ≠ relevant" is the original
   * diagnosis this whole effort started from.
   */
  tieBreak: 'recency' | 'source-confidence' | 'semantic-rank';
  /**
   * How many of the most recent Observations in scope enter the semantic
   * candidate pool. `Infinity` = the whole scope (brute force).
   *
   * Phase 3B instrument, added at the frozen production value 200 so the default
   * is byte-identical to the literal it replaces. It exists because the defect
   * plan §11 describes cannot be measured without it: the pool is TRUNCATED by
   * `turn_stopped_at DESC` and then RANKED by cosine, so an old but highly
   * relevant record disappears BEFORE it is ever scored. That is not "its score
   * was too low" — the comparison never happened.
   *
   * The 30-turn benchmark corpus is structurally blind to this: 30 < 200, so every
   * record is always in the pool and the two settings cannot differ. Measuring it
   * needs the phase 3B recall-scale fixture (2,000 records, targets deliberately
   * placed outside the newest 200).
   *
   * Raising it is NOT free and phase 3B does not select a value. Two costs it must
   * price first:
   *
   *  - the semantic leg scores 10x the vectors, so the opportunity for a plausible
   *    noise record to reach the page scales with it. That is exactly the shape
   *    phase 3A failed on — real gain, out-of-bounds false recall;
   *  - full-scope brute force has to stay inside the p95 < 300ms budget.
   *
   * Note this pool is a UNION, not a filter: FTS hits (and bigram hits when that
   * leg runs) are added to it regardless of age, so a lexically reachable old
   * record is already scored today. The truncation only bounds what the semantic
   * leg can find ON ITS OWN — which, since phase 2C, is the leg that carries
   * zero-keyword recall.
   */
  semanticCandidatePool: number;
  /**
   * Whether the auxiliary CJK bigram leg runs (phase 3A).
   *
   * `false`, and it stays `false`: **Codex Gate E ruled phase 3A NOT PASSED**
   * (2026-08-04). Zero of 15 arms satisfied both the quality and the false-recall
   * gates registered before any arm ran. The code, tests, evidence trail and the
   * third-leg architecture were accepted; the working point was not, because none
   * exists yet.
   *
   * What it buys — and the gain is real, which is why the leg is kept rather than
   * reverted: Chinese two-character words the trigram index cannot reach.
   * `FTS_CJK_WINDOW=3` means 引号 is findable only when the 3-character windows
   * line up on both sides, and measured on q32 they do not — the query yields
   * `带引号`/`引号或`, the record `合引号`/`引号等`/`双引号`/`引号翻`. Turning the leg on
   * moved the phase 2 calibration set from hit@5 50.0% to 68.1% and gave 68
   * previously zero-keyword queries a candidate.
   *
   * What it costs, and why no setting shipped:
   *
   *  1. Unsegmented sliding windows emit generic words — 处理 / 配置 / 服务 / 字段 —
   *     that create real lexical overlap carrying no relevance. On a 26-record
   *     corpus a DF RATIO has 3.85 percentage points of resolution per step, and
   *     「处理」(df 3) and 「引号」(df ≤2) have no separating point between them.
   *  2. `bigramOnlyLimit` bounds only the discovery half. A record the semantic
   *     leg already surfaced gets a third RRF vote and can be pushed on-page as
   *     `hybrid`, where no cap applies.
   *  3. Equal-weight fusion gives "how many distinct bigrams matched" the same
   *     voting power as bm25 and cosine, and that signal is far coarser. Measured
   *     both directions on one arm: q14 lost rank 1, q04 gained it.
   *
   * A later round must first freeze a calibration set where BOTH legs hit — the
   * phase 2 set is all `ftsCount=0` and therefore structurally blind to a fusion
   * change — and a larger empty / hard-negative set, then pre-register gates and
   * calibrate `bigramWeight`, the co-occurrence condition, or whether this leg may
   * vote for a record another leg already found. Full record:
   * `benchmark/reports/phase3a-submission.md`.
   *
   * **That later round ran (phase 3A-R2) and the route is now CLOSED.** The gate
   * ruling of 2026-08-04 (`benchmark/reports/phase3a-r2-submission.md`, top)
   * answered all three of those knobs and stopped a fourth attempt:
   *
   *  - `bigramWeight` — cannot reduce the CANDIDATE COUNT, so it has no causal
   *    path to false recall. Three weights (0.25 / 0.5 / 0.75) produced false-recall
   *    readings identical to the digit.
   *  - the co-occurrence condition (`bigramMinMatches`) — suppresses noise, but
   *    suppresses real candidates alongside it, and regressed tuned R-precision.
   *  - voting scope (`bigramVote: 'discovery-only'`) — removes the `hybrid`
   *    amplification of cause 2 above, but discovery alone still leaves false
   *    recall above baseline.
   *
   * The ruling calls this "mechanism convergence, not an under-scanned parameter
   * space". The one knob never tried is the CANDIDATE ADMISSION condition, and it
   * needs resolution this 26-record corpus does not have (3.85 percentage points
   * per DF step) — which is why the next phase is 3B, building the recall-scale
   * fixture. Phase 3B may not re-open a bigram arm.
   */
  bigramAux: boolean;
  /**
   * Max `df / scopeSize` for a bigram to be probed at all.
   *
   * A RATIO, not an absolute count, and that is not a style choice. On the
   * 26-record benchmark corpus `df <= 1` is the only pure-DF setting that does
   * not breach the false-recall bound, but an absolute 1 does not survive a
   * change of scale: 「引号」 will not have df 1 in 10,000 records, so the feature
   * would silently stop firing on exactly the corpora it matters for. A fraction
   * transfers — 「测试」 takes 30-50% of any corpus, 「引号」 a few percent.
   *
   * Registered limitation: with primary=26 the resolution is 3.85 percentage
   * points per step, so a value picked here is "a setting that does not breach",
   * not "a calibrated optimum". Real calibration needs the phase 3B
   * recall-scale fixture.
   */
  bigramDfRatioCeiling: number;
  /**
   * Min number of DISTINCT surviving bigrams a record must match to become a
   * candidate.
   *
   * Measured effective but blunt: at 2 the worst-case false recall drops to 0-2,
   * but reachable targets fall from 32/72 to 9/72 — worse than what the DF
   * ceiling alone achieves, because it suppresses noise by suppressing real
   * candidates alongside it. Default 1.
   */
  bigramMinMatches: number;
  /**
   * Max results per request that ONLY the bigram leg found, applied AFTER fusion.
   *
   * It bounds ONE of the two false-recall shapes, and phase 3A measured that the
   * other one is the bigger problem. Read this before treating it as a safety
   * guarantee:
   *
   *  - it DOES bound, by construction, how many results reach the page that no
   *    other leg found — independent of corpus size and DF distribution, which is
   *    what a DF threshold cannot promise;
   *  - it does NOT bound anything about a record the semantic leg already
   *    surfaced. The bigram leg adds a third RRF vote to such a record and can
   *    push it from off-page to on-page, where it is labelled `hybrid` and this
   *    cap never sees it. Measured: at `bigramOnlyLimit=1` the query
   *    「Kubernetes Ingress 灰度发布配置」 — work this project never did — returned
   *    5 records (`benchmark/reports/phase3a-submission.md` §5.2).
   *
   * Codex Gate E ruled on exactly this: "third leg + cap" is NOT a complete
   * safety scheme, and a later round must separately calibrate `bigramWeight`,
   * the co-occurrence condition, or whether the bigram leg may vote for a record
   * another leg already found. Until one of those lands, do NOT enable
   * `bigramAux` on the argument that the cap bounds the worst case.
   *
   * The shape is still the right one for the discovery half, and it is the same
   * reasoning that made `semanticOnlyLimit` rather than a higher cosine floor the
   * bound on the semantic leg in phase 2C.
   */
  bigramOnlyLimit: number;
  /** RRF weight of the bigram leg. Fixed at 1 for phase 3A (see plan §7.1). */
  bigramWeight: number;
  /**
   * Which candidates the bigram leg is allowed to vote for (phase 3A-R2).
   *
   * `always` — phase 3A behavior: every candidate the leg matched gets a third
   *   RRF term.
   * `discovery-only` — the leg contributes a term ONLY for candidates that
   *   neither the trigram FTS leg nor the semantic leg found. A record another leg
   *   already surfaced gets nothing from it.
   *
   * Why the switch exists: Codex Gate E ruled that "third leg + cap" is not a
   * complete safety scheme, and both of phase 3A's root causes share ONE mechanism
   * — the bigram leg voting for a record another leg already found:
   *
   *  - §5.2: at `bigramOnlyLimit=1`, a query about work this project never did
   *    still returned 5 records, most labelled `hybrid`. The leg pushed
   *    already-present semantic candidates from off-page to on-page, where the cap
   *    (which only sees `bigram`) never applies.
   *  - §5.3: q14's correct answer fell from rank 1 to 2 because another record
   *    matched more two-character words. "How many bigrams matched" is a far
   *    coarser signal than bm25 or cosine, and at equal weight its direction is
   *    uncontrolled — q04 gained a rank on the same arm.
   *
   * `discovery-only` closes both structurally: nothing the leg does can move a
   * record another leg found, so the ONLY thing it can still contribute is
   * discovery — and discovery is entirely inside `bigramOnlyLimit`'s reach. That
   * turns the cap from "bounds one of the two shapes" into "bounds everything this
   * leg adds".
   *
   * The cost is real and is what the R2 grid measures: it gives up whatever the
   * leg contributed to head-of-page ordering. On phase 3A's evidence that
   * contribution had no reliable direction, but "no reliable direction" is not the
   * same as "no value".
   */
  bigramVote: 'always' | 'discovery-only';
  /**
   * How many top-scoring semantic candidates the streaming scorer keeps.
   *
   * The scorer reads candidate vectors in chunks, scores each chunk immediately and
   * retains only a bounded set, so peak memory is `O(chunk + semanticTopK)` instead
   * of `O(candidates)`. That is the whole point: the pool round measured scope-wide
   * scoring at 50,000 records and it failed on MEMORY (+720MB against a 512MB
   * budget) while passing on latency (p95 277ms), because the old path fetched every
   * blob, converted every one to a `Float32Array` and aggregated every above-floor
   * candidate before sorting.
   *
   * `Infinity` means "retain everything above the floor", which is exactly the old
   * behavior and is the shipped default for phase 1 of the Top-K round: the
   * streaming refactor must be provably result-identical BEFORE any truncation is
   * introduced (`topk-criteria.md` §5). Phase 2 scans finite values.
   *
   * Two invariants hold at any K and are not negotiable (§3.1):
   *
   *  - a candidate the FTS or bigram leg matched is ALWAYS retained, whatever its
   *    score rank. Dropping it would turn a `hybrid` result into `fts`, which is a
   *    result change wearing a memory-optimization label;
   *  - a retained candidate's rank is its TRUE global rank among above-floor
   *    candidates, never `K + 1`. Ranks feed RRF and the `semantic-rank` tie-break,
   *    so an approximated rank silently changes ordering.
   */
  semanticTopK: number;
}

/**
 * The frozen production strategy (phases 2C + 2D).
 *
 * `discovery on / floor 0.197 / cap 2` — the values Codex Gate B passed
 * (`benchmark/reports/phase2b-codex-gate-b-decision.md`): selected by the rule in
 * `benchmark/select-phase2b-arm.ts` over 12 full-pipeline arms on 121 frozen
 * `ftsCount=0` calibration queries, then confirmed on heldout, the existing
 * validation set, and a Codex-built blind audit set that had never seen this
 * policy's output (20 zero-FTS relevance queries: hit@5 100%, MRR 1.000;
 * 20 hard negatives: mean 0.30 returned, worst 2).
 *
 * `tieBreak: 'semantic-rank'` is the phase 2D selection
 * (`benchmark/reports/phase2d-selection.md`), and it is the ONLY field 2D moved:
 * `rrfK` and the weights stay at 60 / 1:1 because the weighted arms change
 * candidates that are NOT tied, which is a quality-tuning question with no legal
 * calibration set — every one of the 121 phase 2 calibration queries has
 * `ftsCount=0`, so a single-leg page cannot measure a fusion change at all.
 *
 * Changing any field here is a product change. It needs a new full-matrix run
 * and a new gate, not an edit — the numbers above stop describing the shipped
 * behavior the moment one value moves.
 */
export const DEFAULT_RETRIEVAL_POLICY: RetrievalPolicy = {
  semanticDiscovery: true,
  semanticFloor: 0.197,
  semanticOnlyLimit: 2,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: 'semantic-rank',
  /**
   * 20,000 candidates — branch **B-2** of the pool round.
   *
   * Was 200 through phase 3B. The round's own rule (§7) selected scope-wide
   * (`Infinity`), and on quality it is still the right answer: the 72 `ftsCount=0`
   * calibration queries went from **0/72 reachable** to 43/72 (hit@5 0% → 31.9%),
   * overall semantic reach 35.8% → 80.0%, hit@5 36.8% → 65.8%, with **zero** gold
   * answers leaving top-5 or the page. 500 / 1000 / 1970 were measured and are not
   * compromises: reach stays exactly 68, i.e. zero benefit at up to 9.4× the work.
   *
   * `Infinity` did not ship because it failed the **memory** gate, measured under
   * the ruling's two-process protocol (seed in one process, search in another, so
   * seeding's footprint is not charged to search) on a 50,000-record corpus whose
   * vectors replay a real `semantic-en-v1` cosine distribution:
   *
   * ```text
   * pool=Infinity  p95 277.35ms  p99 434.00ms  loop RSS +720MB  ← over the 512MB gate
   * pool=20000     p95 183.15ms  p99 300.24ms  loop RSS +384MB
   * ```
   *
   * The mechanism is not a leak (per-round RSS oscillates 657–825MB): scoring the
   * whole scope aggregates every fetched blob and every above-floor candidate in
   * memory at once. Measured pass rate above `semanticFloor` is 9.2% mean / 29.7%
   * max, so at 50,000 that is ~4,600 candidates on average and ~14,800 at worst.
   * Fixing it properly means chunked read → score immediately → keep a bounded
   * Top-K, which is a separate round; raising this number before that lands would
   * ship the memory failure.
   *
   * **20,000 is NOT recall-equivalent to scope-wide.** On a scope larger than
   * 20,000 Observations it truncates by recency again — 60% of a 50,000-record
   * scope is never scored — and that recall loss is UNMEASURED: the recall fixture
   * holds 2,000 records, so every pool ≥ 2,000 reads identically on it. Do not cite
   * the numbers above as evidence for corpora past 20,000.
   */
  semanticCandidatePool: 20000,
  // Phase 3A arrives switched OFF. The knobs exist so the 3A matrix can scan
  // them; the working point is not selected yet, so shipping it on would be a
  // product change with no gate behind it. `bun run benchmark/run.ts` with no
  // bigram flags must reproduce the 2D report query by query.
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  // `always` is phase 3A's behavior, and it is the default on purpose: writing
  // `discovery-only` here would ship an R2 product change with no gate behind it.
  // The R2 grid selects; this line follows the grid, not the other way round.
  bigramVote: 'always',
  // Phase 1 of the Top-K round ships "retain everything", i.e. the pre-streaming
  // behavior. Truncation is a product change and needs phase 2 (topk-criteria.md §6).
  semanticTopK: Number.POSITIVE_INFINITY,
};

/**
 * The explicit rollback profile: phase 1b behavior, field for field.
 *
 * Reached only by setting `retrieval.semanticDiscovery: false` in
 * `~/.kiro-mem/config.json` — see `resolveRetrievalPolicy`. Nothing in the code
 * falls back to it: an embedding failure degrades to FTS-only for that ONE
 * request and is reported as `degraded`, which is a different event from an
 * operator deciding to turn discovery off.
 *
 * It restores ALL of phase 1b, not just the gate, because that is the only shape
 * with evidence behind it: phase 2A proved this exact profile reproduces the
 * phase 1b report query by query. `discovery off` combined with the 2C floor and
 * cap has never been measured, so shipping it as "the safe option" would be a
 * guess wearing a rollback label.
 */
export const LEXICAL_ANCHOR_ROLLBACK_POLICY: RetrievalPolicy = {
  semanticDiscovery: false,
  semanticFloor: 0.2,
  semanticOnlyLimit: Number.POSITIVE_INFINITY,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: 'recency',
  // Phase 1b scored the most recent 200 too, so restoring 1b means 200 here.
  semanticCandidatePool: 200,
  // Phase 1b had no bigram leg, so restoring phase 1b means off. Keeping it off
  // here also means the rollback switch cannot silently carry a phase 3A change
  // into a profile whose numbers were measured without one.
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  bigramVote: 'always',
  // Phase 1b scored and ranked every above-floor candidate, so restoring 1b means
  // no truncation here either.
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
  /**
   * Retrieval strategy override, merged field-wise over
   * {@link DEFAULT_RETRIEVAL_POLICY}.
   *
   * `Partial` on purpose: the phase 2B matrix varies one or two knobs across 12
   * arms, and forcing each arm to restate all seven fields would make a typo in
   * an unrelated field indistinguishable from the variable under test.
   *
   * Production passes one of the two frozen profiles from
   * {@link resolveRetrievalPolicy} — never a hand-assembled combination. It lives
   * in `deps` rather than in `ObservationSearchOpts` because `opts` is the shape
   * the MCP tool forwards from its caller; putting policy there would put it one
   * refactor away from being user-settable.
   */
  policy?: Partial<RetrievalPolicy>;
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
    /**
     * Candidates above the floor, counted exactly during streaming.
     *
     * Equals `semanticCount` while `semanticTopK` is `Infinity`. Once truncation is
     * on they diverge: `semanticCount` becomes the size of the RETAINED set, while
     * this stays the true population — so a benchmark measuring "what fraction of the
     * pool clears the floor" must read this one, or it will silently start measuring
     * K instead.
     */
    aboveFloorCount: number;
    /**
     * How many stored vectors in the ACTIVE space key were available to score.
     *
     * Not the same as "vectors in this workspace": it counts the candidate pool
     * (FTS hits ∪ the most recent `policy.semanticCandidatePool` in
     * scope/type/days) that had a vector under this protocol, so it is bounded by
     * that pool. It answers the operational
     * question a zero-result search cannot — "did the semantic leg have anything
     * to compare against, or is the `semantic-en-v1` rebuild still pending in
     * this scope?" — which otherwise looks identical to "nothing was relevant".
     *
     * 0 on the lexical-anchor early return and on a degraded request, because no
     * vector was read in either case.
     */
    comparableVectors: number;
    /**
     * How many vectors exist in the ACTIVE space across the whole search scope —
     * not just the candidate pool (plan §8.2 "scope 内向量数量").
     *
     * `comparableVectors` is capped by the 200-row pool, so on a large workspace
     * it saturates and stops answering "has this scope been embedded under this
     * protocol?". This one does, which is the difference between "nothing was
     * relevant" and "the rebuild has not reached this workspace".
     *
     * `null` on the lexical-anchor early return: the semantic step never ran, so
     * nothing was counted. Reporting 0 there would be indistinguishable from a
     * scope with no vectors at all — the exact confusion this field exists to
     * remove. Also `null` when the count itself fails.
     */
    scopeVectors: number | null;
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
    /**
     * The resolved policy this search ran under. Reported per query because a
     * matrix report that states the policy only once in its provenance cannot
     * prove that every row used it (plan §6.2 item 7).
     */
    policy: RetrievalPolicy;
    /** `policy.semanticDiscovery` as asked for. */
    discoveryRequested: boolean;
    /**
     * Whether discovery was actually available: requested AND in the
     * `semantic-en-v1` space.
     *
     * Reported separately from `discoveryRequested` because the gap between them
     * is the whole point — a 2B arm whose `semantic_query_en` coverage is poor
     * would otherwise report "discovery on" while most of its queries never left
     * the keyword gate, and the arm's recall would be blamed on the floor.
     */
    discoveryEffective: boolean;
    /**
     * Bigram leg candidate count (phase 3A). 0 when `bigramAux` is off.
     *
     * Reported separately from `ftsCount` because plan §10 requires the phase 3A
     * gain NOT be misattributed to `semantic-en`. Folding these into `ftsCount`
     * would make "the trigram index found it" and "the bigram leg found it"
     * indistinguishable, which is the same mistake as folding the leg into the
     * FTS rank.
     */
    bigramCount: number;
    /** observation id -> 1-based bigram-leg rank. */
    bigramRank: ReadonlyMap<number, number>;
    /**
     * observation id -> the two-character words that matched it.
     *
     * The attribution plan §10 requires: a recall change has to point at a
     * SPECIFIC two-character word, otherwise "the bigram leg helped" is
     * indistinguishable from "something else moved". A benchmark exit, not a
     * metrics one — the runtime path records counts only, because one
     * two-character word can leak what the user asked (plan §14.10).
     */
    bigramMatched: ReadonlyMap<number, readonly string[]>;
    /**
     * Bigram units that actually ran, and why the rest did not.
     *
     * `dropped` carries the bigram TEXT because the benchmark has to attribute a
     * recall change to a specific two-character word. That is a benchmark exit,
     * not a metrics one: the runtime observability path records counts only, since
     * a single two-character word can leak what the user asked (plan §14.10).
     */
    bigramUnits: {
      probed: number;
      /** Present in the corpus but over the DF ratio ceiling. */
      dropped: { bigram: string; df: number }[];
      /** Absent from the corpus entirely. */
      zeroDf: number;
      /** Rows the DF ratio was computed against. */
      scopeSize: number;
    };
  }) => void;
  /**
   * Post-fusion observation exit. READ-ONLY, same contract as `onCandidates`.
   *
   * Separate from `onCandidates` because the cap is applied after the full
   * ranking exists, and the number it discards is not derivable from either
   * candidate list or the returned page — the harness would have to re-implement
   * fusion to recover it, which is the second source of truth this module
   * exists to avoid.
   *
   * Does NOT fire on the lexical-anchor early return or on a blank query: no
   * fusion happened, so there is nothing to report.
   */
  onFusion?: (info: {
    /** semantic-only candidates dropped by `semanticOnlyLimit`. */
    semanticOnlyDropped: number;
    /** semantic-only results that survived into the returned page. */
    semanticOnlyReturned: number;
    /** bigram-only candidates dropped by `bigramOnlyLimit` (phase 3A). */
    bigramOnlyDropped: number;
    /** bigram-only results that survived into the returned page. */
    bigramOnlyReturned: number;
    /** `policy.bigramVote` as it actually ran (phase 3A-R2). */
    bigramVoteMode: RetrievalPolicy['bigramVote'];
    /**
     * bigram matches that did NOT get an RRF term because another leg had already
     * found the record (`discovery-only`).
     *
     * The direct read on whether the switch took effect: zero here while
     * `bigramCount` is positive means the suppression never fired. Always 0 under
     * `always`, by construction.
     */
    bigramVotesSuppressed: number;
    /**
     * The fully fused ranking BEFORE the semantic-only cap and before the result
     * limit, carrying the fused score this kernel actually computed.
     *
     * It exists so "which candidate pairs entered the tie-break?" is a measurement
     * rather than an inference. The question cannot be answered from the returned
     * page (equal scores are not visible in it) and answering it by recomputing
     * `w/(K+rank)` in the harness would put the fusion formula in two places —
     * the drift risk `onCandidates` was written to avoid. A tie is `===` on these
     * float64 values, which is the same comparison the comparator makes, so the
     * enumerated set cannot disagree with the code by construction.
     *
     * An earlier 2D draft inferred the tie set from an infinitesimal weight
     * perturbation (`w_sem = 1+ε`) instead. That is a finite perturbation and can
     * in general flip strictly-ordered pairs that are merely close, so it is a
     * diagnostic, not a proof. It is kept as a cross-check only.
     */
    ranked: readonly {
      id: number;
      score: number;
      matchSource: 'fts' | 'semantic' | 'hybrid' | 'bigram';
      /** 1-based semantic rank, or null when the candidate has none. */
      semRank: number | null;
      /** 1-based bigram-leg rank, or null when the candidate has none. */
      bigramRank: number | null;
    }[];
  }) => void;
}

export type ScoredObservation = Observation & {
  /**
   * Which legs supported this result.
   *
   * `hybrid` — lexical AND semantic. `fts` — a trigram substring matched (a
   * bigram may have matched too; trigram is the stronger signal and names the
   * source). `bigram` — ONLY the auxiliary CJK two-character leg, so no trigram
   * substring and no vector over the floor. `semantic` — only the vector.
   *
   * Note `hybrid` deliberately does NOT mean "more than one leg". Trigram and
   * bigram are both lexical, and a Chinese query's trigram hit necessarily also
   * matches the bigrams inside that window — counting legs would relabel most
   * Chinese `fts` results as `hybrid` and claim semantic evidence that never
   * existed.
   *
   * `bigram` (phase 3A) is a lead of the same epistemic status as `semantic` —
   * worth surfacing, worth verifying — and it is capped by `bigramOnlyLimit` for
   * exactly that reason.
   */
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
  const days = opts?.days ?? 90;
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

  // --- Discovery eligibility: protocol boundary ---
  //
  // Discovery (recalling records FTS never matched) is allowed ONLY in the
  // `semantic-en-v1` space. Two reasons, both measured:
  //
  //  1. `raw-v1` has no floor that separates signal from noise. Chinese text fed
  //     straight to MiniLM puts annotated positives at cosine 0.080…0.607 while
  //     the worst noise on a query about work that never happened reaches 0.431 —
  //     overlapping distributions. Under `semantic-en-v1` the same records and
  //     queries separate at AUC 0.998. A floor picked for the English space is
  //     meaningless in the raw one, and phase 2B calibrates only the English one.
  //  2. A missing or refused `semantic_query_en` is a CAPABILITY DEGRADATION
  //     (plan §2.3), not a retrieval topology. Letting it silently take the
  //     discovery path would make "the protocol did not help" and "the caller
  //     forgot the parameter" produce the same page.
  //
  // This is deliberately not expressed as a policy field: it is not a knob to
  // scan, it is an invariant. A 2B arm cannot accidentally turn it off.
  //
  // Note the boundary only affects the ftsCount === 0 case. When FTS has
  // candidates the semantic leg still reranks in whichever space it is in,
  // including `raw-v1` — that is phase 1b behavior and must stay neutral.
  const discoveryRequested = policy.semanticDiscovery;
  const discoveryEffective = discoveryRequested && protocol === SEMANTIC_EN_PROTOCOL;

  // Lexical anchor rule, now scoped by the boundary above.
  //
  // Since phase 2C this branch is NOT the production path: the default policy
  // has discovery on, so a `semantic-en-v1` query reaches the semantic leg with
  // zero FTS candidates. It stays reachable for exactly two situations, and they
  // are different in kind:
  //
  //  1. the operator rolled back (`retrieval.semanticDiscovery: false`), which
  //     restores the whole phase 1b profile deliberately;
  //  2. the search is NOT in the English space — `semantic_query_en` missing or
  //     refused. That is a capability degradation, not a topology choice: under
  //     `raw-v1` there is no floor that separates signal from noise (annotated
  //     positives 0.080…0.607 overlapping worst-case noise at 0.431), and the
  //     candidate pool is "the most recent 200 Observations in this scope" with
  //     every one of them scored, so opening discovery there filled the page with
  //     plausible-looking noise — measured at a mean of 8.4 records (worst 10 =
  //     the limit) on queries about work that never happened here.
  //
  // READ THE expected-empty METRIC WITH THIS IN MIND: on a run where
  // `discoveryEffective` is false, "expected-empty returned 0.00 records" is
  // structurally guaranteed for any query with no lexical overlap — a continuity
  // reading, NOT evidence that a floor or cap controls false recall. The 2B/2C
  // false-recall numbers all come from runs where discovery was effective.
  // A bigram hit COUNTS AS A LEXICAL ANCHOR, so it is part of this condition.
  //
  // The gate's premise is "the semantic leg may not discover records with no
  // lexical evidence behind them". A bigram match is lexical evidence in the
  // plainest sense: the user typed 引号 and the record contains 引号. The reason
  // the trigram index missed it is a window-alignment artifact, not an absence of
  // overlap. Treating it as an anchor is also why the bigram leg needs no cosine
  // floor calibration to be safe on the degraded path — it is not a similarity
  // judgement.
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
    // Ascending order is what makes the streaming path provably equivalent to the
    // old one, not a cosmetic choice. The old path issued ONE `IN (...)` query and
    // sorted its rows with a stable sort, so equal scores kept the order SQLite
    // returned them in — and SQLite returns `WHERE id IN (...)` rows in ascending
    // rowid order regardless of the list order (measured on Bun 1.2.20 / SQLite
    // 3.43.2). Streaming ascending chunks therefore visits candidates in the same
    // sequence, and `(score desc, id asc)` reproduces the same tie order.
    candidateIds.sort((a, b) => a - b);
    // Candidates another leg already matched. They are retained at any K (§3.1):
    // dropping one would turn a `hybrid` result into `fts`. Bounded by the internal
    // FTS limit plus the bigram cap, so the per-item counters below are cheap.
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

    // --- match_source ---
    //
    // Uses `bigramVotes`, NOT `bigramRank !== null`: a suppressed leg did nothing
    // to this result, so claiming it as supporting evidence would be false.
    //
    // The criteria (§3.1) spelled this out only for the FTS+bigram case, where the
    // label is `fts` either way. The case it left open is semantic+bigram, and the
    // answer matters a lot, so it is decided here and disclosed in the criteria's
    // amendment A1:
    //
    //   Under `discovery-only`, a record found by the semantic leg AND the bigram
    //   leg is labelled `semantic` — which means `semanticOnlyLimit` applies to it.
    //
    // The alternative (keep calling it `hybrid` so it escapes the semantic cap)
    // was rejected because it reopens §5.2 through a different door: a noisy
    // bigram would still promote a hard negative, not by score but by lifting it
    // out of the cap's reach. Closing that door is the entire point of R2, so the
    // suppression has to be total — the leg either acted on this candidate or it
    // did not.
    //
    // **RATIFIED by the 3A-R2 gate ruling (2026-08-04) as the formal three-tier
    // definition, no longer an implementer's choice awaiting review:**
    //
    //   semantic + trigram FTS  => hybrid, exempt from semanticOnlyLimit
    //   semantic + bigram only  => semantic, still bound by semanticOnlyLimit
    //   bigram only             => bigram, bound by bigramOnlyLimit
    //
    // The reason given is about what `hybrid` MEANS: semantic evidence plus
    // RELIABLE lexical evidence. A trigram hit qualifies; a two-character sliding
    // window does not. 「配置 / 发布 / 处理 / 服务」 were measured to produce semantic
    // neighbours and lexical noise AT THE SAME TIME, so the two legs' errors are
    // correlated — agreeing does not make two independent signals.
    //
    // The cost is predicted and measurable: the S3 layer (FTS ✗, semantic ✓,
    // bigram ✓, 19 queries) becomes semantic-only under `discovery-only` and is
    // therefore capped at 2 per page. If that cap eats the S3 benefit, the grid
    // will show it as S3 hit@5 failing to rise — which is exactly the reading
    // §6.1 registered. It did, and the ruling reads that not as a tuning target
    // but as proof this bigram mechanism cannot deliver the gain and the safety
    // bound at once.
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

  /**
   * Tie-break rank: lower wins. Only consulted on an exactly equal score.
   *
   * `bigram` is APPENDED as the weakest bucket rather than inserted among the
   * existing three. Phase 2D calibrated `hybrid > semantic > fts` and its
   * evidence covers only those; changing their relative order here would be an
   * uncalibrated boundary smuggled in under a different phase. Last place is also
   * the honest ranking: a bigram-only hit is a two-character substring match with
   * no trigram context and no vector support behind it.
   */
  const confidenceOf = (s: ScoredObservation['match_source']): number =>
    s === 'hybrid' ? 0 : s === 'semantic' ? 1 : s === 'fts' ? 2 : 3;

  // Rank by fused score, then break exact ties per policy.
  //
  // The `b.score !== a.score` guard is what keeps a tie-break a tie-break: a
  // candidate that lost on fused score can never be rescued by having a better
  // semantic rank, so switching `tieBreak` cannot reorder anything the fusion
  // already separated. That is the property phase 2D needed and re-weighting the
  // semantic leg does NOT have — `w_sem > 1` moves non-tied candidates too, which
  // is how it changed which records fit on q13's page.
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

  // --- semantic-only cap, applied AFTER the full ranking ---
  //
  // Deliberately not applied before fusion. Truncating the semantic list first
  // would change the semantic RANK of the hybrid candidates that survive, so the
  // cap would silently interact with the fusion weights and a matrix arm could
  // not attribute its result to either one.
  //
  // A capped candidate does not consume the request limit: the walk keeps going
  // and backfills with whatever hybrid/fts results come next, so a small cap
  // trades noise for depth rather than for a shorter page.
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
