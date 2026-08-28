import { Hono } from 'hono';
import { writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { MemoryDB, detectRepo } from '../db';
import type { MemoryType } from '../db/types';
import type { MemoryCompressor, ObservationSummaryResult } from '../compressor';
import { ACPCompressor, checkRuntimeHome, formatIssues } from '../acp';
import { buildBootstrapContext } from '../bootstrap-context';
import { loadConfig, getDataDir, resolveRuntimeHome, type Config } from '../config';
import { ensureLocalAuthToken, readLocalAuthToken } from '../auth-token';
import { readCaptureMisses } from '../hooks/capture-log';
import { logError } from '../logger';
import { JobRunner, extractArtifacts } from '../jobs';
import { sampleRssTreeAsync, type RssSample } from '../process-rss';
import { resolveRetrievalPolicy } from './observation-search';
import { registerViewerRoutes } from './viewer-routes';
import { ViewerStreamHub } from './viewer-stream';
import type { ViewerQueueStatus } from './viewer-types';
import {
  generateEmbedding,
  embeddingModelInitCount,
  prewarmEmbeddingModel,
  embeddingToBlob,
  buildObservationSearchText,
  DIMENSIONS,
  withEmbeddingTimeout,
  DEFAULT_JOB_EMBEDDING_TIMEOUT_MS,
} from '../embedding';
import {
  RAW_PROTOCOL,
  SEMANTIC_EN_PROTOCOL,
  checkSemanticEnRecord,
  embeddingSpaceKey,
  semanticEnSearchTextFields,
  type SemanticEnRecord,
  type SemanticEnRecordSource,
} from '../semantic-en';
import { PACKAGE_VERSION } from '../version';

// --- Global error handlers (only in production entry) ---

if (typeof process !== 'undefined') {
  process.on('uncaughtException', (err) => { logError('uncaughtException', err); });
  process.on('unhandledRejection', (reason) => { logError('unhandledRejection', reason); });
}

// --- Shared utilities ---

const PRIVATE_OPEN = '<private>';
const PRIVATE_CLOSE = '</private>';
const REDACTED = '[REDACTED]';

/**
 * Fail-closed `<private>` redaction.
 *
 * A regex like /<private>[\s\S]*?<\/private>/ only redacts well-formed pairs,
 * so a user who forgets the closing tag gets their secret written verbatim into
 * the append-only Truth Layer — the one place we cannot retract it from. This
 * scanner instead treats an *unterminated* `<private>` as "redact to the end of
 * the string", and counts nesting depth so an inner `</private>` cannot end the
 * outer block early.
 *
 * Exported for tests.
 */
export function redactPrivate(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let i = 0;
  let depth = 0;

  while (i < text.length) {
    if (lower.startsWith(PRIVATE_OPEN, i)) {
      depth++;
      i += PRIVATE_OPEN.length;
      continue;
    }
    if (lower.startsWith(PRIVATE_CLOSE, i)) {
      if (depth > 0) {
        depth--;
        i += PRIVATE_CLOSE.length;
        if (depth === 0) out += REDACTED;
        continue;
      }
      // A stray closing tag never opened a block; it carries no secret.
      out += text.slice(i, i + PRIVATE_CLOSE.length);
      i += PRIVATE_CLOSE.length;
      continue;
    }
    if (depth === 0) out += text[i];
    i++;
  }

  // Unterminated block: everything after the opening tag stays redacted.
  if (depth > 0) out += REDACTED;
  return out;
}

function stripPrivateTags(val: unknown): unknown {
  if (typeof val === 'string') return redactPrivate(val);
  if (Array.isArray(val)) return val.map(stripPrivateTags);
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) out[k] = stripPrivateTags(v);
    return out;
  }
  return val;
}

function shouldSkip(toolName: string, skipTools: string[]): boolean {
  return skipTools.some((pattern) => {
    if (pattern.endsWith('*')) return toolName.startsWith(pattern.slice(0, -1));
    return toolName === pattern;
  });
}

/**
 * Extract the assistant's final response from a turn's Stop event.
 *
 * The Stop payload is already private-tag-redacted at ingest time, so whatever
 * we read here is safe to feed the compressor.
 *
 * VERIFIED against kiro-cli 2.12.1 (and the official hooks docs, updated
 * 2026-06-05): the Stop hook payload carries the assistant's last response as
 * a top-level string field named `assistant_response`. We read exactly that
 * and tolerate its absence (returns ''), so a missing/older payload never
 * breaks the job.
 */
function extractAssistantResponse(db: MemoryDB, turn_id: number): string {
  const events = db.listTurnEvents(turn_id);
  // Prefer the last stop event if there are several (there should be one).
  const stop = [...events].reverse().find((e) => e.hook_event_name === 'stop');
  if (!stop) return '';
  try {
    const payload = JSON.parse(stop.payload_json) as Record<string, unknown>;
    return typeof payload.assistant_response === 'string' ? payload.assistant_response : '';
  } catch {
    return '';
  }
}

/** Recorded on every derived value so a translator change can invalidate rows. */
const SEMANTIC_EN_TRANSLATOR = 'acp:kiro-mem-compressor';

/**
 * Concurrent query embeddings allowed before the Worker sheds load.
 *
 * A local MiniLM query embedding is ~2-5ms warm, so this is a burst allowance,
 * not a throughput knob: with three repos searching at once the queue never
 * approaches it, and if it does the caller is better off with FTS-only than
 * with a search that misses its 1.2s deadline.
 */
const EMBED_QUEUE_LIMIT = 8;
/** Longest query text accepted for embedding (a query, not a document). */
const EMBED_TEXT_MAX_CHARS = 4000;

interface ResolvedSemanticEn {
  status: 'ready' | 'pending' | 'failed';
  payload: SemanticEnRecord | null;
  attempts: number;
  reason: string | null;
}

/**
 * Decide the `semantic-en-v1` derived value for one Observation, at most two
 * attempts.
 *
 * Attempt 1 rode along with the compression response (no extra call — that is
 * the whole point of the design). Attempt 2 is a translation-only ACP call, and
 * only happens because attempt 1 produced something the guardrails refused.
 *
 * The three outcomes are deliberately distinguishable:
 *   ready   — validated, gets an English vector.
 *   failed  — the guardrails refused it twice. A content problem: retrying the
 *             same translator with the same input will refuse it again, so it
 *             needs a protocol/prompt change, not a queue.
 *   pending — no usable attempt happened (translator unavailable, ACP error, or
 *             a fallback-quality Observation with nothing to translate). Fixable
 *             by re-running later.
 *
 * Neither non-ready outcome writes a vector. A wrong translation is worse than a
 * missing one: at read time it is indistinguishable from a good one, and the
 * phase 1a `zh query → en record` measurement (MRR 0.437 vs 0.529 raw) is what a
 * silently mismatched pair actually costs.
 */
