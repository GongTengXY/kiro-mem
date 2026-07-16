import { Hono } from 'hono';
import { writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { MemoryDB } from '../db';
import type { MemoryType } from '../db/types';
import type { MemoryCompressor, ObservationSummaryResult } from '../compressor';
import { ACPCompressor, checkRuntimeHome, formatIssues } from '../acp';
import { buildBootstrapContext } from '../bootstrap-context';
import { loadConfig, getDataDir, type Config } from '../config';
import { logError } from '../logger';
import { JobRunner, extractArtifacts } from '../jobs';
import { generateEmbedding, embeddingToBlob, DIMENSIONS } from '../embedding';

// --- Version ---

const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf-8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// --- Global error handlers (only in production entry) ---

if (typeof process !== 'undefined') {
  process.on('uncaughtException', (err) => { logError('uncaughtException', err); });
  process.on('unhandledRejection', (reason) => { logError('unhandledRejection', reason); });
}

// --- Shared utilities ---

const PRIVATE_RE = /<private>[\s\S]*?<\/private>/gi;

function stripPrivateTags(val: unknown): unknown {
  if (typeof val === 'string') return val.replace(PRIVATE_RE, '[REDACTED]');
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

function detectRepo(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {}
  return null;
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

// =============================================================
// createApp — testable factory. Tests inject their own DB/compressor.
// =============================================================

export interface AppDeps {
  db: MemoryDB;
  compressor: MemoryCompressor;
  config: Config;
  /** Set false to skip embedding generation (tests). */
  enableEmbeddings?: boolean;
  /** Set false to disable token auth (tests). */
  enableAuth?: boolean;
}

export function createApp(deps: AppDeps) {
  const { db, compressor, config } = deps;
  const enableEmbeddings = deps.enableEmbeddings ?? true;
  const enableAuth = deps.enableAuth ?? true;
  const skipTools = config.filter.skipTools;

  // --- Job Runner ---
  const jobRunner = new JobRunner(db, {
    concurrency: config.compression.concurrency,
    pollMs: 2000,
  });

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

    const observationId = db.insertObservation({
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
    }
  });

  // --- embed_observation job ---
  //
  // Generates the local semantic vector for an Observation. Embedding input is
  // the structured search text (§5.5) — never the full assistant_response or
  // raw tool output, to keep the vector space clean and free of noise/PII.
  jobRunner.register('embed_observation', async (job) => {
    if (!enableEmbeddings) return;
    const { observation_id } = JSON.parse(job.payload_json) as { observation_id: number };
    const obs = db.getObservation(observation_id);
    if (!obs) return;
    if (db.getObservationEmbedding(observation_id)) return; // idempotent

    const parseArr = (json: string): string[] => {
      try {
        const p = JSON.parse(json);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
      } catch { return []; }
    };
    const concepts = parseArr(obs.concepts_json);
    const files = parseArr(obs.files_touched_json);
    const searchText = [
      obs.title, obs.summary, obs.outcome, obs.learned,
      concepts.join(', '), files.join(', '),
    ].filter(Boolean).join('\n');
    if (!searchText.trim()) return;

    const embedding = await generateEmbedding(searchText);
    db.upsertObservationEmbedding(observation_id, 'all-MiniLM-L6-v2', DIMENSIONS, embeddingToBlob(embedding));
  });

  // --- Hono app ---
  const app = new Hono();

  // --- Local token auth middleware ---
  if (enableAuth) {
    const tokenPath = join(getDataDir(), '.token');
    let expectedToken = '';
    try { expectedToken = readFileSync(tokenPath, 'utf-8').trim(); } catch {}

    if (expectedToken) {
      app.use('*', async (c, next) => {
        // /health is public
        if (c.req.path === '/health') return next();
        const auth = c.req.header('Authorization') || '';
        const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (provided !== expectedToken) {
          return c.json({ ok: false, error: 'unauthorized' }, 401);
        }
        return next();
      });
    }
  }

  app.onError((err, c) => {
    logError(`${c.req.method} ${c.req.path}`, err);
    return c.json({ ok: false, error: 'internal error' }, 500);
  });

  app.get('/health', (c) => {
    const stats = db.getObservabilityStats();
    return c.json({
      status: 'ok',
      version: PKG_VERSION,
      jobs: jobRunner.stats,
      jobs_24h: stats.jobs24h,
      search_24h: stats.search24h,
      observations: stats.observations,
      embeddings: stats.embeddings,
      // Live cumulative pool/compressor state (since worker start).
      acp: compressor.stats ?? null,
      // Windowed repair / contamination counts over the last 24h.
      acp_24h: stats.acp24h,
    });
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

    return c.json({ ok: true, session_id: sessionId, turn_id: turn.id });
  });

  return { app, jobRunner };
}

// =============================================================
// Production singleton (used when running as main or via startWorker)
// =============================================================

const config = loadConfig();
const db = new MemoryDB();

// kiroHome holds the isolated KIRO_HOME for the ACP compressor sub-agent.
// Empty config falls back to the layout `kiro-mem install` lays down at
// <dataDir>/kiro-runtime.
const KIRO_RUNTIME_HOME = config.runtime.kiroHome || join(getDataDir(), 'kiro-runtime');
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
const { app, jobRunner } = createApp({ db, compressor, config });

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
  jobRunner.start();
  Bun.serve({ fetch: app.fetch, port, hostname: host });
}

if (import.meta.main) {
  startWorker();
}
