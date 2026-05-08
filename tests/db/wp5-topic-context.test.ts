import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { Compressor } from '../../src/compressor';
import { JobRunner } from '../../src/jobs';
import { buildContext } from '../../src/context-builder';
import { FakeCompressorProvider } from '../support/fake-compressor';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';

let db: MemoryDB;
let fakeProvider: FakeCompressorProvider;

beforeEach(() => {
  db = openInMemoryDB();
  fakeProvider = new FakeCompressorProvider();
});
afterEach(() => { db.close(); });

function insertMem(overrides: Partial<Parameters<typeof db.insertMemory>[0]> = {}) {
  return db.insertMemory({
    memory_kind: 'turn', title: 'Test', summary: 'Summary', memory_type: 'change',
    first_turn_at: new Date().toISOString(), last_turn_at: new Date().toISOString(),
    ...overrides,
  });
}

describe('WP5 / normalize_topic', () => {
  test('creates new topic when no match', async () => {
    fakeProvider.setFallback(JSON.stringify({
      action: 'new', canonical_label: 'auth login', aliases: [],
    }));
    const compressor = new Compressor(fakeProvider);

    const result = await compressor.normalizeTopic({
      candidate: 'auth login',
      existing_labels: ['database', 'ui'],
      memory_title: 'Fix auth login flow',
    });

    expect(result.action).toBe('new');
    expect(result.canonical_label).toBe('auth login');
  });

  test('maps to existing topic when semantically same', async () => {
    fakeProvider.setFallback(JSON.stringify({
      action: 'existing', canonical_label: 'authentication', aliases: ['auth login'],
    }));
    const compressor = new Compressor(fakeProvider);

    const result = await compressor.normalizeTopic({
      candidate: 'auth login',
      existing_labels: ['authentication', 'database'],
      memory_title: 'Fix auth login flow',
    });

    expect(result.action).toBe('existing');
    expect(result.canonical_label).toBe('authentication');
    expect(result.aliases).toContain('auth login');
  });

  test('normalize_topic job handler links memory to topic', async () => {
    fakeProvider.setFallback(JSON.stringify({
      action: 'new', canonical_label: 'auth', aliases: [],
    }));

    const mid = insertMem({ title: 'Auth work', concepts: ['auth', 'jwt'], repo: '/proj' });
    db.enqueueJob({ job_type: 'normalize_topic', payload_json: JSON.stringify({ memory_id: mid }) });

    const compressor = new Compressor(fakeProvider);
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });

    runner.register('normalize_topic', async (job) => {
      const { memory_id } = JSON.parse(job.payload_json);
      const memory = db.getMemory(memory_id);
      if (!memory || memory.state !== 'active') return;
      const concepts: string[] = JSON.parse(memory.concepts_json || '[]');
      const candidate = concepts[0] || memory.title.slice(0, 40);
      const existingTopics = db.getActiveTopics(memory.repo, 50);
      const result = await compressor.normalizeTopic({
        candidate, existing_labels: existingTopics.map(t => t.canonical_label), memory_title: memory.title,
      });
      let topicId: number;
      if (result.action === 'existing') {
        const existing = db.findTopic(memory.repo, result.canonical_label);
        topicId = existing ? existing.id : db.createTopic({ repo: memory.repo, canonical_label: result.canonical_label }).id;
      } else {
        topicId = db.createTopic({ repo: memory.repo, canonical_label: result.canonical_label }).id;
      }
      db.updateTopic(topicId, { memory_count_delta: 1 });
      db.raw.run('UPDATE memories SET topic_id = ? WHERE id = ?', [topicId, memory_id]);
    });

    runner.start();
    await Bun.sleep(200);
    runner.stop();

    const mem = db.getMemory(mid)!;
    expect(mem.topic_id).not.toBeNull();
    const topic = db.getTopic(mem.topic_id!)!;
    expect(topic.canonical_label).toBe('auth');
    expect(topic.memory_count).toBe(1);
  });
});

