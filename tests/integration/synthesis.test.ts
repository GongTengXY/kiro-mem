import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import type { Hono } from 'hono';

let db: MemoryDB;
let fakePool: FakeACPPool;
let jobRunner: { start: () => void; stop: () => void };
let app: Hono;

beforeEach(() => {
  db = openInMemoryDB();
  fakePool = new FakeACPPool();
  const config = loadConfig();
  const result = createApp({
    db,
    compressor: new ACPCompressor({}, fakePool),
    config,
    enableEmbeddings: false,
    enableAuth: false,
  });
  app = result.app;
  jobRunner = result.jobRunner;
});

afterEach(() => {
  jobRunner.stop();
  db.close();
});

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Build a closed turn with a tool event and a stop event carrying a response. */
function seedTurn(opts: {
  session_id?: string;
  prompt: string;
  assistant_response?: string;
  command?: string;
  commandResponse?: unknown;
  file?: string;
}) {
  const sessionId = opts.session_id ?? 's1';
  db.upsertSessionRef({ session_id: sessionId, cwd: '/proj', repo: '/proj' });
  const seq = db.allocateNextTurnSeq(sessionId);
  const turn = db.createTurn({ session_id: sessionId, seq, cwd: '/proj', repo: '/proj', prompt_text: opts.prompt });

  if (opts.command || opts.file) {
    db.appendTurnEvent({
      turn_id: turn.id,
      session_id: sessionId,
      hook_event_name: 'postToolUse',
      tool_name: 'shell',
      payload_json: JSON.stringify({
        tool_input: { command: opts.command, path: opts.file },
        tool_response: opts.commandResponse ?? { exit_status: 0, stdout: '' },
      }),
    });
  }
  if (opts.assistant_response !== undefined) {
    db.appendTurnEvent({
      turn_id: turn.id,
      session_id: sessionId,
      hook_event_name: 'stop',
      payload_json: JSON.stringify({ assistant_response: opts.assistant_response }),
    });
  }
  db.markTurnClosed(turn.id);
  return turn;
}

function enqueueSummarize(turnId: number, key = `sum:${turnId}`) {
  db.enqueueJob({
    job_type: 'summarize_turn',
    dedupe_key: key,
    entity_type: 'turn',
    entity_id: String(turnId),
    payload_json: JSON.stringify({ turn_id: turnId }),
  });
}

