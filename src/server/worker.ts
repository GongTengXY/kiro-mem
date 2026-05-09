import { Hono } from 'hono';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { MemoryDB, computeScopeKey } from '../db';
import type { MemoryType } from '../db/types';
import { Compressor, type CompressorProvider } from '../compressor';
import { buildContext } from '../context-builder';
import { loadConfig, getDataDir, type Config } from '../config';
import { logError } from '../logger';
import { JobRunner, extractArtifacts } from '../jobs';
import { generateEmbedding, embeddingToBlob, DIMENSIONS } from '../embedding';

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

// =============================================================
// createApp — testable factory. Tests inject their own DB/compressor.
// =============================================================

export interface AppDeps {
  db: MemoryDB;
  compressor: Compressor;
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

  jobRunner.register('summarize_turn', async (job) => {
    const { turn_id } = JSON.parse(job.payload_json) as { turn_id: number };
    const turn = db.getTurn(turn_id);
    if (!turn || turn.state !== 'closed') return;

    // Idempotency: canonical memory already claimed
    if (turn.memory_id != null) {
      db.setTurnSummarizationState(turn_id, 'ready');
      return;
    }

    db.setTurnSummarizationState(turn_id, 'running');
    const artifacts = extractArtifacts(db, turn_id);

    try {
      const result = await compressor.summarizeTurn({
        prompt_text: turn.prompt_text || '',
        artifacts: {
          tool_names: artifacts.tool_names,
          files_touched: artifacts.files_touched,
          commands: artifacts.commands,
          error_signals: artifacts.error_signals,
        },
      });

      const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
      const memoryType = (validTypes.includes(result.memory_type) ? result.memory_type : 'change') as MemoryType;

      // Atomic: insert memory + claim slot + link — all in one SQLite txn
      const memoryId = db.createTurnMemoryAtomic(turn_id, {
        memory_kind: 'turn',
        repo: turn.repo,
        cwd_scope: turn.cwd,
        title: result.title || 'Untitled turn',
        summary: result.summary || '',
        request: result.request || null,
        investigated: result.investigated || null,
        learned: result.learned || null,
        completed: result.completed || null,
        next_steps: result.next_steps || null,
        memory_type: memoryType,
        importance_score: result.importance_score ?? 0.5,
        confidence_score: result.confidence_score ?? 0.5,
        unresolved_score: result.unresolved_score ?? 0,
        files_touched: result.files_touched ?? [],
        concepts: result.concepts ?? [],
        // Persist the LLM-generated topic candidate so normalize_topic can use
        // the strongest available semantic signal instead of falling back to
        // concepts[0] / title truncation.
        topic_candidate: (result.topic_candidate || '').trim() || null,
        first_turn_at: turn.started_at,
        last_turn_at: turn.stopped_at || turn.last_event_at,
      });

      if (memoryId == null) {
        // Concurrent run already claimed
        db.setTurnSummarizationState(turn_id, 'ready');
        return;
      }

      // Embedding (non-blocking)
      if (enableEmbeddings) {
        try {
          const searchText = [result.title, result.summary, result.learned, (result.concepts || []).join(', ')].filter(Boolean).join('\n');
          if (searchText.trim()) {
            const embedding = await generateEmbedding(searchText);
            db.upsertMemoryEmbedding(memoryId, 'all-MiniLM-L6-v2', DIMENSIONS, embeddingToBlob(embedding));
          }
        } catch (embErr) {
          logError('summarize_turn/embedding', embErr);
        }
      }

      db.setTurnSummarizationState(turn_id, 'ready');

      // Enqueue normalize_topic for the new memory (Fix #1: connect to main pipeline)
      db.enqueueJob({
        job_type: 'normalize_topic',
        dedupe_key: `topic:mem:${memoryId}`,
        entity_type: 'memory',
        entity_id: String(memoryId),
        payload_json: JSON.stringify({ memory_id: memoryId }),
      });
    } catch (err) {
      db.setTurnSummarizationState(turn_id, 'failed');
      throw err;
    }
  });

