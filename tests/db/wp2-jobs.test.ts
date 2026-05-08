import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { JobRunner } from '../../src/jobs/runner';
import { extractArtifacts } from '../../src/jobs/artifacts';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

describe('WP2 / JobRunner — lease & execute', () => {
  test('fetches and executes a pending job', async () => {
    db.enqueueJob({ job_type: 'test_job', payload_json: '{"x":1}' });

    let executed = false;
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });
    runner.register('test_job', async () => { executed = true; });
    runner.start();

    await Bun.sleep(150);
    runner.stop();

    expect(executed).toBe(true);
    const jobs = db.listJobsByState('succeeded');
    expect(jobs.length).toBe(1);
  });

  test('failed job retries with backoff', async () => {
    db.enqueueJob({ job_type: 'flaky', payload_json: '{}', max_attempts: 3 });

    let attempts = 0;
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });
    runner.register('flaky', async () => { attempts++; throw new Error('boom'); });
    runner.start();

    await Bun.sleep(200);
    runner.stop();

    // First attempt fails, job goes back to pending with backoff
    expect(attempts).toBe(1);
    const pending = db.listJobsByState('pending');
    expect(pending.length).toBe(1);
    expect(pending[0]!.attempts).toBe(1);
    expect(pending[0]!.last_error).toBe('boom');
  });

  test('job goes dead after max_attempts', async () => {
    // Pre-set attempts to max-1 so next failure = dead
    db.enqueueJob({ job_type: 'doomed', payload_json: '{}', max_attempts: 1 });

    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });
    runner.register('doomed', async () => { throw new Error('fatal'); });
    runner.start();

    await Bun.sleep(150);
    runner.stop();

    const dead = db.listJobsByState('dead');
    expect(dead.length).toBe(1);
    expect(dead[0]!.last_error).toBe('fatal');
  });

  test('dedupe prevents duplicate jobs', () => {
    const j1 = db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'turn:1', payload_json: '{}' });
    const j2 = db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'turn:1', payload_json: '{}' });
    expect(j1).not.toBeNull();
    expect(j2).toBeNull();
  });

  test('stale leases are reclaimed on start', async () => {
    // Simulate a job left in leased state from a crashed worker
    db.enqueueJob({ job_type: 'orphan', payload_json: '{}' });
    db.raw.run("UPDATE jobs SET state = 'leased', lease_owner = 'dead-pid'");

    let executed = false;
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });
    runner.register('orphan', async () => { executed = true; });
    runner.start(); // should reclaim the stale lease

    await Bun.sleep(150);
    runner.stop();

    expect(executed).toBe(true);
  });
});

describe('WP2 / Artifact extraction', () => {
  test('extracts tool names and file paths from turn events', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/proj' });
    const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/proj' });

    db.appendTurnEvent({
      turn_id: turn.id, session_id: 's1', hook_event_name: 'postToolUse',
      tool_name: 'read',
      payload_json: JSON.stringify({ tool_input: { path: '/proj/src/main.ts' }, tool_response: 'content' }),
    });
    db.appendTurnEvent({
      turn_id: turn.id, session_id: 's1', hook_event_name: 'postToolUse',
      tool_name: 'shell',
      payload_json: JSON.stringify({ tool_input: { command: 'bun test' }, tool_response: 'ok' }),
    });

    const artifacts = extractArtifacts(db, turn.id);

    expect(artifacts.tool_names).toContain('read');
    expect(artifacts.tool_names).toContain('shell');
    expect(artifacts.files_touched).toContain('/proj/src/main.ts');
    expect(artifacts.commands).toContain('bun test');
    expect(artifacts.stats.event_count).toBe(2);

    // Verify persisted to DB
    const stored = db.getTurnArtifacts(turn.id);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.tool_names_json)).toContain('read');
  });

  test('extracts error signals from tool responses', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/proj' });
    const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/proj' });

    db.appendTurnEvent({
      turn_id: turn.id, session_id: 's1', hook_event_name: 'postToolUse',
      tool_name: 'shell',
      payload_json: JSON.stringify({ tool_input: { command: 'tsc' }, tool_response: 'Error: TS2345 blah' }),
    });

    const artifacts = extractArtifacts(db, turn.id);
    expect(artifacts.error_signals.length).toBeGreaterThan(0);
    expect(artifacts.error_signals[0]).toContain('Error');
  });
});

describe('WP2 / summarize_turn job integration', () => {
  test('turn close → job enqueue → runner extracts artifacts', async () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/proj' });
    const seq = db.allocateNextTurnSeq('s1');
    const turn = db.createTurn({ session_id: 's1', seq, cwd: '/proj', prompt_text: 'fix it' });

    db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'userPromptSubmit', payload_json: '{"prompt":"fix it"}' });
    db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'postToolUse', tool_name: 'read', payload_json: JSON.stringify({ tool_input: { path: '/a.ts' }, tool_response: 'code' }) });
    db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'stop', payload_json: '{}' });
    db.markTurnClosed(turn.id);

    // Enqueue (same as worker does)
    db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: `turn:${turn.id}`, payload_json: JSON.stringify({ turn_id: turn.id }) });

    // Run job
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });
    runner.register('summarize_turn', async (job) => {
      const { turn_id } = JSON.parse(job.payload_json);
      const t = db.getTurn(turn_id);
      if (!t || t.state !== 'closed') return;
      db.setTurnSummarizationState(turn_id, 'running');
      extractArtifacts(db, turn_id);
      db.setTurnSummarizationState(turn_id, 'ready');
    });
    runner.start();
    await Bun.sleep(200);
    runner.stop();

    // Verify
    const updated = db.getTurn(turn.id)!;
    expect(updated.summarization_state).toBe('ready');
    const artifacts = db.getTurnArtifacts(turn.id);
    expect(artifacts).not.toBeNull();
    expect(JSON.parse(artifacts!.files_touched_json)).toContain('/a.ts');
  });
});
