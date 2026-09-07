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

const PRIVATE_OPEN = '<private>';
const PRIVATE_CLOSE = '</private>';
const REDACTED = '[REDACTED]';

/**
 * Fail-closed `<private>` redaction. A regex over well-formed pairs writes the
 * secret verbatim into the append-only Truth Layer whenever the closing tag is
 * missing — the one place we cannot retract it from. So an unterminated
 * `<private>` redacts to the end of the string, and nesting depth is counted so
 * an inner `</private>` cannot end the outer block early. Exported for tests.
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
 * The Stop payload is already private-tag-redacted at ingest, so what we read
 * here is safe to feed the compressor. Verified against kiro-cli 2.12.1 and the
 * hooks docs (updated 2026-06-05): it carries the last assistant response as a
 * top-level `assistant_response` string. Absence returns ''.
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
 * Burst allowance, not a throughput knob: a warm MiniLM query embedding is ~2-5ms,
 * so three repos searching at once never approach this, and a caller that does is
 * better off FTS-only than missing its 1.2s deadline.
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
 * attempts: attempt 1 rides along with the compression response, attempt 2 is a
 * translation-only ACP call made only when the guardrails refused attempt 1.
 *
 *   ready   — validated, gets an English vector.
 *   failed  — refused twice; the same translator on the same input refuses
 *             again, so this needs a protocol change, not a queue.
 *   pending — no usable attempt happened. Retryable.
 *
 * Neither non-ready outcome writes a vector: a wrong translation is worse than a
 * missing one, being indistinguishable from a good one at read time — phase 1a
 * measured `zh query → en record` at MRR 0.437 vs 0.529 raw.
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

// --- createApp — testable factory. Tests inject their own DB/compressor. ---
export interface AppDeps {
  db: MemoryDB;
  compressor: MemoryCompressor;
  config: Config;
  enableEmbeddings?: boolean;
  /** Override local embedding generation for deterministic failure tests. */
  embeddingGenerator?: (text: string) => Promise<Float32Array>;
  embeddingTimeoutMs?: number;
  jobPollMs?: number;
  /** Explicit token for tests; undefined reads <dataDir>/.token. Empty disables auth. */
  authToken?: string;
  enableAuth?: boolean;
  /** Viewer bundle search path. Tests point this at a fixture directory. */
  viewerUiDirs?: string[];
  viewerLogsDir?: string;
}