  // --- normalize_topic job ---
  //
  // Takes a freshly-summarized memory and attaches it to a canonical topic.
  // Candidate precedence: persisted topic_candidate > concepts[0] > title.
  // The memory → topic link, memory_count increment, and alias union are
  // performed as one atomic upsert (see db.upsertTopicAndLinkMemory).
  jobRunner.register('normalize_topic', async (job) => {
    const { memory_id } = JSON.parse(job.payload_json) as { memory_id: number };
    const memory = db.getMemory(memory_id);
    if (!memory || memory.state !== 'active') return;

    // Idempotency: memory already linked to a topic — nothing to do.
    if (memory.topic_id != null) return;

    // Candidate precedence: persisted topic_candidate > concepts[0] > title
    const concepts: string[] = (() => {
      try {
        const p = JSON.parse(memory.concepts_json || '[]');
        return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
      } catch { return []; }
    })();
    const candidate =
      (memory.topic_candidate || '').trim() ||
      concepts[0] ||
      memory.title.slice(0, 40);
    if (!candidate) return;

    const scopeKey = computeScopeKey(memory.repo, memory.cwd_scope);
    const existingTopics = db.getActiveTopics({
      repo: memory.repo,
      cwd: memory.cwd_scope,
      limit: 50,
    });

    // --- Deterministic pre-dedup (Fix 3.4) ---
    //
    // Before spending an LLM call on "is this candidate equivalent to an
    // existing topic?", try a cheap structural match first. This covers the
    // dominant drift case where summarize_turn emits a slight re-wording of a
    // topic the system already knows about (either as the canonical label or
    // as a previously-seen alias). Only fall through to the LLM when no exact
    // structural hit exists.
    //
    // Keeping this matcher narrow (case/whitespace/trailing-punct only) is
    // intentional: it must never produce false positives. Anything semantic
    // — synonyms, translations, inclusion — still goes through the LLM path
    // with aliases surfaced in the prompt.
    const existingParsed = existingTopics.map((t) => {
      let aliases: string[] = [];
      try {
        const p = JSON.parse(t.aliases_json || '[]');
        if (Array.isArray(p)) aliases = p.filter((x): x is string => typeof x === 'string');
      } catch { /* ignore malformed aliases_json */ }
      return { id: t.id, canonical_label: t.canonical_label, aliases };
    });

    const normalizeForMatch = (s: string): string =>
      s.trim().replace(/\s+/g, ' ').replace(/[\s。.!?！？,，、;；:：]+$/u, '').toLowerCase();

    const candNorm = normalizeForMatch(candidate);
    let result: { canonical_label: string; aliases: string[] } | null = null;
    if (candNorm) {
      for (const t of existingParsed) {
        if (normalizeForMatch(t.canonical_label) === candNorm) {
          result = { canonical_label: t.canonical_label, aliases: [] };
          break;
        }
        if (t.aliases.some((a) => normalizeForMatch(a) === candNorm)) {
          result = { canonical_label: t.canonical_label, aliases: [candidate] };
          break;
        }
      }
    }

    if (!result) {
      const llmResult = await compressor.normalizeTopic({
        candidate,
        existing_topics: existingParsed.map((t) => ({
          canonical_label: t.canonical_label,
          aliases: t.aliases,
        })),
        memory_title: memory.title,
      });
      result = {
        canonical_label: llmResult.canonical_label,
        aliases: llmResult.aliases,
      };
    }

    // Atomic upsert + link + alias union. All three happen in one SQLite
    // transaction; aliases are merged via a pure-SQL DISTINCT UNION so
    // concurrent writes to the same topic never lose entries.
    const { topic_id, linked } = db.upsertTopicAndLinkMemory({
      memory_id,
      scope_key: scopeKey,
      repo: memory.repo,
      canonical_label: result.canonical_label,
      aliases: result.aliases,
    });

    // Check if topic has enough memories to trigger merge.
    const topic = db.getTopic(topic_id);

    // --- Enqueue summarize_topic at threshold boundaries (Fix 3.1) ---
    //
    // Only fire when this call actually incremented memory_count (`linked`).
    // Dedupe on the concrete threshold so each boundary fires at most once
    // per topic, even if normalize_topic runs many times at the same count
    // due to retries or concurrent work.
    if (linked && topic) {
      const SUMMARY_THRESHOLDS = [3, 5, 10, 20];
      if (SUMMARY_THRESHOLDS.includes(topic.memory_count)) {
        db.enqueueJob({
          job_type: 'summarize_topic',
          dedupe_key: `summary:topic:${topic_id}:count:${topic.memory_count}`,
          entity_type: 'topic',
          entity_id: String(topic_id),
          payload_json: JSON.stringify({ topic_id }),
        });
      }
    }

    if (topic && topic.memory_count >= 3) {
      const candidates = db.raw.query(
        `SELECT id FROM memories WHERE topic_id = ? AND state = 'active' AND memory_kind = 'turn' ORDER BY first_turn_at LIMIT 6`,
      ).all(topic_id) as { id: number }[];
      if (candidates.length >= 3) {
        const ids = candidates.map(c => c.id);
        const dedupeKey = `merge:topic:${topic_id}:${ids.join(',')}`;
        db.enqueueJob({
          job_type: 'merge_cluster_to_memory',
          dedupe_key: dedupeKey,
          entity_type: 'topic',
          entity_id: String(topic_id),
          payload_json: JSON.stringify({ memory_ids: ids, topic_id }),
        });
      }
    }
  });

