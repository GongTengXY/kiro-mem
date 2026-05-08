import { Hono } from 'hono';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { MemoryDB } from '../db';
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
  jobRunner.register('normalize_topic', async (job) => {
    const { memory_id } = JSON.parse(job.payload_json) as { memory_id: number };
    const memory = db.getMemory(memory_id);
    if (!memory || memory.state !== 'active') return;

    // Fix #3: Idempotency — if memory already has a topic, skip.
    if (memory.topic_id != null) return;

    // Get topic_candidate from concepts or title
    const concepts: string[] = JSON.parse(memory.concepts_json || '[]');
    const candidate = concepts[0] || memory.title.slice(0, 40);
    if (!candidate) return;

    const existingTopics = db.getActiveTopics(memory.repo, 50);
    const existingLabels = existingTopics.map(t => t.canonical_label);

    const result = await compressor.normalizeTopic({
      candidate,
      existing_labels: existingLabels,
      memory_title: memory.title,
    });

    let topicId: number;
    if (result.action === 'existing') {
      const existing = db.findTopic(memory.repo, result.canonical_label);
      if (existing) {
        topicId = existing.id;
        const currentAliases: string[] = JSON.parse(existing.aliases_json || '[]');
        const newAliases = [...new Set([...currentAliases, ...result.aliases])];
        db.updateTopic(topicId, { aliases: newAliases, memory_count_delta: 1, last_active_at: new Date().toISOString() });
      } else {
        topicId = db.createTopic({ repo: memory.repo, canonical_label: result.canonical_label, aliases: result.aliases }).id;
        db.updateTopic(topicId, { memory_count_delta: 1 });
      }
    } else {
      topicId = db.createTopic({ repo: memory.repo, canonical_label: result.canonical_label, aliases: result.aliases }).id;
      db.updateTopic(topicId, { memory_count_delta: 1 });
    }

    // Link memory to topic
    db.raw.run('UPDATE memories SET topic_id = ?, updated_at = ? WHERE id = ? AND topic_id IS NULL', [topicId, new Date().toISOString(), memory_id]);

    // Check if topic has enough memories to trigger merge (Fix #1: auto-enqueue merge)
    const topic = db.getTopic(topicId);
    if (topic && topic.memory_count >= 3) {
      // Find un-merged turn memories for this topic
      const candidates = db.raw.query(
        `SELECT id FROM memories WHERE topic_id = ? AND state = 'active' AND memory_kind = 'turn' ORDER BY first_turn_at LIMIT 6`,
      ).all(topicId) as { id: number }[];
      if (candidates.length >= 3) {
        const ids = candidates.map(c => c.id);
        // Dedupe key includes the specific candidate set so future merges with
        // new memories get their own job (not permanently blocked by old ones).
        const dedupeKey = `merge:topic:${topicId}:${ids.join(',')}`;
        db.enqueueJob({
          job_type: 'merge_cluster_to_memory',
          dedupe_key: dedupeKey,
          entity_type: 'topic',
          entity_id: String(topicId),
          payload_json: JSON.stringify({ memory_ids: ids, topic_id: topicId }),
        });
      }
    }
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
      source_turn_count: memories.length,
      first_turn_at: firstTurnAt,
      last_turn_at: lastTurnAt,
    });

    // Link merged memory to all source turns
    for (let i = 0; i < memories.length; i++) {
      const links = db.listMemoryTurnLinks(memories[i]!.id);
      for (const link of links) {
        db.linkMemoryToTurn({ memory_id: mergedId, turn_id: link.turn_id, ordinal: i + 1 });
      }
    }

    // Supersede source turn memories
    for (const m of memories) {
      db.setMemoryState(m.id, 'superseded');
    }
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
    const text = buildContext(db, cwd, config.context);
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
