import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

function insertTestMemory(overrides: Partial<Parameters<typeof db.insertMemory>[0]> = {}) {
  return db.insertMemory({
    memory_kind: 'turn',
    title: 'Default title',
    summary: 'Default summary',
    memory_type: 'change',
    first_turn_at: new Date().toISOString(),
    last_turn_at: new Date().toISOString(),
    ...overrides,
  });
}

describe('WP4 / memory search — FTS', () => {
  test('searchMemoriesFts finds by title keyword', () => {
    insertTestMemory({ title: 'Fix authentication token refresh' });
    insertTestMemory({ title: 'Add pagination to users API' });

    const results = db.searchMemoriesFts('authentication');
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain('authentication');
  });

  test('searchMemoriesFts finds by concepts_json', () => {
    insertTestMemory({ title: 'Some work', concepts: ['jwt', 'auth', '认证'] });
    insertTestMemory({ title: 'Other work', concepts: ['database'] });

    const results = db.searchMemoriesFts('jwt');
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe('Some work');
  });

  test('searchMemoriesFts filters by memory_type', () => {
    insertTestMemory({ title: 'Bug fix for auth', memory_type: 'bugfix' });
    insertTestMemory({ title: 'Auth refactor', memory_type: 'refactor' });

    const results = db.searchMemoriesFts('auth', { type: 'bugfix' });
    expect(results.length).toBe(1);
    expect(results[0]!.memory_type).toBe('bugfix');
  });

  test('searchMemoriesFts filters by repo', () => {
    insertTestMemory({ title: 'Work in repo A', repo: '/repo-a' });
    insertTestMemory({ title: 'Work in repo B', repo: '/repo-b' });

    const results = db.searchMemoriesFts('Work', { repo: '/repo-a' });
    expect(results.length).toBe(1);
    expect(results[0]!.repo).toBe('/repo-a');
  });

  test('searchMemoriesFts excludes superseded/archived memories', () => {
    const id = insertTestMemory({ title: 'Archived memory xyz' });
    db.setMemoryState(id, 'archived');

    const results = db.searchMemoriesFts('xyz');
    expect(results.length).toBe(0);
  });

  test('pinned memories sort first', () => {
    const id1 = insertTestMemory({ title: 'Unpinned auth work' });
    const id2 = insertTestMemory({ title: 'Pinned auth decision' });
    db.pinMemory(id2, true);

    const results = db.searchMemoriesFts('auth');
    expect(results[0]!.id).toBe(id2);
  });

  test('short query (<3 chars) uses LIKE fallback', () => {
    insertTestMemory({ title: 'JWT token handling' });
    const results = db.searchMemoriesFts('JW');
    expect(results.length).toBe(1);
  });
});

describe('WP4 / traceMemory', () => {
  test('returns source turns and neighbors', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/tmp' });
    const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/tmp' });
    db.markTurnClosed(turn.id);

    const mid = db.createTurnMemoryAtomic(turn.id, {
      memory_kind: 'turn', title: 'Target', summary: 'S', memory_type: 'change',
      first_turn_at: turn.started_at, last_turn_at: turn.started_at, repo: null,
    })!;

    // Add neighbors
    insertTestMemory({ title: 'Before' });
    insertTestMemory({ title: 'After' });

    const trace = db.traceMemory(mid);
    expect(trace.memory).not.toBeNull();
    expect(trace.memory!.title).toBe('Target');
    expect(trace.source_turns.length).toBe(1);
    expect(trace.source_turns[0]!.id).toBe(turn.id);
  });

  test('returns null for non-existent memory', () => {
    const trace = db.traceMemory(9999);
    expect(trace.memory).toBeNull();
  });
});

describe('WP4 / topics', () => {
  test('getActiveTopics returns active topics', () => {
    db.createTopic({ repo: '/proj', canonical_label: 'auth' });
    db.createTopic({ repo: '/proj', canonical_label: 'db migration', status: 'archived' });

    const topics = db.getActiveTopics({ repo: '/proj' });
    expect(topics.length).toBe(1);
    expect(topics[0]!.canonical_label).toBe('auth');
  });
});

describe('WP4 / pin', () => {
  test('pin targets memory, not observation', () => {
    const id = insertTestMemory({ title: 'Important decision' });
    db.pinMemory(id, true);
    expect(db.getMemory(id)!.is_pinned).toBe(1);

    const pinned = db.getPinnedMemories();
    expect(pinned.length).toBe(1);
    expect(pinned[0]!.id).toBe(id);
  });
});

describe('WP4 / get_memories', () => {
  test('getMemoriesByIds returns full details', () => {
    const id = insertTestMemory({
      title: 'Full detail test',
      summary: 'Detailed summary',
      request: 'User asked X',
      learned: 'Key finding',
      next_steps: 'Do Y next',
      concepts: ['concept1', 'concept2'],
      files_touched: ['/src/a.ts'],
    });

    const mems = db.getMemoriesByIds([id]);
    expect(mems.length).toBe(1);
    const m = mems[0]!;
    expect(m.title).toBe('Full detail test');
    expect(m.request).toBe('User asked X');
    expect(m.learned).toBe('Key finding');
    expect(m.next_steps).toBe('Do Y next');
    expect(JSON.parse(m.concepts_json)).toContain('concept1');
    expect(JSON.parse(m.files_touched_json)).toContain('/src/a.ts');
  });
});