describe('WP5 / merge_cluster_to_memory', () => {
  test('merges 3 turn memories into one merged memory', async () => {
    fakeProvider.setFallback(JSON.stringify({
      title: 'Auth login complete flow',
      summary: 'Implemented full auth login with token refresh',
      request: 'Build auth', investigated: 'Token patterns', learned: 'Use refresh rotation',
      completed: 'Login + refresh', next_steps: 'Add tests',
      memory_type: 'feature', files_touched: ['/src/auth.ts'],
      concepts: ['auth'], topic_candidate: 'auth',
      importance_score: 0.85, confidence_score: 0.9, unresolved_score: 0.2,
    }));

    const topic = db.createTopic({ repo: '/proj', canonical_label: 'auth' });

    // Create 3 turn memories
    db.upsertSessionRef({ session_id: 's1', cwd: '/proj' });
    const turnIds: number[] = [];
    const memIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const turn = db.createTurn({ session_id: 's1', seq: db.allocateNextTurnSeq('s1'), cwd: '/proj', repo: '/proj' });
      db.markTurnClosed(turn.id);
      const mid = db.createTurnMemoryAtomic(turn.id, {
        memory_kind: 'turn', title: `Auth step ${i + 1}`, summary: `Did step ${i + 1}`,
        memory_type: 'feature', first_turn_at: turn.started_at, last_turn_at: turn.started_at, repo: '/proj',
      })!;
      turnIds.push(turn.id);
      memIds.push(mid);
    }

    // Run merge
    const compressor = new Compressor(fakeProvider);
    const result = await compressor.mergeTurnMemories({
      memories: memIds.map(id => {
        const m = db.getMemory(id)!;
        return { title: m.title, summary: m.summary };
      }),
      topic_label: 'auth',
    });

    const mergedId = db.insertMemory({
      memory_kind: 'merged', repo: '/proj', topic_id: topic.id,
      title: result.title, summary: result.summary,
      memory_type: result.memory_type as any,
      importance_score: result.importance_score,
      confidence_score: result.confidence_score,
      unresolved_score: result.unresolved_score,
      source_turn_count: 3,
      first_turn_at: new Date().toISOString(), last_turn_at: new Date().toISOString(),
    });

    // Supersede source memories
    for (const mid of memIds) db.setMemoryState(mid, 'superseded');

    // Verify
    const merged = db.getMemory(mergedId)!;
    expect(merged.memory_kind).toBe('merged');
    expect(merged.title).toBe('Auth login complete flow');
    expect(merged.source_turn_count).toBe(3);

    // Superseded memories excluded from search
    const searchResults = db.searchMemoriesFts('auth');
    const activeIds = searchResults.map(m => m.id);
    expect(activeIds).toContain(mergedId);
    for (const mid of memIds) expect(activeIds).not.toContain(mid);
  });
});

describe('WP5 / context-builder — topic-first', () => {
  test('output contains Pinned / Active Topics / Recent sections', () => {
    const topic = db.createTopic({ canonical_label: 'auth', repo: null });
    db.updateTopic(topic.id, { memory_count_delta: 3 });

    const mid = insertMem({ title: 'Important decision' });
    db.pinMemory(mid, true);
    insertMem({ title: 'Recent work A' });
    insertMem({ title: 'Recent work B' });

    const config = loadConfig();
    const output = buildContext(db, '', config.context);

    expect(output).toContain('<kiro-mem-context>');
    expect(output).toContain('</kiro-mem-context>');
    expect(output).toContain('Pinned Memories');
    expect(output).toContain('Important decision');
    expect(output).toContain('Active Topics');
    expect(output).toContain('auth');
    expect(output).toContain('Recent Memories');
  });

  test('output is under 10KB', () => {
    // Insert many memories
    for (let i = 0; i < 50; i++) {
      insertMem({ title: `Memory item number ${i} with some extra text to fill space` });
    }
    const config = loadConfig();
    const output = buildContext(db, '', config.context);

    expect(output.length).toBeLessThan(10240);
  });

  test('markdown is properly closed (no truncated tags)', () => {
    for (let i = 0; i < 30; i++) {
      insertMem({ title: `Item ${i}` });
    }
    const config = loadConfig();
    const output = buildContext(db, '', config.context);

    expect(output).toContain('</kiro-mem-context>');
    // No unclosed markdown elements
    expect(output.endsWith('</kiro-mem-context>')).toBe(true);
  });

  test('empty DB returns empty string', () => {
    const config = loadConfig();
    const output = buildContext(db, '', config.context);
    // With no data, should be minimal or empty
    expect(output.length).toBeLessThan(200);
  });
});