  // --- summarize_topic job (Fix 3.1) ---
  //
  // Produces a compact topic-level narrative that context-builder's
  // Active Topics renderer already expects (`topics.unresolved_summary`).
  // Pulls the current active memories under the topic — this means the
  // summary always reflects the latest state, whether the topic has been
  // through a merge or not.
  jobRunner.register('summarize_topic', async (job) => {
    const { topic_id } = JSON.parse(job.payload_json) as { topic_id: number };
    const topic = db.getTopic(topic_id);
    if (!topic || topic.status === 'archived') return;

    const rows = db.raw.query(
      `SELECT title, summary, learned, next_steps
         FROM memories
        WHERE topic_id = ? AND state = 'active'
        ORDER BY last_turn_at DESC
        LIMIT 20`,
    ).all(topic_id) as Array<{
      title: string;
      summary: string;
      learned: string | null;
      next_steps: string | null;
    }>;

    // Nothing to summarize — bail silently. This can happen if all memories
    // under the topic have been superseded/archived between enqueue and run.
    if (!rows.length) return;

    const result = await compressor.summarizeTopic({
      topic_label: topic.canonical_label,
      memories: rows.map((r) => ({
        title: r.title,
        summary: r.summary,
        learned: r.learned || undefined,
        next_steps: r.next_steps || undefined,
      })),
    });

    // Guard: when BOTH fields are empty, this is almost certainly a
    // parseJSON fallback (LLM returned unparseable output). Skip the update
    // entirely so we don't erase a previously-valid unresolved_summary.
    const summaryVal = (result.summary || '').trim();
    const unresolvedVal = (result.unresolved_summary || '').trim();
    if (!summaryVal && !unresolvedVal) return;

    const patch: {
      summary?: string;
      unresolved_summary?: string;
    } = {};
    if (summaryVal) {
      patch.summary = summaryVal;
    }
    // Unresolved explicitly supports empty string (means: nothing outstanding).
    // We only write it when summary is also non-empty (i.e. a real LLM response).
    patch.unresolved_summary = unresolvedVal;
    db.updateTopic(topic_id, patch);
  });

