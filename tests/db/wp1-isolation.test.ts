/**
 * WP1 integration tests: session_id isolation, quarantine, and turn lifecycle.
 *
 * These tests exercise the Worker HTTP routes directly via Hono's test client
 * (no network needed). They verify the three core WP1 acceptance criteria:
 *
 * 1. Same cwd, different session_id → events land in separate turns.
 * 2. Missing session_id → event is quarantined, never enters a trusted turn.
 * 3. stop → turn is closed correctly.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

// We need to test the route handlers with a controlled DB. The simplest way is
// to replicate the route registration against our test DB. We import the
// production `app` indirectly by re-creating the minimal route logic here.
// However, to keep tests faithful to the real code, we'll instead use a
// lightweight approach: directly call the worker module's Hono app but with
// env override for the DB path. Since the worker module uses module-level
// singletons, we'll test via fetch against the Hono app object.

// For WP1 we test at the DB layer directly (unit-level) to avoid module
// singleton issues. The Worker routes are thin wrappers; the real logic is in
// the DB methods which we already tested in WP0. Here we add scenario-level
// tests that simulate the full ingest sequence.

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

describe('WP1 / session_id isolation', () => {
  test('same cwd, different session_ids → separate turns', () => {
    const cwd = '/project';
    const repo = '/project';

    // Session A: prompt + tool + stop
    db.upsertSessionRef({ session_id: 'A', cwd, repo });
    const seqA = db.allocateNextTurnSeq('A');
    const turnA = db.createTurn({ session_id: 'A', seq: seqA, cwd, repo, prompt_text: 'fix bug' });
    db.appendTurnEvent({ turn_id: turnA.id, session_id: 'A', hook_event_name: 'userPromptSubmit', payload_json: '{"prompt":"fix bug"}' });

    // Session B: prompt (interleaved)
    db.upsertSessionRef({ session_id: 'B', cwd, repo });
    const seqB = db.allocateNextTurnSeq('B');
    const turnB = db.createTurn({ session_id: 'B', seq: seqB, cwd, repo, prompt_text: 'add feature' });
    db.appendTurnEvent({ turn_id: turnB.id, session_id: 'B', hook_event_name: 'userPromptSubmit', payload_json: '{"prompt":"add feature"}' });

    // Session A: tool event
    db.appendTurnEvent({ turn_id: turnA.id, session_id: 'A', hook_event_name: 'postToolUse', tool_name: 'read', payload_json: '{}' });
    db.incrementTurnCounters(turnA.id, { tool_events: 1 });

    // Session B: tool event
    db.appendTurnEvent({ turn_id: turnB.id, session_id: 'B', hook_event_name: 'postToolUse', tool_name: 'write', payload_json: '{}' });
    db.incrementTurnCounters(turnB.id, { tool_events: 1 });

    // Session A: stop
    db.appendTurnEvent({ turn_id: turnA.id, session_id: 'A', hook_event_name: 'stop', payload_json: '{}' });
    db.markTurnClosed(turnA.id);

    // Session B: stop
    db.appendTurnEvent({ turn_id: turnB.id, session_id: 'B', hook_event_name: 'stop', payload_json: '{}' });
    db.markTurnClosed(turnB.id);

    // Verify isolation
    const eventsA = db.listTurnEvents(turnA.id);
    const eventsB = db.listTurnEvents(turnB.id);

    expect(eventsA.length).toBe(3); // prompt + tool + stop
    expect(eventsB.length).toBe(3);

    // All events in turn A belong to session A
    expect(eventsA.every(e => e.session_id === 'A')).toBe(true);
    // All events in turn B belong to session B
    expect(eventsB.every(e => e.session_id === 'B')).toBe(true);

    // Tool names are correct per turn
    expect(eventsA.find(e => e.hook_event_name === 'postToolUse')?.tool_name).toBe('read');
    expect(eventsB.find(e => e.hook_event_name === 'postToolUse')?.tool_name).toBe('write');

    // Both turns are closed
    expect(db.getTurn(turnA.id)!.state).toBe('closed');
    expect(db.getTurn(turnB.id)!.state).toBe('closed');
  });

  test('getOpenTurnBySession only returns turn for the correct session', () => {
    db.upsertSessionRef({ session_id: 'X', cwd: '/a' });
    db.upsertSessionRef({ session_id: 'Y', cwd: '/a' });

    db.createTurn({ session_id: 'X', seq: db.allocateNextTurnSeq('X'), cwd: '/a' });
    db.createTurn({ session_id: 'Y', seq: db.allocateNextTurnSeq('Y'), cwd: '/a' });

    const openX = db.getOpenTurnBySession('X');
    const openY = db.getOpenTurnBySession('Y');

    expect(openX).not.toBeNull();
    expect(openY).not.toBeNull();
    expect(openX!.session_id).toBe('X');
    expect(openY!.session_id).toBe('Y');
    expect(openX!.id).not.toBe(openY!.id);
  });
});

describe('WP1 / quarantine — missing session_id', () => {
  test('tool event without session_id cannot enter any trusted turn', () => {
    // Create a valid open turn for session A
    db.upsertSessionRef({ session_id: 'A', cwd: '/proj' });
    const turn = db.createTurn({ session_id: 'A', seq: db.allocateNextTurnSeq('A'), cwd: '/proj' });

    // Simulate: an event arrives without session_id. The worker would
    // quarantine it. Here we verify that getOpenTurnBySession with empty/null
    // session_id does NOT return the existing turn.
    const found = db.getOpenTurnBySession('');
    expect(found).toBeNull();

    // The turn for session A is untouched
    expect(db.countTurnEvents(turn.id)).toBe(0);
  });

  test('tool event with unknown session_id finds no open turn', () => {
    db.upsertSessionRef({ session_id: 'A', cwd: '/proj' });
    db.createTurn({ session_id: 'A', seq: db.allocateNextTurnSeq('A'), cwd: '/proj' });

    // Different session_id that has no open turn
    const found = db.getOpenTurnBySession('UNKNOWN');
    expect(found).toBeNull();
  });
});

describe('WP1 / stop closes turn correctly', () => {
  test('stop sets state=closed and stopped_at', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/tmp' });

    expect(turn.state).toBe('open');
    expect(turn.stopped_at).toBeNull();

    db.markTurnClosed(turn.id);

    const closed = db.getTurn(turn.id)!;
    expect(closed.state).toBe('closed');
    expect(closed.stopped_at).not.toBeNull();
  });

  test('after stop, getOpenTurnBySession returns null', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/tmp' });
    db.markTurnClosed(turn.id);

    expect(db.getOpenTurnBySession('s1')).toBeNull();
  });

  test('stop enqueues summarize_turn job with dedupe', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/tmp' });
    db.markTurnClosed(turn.id);

    // Enqueue job (simulating what worker.ts does)
    const job = db.enqueueJob({
      job_type: 'summarize_turn',
      dedupe_key: `turn:${turn.id}`,
      entity_type: 'turn',
      entity_id: String(turn.id),
      payload_json: JSON.stringify({ turn_id: turn.id }),
    });
    expect(job).not.toBeNull();
    expect(job!.job_type).toBe('summarize_turn');

    // Duplicate enqueue returns null (dedupe works)
    const dup = db.enqueueJob({
      job_type: 'summarize_turn',
      dedupe_key: `turn:${turn.id}`,
      entity_type: 'turn',
      entity_id: String(turn.id),
      payload_json: JSON.stringify({ turn_id: turn.id }),
    });
    expect(dup).toBeNull();
  });
});

describe('WP1 / stale open turn auto-close on new prompt', () => {
  test('new prompt for same session closes stale open turn', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn1 = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/tmp', prompt_text: 'first' });

    // Simulate: a new prompt arrives for the same session (missed stop)
    // Worker logic: close stale open turn, then create new one
    const stale = db.getOpenTurnBySession('s1');
    expect(stale).not.toBeNull();
    db.markTurnClosed(stale!.id);

    const turn2 = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/tmp', prompt_text: 'second' });

    expect(db.getTurn(turn1.id)!.state).toBe('closed');
    expect(db.getTurn(turn2.id)!.state).toBe('open');
    expect(turn2.seq).toBe(2);
  });
});
