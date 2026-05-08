import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

describe('WP0 / V2 CRUD — session_refs', () => {
  test('upsert creates and returns session_ref', () => {
    const ref = db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    expect(ref.session_id).toBe('s1');
    expect(ref.cwd).toBe('/tmp');
    expect(ref.last_turn_seq).toBe(0);
    expect(ref.state).toBe('active');
  });

  test('upsert is idempotent and updates last_seen_at', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/a' });
    const ref2 = db.upsertSessionRef({ session_id: 's1', cwd: '/b' });
    expect(ref2.cwd).toBe('/b');
    expect(ref2.last_turn_seq).toBe(0);
  });

  test('allocateNextTurnSeq increments atomically', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    expect(db.allocateNextTurnSeq('s1')).toBe(1);
    expect(db.allocateNextTurnSeq('s1')).toBe(2);
    expect(db.allocateNextTurnSeq('s1')).toBe(3);
  });
});

describe('WP0 / V2 CRUD — turns', () => {
  test('createTurn + getOpenTurnBySession', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: 1, cwd: '/tmp', prompt_text: 'hello' });
    expect(turn.state).toBe('open');
    expect(turn.summarization_state).toBe('pending');
    const found = db.getOpenTurnBySession('s1');
    expect(found?.id).toBe(turn.id);
  });

  test('markTurnClosed sets state and stopped_at', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: 1, cwd: '/tmp' });
    db.markTurnClosed(turn.id);
    const closed = db.getTurn(turn.id)!;
    expect(closed.state).toBe('closed');
    expect(closed.stopped_at).not.toBeNull();
  });

  test('getOpenTurnBySession returns null after close', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: 1, cwd: '/tmp' });
    db.markTurnClosed(turn.id);
    expect(db.getOpenTurnBySession('s1')).toBeNull();
  });
});

describe('WP0 / V2 CRUD — turn_events', () => {
  test('appendTurnEvent auto-increments event_seq', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: 1, cwd: '/tmp' });
    const e1 = db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'userPromptSubmit', payload_json: '{}' });
    const e2 = db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'postToolUse', tool_name: 'read', payload_json: '{"x":1}' });
    expect(e1.event_seq).toBe(1);
    expect(e2.event_seq).toBe(2);
    expect(db.countTurnEvents(turn.id)).toBe(2);
  });
});

describe('WP0 / V2 CRUD — memories + FTS', () => {
  test('insertMemory + getMemory', () => {
    const id = db.insertMemory({
      memory_kind: 'turn',
      title: 'Fix auth bug',
      summary: 'Fixed token refresh',
      memory_type: 'bugfix',
      first_turn_at: new Date().toISOString(),
      last_turn_at: new Date().toISOString(),
    });
    const m = db.getMemory(id)!;
    expect(m.title).toBe('Fix auth bug');
    expect(m.memory_kind).toBe('turn');
    expect(m.state).toBe('active');
  });

  test('memories_fts trigger populates on insert', () => {
    const id = db.insertMemory({
      memory_kind: 'turn',
      title: 'Unique search term xyz123',
      summary: 'Some summary',
      memory_type: 'feature',
      first_turn_at: new Date().toISOString(),
      last_turn_at: new Date().toISOString(),
    });
    const rows = db.raw.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'xyz123'").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).rowid).toBe(id);
  });

  test('pinMemory toggles is_pinned', () => {
    const id = db.insertMemory({
      memory_kind: 'turn', title: 'T', summary: 'S', memory_type: 'change',
      first_turn_at: new Date().toISOString(), last_turn_at: new Date().toISOString(),
    });
    db.pinMemory(id, true);
    expect(db.getMemory(id)!.is_pinned).toBe(1);
    db.pinMemory(id, false);
    expect(db.getMemory(id)!.is_pinned).toBe(0);
  });
});

describe('WP0 / V2 CRUD — jobs', () => {
  test('enqueueJob creates pending job', () => {
    const job = db.enqueueJob({ job_type: 'summarize_turn', payload_json: '{"turn_id":1}' });
    expect(job).not.toBeNull();
    expect(job!.state).toBe('pending');
    expect(job!.attempts).toBe(0);
  });

  test('dedupe_key prevents duplicate jobs', () => {
    db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'turn:1', payload_json: '{}' });
    const dup = db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: 'turn:1', payload_json: '{}' });
    expect(dup).toBeNull();
  });
});

describe('WP0 / V2 CRUD — topics', () => {
  test('createTopic + findTopic', () => {
    const t = db.createTopic({ repo: '/repo', canonical_label: 'auth' });
    expect(t.canonical_label).toBe('auth');
    const found = db.findTopic('/repo', 'auth');
    expect(found?.id).toBe(t.id);
  });
});