describe('Integration / summarize_turn -> observation', () => {
  test('one closed turn -> one Observation; consumes assistant_response + test signal; no topic/merge jobs', async () => {
    fakePool.script({
      match: '本轮事实来源',
      respondWith: JSON.stringify({
        title: 'Fixed auth token refresh',
        summary: 'Refresh tokens now rotate on use.',
        request: 'Fix the auth bug',
        outcome: 'Rotation implemented; tests pass.',
        learned: 'Refresh tokens must rotate to prevent replay.',
        next_steps: '',
        memory_type: 'bugfix',
        files_touched: ['src/auth/refresh.ts'],
        concepts: ['auth', 'token refresh'],
        evidence: ['bun test (exit 0)'],
        importance_score: 0.8,
        confidence_score: 0.9,
        unresolved_score: 0,
      }),
    });

    const turn = seedTurn({
      prompt: 'Fix the auth bug',
      assistant_response: 'I made refresh tokens rotate and the tests pass now.',
      command: 'bun test',
      commandResponse: { exit_status: 0, stdout: '12 pass, 0 fail' },
      file: 'src/auth/refresh.ts',
    });
    enqueueSummarize(turn.id);

    jobRunner.start();
    await waitFor(() => !!db.getObservationByTurnId(turn.id));

    const obs = db.getObservationByTurnId(turn.id)!;
    expect(obs.title).toBe('Fixed auth token refresh');
    expect(obs.quality).toBe('normal');
    expect(obs.memory_type).toBe('bugfix');
    expect(obs.scope_key).toBe('/proj');
    expect(obs.outcome).toBe('Rotation implemented; tests pass.');

    // The compression prompt actually consumed the assistant_response AND the
    // deterministic test signal derived from the shell command.
    const v3Call = fakePool.calls.find((c) => c.prompt.includes('本轮事实来源'))!;
    expect(v3Call).toBeDefined();
    expect(v3Call.prompt).toContain('I made refresh tokens rotate');
    expect(v3Call.prompt).toContain('test PASS');

    // It never schedules write-time organization jobs.
    const jobTypes = (db.raw.query('SELECT DISTINCT job_type FROM jobs').all() as { job_type: string }[]).map((r) => r.job_type);
    expect(jobTypes).toContain('summarize_turn');
    expect(jobTypes).not.toContain('normalize_topic');
    expect(jobTypes).not.toContain('summarize_topic');
    expect(jobTypes).not.toContain('merge_cluster_to_memory');

    expect(db.listJobsByState('dead').length).toBe(0);
  });

  test('idempotent: re-enqueuing summarize_turn for the same turn keeps exactly one Observation', async () => {
    fakePool.script({
      match: '本轮事实来源',
      respondWith: JSON.stringify({
        title: 'T', summary: 'S', request: 'r', outcome: 'o', learned: 'l',
        next_steps: '', memory_type: 'change', files_touched: [], concepts: [],
        evidence: [], importance_score: 0.5, confidence_score: 0.6, unresolved_score: 0,
      }),
    });

    const turn = seedTurn({ prompt: 'work', assistant_response: 'done' });
    enqueueSummarize(turn.id, `sum:a:${turn.id}`);
    jobRunner.start();
    await waitFor(() => !!db.getObservationByTurnId(turn.id));
    const firstId = db.getObservationByTurnId(turn.id)!.id;

    // Simulate a retry that re-runs the handler for the same turn.
    enqueueSummarize(turn.id, `sum:b:${turn.id}`);
    await waitFor(() => db.listJobsByState('succeeded').length >= 2);

    const cnt = (db.raw.query('SELECT COUNT(*) AS c FROM observations WHERE turn_id = ?').get(turn.id) as { c: number }).c;
    expect(cnt).toBe(1);
    expect(db.getObservationByTurnId(turn.id)!.id).toBe(firstId);
    expect(db.listJobsByState('dead').length).toBe(0);
  });

  test('fallback: unparseable compression -> quality=fallback with request/files/evidence, no fabricated outcome', async () => {
    // Every attempt is unparseable — the first prompt AND both JSON-repair
    // retries — so repair exhausts and the production compressor returns its
    // empty result, which the job turns into a quality=fallback Observation.
    // Scripting only the first prompt would let a repair attempt succeed, which
    // is a different (and also correct) production behavior.
    fakePool.setFallback('Sorry, I cannot output JSON here.');

    const turn = seedTurn({
      prompt: 'Investigate the failing build',
      assistant_response: 'The build is broken.',
      command: 'bun run build',
      commandResponse: { exit_status: 1, stderr: 'error: type mismatch' },
      file: 'src/x.ts',
    });
    enqueueSummarize(turn.id);

    jobRunner.start();
    await waitFor(() => !!db.getObservationByTurnId(turn.id));

    const obs = db.getObservationByTurnId(turn.id)!;
    expect(obs.quality).toBe('fallback');
    expect(obs.confidence_score).toBe(0);
    expect(obs.outcome).toBeNull(); // never fabricate a completion
    expect(obs.request).toContain('Investigate the failing build');
    expect(JSON.parse(obs.files_touched_json)).toContain('src/x.ts');
    // Evidence carries the deterministic build failure signal.
    const evidence: string[] = JSON.parse(obs.evidence_json);
    expect(evidence.join(' ')).toMatch(/build FAIL|exit 1|error/i);

    expect(db.listJobsByState('dead').length).toBe(0);
  });

  test('assistant_response is redacted through /events/stop before reaching the compressor', async () => {
    fakePool.script({
      match: '本轮事实来源',
      respondWith: JSON.stringify({
        title: 'T', summary: 'S', request: 'r', outcome: 'o', learned: 'l',
        next_steps: '', memory_type: 'change', files_touched: [], concepts: [],
        evidence: [], importance_score: 0.5, confidence_score: 0.5, unresolved_score: 0,
      }),
    });

    // Drive real ingest so stripPrivateTags runs on the stop payload.
    const r1 = await app.request('/events/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'S1', cwd: '/proj', prompt: 'help' }),
    });
    const turnId = ((await r1.json()) as { turn_id: number }).turn_id;

    await app.request('/events/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'S1', assistant_response: '<private>SUPER_SECRET_TOKEN</private> all done' }),
    });

    // /events/stop now enqueues summarize_turn in production (Phase 4).
    jobRunner.start();
    await waitFor(() => !!db.getObservationByTurnId(turnId));

    const v3Call = fakePool.calls.find((c) => c.prompt.includes('本轮事实来源'))!;
    expect(v3Call).toBeDefined();
    expect(v3Call.prompt).toContain('[REDACTED]');
    expect(v3Call.prompt).not.toContain('SUPER_SECRET_TOKEN');

    // And the stored raw stop event is redacted too (Truth Layer is redacted).
    const events = db.listTurnEvents(turnId);
    const stopEv = events.find((e) => e.hook_event_name === 'stop')!;
    expect(stopEv.payload_json).not.toContain('SUPER_SECRET_TOKEN');
  });

  test('production ingest path: prompt → observation → stop auto-produces an Observation, no V2 jobs', async () => {
    fakePool.script({
      match: '本轮事实来源',
      respondWith: JSON.stringify({
        title: 'Prod path obs', summary: 'built end to end', request: 'do it',
        outcome: 'done', learned: 'wiring works', next_steps: '', memory_type: 'feature',
        files_touched: ['x.ts'], concepts: ['e2e'], evidence: ['bun test (exit 0)'],
        importance_score: 0.6, confidence_score: 0.8, unresolved_score: 0,
      }),
    });

    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const r1 = await post('/events/prompt', { session_id: 'P1', cwd: '/proj', prompt: 'build the thing' });
    const turnId = ((await r1.json()) as { turn_id: number }).turn_id;
    await post('/events/observation', { session_id: 'P1', tool_name: 'shell', tool_input: { command: 'bun test' }, tool_response: { exit_status: 0, stdout: '3 pass, 0 fail' } });
    const rs = await post('/events/stop', { session_id: 'P1', assistant_response: 'All wired up.' });
    // /events/stop enqueues summarize_turn in production.
    expect(((await rs.json()) as { turn_id: number }).turn_id).toBe(turnId);

    jobRunner.start();
    await waitFor(() => !!db.getObservationByTurnId(turnId));

    const obs = db.getObservationByTurnId(turnId)!;
    expect(obs.title).toBe('Prod path obs');
    expect(obs.quality).toBe('normal');

    // The only job types in play are the synthesis pipeline; no topic/merge jobs.
    const jobTypes = (db.raw.query('SELECT DISTINCT job_type FROM jobs').all() as { job_type: string }[]).map((r) => r.job_type);
    expect(jobTypes).toContain('summarize_turn');
    expect(jobTypes).not.toContain('normalize_topic');
    expect(jobTypes).not.toContain('merge_cluster_to_memory');
    expect(db.listJobsByState('dead').length).toBe(0);
  });

  test('repeated ACP infrastructure failures retry then produce a truthful fallback on the final attempt', async () => {
    const localDb = openInMemoryDB();
    let calls = 0;
    const failingCompressor = {
      summarizeObservation: async () => { calls++; throw new Error('ACP process exited'); },
    };
    const local = createApp({
      db: localDb, compressor: failingCompressor, config: loadConfig(),
      enableEmbeddings: false, enableAuth: false, jobPollMs: 10,
    });
    try {
      const post = (path: string, body: unknown) => local.app.request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const prompt = await post('/events/prompt', { session_id: 'infra', cwd: '/proj', prompt: 'preserve this request' });
      const turnId = ((await prompt.json()) as { turn_id: number }).turn_id;
      await post('/events/stop', { session_id: 'infra', assistant_response: 'reported completion' });
      localDb.raw.run("UPDATE jobs SET max_attempts = 2 WHERE job_type = 'summarize_turn' AND entity_id = ?", [String(turnId)]);

      local.jobRunner.start();
      await waitFor(() => {
        const job = localDb.raw.query("SELECT state, attempts FROM jobs WHERE job_type = 'summarize_turn' AND entity_id = ?").get(String(turnId)) as { state: string; attempts: number };
        return job.state === 'pending' && job.attempts === 1;
      });
      localDb.raw.run("UPDATE jobs SET available_at = ? WHERE job_type = 'summarize_turn' AND entity_id = ?", ['2000-01-01T00:00:00.000Z', String(turnId)]);
      await waitFor(() => !!localDb.getObservationByTurnId(turnId));

      const obs = localDb.getObservationByTurnId(turnId)!;
      expect(calls).toBe(2);
      expect(obs.quality).toBe('fallback');
      expect(obs.request).toContain('preserve this request');
      expect(obs.outcome).toBeNull();
      expect(localDb.listTurnEvents(turnId).length).toBe(2);
      const job = localDb.raw.query("SELECT state FROM jobs WHERE job_type = 'summarize_turn' AND entity_id = ?").get(String(turnId)) as { state: string };
      expect(job.state).toBe('succeeded');
    } finally {
      local.jobRunner.stop();
      localDb.close();
    }
  });

  test('a hanging embed_observation job times out instead of remaining leased', async () => {
    const localDb = openInMemoryDB();
    const local = createApp({
      db: localDb,
      compressor: { summarizeObservation: async () => { throw new Error('unused'); } },
      config: loadConfig(), enableEmbeddings: true, enableAuth: false,
      embeddingGenerator: () => new Promise<Float32Array>(() => {}),
      embeddingTimeoutMs: 20, jobPollMs: 10,
    });
    try {
      localDb.upsertSessionRef({ session_id: 'embed', cwd: '/proj', repo: '/proj' });
      const turn = localDb.createTurn({ session_id: 'embed', seq: 1, cwd: '/proj', repo: '/proj', prompt_text: 'embed me' });
      localDb.markTurnClosed(turn.id);
      const observationId = localDb.insertObservation({
        turn_id: turn.id, session_id: 'embed', turn_seq: 1, repo: '/proj', cwd_scope: '/proj',
        title: 'embedding timeout marker', summary: 'embedding timeout marker', memory_type: 'change', quality: 'normal',
        turn_started_at: turn.started_at, turn_stopped_at: new Date().toISOString(),
      })!;
      localDb.enqueueJob({
        job_type: 'embed_observation', dedupe_key: `embed-timeout:${observationId}`,
        entity_type: 'observation', entity_id: String(observationId),
        payload_json: JSON.stringify({ observation_id: observationId }), max_attempts: 1,
      });

      local.jobRunner.start();
      await waitFor(() => localDb.listJobsByState('dead').some((job) => job.entity_id === String(observationId)));
      expect(localDb.getObservationEmbedding(observationId)).toBeNull();
      expect(localDb.listJobsByState('leased')).toEqual([]);
    } finally {
      local.jobRunner.stop();
      localDb.close();
    }
  });
});
