import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { Compressor } from '../../src/compressor';
import { createApp } from '../../src/server/worker';
import { FakeCompressorProvider } from '../support/fake-compressor';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';

let db: MemoryDB;
let fakeProvider: FakeCompressorProvider;

beforeEach(() => {
  db = openInMemoryDB();
  fakeProvider = new FakeCompressorProvider();
});

afterEach(() => {
  db.close();
});

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('Integration / synthesis pipeline', () => {
  test('summarize -> normalize topic -> merge -> summarize topic, with source turns ordered by time', async () => {
    fakeProvider
      .script({
        match: '用户 Prompt: auth step 1',
        respondWith: JSON.stringify({
          title: 'Auth step 1',
          summary: 'Implemented login controller.',
          request: 'Build auth',
          investigated: 'Login path',
          learned: 'Controller owns session creation',
          completed: 'Login controller',
          next_steps: 'Add token refresh',
          memory_type: 'feature',
          files_touched: ['src/auth/login.ts'],
          concepts: ['auth'],
          topic_candidate: 'auth flow',
          importance_score: 0.7,
          confidence_score: 0.9,
          unresolved_score: 0.3,
        }),
      })
      .script({
        match: '用户 Prompt: auth step 2',
        respondWith: JSON.stringify({
          title: 'Auth step 2',
          summary: 'Added refresh token handling.',
          request: 'Build auth',
          investigated: 'Refresh path',
          learned: 'Refresh tokens need rotation',
          completed: 'Refresh handler',
          next_steps: 'Add logout',
          memory_type: 'feature',
          files_touched: ['src/auth/refresh.ts'],
          concepts: ['auth'],
          topic_candidate: 'auth flow',
          importance_score: 0.8,
          confidence_score: 0.9,
          unresolved_score: 0.2,
        }),
      })
      .script({
        match: '用户 Prompt: auth step 3',
        respondWith: JSON.stringify({
          title: 'Auth step 3',
          summary: 'Added logout endpoint.',
          request: 'Build auth',
          investigated: 'Logout path',
          learned: 'Logout clears server-side refresh state',
          completed: 'Logout endpoint',
          next_steps: '',
          memory_type: 'feature',
          files_touched: ['src/auth/logout.ts'],
          concepts: ['auth'],
          topic_candidate: 'auth flow',
          importance_score: 0.8,
          confidence_score: 0.9,
          unresolved_score: 0,
        }),
      })
      .script({
        match: '候选主题: "auth flow"',
        respondWith: JSON.stringify({
          action: 'new',
          canonical_label: 'auth flow',
          aliases: [],
        }),
      })
      .script({
        match: '待合并的 turn 记忆',
        respondWith: JSON.stringify({
          title: 'Auth flow complete',
          summary: 'Consolidated login, refresh, and logout into an auth flow.',
          request: 'Build auth',
          investigated: 'Login, refresh, and logout paths',
          learned: 'Refresh rotation is the main security detail',
          completed: 'Core auth flow',
          next_steps: 'Add integration tests',
          memory_type: 'feature',
          files_touched: ['src/auth/login.ts', 'src/auth/refresh.ts', 'src/auth/logout.ts'],
          concepts: ['auth'],
          topic_candidate: 'auth flow',
          importance_score: 0.9,
          confidence_score: 0.95,
          unresolved_score: 0.1,
        }),
      })
      .script({
        match: '紧凑的主题进展对象',
        respondWith: JSON.stringify({
          summary: 'Auth flow now covers login, refresh, and logout.',
          unresolved_summary: '还差集成测试',
        }),
      });

    const config = loadConfig();
    const { jobRunner } = createApp({
      db,
      compressor: new Compressor(fakeProvider),
      config: {
        ...config,
        compression: { ...config.compression, concurrency: 6 },
      },
      enableEmbeddings: false,
      enableAuth: false,
    });

    db.upsertSessionRef({ session_id: 's1', cwd: '/proj', repo: '/proj' });
    const startedAts = [
      '2026-01-01T00:00:03.000Z',
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:02.000Z',
    ];
    const turnIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const turn = db.createTurn({
        session_id: 's1',
        seq: db.allocateNextTurnSeq('s1'),
        cwd: '/proj',
        repo: '/proj',
        prompt_text: `auth step ${i + 1}`,
        started_at: startedAts[i],
      });
      db.markTurnClosed(turn.id);
      turnIds.push(turn.id);
      db.enqueueJob({
        job_type: 'summarize_turn',
        dedupe_key: `turn:${turn.id}`,
        entity_type: 'turn',
        entity_id: String(turn.id),
        payload_json: JSON.stringify({ turn_id: turn.id }),
      });
    }

    jobRunner.start();
    try {
      await waitFor(() => {
        const mergedCount = (db.raw.query(
          `SELECT COUNT(*) AS count FROM memories WHERE memory_kind = 'merged' AND state = 'active'`,
        ).get() as { count: number }).count;
        const topic = db.getActiveTopics({ repo: '/proj', limit: 1 })[0];
        return mergedCount === 1 && !!topic?.summary;
      }, 8000);
    } finally {
      jobRunner.stop();
    }

    const turnMemories = db.raw.query(
      `SELECT * FROM memories WHERE memory_kind = 'turn' ORDER BY id`,
    ).all() as Array<{ id: number; state: string; topic_id: number | null }>;
    expect(turnMemories.length).toBe(3);
    expect(turnMemories.every((m) => m.state === 'superseded')).toBe(true);
    expect(turnMemories.every((m) => m.topic_id != null)).toBe(true);

    const merged = db.raw.query(
      `SELECT * FROM memories WHERE memory_kind = 'merged' AND state = 'active' LIMIT 1`,
    ).get() as { id: number; title: string; source_turn_count: number; topic_id: number };
    expect(merged.title).toBe('Auth flow complete');
    expect(merged.source_turn_count).toBe(3);

    const links = db.listMemoryTurnLinks(merged.id);
    expect(links.map((l) => l.turn_id)).toEqual([turnIds[1], turnIds[2], turnIds[0]]);
    expect(links.map((l) => l.ordinal)).toEqual([1, 2, 3]);

    const topic = db.getTopic(merged.topic_id)!;
    expect(topic.canonical_label).toBe('auth flow');
    expect(topic.summary).toBe('Auth flow now covers login, refresh, and logout.');
    expect(topic.unresolved_summary).toBe('还差集成测试');

    const failedJobs = db.listJobsByState('dead');
    expect(failedJobs.length).toBe(0);
  }, 10000);
});
