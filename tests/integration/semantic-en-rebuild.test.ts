/**
 * Rebuild path for English derived values (`renormalize_observation`).
 *
 * Two things must hold, and they pull in opposite directions:
 *
 *  - A `pending` value is retryable and must NOT wait for a human to run
 *    `kiro-mem repair`. Measured basis: a standalone translation call succeeds
 *    11/20 on the first pass but 9/9 on a targeted retry, so "try again later"
 *    is the correct response to an unparsable answer.
 *  - A `failed` value must NOT be retried. The guardrails already refused that
 *    exact content twice; a third identical attempt costs an ACP call and
 *    changes nothing. It needs a protocol or prompt change, and it has to stay
 *    visible instead of cycling forever.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import { DIMENSIONS } from '../../src/embedding-space';
import {
  SEMANTIC_EN_PROTOCOL,
  embeddingSpaceKey,
  type SemanticEnRecord,
  type SemanticEnRecordSource,
} from '../../src/semantic-en';
import type { MemoryCompressor, ObservationSummaryResult } from '../../src/compressor';

const EN_SPACE = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);

const ZH = {
  title: '修复候选池按日期截断',
  summary: '把 getRecentObservationIds 的 limit 200 改成全 scope 打分。',
  outcome: '已改并通过 bun test',
  learned: '排序键与截断键不一致会形成硬天花板',
  concepts: ['检索', '候选池'],
};
const EN: SemanticEnRecord = {
  title: 'Fix date-based truncation of the candidate pool',
  summary: 'Changed the getRecentObservationIds limit of 200 to scoring the whole scope.',
  outcome: 'Changed and verified with bun test',
  learned: 'A ranking key that differs from the truncation key creates a hard ceiling',
  concepts: ['retrieval', 'candidate pool'],
};

/** Compressor whose translation-only call is scripted per attempt. */
class ScriptedCompressor implements MemoryCompressor {
  public calls = 0;
  constructor(private script: (attempt: number) => SemanticEnRecord | null | Error) {}
  async summarizeObservation(): Promise<ObservationSummaryResult> {
    throw new Error('not used');
  }
  async normalizeSemanticEn(_source: SemanticEnRecordSource): Promise<SemanticEnRecord | null> {
    this.calls++;
    const outcome = this.script(this.calls);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

let db: MemoryDB;
let stop: (() => void) | null = null;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { stop?.(); stop = null; db.close(); });

/** Seed a normal Observation with a non-ready derived value. */
function seed(status: 'pending' | 'failed' | 'absent'): number {
  db.upsertSessionRef({ session_id: 's1', cwd: '/proj', repo: '/proj' });
  const seq = db.allocateNextTurnSeq('s1');
  const turn = db.createTurn({ session_id: 's1', seq, cwd: '/proj', repo: '/proj', prompt_text: 'p' });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: 's1', turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
    title: ZH.title, summary: ZH.summary, outcome: ZH.outcome, learned: ZH.learned,
    concepts: ZH.concepts, memory_type: 'refactor', quality: 'normal',
    turn_started_at: '2026-07-20T00:00:00Z', turn_stopped_at: '2026-07-20T00:00:00Z',
  })!;
  if (status !== 'absent') {
    db.upsertObservationSemanticText({
      observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status,
      translator: 'acp:kiro-mem-compressor', attempts: status === 'failed' ? 2 : 1,
      failure_reason: status === 'failed' ? 'placeholder|placeholder:summary' : 'retry_error:TimeoutError',
    });
  }
  return id;
}

function runJobs(compressor: MemoryCompressor) {
  const { jobRunner } = createApp({
    db, compressor, config: loadConfig(), enableEmbeddings: true,
    embeddingGenerator: async () => new Float32Array(DIMENSIONS).fill(0.1),
    enableAuth: false, jobPollMs: 10,
  });
  stop = () => jobRunner.stop();
  jobRunner.start();
  return jobRunner;
}

async function waitFor(pred: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

describe('renormalize_observation', () => {
  test('rebuilds a pending value and enqueues its vector', async () => {
    const id = seed('pending');
    expect(db.requeueSemanticTextRebuild({ protocol: SEMANTIC_EN_PROTOCOL })).toBe(1);
    const compressor = new ScriptedCompressor(() => EN);
    runJobs(compressor);

    expect(await waitFor(() => db.getObservationEmbedding(id, EN_SPACE) != null)).toBe(true);
    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('ready');
    // attempts continues the count instead of restarting it — a rebuild that
    // silently reset the counter would hide a value that keeps needing rescue.
    expect(row.attempts).toBe(2);
    expect(JSON.parse(row.payload_json!).title).toBe(EN.title);
    expect(compressor.calls).toBe(1);
  });

  test('an unparsable answer stays pending and is retried by the queue', async () => {
    const id = seed('pending');
    db.requeueSemanticTextRebuild({ protocol: SEMANTIC_EN_PROTOCOL });
    // First attempt returns nothing (the measured "model answered prose, not
    // JSON" case), second succeeds — exactly the probe's 9/9 retry recovery.
    const compressor = new ScriptedCompressor((n) => (n === 1 ? null : EN));
    runJobs(compressor);

    expect(await waitFor(() => compressor.calls >= 1)).toBe(true);
    expect(await waitFor(() => {
      const r = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
      return r.status === 'pending' && r.failure_reason!.startsWith('retry_empty');
    })).toBe(true);
    // The job row went back to pending with a backoff, not to dead.
    const job = db.raw
      .query("SELECT state, attempts FROM jobs WHERE job_type = 'renormalize_observation'")
      .get() as { state: string; attempts: number };
    expect(job.state).toBe('pending');
    expect(job.attempts).toBe(1);
  });

  test('a refused translation goes to failed and is never retried', async () => {
    const id = seed('pending');
    db.requeueSemanticTextRebuild({ protocol: SEMANTIC_EN_PROTOCOL });
    // Well-formed, schema-valid, and useless: the phase 1a q16 failure.
    const compressor = new ScriptedCompressor(() => ({ ...EN, summary: '...' }));
    runJobs(compressor);

    expect(await waitFor(() => db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!.status === 'failed')).toBe(true);
    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.failure_reason).toContain('placeholder');
    expect(row.payload_json).toBeNull();
    expect(db.getObservationEmbedding(id, EN_SPACE)).toBeNull();
    // Non-retryable: the job succeeded (it did its job — it decided), and one
    // translation call was spent, not five.
    await new Promise((r) => setTimeout(r, 100));
    expect(compressor.calls).toBe(1);
    // And it is not picked up again by a later batch pass.
    expect(db.findObservationsMissingSemanticText({ protocol: SEMANTIC_EN_PROTOCOL })).toEqual([]);
  });

  test('a ready value short-circuits — no translation call at all', async () => {
    const id = seed('absent');
    db.upsertObservationSemanticText({
      observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status: 'ready',
      payload: EN, translator: 'acp:kiro-mem-compressor', attempts: 1,
    });
    db.enqueueJob({
      job_type: 'renormalize_observation', dedupe_key: `renorm:obs:${id}`,
      entity_type: 'observation', entity_id: String(id),
      payload_json: JSON.stringify({ observation_id: id }),
    });
    const compressor = new ScriptedCompressor(() => EN);
    runJobs(compressor);

    expect(await waitFor(() => {
      const j = db.raw.query("SELECT state FROM jobs WHERE job_type = 'renormalize_observation'").get() as { state: string };
      return j.state === 'succeeded';
    })).toBe(true);
    expect(compressor.calls).toBe(0);
  });
});

