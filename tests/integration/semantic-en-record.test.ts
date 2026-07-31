/**
 * Record side of `semantic-en-v1` (plan §5.4 item 1, §5.5 gates 1/3/4).
 *
 * Driven through the production path: real `ACPCompressor` (real prompt, real
 * schema validation, real repair retries) with only the transport faked, plus the
 * real `summarize_turn` / `embed_observation` jobs.
 *
 * The invariant worth the most here: a derived value the guardrails refuse must
 * cost the Observation its English vector and SAY SO — never get embedded
 * anyway. A wrong translation is indistinguishable from a good one at read time,
 * which is why "no vector" is the safe outcome and "a vector from `...`" is not.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import { DIMENSIONS } from '../../src/embedding-space';
import { RAW_PROTOCOL, SEMANTIC_EN_PROTOCOL, embeddingSpaceKey } from '../../src/semantic-en';

const RAW_SPACE = embeddingSpaceKey(RAW_PROTOCOL);
const EN_SPACE = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
/** Marker unique to the translation-only prompt (the second, last attempt). */
const RETRY_MARKER = '把下面这条开发记忆的字段忠实翻译成英文';

let db: MemoryDB;
let stop: (() => void) | null = null;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { stop?.(); stop = null; db.close(); });

const ZH = {
  title: '修复检索候选池截断',
  summary: '把 getRecentObservationIds 的 limit 从 200 提到全量打分。',
  outcome: '已改并通过 bun test',
  learned: '排序键与截断键不一致会形成硬天花板',
  concepts: ['检索', '候选池'],
};

const EN_GOOD = {
  title: 'Fix retrieval candidate pool truncation',
  summary: 'Raised the getRecentObservationIds limit from 200 to scoring the whole scope.',
  outcome: 'Changed and verified with bun test',
  learned: 'A ranking key that differs from the truncation key creates a hard ceiling',
  concepts: ['retrieval', 'candidate pool'],
};

function summaryResponse(semantic_en: unknown): string {
  return JSON.stringify({
    title: ZH.title,
    summary: ZH.summary,
    request: '优化检索',
    outcome: ZH.outcome,
    learned: ZH.learned,
    next_steps: '',
    memory_type: 'refactor',
    files_touched: [],
    concepts: ZH.concepts,
    evidence: [],
    importance_score: 0.6,
    confidence_score: 0.8,
    unresolved_score: 0,
    ...(semantic_en === undefined ? {} : { semantic_en }),
  });
}

async function runTurn(pool: FakeACPPool): Promise<number> {
  const { jobRunner } = createApp({
    db,
    compressor: new ACPCompressor({ maxRetries: 0 }, pool),
    config: loadConfig(),
    enableEmbeddings: true,
    // Deterministic vector: this test is about WHICH spaces get written, not
    // about the numbers in them.
    embeddingGenerator: async () => new Float32Array(DIMENSIONS).fill(0.1),
    enableAuth: false,
    jobPollMs: 10,
  });
  stop = () => jobRunner.stop();

  db.upsertSessionRef({ session_id: 's1', cwd: '/proj', repo: '/proj' });
  const seq = db.allocateNextTurnSeq('s1');
  const turn = db.createTurn({ session_id: 's1', seq, cwd: '/proj', repo: '/proj', prompt_text: 'p' });
  db.appendTurnEvent({
    turn_id: turn.id, session_id: 's1', hook_event_name: 'stop',
    payload_json: JSON.stringify({ assistant_response: 'done' }),
  });
  db.markTurnClosed(turn.id);
  db.enqueueJob({
    job_type: 'summarize_turn', dedupe_key: `turn:${turn.id}`,
    entity_type: 'turn', entity_id: String(turn.id),
    payload_json: JSON.stringify({ turn_id: turn.id }),
  });

  jobRunner.start();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const obs = db.getObservationByTurnId(turn.id);
    // Wait for the embed job too: the raw vector is unconditional, so its
    // presence marks the end of the pipeline for this turn.
    if (obs && db.getObservationEmbedding(obs.id, RAW_SPACE)) return obs.id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for the observation + raw vector');
}