async function resolveSemanticEn(
  compressor: MemoryCompressor,
  fromSummary: SemanticEnRecord | null,
  source: SemanticEnRecordSource,
): Promise<ResolvedSemanticEn> {
  const first = checkSemanticEnRecord(fromSummary, source);
  if (first.ok) {
    return { status: 'ready', payload: fromSummary, attempts: 1, reason: null };
  }

  if (!compressor.normalizeSemanticEn) {
    return {
      status: 'pending',
      payload: null,
      attempts: 1,
      reason: `translator_unavailable:${first.reason}`,
    };
  }

  let retried: SemanticEnRecord | null = null;
  try {
    retried = await compressor.normalizeSemanticEn(source);
  } catch (error) {
    return {
      status: 'pending',
      payload: null,
      attempts: 2,
      reason: `retry_error:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }

  const second = checkSemanticEnRecord(retried, source);
  if (second.ok) return { status: 'ready', payload: retried, attempts: 2, reason: null };

  // No retry produced anything at all => infra, not content.
  if (retried === null) {
    return { status: 'pending', payload: null, attempts: 2, reason: `retry_empty:${second.reason}` };
  }
  return {
    status: 'failed',
    payload: null,
    attempts: 2,
    reason: `${first.reason}|${second.reason}:${second.detail}`.slice(0, 200),
  };
}

// =============================================================
// createApp — testable factory. Tests inject their own DB/compressor.
// =============================================================
export interface AppDeps {
  db: MemoryDB;
  compressor: MemoryCompressor;
  config: Config;
  /** Set false to skip embedding generation (tests). */
  enableEmbeddings?: boolean;
  /** Override local embedding generation for deterministic failure tests. */
  embeddingGenerator?: (text: string) => Promise<Float32Array>;
  embeddingTimeoutMs?: number;
  jobPollMs?: number;
  /** Explicit token for tests; undefined reads <dataDir>/.token. Empty disables auth. */
  authToken?: string;
  /** Set false to disable token auth (legacy tests). */
  enableAuth?: boolean;
  /** Viewer bundle search path. Tests point this at a fixture directory. */
  viewerUiDirs?: string[];
  /** Viewer log-drawer source directory. Tests point this at a fixture. */
  viewerLogsDir?: string;
}

/**
 * The gray-release switch as it is ON DISK right now.
 *
 * `/health` needs the live value, not the one this Worker booted with: the switch
 * is read per MCP server process, so an operator who edits `config.json` has new
 * sessions on the new profile immediately while this long-lived process still
 * holds its startup copy. Falls back to the injected config when the file is
 * missing or unreadable (fresh install, tests), and treats only an explicit
 * `false` as a rollback — same rule as `loadConfig()`.
 *
 * One small JSON read per health check. `/health` is polled by `diagnose` and by
 * hand, not per request, so this is not on any hot path.
 */
function readSemanticDiscoverySwitch(fallback: Config): boolean {
  try {
    const raw = JSON.parse(readFileSync(join(getDataDir(), 'config.json'), 'utf-8'));
    if (raw?.retrieval?.semanticDiscovery !== undefined) {
      return raw.retrieval.semanticDiscovery !== false;
    }
  } catch {
    /* fall through to the injected config */
  }
  return fallback.retrieval.semanticDiscovery;
}

export function createApp(deps: AppDeps) {
  const { db, compressor, config } = deps;
  const enableEmbeddings = deps.enableEmbeddings ?? true;
  const embeddingGenerator = deps.embeddingGenerator ?? generateEmbedding;
  const embeddingTimeoutMs = deps.embeddingTimeoutMs ?? DEFAULT_JOB_EMBEDDING_TIMEOUT_MS;
  const enableAuth = deps.enableAuth ?? true;
  const skipTools = config.filter.skipTools;

  // =============================================================
  // Runtime observability state (in-memory, since worker start)
  // =============================================================
  //
  // None of this is persisted. It answers "what is this machine doing right
  // now", which a restart legitimately resets — and keeping it out of SQLite
  // means a polled `/health` adds no writes.

  /**
   * MCP processes seen recently, `pid -> last seen epoch ms`.
   *
   * The Worker has no other way to know they exist: MCP servers are spawned by
   * kiro-cli, not by us, and they never registered before. Without this, the one
   * question the internal test most needs answered — "is the per-session memory
   * duplication actually gone now that the model is a Worker singleton?" — can
   * only be answered by asking each tester to run `ps` and correlate by hand.
   *
   * Best-effort by construction: a PID lands here when it calls `/embed/query`,
   * and there is no exit notification, so entries are pruned by age.
   */
  const mcpClientsSeen = new Map<number, number>();
  /** Beyond this the caller is no longer considered recently observed. */
  const MCP_CLIENT_TTL_MS = 10 * 60 * 1000;
  /** Hard cap so a PID-churning caller cannot grow this map without bound. */
  const MCP_CLIENT_MAX = 64;

  const runtimeStartedAtMs = Date.now();
  const runtimeStartedAt = new Date(runtimeStartedAtMs).toISOString();

  const noteMcpClient = (raw: string | undefined | null): void => {
    if (!raw) return;
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return;
    mcpClientsSeen.set(pid, Date.now());
    if (mcpClientsSeen.size > MCP_CLIENT_MAX) {
      // Drop the oldest first: the newest entries are the live sessions.
      const oldest = [...mcpClientsSeen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [pid] of oldest.slice(0, mcpClientsSeen.size - MCP_CLIENT_MAX)) {
        mcpClientsSeen.delete(pid);
      }
    }
  };

  /**
   * Rolling latency of the raw-event ingest route, in ms.
   *
   * Hooks give the Worker 700ms and never block the user's turn, so a Worker that
   * got slow shows up as permanently missing memory rather than as a slow turn.
   * `capture_misses_24h` already counts the misses; this says whether the Worker
   * is the reason.
   *
   * Bounded ring buffer — this is a health endpoint, not a metrics backend.
   */
  const INGEST_SAMPLE_MAX = 512;
  const ingestLatencies: number[] = [];
  let ingestRequests = 0;
  const noteIngestLatency = (ms: number): void => {
    ingestRequests++;
    if (ingestLatencies.length >= INGEST_SAMPLE_MAX) ingestLatencies.shift();
    ingestLatencies.push(ms);
  };
  const percentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx]!);
  };

  const EMBED_SAMPLE_MAX = 512;
  const embedLatencies: number[] = [];
  let embedRequests = 0;
  const noteEmbedLatency = (ms: number): void => {
    embedRequests++;
    if (embedLatencies.length >= EMBED_SAMPLE_MAX) embedLatencies.shift();
    embedLatencies.push(ms);
  };

  // RSS is sampled out of band. A failed or slow `ps` must never block the
  // Worker's event loop, so /health returns the last completed sample instead.
  let rssSample: RssSample = { byPid: new Map(), measured: true };
  let rssSampleAt = 0;
  let rssSampleKey = '';
  let rssSampling = false;
  const requestRssSample = (pids: number[]): void => {
    const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))]
      .sort((a, b) => a - b);
    const key = unique.join(',');
    if (rssSampling || (key === rssSampleKey && Date.now() - rssSampleAt < 1000)) return;
    rssSampleKey = key;
    rssSampling = true;
    void sampleRssTreeAsync(unique).then((sample) => {
      rssSample = sample;
      rssSampleAt = Date.now();
    }).finally(() => {
      rssSampling = false;
    });
  };

  // --- Job Runner ---
  const jobRunner = new JobRunner(db, {
    concurrency: config.compression.concurrency,
    pollMs: deps.jobPollMs ?? 2000,
  });

  // --- Viewer SSE hub (plan §8) ---
  //
  // Created here rather than beside the routes because the synthesis jobs below
  // publish into it: an Observation appearing in the Feed the moment its
  // transaction commits is the whole point of the stream. Broadcasts are no-ops
  // while nobody is connected, so an idle Worker pays nothing for it.
  const viewerHub = new ViewerStreamHub({
    queueStatus: () => viewerQueueStatus(),
  });
  const viewerQueueStatus = (): ViewerQueueStatus => {
    const stats = jobRunner.stats;
    return {
      pending: stats.pending,
      leased: stats.leased,
      dead: stats.dead,
      succeeded24h: db.getObservabilityStats().jobs24h.succeeded,
    };
  };

  // =============================================================
  // Synthesis jobs — project closed turns into atomic Observations.
  // =============================================================

  // --- summarize_turn job ---
  //
  // Projects exactly one closed turn into at most one immutable Observation.
  // Input = user prompt + assistant final response + deterministic artifacts.
  // Idempotent on observations.turn_id (UNIQUE). Compression failure never
  // touches the Truth Layer; on retry exhaustion it degrades to a
  // quality='fallback' Observation carrying only deterministic evidence.
  // It never schedules any cross-observation organization job.
  jobRunner.register('summarize_turn', async (job) => {
    const { turn_id } = JSON.parse(job.payload_json) as { turn_id: number };
    const turn = db.getTurn(turn_id);
    if (!turn || turn.state !== 'closed') return;

    // Idempotency: an Observation already exists for this turn.
    if (db.getObservationByTurnId(turn_id)) return;

    const artifacts = extractArtifacts(db, turn_id);
    const assistantResponse = extractAssistantResponse(db, turn_id);
    const turnStoppedAt = turn.stopped_at || turn.last_event_at;

    let result: ObservationSummaryResult;
    try {
      result = await compressor.summarizeObservation({
        user_prompt: turn.prompt_text || '',
        assistant_response: assistantResponse,
        artifacts: {
          files_touched: artifacts.files_touched,
          commands: artifacts.commands,
          test_signals: artifacts.test_signals,
          error_signals: artifacts.error_signals,
          facts: artifacts.facts,
        },
      });
    } catch (err) {
      // ACP infra failure (timeout / contamination / process death). Retry
      // with backoff while attempts remain; on the final attempt degrade to a
      // fallback Observation so the closed turn still yields a retrievable
      // record. The Truth Layer is untouched either way.
      const isFinalAttempt = job.attempts + 1 >= job.max_attempts;
      if (!isFinalAttempt) throw err;
      result = {
        title: '', summary: '', request: '', outcome: '', learned: '',
        next_steps: '', memory_type: 'change', files_touched: [], concepts: [],
        evidence: [], importance_score: 0, confidence_score: 0, unresolved_score: 0,
      };
    }

    const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
    // Empty title AND summary => the model produced nothing usable (parse
    // repair exhausted, or the ACP-final-attempt degrade above).
    const isFallback = !result.title.trim() && !result.summary.trim();

    let fields: {
      title: string; summary: string; request: string | null; outcome: string | null;
      learned: string | null; next_steps: string | null; memory_type: MemoryType;
      files_touched: string[]; concepts: string[]; evidence: string[];
      importance_score: number; confidence_score: number; unresolved_score: number;
    };

    if (isFallback) {
      const promptText = (turn.prompt_text || '').replace(/\s+/g, ' ').trim();
      const evidence = [
        ...artifacts.error_signals,
        ...artifacts.test_signals,
        ...artifacts.commands.slice(0, 5),
      ].slice(0, 10);
      fields = {
        title: promptText.slice(0, 40) || `Turn ${turn.seq}`,
        summary: 'Compression unavailable; deterministic evidence only.',
        request: promptText || null,
        outcome: null, // never fabricate a completion state
        learned: null,
        next_steps: null,
        memory_type: 'change',
        files_touched: artifacts.files_touched,
        concepts: [],
        evidence,
        importance_score: 0,
        confidence_score: 0,
        unresolved_score: 0,
      };
    } else {
      const memoryType = (validTypes.includes(result.memory_type) ? result.memory_type : 'change') as MemoryType;
      fields = {
        title: result.title || `Turn ${turn.seq}`,
        summary: result.summary || '',
        request: result.request || null,
        outcome: result.outcome || null,
        learned: result.learned || null,
        next_steps: result.next_steps || null,
        memory_type: memoryType,
        files_touched: result.files_touched ?? [],
        concepts: result.concepts ?? [],
        evidence: result.evidence ?? [],
        importance_score: result.importance_score ?? 0.5,
        confidence_score: result.confidence_score ?? 0.5,
        unresolved_score: result.unresolved_score ?? 0,
      };
    }

    // Observation + its embedding job are one unit of work: an Observation with
    // no embed job is silently semantic-search-invisible, and only shows up as a
    // slightly lower coverage percentage.
    //
    // The English derived value joins that unit for the same reason: written in
    // the same transaction, it is either visible to the embed job or absent, but
    // never half-applied.
    const semanticSource: SemanticEnRecordSource = {
      title: fields.title,
      summary: fields.summary,
      outcome: fields.outcome,
      learned: fields.learned,
      concepts: fields.concepts,
    };
    const derived = isFallback
      ? { status: 'pending' as const, payload: null, attempts: 0, reason: 'source_quality_fallback' }
      : await resolveSemanticEn(compressor, result.semantic_en ?? null, semanticSource);

    let observationId: number | null = null;
    db.transaction(() => {
      observationId = db.insertObservation({
        turn_id,
        session_id: turn.session_id,
        turn_seq: turn.seq,
        repo: turn.repo,
        cwd_scope: turn.cwd,
        ...fields,
        quality: isFallback ? 'fallback' : 'normal',
        turn_started_at: turn.started_at,
        turn_stopped_at: turnStoppedAt,
      });

      // null => a concurrent run already created the Observation for this turn.
      if (observationId == null) return;

      db.upsertObservationSemanticText({
        observation_id: observationId,
        protocol: SEMANTIC_EN_PROTOCOL,
        status: derived.status,
        payload: derived.payload,
        translator: SEMANTIC_EN_TRANSLATOR,
        translator_version: PACKAGE_VERSION,
        attempts: derived.attempts,
        failure_reason: derived.reason,
      });

      // Embedding runs as its own job (§5.7). Gate the enqueue on embeddings
      // being enabled so tests don't accrue no-op jobs.
      if (enableEmbeddings) {
        db.enqueueJob({
          job_type: 'embed_observation',
          dedupe_key: `embed:obs:${observationId}`,
          entity_type: 'observation',
          entity_id: String(observationId),
          payload_json: JSON.stringify({ observation_id: observationId }),
        });

        // `pending` means "no usable attempt happened", which is retryable — so
        // it must not sit there waiting for someone to run `kiro-mem repair`.
        // `failed` is deliberately NOT requeued: the guardrails refused the
        // content twice already, and a third identical attempt is just cost.
        if (derived.status === 'pending' && compressor.normalizeSemanticEn) {
          db.enqueueJob({
            job_type: 'renormalize_observation',
            dedupe_key: `renorm:obs:${observationId}`,
            entity_type: 'observation',
            entity_id: String(observationId),
            payload_json: JSON.stringify({ observation_id: observationId }),
          });
        }
      }
    });

    // After the transaction, never inside it: a Viewer told that an Observation
    // exists must be able to fetch it, and a rolled-back transaction must not
    // have announced anything. The annotation keeps the declared union — the id
    // is assigned inside a callback, which control-flow analysis cannot see.
    const createdId: number | null = observationId;
    if (createdId != null) {
      const created = db.getObservation(createdId);
      if (created) {
        viewerHub.broadcast({
          type: 'observation_created',
          scopeKey: created.scope_key,
          observationId: created.id,
        });
      }
    }
  });

  // --- embed_observation job ---
  //
  // Generates the local semantic vectors for an Observation. Embedding input is
  // the structured search text (§5.5) — never the full assistant_response or
  // raw tool output, to keep the vector space clean and free of noise/PII.
  //
  // Keep the locally rebuildable raw projection for compatibility, although
  // current search never scores it. The semantic-en vector is written only after
  // the derived value passes the current guardrails again.
  jobRunner.register('embed_observation', async (job) => {
    if (!enableEmbeddings) return;
    const { observation_id } = JSON.parse(job.payload_json) as { observation_id: number };
    const obs = db.getObservation(observation_id);
    if (!obs) return;

    const parseArr = (json: string): string[] => {
      try {
        const p = JSON.parse(json);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
      } catch { return []; }
    };
    const concepts = parseArr(obs.concepts_json);
    const files = parseArr(obs.files_touched_json);

    // Idempotent, but only against a vector in the CURRENT space: a row written
    // by an older model (or an older protocol) must be REPLACED, not treated as
    // "already done", or `kiro-mem repair` would requeue jobs that no-op forever.
    const has = (spaceKey: string): boolean =>
      db.getObservationEmbeddingsByIds([observation_id], {
        model: spaceKey,
        dimensions: DIMENSIONS,
      }).length > 0;

    const embedInto = async (spaceKey: string, text: string): Promise<void> => {
      if (!text.trim() || has(spaceKey)) return;
      const embedding = await withEmbeddingTimeout(
        embeddingGenerator(text),
        embeddingTimeoutMs,
      );
      db.upsertObservationEmbedding(observation_id, spaceKey, DIMENSIONS, embeddingToBlob(embedding));
    };

    await embedInto(
      embeddingSpaceKey(RAW_PROTOCOL),
      buildObservationSearchText({
        title: obs.title,
        summary: obs.summary,
        outcome: obs.outcome,
        learned: obs.learned,
        concepts,
        files,
      }),
    );

    const derivedRow = db.getObservationSemanticText(observation_id, SEMANTIC_EN_PROTOCOL);
    if (derivedRow?.status !== 'ready' || !derivedRow.payload_json) return;
    let payload: SemanticEnRecord | null = null;
    try {
      payload = JSON.parse(derivedRow.payload_json) as SemanticEnRecord;
    } catch {
      payload = null;
    }
    const check = checkSemanticEnRecord(payload, {
      title: obs.title,
      summary: obs.summary,
      outcome: obs.outcome,
      learned: obs.learned,
      concepts,
    });
    if (!check.ok || !payload) {
      // Demote the row instead of embedding it: the protocol table must not
      // claim `ready` for a value the current guardrails reject. This is the one
      // permitted downgrade — it carries proof, having just re-run the check.
      db.upsertObservationSemanticText({
        observation_id,
        protocol: SEMANTIC_EN_PROTOCOL,
        status: 'failed',
        payload: null,
        translator: derivedRow.translator,
        translator_version: derivedRow.translator_version,
        attempts: derivedRow.attempts,
        failure_reason: `embed_gate:${check.ok ? 'unparsable' : check.reason}`,
        allowDowngrade: true,
      });
      return;
    }

    await embedInto(
      embeddingSpaceKey(SEMANTIC_EN_PROTOCOL),
      buildObservationSearchText(semanticEnSearchTextFields(payload, files)),
    );

    // The Viewer shows whether an Observation is semantically reachable yet, so
    // the state change has to reach an open page without a manual refresh.
    viewerHub.broadcast({
      type: 'observation_updated',
      scopeKey: obs.scope_key,
      observationId: obs.id,
      reason: 'embedding',
    });
  });

  // --- renormalize_observation job ---
  //
  // Second chance for an English derived value that is not `ready`: the one that
  // came with the compression response failed the guardrails, or no attempt
  // happened at all (translator unavailable, ACP error, an older build).
  //
  // Two reasons this exists as its own job rather than more retries inside
  // `summarize_turn`:
  //   1. By then the Observation is already written and immutable, so re-running
  //      the whole compression would produce text that disagrees with it.
  //   2. A protocol or translator upgrade invalidates derived values for
  //      Observations that were compressed months ago. Without a job there is no
  //      path from "we changed the protocol" to "the corpus is rebuilt".
  //
  // Retryable vs not is the whole design here. Measured (phase 1b verification):
  // a standalone translation call succeeds 11/20 on the first pass but 9/9 on a
  // targeted retry — so an unparsable/absent answer must go back on the queue
  // with backoff. A value the guardrails REFUSED is different: the same input
  // through the same translator will be refused again, so it is recorded as
  // `failed` and left alone rather than burning five attempts.
  jobRunner.register('renormalize_observation', async (job) => {
    if (!enableEmbeddings) return;
    const { observation_id } = JSON.parse(job.payload_json) as { observation_id: number };
    const obs = db.getObservation(observation_id);
    if (!obs) return;

    const existing = db.getObservationSemanticText(observation_id, SEMANTIC_EN_PROTOCOL);
    // Idempotent: a concurrent run (or the original summarize) already got one.
    if (existing?.status === 'ready') return;
    // A fallback Observation has no compressed prose to mirror — translating
    // "Compression unavailable; deterministic evidence only." buys nothing.
    if (obs.quality === 'fallback') return;
    if (!compressor.normalizeSemanticEn) return;

    const parseArr = (json: string): string[] => {
      try {
        const p = JSON.parse(json);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
      } catch { return []; }
    };
    const source: SemanticEnRecordSource = {
      title: obs.title,
      summary: obs.summary,
      outcome: obs.outcome,
      learned: obs.learned,
      concepts: parseArr(obs.concepts_json),
    };
    const attempts = (existing?.attempts ?? 0) + 1;
    const record = (
      status: 'ready' | 'pending' | 'failed',
      payload: SemanticEnRecord | null,
      reason: string | null,
    ) => {
      db.upsertObservationSemanticText({
        observation_id,
        protocol: SEMANTIC_EN_PROTOCOL,
        status,
        payload,
        translator: SEMANTIC_EN_TRANSLATOR,
        translator_version: PACKAGE_VERSION,
        attempts,
        failure_reason: reason,
      });
    };

    let candidate: SemanticEnRecord | null = null;
    try {
      candidate = await compressor.normalizeSemanticEn(source);
    } catch (error) {
      // Infrastructure, not content: stay `pending` and let the queue retry with
      // backoff. Recording the attempt first means the count survives the throw.
      record('pending', null, `retry_error:${error instanceof Error ? error.name : 'unknown'}`);
      throw error;
    }

    const check = checkSemanticEnRecord(candidate, source);
    if (check.ok && candidate) {
      record('ready', candidate, null);
      // The vector is a separate job on purpose: this one owns the translation,
      // that one owns the embedding, and either can fail without the other.
      db.enqueueJob({
        job_type: 'embed_observation',
        dedupe_key: `embed:obs:${observation_id}:renorm`,
        entity_type: 'observation',
        entity_id: String(observation_id),
        payload_json: JSON.stringify({ observation_id }),
      });
      return;
    }

    if (!candidate) {
      record('pending', null, `retry_empty:${check.ok ? 'null' : check.reason}`);
      // Retryable: the measured failure mode here is a non-JSON answer, and a
      // targeted retry recovered 9/9 of those.
      throw new Error(`semantic-en renormalize produced nothing for #${observation_id}`);
    }
    // Refused content. Retrying the same input through the same translator will
    // be refused again, so stop here instead of consuming the retry budget.
    record('failed', null, `renorm:${check.ok ? 'unknown' : `${check.reason}:${check.detail}`}`);
  });

  // --- Hono app ---
  const app = new Hono();

  // --- Local token auth middleware ---
  //
  // The expected token is resolved PER REQUEST, not captured at startup: a
  // repair install regenerates `<dataDir>/.token` while the Worker keeps
  // running, and a startup-only snapshot would then reject every Hook forever.
  //
  // A missing or blank token file is regenerated instead of disabling auth.
  // Silently running unauthenticated would mean anyone able to delete one file
  // can bypass the credential; regenerating keeps auth always-on and lets the
  // Hooks pick the new value up on their next event, so the user sees nothing.
  //
  // `authToken: ''` still disables auth explicitly for legacy tests.
  if (enableAuth && deps.authToken !== '') {
    const dataDir = getDataDir();
    const fixedToken = deps.authToken;
    let lastKnownToken = '';
    const lastLoggedAt = new Map<string, number>();

    const resolveExpectedToken = (): string => {
      if (fixedToken !== undefined) return fixedToken;

      const onDisk = readLocalAuthToken(dataDir);
      if (onDisk) {
        lastKnownToken = onDisk;
        return onDisk;
      }

      try {
        lastKnownToken = ensureLocalAuthToken(dataDir);
        logError('auth/token-regenerated', { reason: 'missing-or-empty' });
      } catch (err) {
        logError('auth/token-unreadable', {
          error_type: err instanceof Error ? err.name : 'unknown',
        });
      }
      return lastKnownToken;
    };

    // Hooks are fire-and-forget, so a rejected event is invisible to the user
    // and to `app.onError`. Count every rejection for /health and log the
    // reason, throttled per reason so a persistent mismatch (one 401 per tool
    // event) cannot grow the log without bound. Never log token values.
    const reject = (path: string, reason: string) => {
      db.recordAuthEvent('unauthorized');
      const now = Date.now();
      if (now - (lastLoggedAt.get(reason) ?? 0) > 60_000) {
        lastLoggedAt.set(reason, now);
        logError('auth/unauthorized', { reason, path });
      }
    };

    app.use('*', async (c, next) => {
      // /health is public. So is the Viewer's static shell: a browser cannot set
      // an Authorization header on a top-level navigation, and the shell carries
      // no memory content — it fetches everything under /api/viewer/*, which is
      // deliberately NOT exempt here and therefore fails closed.
      if (c.req.path === '/health') return next();
      if (c.req.path === '/ui' || c.req.path.startsWith('/ui/')) return next();

      const expected = resolveExpectedToken();
      const auth = c.req.header('Authorization') || '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';

      // No server-side credential (regeneration failed) must fail CLOSED —
      // comparing two empty strings would otherwise authenticate everyone.
      if (!expected) {
        reject(c.req.path, 'no-server-token');
        return c.json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (!provided) {
        reject(c.req.path, 'no-credential');
        return c.json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (provided !== expected) {
        reject(c.req.path, 'token-mismatch');
        return c.json({ ok: false, error: 'unauthorized' }, 401);
      }
      return next();
    });
  }

  app.onError((err, c) => {
    logError(`${c.req.method} ${c.req.path}`, err);
    return c.json({ ok: false, error: 'internal error' }, 500);
  });

  // --- Ingest latency instrumentation ---
  //
  // Wraps the whole handler, body parse included, because that is what the hook's
  // 700ms deadline actually covers. Registered before the routes so it applies to
  // every `/events/*` path, current and future.
  app.use('/events/*', async (c, next) => {
    const started = performance.now();
    try {
      await next();
    } finally {
      noteIngestLatency(performance.now() - started);
    }
  });

  app.get('/health', (c) => {
    const stats = db.getObservabilityStats();
    // Read once: `memory` below attributes RSS to the same slots `acp` reports,
    // and two reads could disagree about which slots exist.
    const acpStats = compressor.stats ?? null;
    const observedAt = new Date().toISOString();
    return c.json({
      status: 'ok',
      version: PACKAGE_VERSION,
      runtime: {
        observedAt,
        startedAt: runtimeStartedAt,
        uptimeMs: Math.max(0, Date.now() - runtimeStartedAtMs),
      },
      jobs: jobRunner.stats,
      jobs_24h: stats.jobs24h,
      search_24h: stats.search24h,
      // Which retrieval profile MCP servers started from this dataDir will serve
      // (plan §8.2). Read from DISK on every call, not from the config this
      // Worker booted with: the switch takes effect per MCP process, so after a
      // rollback edit new sessions are already on the old profile while the
      // long-lived Worker still holds the value from its own start. Reporting the
      // cached one would make /health answer "did my rollback take effect?" with
      // last week's answer — the README promises the opposite.
      //
      // `semantic_only_limit` is reported as 'none' when uncapped, because JSON
      // turns Infinity into null.
      retrieval: (() => {
        const enabled = readSemanticDiscoverySwitch(config);
        const policy = resolveRetrievalPolicy(enabled);
        return {
          semantic_discovery: enabled,
          profile: enabled ? 'default' : 'lexical-anchor-rollback',
          semantic_floor: policy.semanticFloor,
          semantic_only_limit: Number.isFinite(policy.semanticOnlyLimit)
            ? policy.semanticOnlyLimit
            : 'none',
          // Reported for the same reason floor and cap are: `profile: 'default'`
          // means `recency` on a pre-2D build and `semantic-rank` on this one, so
          // without this field /health cannot answer "which fusion order am I
          // actually serving?" without reading the binary's source.
          tie_break: policy.tieBreak,
        };
      })(),
      observations: stats.observations,
      embeddings: stats.embeddings,
      // Phase 1b's lightweight claim is "one model instance per dataDir, not one
      // per repo/session". It is only a claim if nobody can read the number.
      embedding_runtime: {
        model_instances: embeddingModelInitCount(),
        in_flight: embedInFlight,
        queue_limit: EMBED_QUEUE_LIMIT,
        rejected: embedRejected,
        requests: embedRequests,
        samples: embedLatencies.length,
        latencyMsP50: percentile([...embedLatencies].sort((a, b) => a - b), 50),
        latencyMsP95: percentile([...embedLatencies].sort((a, b) => a - b), 95),
        latencyMsMax: embedLatencies.length > 0
          ? Math.round(Math.max(...embedLatencies))
          : 0,
      },
      // Live cumulative pool/compressor state (since worker start).
      acp: acpStats,
      // Windowed repair / contamination counts over the last 24h.
      acp_24h: stats.acp24h,
      // Rejected Hook requests over the last 24h (silent-failure detector).
      auth_24h: stats.auth24h,
      // Capture is best-effort (P0-3): raw events the hooks could NOT deliver.
      // Non-zero means some turns are permanently missing input, which no
      // projection repair can undo — surfaced so the gap is never silent.
      capture_misses_24h: readCaptureMisses(getDataDir()),
      // How long the Worker itself took to accept raw events. Paired with
      // capture_misses_24h: that field says events were lost, this one says
      // whether the Worker was the bottleneck that lost them.
      ingest_runtime: (() => {
        const sorted = [...ingestLatencies].sort((a, b) => a - b);
        return {
          requests: ingestRequests,
          samples: sorted.length,
          latencyMsP50: percentile(sorted, 50),
          latencyMsP95: percentile(sorted, 95),
          latencyMsMax: sorted.length > 0 ? Math.round(sorted[sorted.length - 1]!) : 0,
        };
      })(),
      // Resident memory, attributed per process. See src/process-rss.ts for why
      // this samples subtrees rather than the PIDs the pool holds.
      memory: (() => {
        const slots = acpStats?.slots ?? [];
        const now = Date.now();
        for (const [pid, seen] of mcpClientsSeen) {
          if (now - seen > MCP_CLIENT_TTL_MS) mcpClientsSeen.delete(pid);
        }
        const mcpPids = [...mcpClientsSeen.keys()];
        const acpPids = slots
          .map((s) => s.pid)
          .filter((p): p is number => typeof p === 'number');
        // One asynchronous `ps` refresh for both groups. The response uses the
        // previous completed sample so a slow process table cannot block /health.
        requestRssSample([...acpPids, ...mcpPids]);
        const sample = rssSample;
        const acpSlots = slots.map((s) => ({
          pid: s.pid,
          // null, not 0: the process may have exited between the stats read and
          // the sample, and 0 would read as "costs nothing".
          rssBytes: s.pid == null ? null : (sample.byPid.get(s.pid) ?? null),
          jobCount: s.jobCount,
          idleMs: s.idleMs,
          busy: s.busy,
        }));
        const acpTotal = acpSlots.reduce((sum, s) => sum + (s.rssBytes ?? 0), 0);
        return {
          // The Worker's own heap. Historically small (measured 10.7MB after 18
          // days), so its job here is to RULE OUT the Worker — a large value
          // means the whole diagnosis has to be reconsidered.
          workerSelfRssBytes: process.memoryUsage().rss,
          acpSlots,
          // This is attributed subtree RSS, not a machine-wide total: shared
          // pages may be counted once per process subtree.
          acpAttributedSubtreeRssBytes: acpTotal,
          mcpClientsSeen: mcpPids.map((pid) => ({
            pid,
            rssBytes: sample.byPid.get(pid) ?? null,
            lastSeenMsAgo: now - (mcpClientsSeen.get(pid) ?? now),
          })),
          mcpClientObservationTtlMs: MCP_CLIENT_TTL_MS,
          rssSampleAt: rssSampleAt > 0 ? new Date(rssSampleAt).toISOString() : null,
          rssSampleAgeMs: rssSampleAt > 0 ? Math.max(0, now - rssSampleAt) : null,
          // False means `ps` failed. Every rssBytes above is then unreliable and
          // must not be read as a small number.
          rssMeasured: sample.measured,
        };
      })(),
      // On-disk growth. Sampled repeatedly, this is what turns "越用越大" from a
      // feeling into a rate.
      storage: stats.storage,
    });
  });

  // --- Query embedding (§5.4: one model instance per dataDir) ---
  //
  // The MCP server used to embed queries in its own process, which meant one
  // model per kiro-cli session: three repos open => three copies of the same
  // weights, three cold starts. Centralizing it here makes the Worker the only
  // holder of the model, and `scope_key` keeps the repos isolated at the data
  // layer where isolation actually belongs.
  //
  // Bounded on purpose. Inference is CPU-bound and cannot be cancelled midway,
  // so an unbounded queue would let one repo's burst push another repo's
  // interactive search past its deadline. Over the limit we reject immediately
  // (429) instead of queueing: the caller degrades to FTS-only in single-digit
  // milliseconds, which is a better answer than a slow correct one.
  let embedInFlight = 0;
  let embedRejected = 0;
  app.post('/embed/query', async (c) => {
    const started = performance.now();
    try {
      if (!enableEmbeddings) return c.json({ ok: false, error: 'embeddings disabled' }, 503);
      // This is an observation point, not a liveness registry: only callers that
      // request an embedding identify themselves, and the PID header is optional.
      noteMcpClient(c.req.header('X-Kiro-Mem-Pid'));
      // Reserve the slot BEFORE the first await. Checking the counter and then
      // yielding on `req.json()` let an entire concurrent burst pass the check
      // while the counter was still 0 — the limit existed and admitted everyone.
      if (embedInFlight >= EMBED_QUEUE_LIMIT) {
        embedRejected++;
        return c.json({ ok: false, error: 'busy', in_flight: embedInFlight }, 429);
      }
      embedInFlight++;
      try {
        let text = '';
        try {
          const body = await c.req.json();
          text = typeof body?.text === 'string' ? body.text : '';
        } catch {
          return c.json({ ok: false, error: 'invalid body' }, 400);
        }
        if (!text.trim()) return c.json({ ok: false, error: 'text required' }, 400);
        // Bound the input the same way the embed job does implicitly: a caller must
        // not be able to turn one search into an arbitrarily long inference.
        if (text.length > EMBED_TEXT_MAX_CHARS) {
          return c.json({ ok: false, error: 'text too long' }, 413);
        }

        const vector = await withEmbeddingTimeout(
          embeddingGenerator(text),
          embeddingTimeoutMs,
        );
        return c.json({
          ok: true,
          dimensions: vector.length,
          // base64 of the raw float32 buffer: same wire shape as the stored blob,
          // and ~3x smaller than a JSON number array.
          embedding: embeddingToBlob(vector).toString('base64'),
        });
      } catch (error) {
        logError('embed/query', {
          error_type: error instanceof Error ? error.name : 'UnknownError',
        });
        return c.json({ ok: false, error: 'embedding unavailable' }, 503);
      } finally {
        embedInFlight--;
      }
    } finally {
      noteEmbedLatency(performance.now() - started);
    }
  });

  // --- AgentSpawn bootstrap index (§7.3) ---
  // Compact atomic-Observation menu for the current scope. Deterministic:
  // no ACP, no embedding, no LLM synthesis. This is the sole context route.
  app.get('/context/bootstrap', async (c) => {
    const cwd = c.req.query('cwd') || '';
    const text = buildBootstrapContext(db, cwd, config.context, config.language);
    return c.text(text);
  });

  // --- Ingest Routes ---

  app.post('/events/prompt', async (c) => {
    const body = await c.req.json();
    const sessionId: string | undefined = body.session_id;
    const cwd: string = body.cwd || '';
    const prompt: string = (body.prompt || '') as string;

    if (!prompt) return c.json({ ok: true });
    if (!sessionId) {
      logError('ingest/prompt', 'missing session_id — event quarantined');
      return c.json({ ok: true, quarantined: true });
    }

    const redactedPrompt = stripPrivateTags(prompt) as string;
    const repo = detectRepo(cwd);

    db.upsertSessionRef({ session_id: sessionId, cwd, repo, branch: null });

    // Close stale open turn + enqueue its summarize job
    const staleOpen = db.getOpenTurnBySession(sessionId);
    if (staleOpen) {
      db.markTurnClosed(staleOpen.id);
      db.enqueueJob({
        job_type: 'summarize_turn',
        dedupe_key: `turn:${staleOpen.id}`,
        entity_type: 'turn',
        entity_id: String(staleOpen.id),
        payload_json: JSON.stringify({ turn_id: staleOpen.id }),
      });
    }

    const seq = db.allocateNextTurnSeq(sessionId);
    const turn = db.createTurn({ session_id: sessionId, seq, cwd, repo, prompt_text: redactedPrompt });

    db.appendTurnEvent({
      turn_id: turn.id,
      session_id: sessionId,
      hook_event_name: 'userPromptSubmit',
      payload_json: JSON.stringify(stripPrivateTags(body)),
    });

    return c.json({ ok: true, session_id: sessionId, turn_id: turn.id });
  });

  app.post('/events/observation', async (c) => {
    const body = await c.req.json();
    const sessionId: string | undefined = body.session_id;
    const toolName: string = body.tool_name || '';

    if (shouldSkip(toolName, skipTools)) return c.json({ ok: true, skipped: true });
    if (!sessionId) {
      logError('ingest/observation', `missing session_id for tool=${toolName} — quarantined`);
      return c.json({ ok: true, quarantined: true });
    }

    const turn = db.getOpenTurnBySession(sessionId);
    if (!turn) {
      logError('ingest/observation', `no open turn for session=${sessionId} tool=${toolName} — quarantined`);
      return c.json({ ok: true, quarantined: true });
    }

    const redactedBody = stripPrivateTags(body) as Record<string, unknown>;
    db.appendTurnEvent({
      turn_id: turn.id,
      session_id: sessionId,
      hook_event_name: 'postToolUse',
      tool_name: toolName,
      payload_json: JSON.stringify(redactedBody),
    });

    db.incrementTurnCounters(turn.id, { tool_events: 1, last_event_at: new Date().toISOString() });

    return c.json({ ok: true, turn_id: turn.id }, 202);
  });

  app.post('/events/stop', async (c) => {
    const body = await c.req.json();
    const sessionId: string | undefined = body.session_id;

    if (!sessionId) {
      logError('ingest/stop', 'missing session_id — ignored');
      return c.json({ ok: true, no_session: true });
    }

    const turn = db.getOpenTurnBySession(sessionId);
    if (!turn) return c.json({ ok: true, no_open_turn: true });

    // Close-out is one transaction. These three writes are a single fact
    // ("this turn ended and needs summarizing"); interleaving a crash or a
    // SQLITE_BUSY between them leaves an orphan — a closed turn with no job, or
    // a stop event on a still-open turn — that nothing later would notice.
    db.transaction(() => {
      db.appendTurnEvent({
        turn_id: turn.id,
        session_id: sessionId,
        hook_event_name: 'stop',
        payload_json: JSON.stringify(stripPrivateTags(body)),
      });

      db.markTurnClosed(turn.id);

      db.enqueueJob({
        job_type: 'summarize_turn',
        dedupe_key: `turn:${turn.id}`,
        entity_type: 'turn',
        entity_id: String(turn.id),
        payload_json: JSON.stringify({ turn_id: turn.id }),
      });
    });

    return c.json({ ok: true, session_id: sessionId, turn_id: turn.id });
  });

  // --- Web Viewer (plan §6, §7) ---
  //
  // Registered last so the auth middleware above already covers every
  // /api/viewer/* path. The static shell is exempt there by explicit path, not by
  // ordering, so this position cannot accidentally expose memory data.
  //
  // `listeningPort` starts at the configured value and is corrected by
  // `startWorker` once the socket is bound, so the Host check is anchored to the
  // port that is really serving rather than to the one config hoped for.
  let listeningPort = config.worker.port;
  registerViewerRoutes(app, {
    db,
    config,
    hub: viewerHub,
    queueStatus: viewerQueueStatus,
    listeningPort: () => listeningPort,
    retrievalProfile: () => {
      const enabled = readSemanticDiscoverySwitch(config);
      const policy = resolveRetrievalPolicy(enabled);
      return {
        semanticDiscovery: enabled,
        profile: enabled ? 'default' : 'lexical-anchor-rollback',
        semanticFloor: policy.semanticFloor,
        semanticOnlyLimit: Number.isFinite(policy.semanticOnlyLimit) ? policy.semanticOnlyLimit : 'none',
        tieBreak: policy.tieBreak,
      };
    },
    retrievalPolicy: resolveRetrievalPolicy(readSemanticDiscoverySwitch(config)),
    version: PACKAGE_VERSION,
    startedAt: runtimeStartedAt,
    ...(deps.viewerUiDirs ? { uiDirs: deps.viewerUiDirs } : {}),
    ...(deps.viewerLogsDir ? { logsDir: deps.viewerLogsDir } : {}),
  });

  return {
    app,
    jobRunner,
    viewerHub,
    /** Called once the socket is bound; keeps the Viewer's Host check truthful. */
    setListeningPort: (value: number) => {
      if (Number.isInteger(value) && value > 0) listeningPort = value;
    },
  };
}

// =============================================================
// Production singleton (used when running as main or via startWorker)
// =============================================================

const config = loadConfig();
const db = new MemoryDB();

// kiroHome holds the isolated KIRO_HOME for the ACP compressor sub-agent.
// Empty config falls back to the layout `kiro-mem install` lays down at
// <dataDir>/kiro-runtime.
const KIRO_RUNTIME_HOME = resolveRuntimeHome(config.runtime.kiroHome);
const COMPRESSOR_AGENT_NAME = 'kiro-mem-compressor';

const compressor: MemoryCompressor = new ACPCompressor({
  agentName: COMPRESSOR_AGENT_NAME,
  kiroHome: KIRO_RUNTIME_HOME,
  concurrency: config.compression.concurrency,
  timeoutMs: config.compression.timeoutMs,
  maxRetries: config.compression.maxRetries,
  // Persist ACP repair / contamination events for the 24h observability window.
  onMetric: (kind) => db.recordAcpEvent(kind),
});
const { app, jobRunner, viewerHub, setListeningPort } = createApp({ db, compressor, config });

export { app };

export function startWorker() {
  // Fail loudly if the runtime layout is broken — a missing prompt or
  // accidentally-tooled compressor agent silently breaks ACP purity.
  const issues = checkRuntimeHome(KIRO_RUNTIME_HOME, COMPRESSOR_AGENT_NAME);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    console.error('[kiro-mem] kiro-runtime check failed:');
    console.error(formatIssues(issues));
    console.error('[kiro-mem] Run `kiro-mem install` to (re)create the runtime layout.');
    process.exit(1);
  }

  const port = config.worker.port;
  const host = config.worker.host;
  const dataDir = getDataDir();

  writeFileSync(join(dataDir, '.worker.pid'), String(process.pid));
  writeFileSync(join(dataDir, '.worker.port'), String(port));

  console.log(`[kiro-mem] Worker starting on ${host}:${port}`);
  // The Worker is now the only process that holds the model (§5.4), so the cold
  // start belongs here rather than in each MCP session. Best-effort: a failed
  // prewarm must not stop the ingest path, and the first real embed retries it.
  void prewarmEmbeddingModel().catch((error) => {
    logError('embedding/prewarm', {
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
  });
  jobRunner.start();
  const server = Bun.serve({ fetch: app.fetch, port, hostname: host });
  // Anchor the Viewer's Host check to the socket that is actually bound.
  setListeningPort(server.port ?? port);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop accepting requests and claiming new work first. Closing ACP runtimes
    // rejects any prompt still in flight; wait for those jobs to record their
    // final state before closing SQLite.
    try { server.stop(true); } catch {}
    jobRunner.stop();
    try { await compressor.close?.(); } catch {}
    await jobRunner.waitForIdle(5000);
    viewerHub.closeAll();
    try { db.close(); } catch {}
    rmSync(join(dataDir, '.worker.pid'), { force: true });
    rmSync(join(dataDir, '.worker.port'), { force: true });
    process.exit(0);
  };
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

if (import.meta.main) {
  startWorker();
}