describe('batch rebuild discovery', () => {
  test('finds absent and pending values, skips failed and fallback', () => {
    const absent = seed('absent');
    const pending = seed('pending');
    seed('failed');
    // A fallback Observation has generated placeholder prose — nothing to mirror.
    const seq = db.allocateNextTurnSeq('s1');
    const turn = db.createTurn({ session_id: 's1', seq, cwd: '/proj', repo: '/proj', prompt_text: 'p' });
    db.markTurnClosed(turn.id);
    db.insertObservation({
      turn_id: turn.id, session_id: 's1', turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
      title: 'x', summary: 'Compression unavailable; deterministic evidence only.',
      memory_type: 'change', quality: 'fallback',
      turn_started_at: '2026-07-20T00:00:00Z', turn_stopped_at: '2026-07-20T00:00:00Z',
    });

    expect(db.findObservationsMissingSemanticText({ protocol: SEMANTIC_EN_PROTOCOL }))
      .toEqual([absent, pending]);
  });

  test('requeue is idempotent while jobs are in flight', () => {
    seed('absent');
    seed('pending');
    expect(db.requeueSemanticTextRebuild({ protocol: SEMANTIC_EN_PROTOCOL })).toBe(2);
    // Second pass finds nothing: the in-flight jobs are excluded, so a repeated
    // `kiro-mem repair` cannot pile up duplicate ACP work.
    expect(db.findObservationsMissingSemanticText({ protocol: SEMANTIC_EN_PROTOCOL })).toEqual([]);
    expect(db.requeueSemanticTextRebuild({ protocol: SEMANTIC_EN_PROTOCOL })).toBe(0);
  });
});

describe('pending is self-healing', () => {
  test('summarize_turn enqueues a rebuild when the derived value lands pending', async () => {
    // The compressor omits `semantic_en` entirely (an older/other implementation),
    // so the first attempt has nothing to validate.
    const compressor: MemoryCompressor = {
      async summarizeObservation() {
        return {
          title: ZH.title, summary: ZH.summary, request: '', outcome: ZH.outcome,
          learned: ZH.learned, next_steps: '', memory_type: 'refactor',
          files_touched: [], concepts: ZH.concepts, evidence: [],
          importance_score: 0.5, confidence_score: 0.5, unresolved_score: 0,
        };
      },
      async normalizeSemanticEn() { return EN; },
    };
    const { jobRunner } = createApp({
      db, compressor, config: loadConfig(), enableEmbeddings: true,
      embeddingGenerator: async () => new Float32Array(DIMENSIONS).fill(0.1),
      enableAuth: false, jobPollMs: 10,
    });
    stop = () => jobRunner.stop();

    db.upsertSessionRef({ session_id: 's2', cwd: '/proj', repo: '/proj' });
    const seq = db.allocateNextTurnSeq('s2');
    const turn = db.createTurn({ session_id: 's2', seq, cwd: '/proj', repo: '/proj', prompt_text: 'p' });
    db.appendTurnEvent({
      turn_id: turn.id, session_id: 's2', hook_event_name: 'stop',
      payload_json: JSON.stringify({ assistant_response: 'done' }),
    });
    db.markTurnClosed(turn.id);
    db.enqueueJob({
      job_type: 'summarize_turn', dedupe_key: `turn:${turn.id}`,
      entity_type: 'turn', entity_id: String(turn.id),
      payload_json: JSON.stringify({ turn_id: turn.id }),
    });
    jobRunner.start();

    // No manual `kiro-mem repair` anywhere in this test: the pending value has
    // to reach `ready` on its own.
    expect(await waitFor(() => {
      const obs = db.getObservationByTurnId(turn.id);
      if (!obs) return false;
      const row = db.getObservationSemanticText(obs.id, SEMANTIC_EN_PROTOCOL);
      return row?.status === 'ready' && db.getObservationEmbedding(obs.id, EN_SPACE) != null;
    }, 6000)).toBe(true);
  });
});