/**
 * The gray-release switch as it is on disk right now. `/health` needs the live
 * value, not the one this Worker booted with: the switch is read per MCP server
 * process, so an operator's edit puts new sessions on the new profile while this
 * long-lived process still holds its startup copy, and a cached answer to "did my
 * rollback take effect?" would be last week's. Falls back to the injected config
 * when the file is missing or unreadable, and treats only an explicit `false` as
 * a rollback — same rule as `loadConfig()`.
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

  // --- Runtime observability state (in-memory, since worker start) ---
  //
  // Not persisted: a restart legitimately resets "what is this machine doing
  // now", and keeping it out of SQLite means a polled `/health` adds no writes.

  /**
   * MCP processes seen recently, `pid -> last seen epoch ms`. kiro-cli spawns them
   * and they never register, so the Worker has no other way to know they exist —
   * and without it "is the per-session model duplication gone?" can only be
   * answered by running `ps` by hand. Best-effort: a PID lands here when it calls
   * `/embed/query`, there is no exit notification, so entries are pruned by age.
   */
  const mcpClientsSeen = new Map<number, number>();
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
   * Rolling latency of the raw-event ingest route, in ms. Hooks give the Worker
   * 700ms and never block the user's turn, so a slow Worker shows up as
   * permanently missing memory rather than a slow turn — `capture_misses_24h`
   * counts the misses, this says whether the Worker is the reason. Bounded ring
   * buffer: a health endpoint, not a metrics backend.
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

  const jobRunner = new JobRunner(db, {
    concurrency: config.compression.concurrency,
    pollMs: deps.jobPollMs ?? 2000,
  });

  // --- Viewer SSE hub (plan §8) ---
  //
  // Here rather than beside the routes because the synthesis jobs below publish
  // into it. Broadcasts are no-ops while nobody is connected.
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

  // --- Synthesis jobs — project closed turns into atomic Observations. ---

  // --- summarize_turn job ---
  //
  // Exactly one closed turn → at most one immutable Observation, idempotent on
  // observations.turn_id (UNIQUE). Compression failure never touches the Truth
  // Layer; on retry exhaustion it degrades to a quality='fallback' Observation
  // carrying only deterministic evidence, and it never schedules any
  // cross-observation organization job.
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
      // ACP infra failure (timeout / contamination / process death): retry with
      // backoff while attempts remain, then degrade so the closed turn still
      // yields a retrievable record.
      const isFinalAttempt = job.attempts + 1 >= job.max_attempts;
      if (!isFinalAttempt) throw err;
      result = {
        title: '', summary: '', request: '', outcome: '', learned: '',
        next_steps: '', memory_type: 'change', files_touched: [], concepts: [],
        evidence: [], importance_score: 0, confidence_score: 0, unresolved_score: 0,
      };
    }

    const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
    // Empty title and summary => nothing usable (parse repair exhausted, or degrade).
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

    // Observation + embedding job + English derived value are one transaction: an
    // Observation with no embed job is silently semantic-search-invisible, showing
    // up only as a slightly lower coverage percentage.
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

      // Embedding is its own job (§5.7); gate the enqueue so tests accrue no no-ops.
      if (enableEmbeddings) {
        db.enqueueJob({
          job_type: 'embed_observation',
          dedupe_key: `embed:obs:${observationId}`,
          entity_type: 'observation',
          entity_id: String(observationId),
          payload_json: JSON.stringify({ observation_id: observationId }),
        });

        // `pending` is retryable, so it must not wait for `kiro-mem repair`.
        // `failed` is not requeued: a third identical attempt is just cost.
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

    // After the transaction, never inside it: a rolled-back transaction must not
    // have announced anything. The annotation stays because the id is assigned
    // inside a callback, which control-flow analysis cannot see.
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
  // Input is the structured search text (§5.5) — never the full assistant_response
  // or raw tool output, to keep the vector space free of noise/PII. The raw
  // projection stays for compatibility though search never scores it; the
  // semantic-en vector is written only after the guardrails re-pass.
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

    // Idempotent only against a vector in the CURRENT space: a row from an older
    // model or protocol must be replaced, or `repair` requeues no-op jobs forever.
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
      // Demote rather than embed: the table must not claim `ready` for a value the
      // guardrails now reject. The one permitted downgrade, and it carries proof.
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

    // Semantic reachability must reach an open Viewer page without a refresh.
    viewerHub.broadcast({
      type: 'observation_updated',
      scopeKey: obs.scope_key,
      observationId: obs.id,
      reason: 'embedding',
    });
  });

  // --- renormalize_observation job ---
  //
  // Second chance for an English derived value that is not `ready`. Its own job
  // rather than more retries inside `summarize_turn`, because the Observation is
  // already written and immutable by then, and because a protocol or translator
  // upgrade invalidates derived values written months ago — without a job there is
  // no path from "we changed the protocol" to "the corpus is rebuilt".
  //
  // Measured (phase 1b): a standalone translation call succeeds 11/20 on the first
  // pass but 9/9 on a targeted retry, so an unparsable/absent answer goes back on
  // the queue with backoff. Refused content does not.
  jobRunner.register('renormalize_observation', async (job) => {
    if (!enableEmbeddings) return;
    const { observation_id } = JSON.parse(job.payload_json) as { observation_id: number };
    const obs = db.getObservation(observation_id);
    if (!obs) return;

    const existing = db.getObservationSemanticText(observation_id, SEMANTIC_EN_PROTOCOL);
    // Idempotent: a concurrent run (or the original summarize) already got one.
    if (existing?.status === 'ready') return;
    // A fallback Observation has no compressed prose worth translating.
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
      // Separate job: this one owns the translation, that one the embedding.
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
      // Retryable: the measured failure mode here is a non-JSON answer.
      throw new Error(`semantic-en renormalize produced nothing for #${observation_id}`);
    }
    // Refused content: the same input through the same translator is refused again.
    record('failed', null, `renorm:${check.ok ? 'unknown' : `${check.reason}:${check.detail}`}`);
  });

  const app = new Hono();

  // --- Local token auth middleware ---
  //
  // The expected token is resolved per request, not captured at startup: a repair
  // install regenerates `<dataDir>/.token` under a running Worker, and a startup
  // snapshot would then reject every Hook forever. A missing or blank file is
  // regenerated rather than disabling auth — otherwise anyone able to delete one
  // file bypasses the credential. `authToken: ''` still disables auth explicitly
  // for legacy tests.
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

    // A rejected hook event is invisible to the user and to `app.onError`, so
    // count it for /health and log the reason, throttled per reason so a
    // persistent mismatch cannot grow the log without bound. Never log token values.
    const reject = (path: string, reason: string) => {
      db.recordAuthEvent('unauthorized');
      const now = Date.now();
      if (now - (lastLoggedAt.get(reason) ?? 0) > 60_000) {
        lastLoggedAt.set(reason, now);
        logError('auth/unauthorized', { reason, path });
      }
    };

    app.use('*', async (c, next) => {
      // /health is public, and so is the Viewer's static shell: a browser cannot
      // set an Authorization header on a top-level navigation, and the shell
      // carries no memory content. /api/viewer/* is not exempt and fails closed.
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
  // 700ms deadline covers. Before the routes, so it covers every `/events/*` path.
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
      // (plan §8.2). Read from DISK on every call, not from the config this Worker
      // booted with — see `readSemanticDiscoverySwitch`.
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
          // `profile: 'default'` means `recency` on a pre-2D build and
          // `semantic-rank` on this one, so the fusion order needs its own field.
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
      acp: acpStats,
      acp_24h: stats.acp24h,
      // Rejected Hook requests over the last 24h (silent-failure detector).
      auth_24h: stats.auth24h,
      // Capture is best-effort (P0-3): raw events the hooks could not deliver.
      // Non-zero means turns are permanently missing input, which no projection
      // repair can undo.
      capture_misses_24h: readCaptureMisses(getDataDir()),
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
        // One async `ps` refresh for both groups; the response uses the previous
        // completed sample so a slow process table cannot block /health.
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
          // The Worker's own heap, historically small (measured 10.7MB after 18
          // days), so its job here is to rule the Worker out.
          workerSelfRssBytes: process.memoryUsage().rss,
          acpSlots,
          // Attributed subtree RSS, not a machine-wide total: shared pages may be
          // counted once per process subtree.
          acpAttributedSubtreeRssBytes: acpTotal,
          mcpClientsSeen: mcpPids.map((pid) => ({
            pid,
            rssBytes: sample.byPid.get(pid) ?? null,
            lastSeenMsAgo: now - (mcpClientsSeen.get(pid) ?? now),
          })),
          mcpClientObservationTtlMs: MCP_CLIENT_TTL_MS,
          rssSampleAt: rssSampleAt > 0 ? new Date(rssSampleAt).toISOString() : null,
          rssSampleAgeMs: rssSampleAt > 0 ? Math.max(0, now - rssSampleAt) : null,
          // False means `ps` failed: every rssBytes above is then unreliable and
          // must not be read as a small number.
          rssMeasured: sample.measured,
        };
      })(),
      // On-disk growth. Sampled repeatedly, this turns "越用越大" into a rate.
      storage: stats.storage,
    });
  });

  // --- Query embedding (§5.4: one model instance per dataDir) ---
  //
  // Embedding in the MCP server meant one model per kiro-cli session: three repos
  // open, three copies of the same weights, three cold starts. The Worker is the
  // only holder of the model; `scope_key` keeps repos isolated at the data layer.
  //
  // Bounded because inference is CPU-bound and cannot be cancelled midway: over
  // the limit we reject with 429 rather than queueing, so the caller degrades to
  // FTS-only in single-digit milliseconds instead of missing its deadline.
  let embedInFlight = 0;
  let embedRejected = 0;
  app.post('/embed/query', async (c) => {
    const started = performance.now();
    try {
      if (!enableEmbeddings) return c.json({ ok: false, error: 'embeddings disabled' }, 503);
      // An observation point, not a liveness registry: the PID header is optional.
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
        // Bound the input: one search must not become an arbitrarily long inference.
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
  // Deterministic: no ACP, no embedding, no LLM synthesis. The sole context route.
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

    // Close-out is one transaction: these three writes are a single fact, and a
    // crash or SQLITE_BUSY between them leaves an orphan — a closed turn with no
    // job, or a stop event on a still-open turn — that nothing later would notice.
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
  // Registered last so the auth middleware already covers every /api/viewer/*
  // path. The static shell is exempt there by explicit path, not by ordering, so
  // this position cannot accidentally expose memory data. `listeningPort` is
  // corrected by `startWorker` once bound, anchoring the Host check to the real port.
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

// --- Production singleton (used when running as main or via startWorker) ---

const config = loadConfig();
const db = new MemoryDB();

// Isolated KIRO_HOME for the ACP compressor sub-agent. Empty config falls back to
// the layout `kiro-mem install` lays down at <dataDir>/kiro-runtime.
const KIRO_RUNTIME_HOME = resolveRuntimeHome(config.runtime.kiroHome);
const COMPRESSOR_AGENT_NAME = 'kiro-mem-compressor';

const compressor: MemoryCompressor = new ACPCompressor({
  agentName: COMPRESSOR_AGENT_NAME,
  kiroHome: KIRO_RUNTIME_HOME,
  concurrency: config.compression.concurrency,
  // Idle governance, read at Worker start: a config edit takes effect on the next
  // start, and `/health.acp.config` reports what this process actually holds.
  minWarmRuntimes: config.compression.minWarmRuntimes,
  idleTtlMs: config.compression.idleTtlMs,
  timeoutMs: config.compression.timeoutMs,
  // Handshake budget, separate from the per-prompt one.
  startupTimeoutMs: config.compression.startupTimeoutMs,
  maxRetries: config.compression.maxRetries,
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
  // Best-effort: a failed prewarm must not stop the ingest path, and the first
  // real embed retries it.
  void prewarmEmbeddingModel().catch((error) => {
    logError('embedding/prewarm', {
      error_type: error instanceof Error ? error.name : 'UnknownError',
    });
  });
  jobRunner.start();
  const server = Bun.serve({ fetch: app.fetch, port, hostname: host });
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