  // --- merge_cluster_to_memory job ---
  jobRunner.register('merge_cluster_to_memory', async (job) => {
    const { memory_ids, topic_id } = JSON.parse(job.payload_json) as { memory_ids: number[]; topic_id: number };
    if (memory_ids.length < 2) return;

    const memories = db.getMemoriesByIds(memory_ids).filter(m => m.state === 'active' && m.memory_kind === 'turn');
    if (memories.length < 2) return;

    const topic = db.getTopic(topic_id);
    const topicLabel = topic?.canonical_label || 'unknown';

    const result = await compressor.mergeTurnMemories({
      memories: memories.map(m => ({ title: m.title, summary: m.summary, learned: m.learned || undefined, next_steps: m.next_steps || undefined })),
      topic_label: topicLabel,
    });

    const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
    const memoryType = (validTypes.includes(result.memory_type) ? result.memory_type : 'change') as MemoryType;

    const firstTurnAt = memories.reduce((min, m) => m.first_turn_at < min ? m.first_turn_at : min, memories[0]!.first_turn_at);
    const lastTurnAt = memories.reduce((max, m) => m.last_turn_at > max ? m.last_turn_at : max, memories[0]!.last_turn_at);

    const mergedId = db.insertMemory({
      memory_kind: 'merged',
      repo: memories[0]!.repo,
      cwd_scope: memories[0]!.cwd_scope,
      topic_id: topic_id,
      title: result.title || 'Merged memory',
      summary: result.summary || '',
      request: result.request || null,
      investigated: result.investigated || null,
      learned: result.learned || null,
      completed: result.completed || null,
      next_steps: result.next_steps || null,
      memory_type: memoryType,
      importance_score: result.importance_score ?? 0.7,
      confidence_score: result.confidence_score ?? 0.8,
      unresolved_score: result.unresolved_score ?? 0,
      files_touched: result.files_touched ?? [],
      concepts: result.concepts ?? [],
      topic_candidate: (result.topic_candidate || topicLabel || '').trim() || null,
      source_turn_count: memories.length,
      first_turn_at: firstTurnAt,
      last_turn_at: lastTurnAt,
    });

    // Link merged memory to all source turns in true turn timeline order.
    // Source memory order can differ from source turn order after retries or
    // future multi-turn inputs, so ordinal must be global across turns.
    const sourceTurnIds = memories.flatMap((m) =>
      db.listMemoryTurnLinks(m.id).map((link) => link.turn_id),
    );
    const sourceTurns = db.listTurnsByIdsOrdered(sourceTurnIds);
    sourceTurns.forEach((turn, idx) => {
      db.linkMemoryToTurn({ memory_id: mergedId, turn_id: turn.id, ordinal: idx + 1 });
    });

    // Supersede source turn memories
    for (const m of memories) {
      db.setMemoryState(m.id, 'superseded');
    }

    // A merge materially changes the active memory set under this topic.
    // Threshold-based summary jobs cover count=3/5/10/20, but repeated merges
    // can happen at counts like 6/9/12. Refresh after every successful merge so
    // Active Topics does not keep narrating superseded turn memories.
    db.enqueueJob({
      job_type: 'summarize_topic',
      dedupe_key: `summary:topic:${topic_id}:merge:${mergedId}`,
      entity_type: 'topic',
      entity_id: String(topic_id),
      payload_json: JSON.stringify({ topic_id }),
    });
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

  app.get('/health', (c) =>
    c.json({ status: 'ok', version: '2.0.0', jobs: jobRunner.stats }),
  );

  app.get('/context', async (c) => {
    const cwd = c.req.query('cwd') || '';
    const text = buildContext(db, cwd, config.context, config.language);
    return c.text(text);
  });

  // --- V2 Ingest Routes ---

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
const compressor = new Compressor();
const { app, jobRunner } = createApp({ db, compressor, config });

export { app };

export function startWorker() {
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