describe('summarize_turn produces the English derived value in the same response', () => {
  test('a valid derived value becomes ready and gets its own vector — one ACP call', async () => {
    const pool = new FakeACPPool({ fallback: summaryResponse(EN_GOOD) });
    const id = await runTurn(pool);

    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('ready');
    expect(row.attempts).toBe(1);
    expect(row.translator).toBe('acp:kiro-mem-compressor');
    expect(JSON.parse(row.payload_json!).title).toBe(EN_GOOD.title);

    expect(db.getObservationEmbedding(id, RAW_SPACE)).not.toBeNull();
    expect(db.getObservationEmbedding(id, EN_SPACE)).not.toBeNull();

    // The hot-path rule for the record side: no second ACP round trip when the
    // first response was usable.
    expect(pool.calls.filter((c) => c.prompt.includes(RETRY_MARKER)).length).toBe(0);
  });

  test('a placeholder derived value is retried once, and the retry can rescue it', async () => {
    const pool = new FakeACPPool({ fallback: summaryResponse({ ...EN_GOOD, summary: '...' }) })
      .script({ match: RETRY_MARKER, respondWith: JSON.stringify(EN_GOOD) });
    const id = await runTurn(pool);

    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('ready');
    expect(row.attempts).toBe(2);
    expect(db.getObservationEmbedding(id, EN_SPACE)).not.toBeNull();
  });

  test('two refusals => failed, raw vector only, reason recorded', async () => {
    const bad = summaryResponse({ ...EN_GOOD, summary: '...' });
    const pool = new FakeACPPool({ fallback: bad })
      .script({ match: RETRY_MARKER, respondWith: JSON.stringify({ ...EN_GOOD, summary: 'N/A' }) });
    const id = await runTurn(pool);

    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(2);
    expect(row.failure_reason).toContain('placeholder');
    expect(row.payload_json).toBeNull();
    // The Observation itself is intact and keyword/raw-semantic reachable.
    expect(db.getObservation(id)!.summary).toBe(ZH.summary);
    expect(db.getObservationEmbedding(id, RAW_SPACE)).not.toBeNull();
    expect(db.getObservationEmbedding(id, EN_SPACE)).toBeNull();
  });

  test('an untranslated echo of the Chinese fields is refused', async () => {
    const pool = new FakeACPPool({
      fallback: summaryResponse({ ...ZH }),
    }).script({ match: RETRY_MARKER, respondWith: JSON.stringify({ ...ZH }) });
    const id = await runTurn(pool);

    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toContain('untranslated');
    expect(db.getObservationEmbedding(id, EN_SPACE)).toBeNull();
  });

  test('a compressor that omits the field leaves the value pending, not wrong', async () => {
    const pool = new FakeACPPool({ fallback: summaryResponse(undefined) })
      .script({ match: RETRY_MARKER, respondWith: 'not json at all' });
    const id = await runTurn(pool);

    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    // pending, not failed: nothing about the CONTENT was proven wrong here, so
    // this is retryable work rather than a protocol violation.
    expect(row.status).toBe('pending');
    expect(db.getObservationEmbedding(id, EN_SPACE)).toBeNull();
    expect(db.getObservabilityStats().embeddings.semanticEn.pending).toBe(1);
  });
});

describe('embed_observation is the last gate', () => {
  test('a ready row that no longer passes the guardrails is demoted instead of embedded', async () => {
    // Simulates a row written by an older, looser build: status says ready, the
    // payload is a placeholder. Nothing upstream will catch it again.
    const pool = new FakeACPPool({ fallback: summaryResponse(EN_GOOD) });
    const id = await runTurn(pool);
    stop?.();

    db.raw.run(
      `UPDATE observation_semantic_texts SET payload_json = ? WHERE observation_id = ? AND protocol = ?`,
      [JSON.stringify({ ...EN_GOOD, summary: '...' }), id, SEMANTIC_EN_PROTOCOL],
    );
    db.raw.run('DELETE FROM observation_embeddings WHERE observation_id = ? AND model = ?', [id, EN_SPACE]);

    const { jobRunner } = createApp({
      db,
      compressor: new ACPCompressor({}, new FakeACPPool()),
      config: loadConfig(),
      enableEmbeddings: true,
      embeddingGenerator: async () => new Float32Array(DIMENSIONS).fill(0.1),
      enableAuth: false,
      jobPollMs: 10,
    });
    stop = () => jobRunner.stop();
    db.enqueueJob({
      job_type: 'embed_observation', dedupe_key: `embed:obs:${id}:re`,
      entity_type: 'observation', entity_id: String(id),
      payload_json: JSON.stringify({ observation_id: id }),
    });
    jobRunner.start();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const row = db.getObservationSemanticText(id, SEMANTIC_EN_PROTOCOL)!;
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe('embed_gate:placeholder');
    expect(db.getObservationEmbedding(id, EN_SPACE)).toBeNull();
  });
});
