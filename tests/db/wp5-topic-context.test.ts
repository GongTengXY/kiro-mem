import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { Compressor } from '../../src/compressor';
import { JobRunner } from '../../src/jobs';
import { buildContext } from '../../src/context-builder';
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
      existing_topics: [
        { canonical_label: 'database', aliases: [] },
        { canonical_label: 'ui', aliases: [] },
      ],
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
      existing_topics: [
        { canonical_label: 'authentication', aliases: [] },
        { canonical_label: 'database', aliases: [] },
      ],
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

    // Mirror the production handler from src/server/worker.ts so this test
    // actually exercises the post-refactor path: scope-aware candidate lookup
    // + deterministic pre-dedup + atomic upsertTopicAndLinkMemory. Kept
    // narrow: we only mirror the pieces the assertions below depend on. If
    // production adds more branches (summary enqueue, merge trigger), this
    // mirror should follow them — not diverge again.
    runner.register('normalize_topic', async (job) => {
      const { memory_id } = JSON.parse(job.payload_json);
      const memory = db.getMemory(memory_id);
      if (!memory || memory.state !== 'active' || memory.topic_id != null) return;

      const concepts: string[] = JSON.parse(memory.concepts_json || '[]');
      const candidate =
        (memory.topic_candidate || '').trim() ||
        concepts[0] ||
        memory.title.slice(0, 40);
      if (!candidate) return;

      const scopeKey = computeScopeKey(memory.repo, memory.cwd_scope);
      const existingTopics = db.getActiveTopics({
        repo: memory.repo, cwd: memory.cwd_scope, limit: 50,
      });
      const existingParsed = existingTopics.map((t) => {
        let aliases: string[] = [];
        try {
          const p = JSON.parse(t.aliases_json || '[]');
          if (Array.isArray(p)) aliases = p.filter((x: unknown): x is string => typeof x === 'string');
        } catch { /* ignore */ }
        return { canonical_label: t.canonical_label, aliases };
      });

      const normalizeForMatch = (s: string): string =>
        s.trim().replace(/\s+/g, ' ').replace(/[\s。.!?！？,，、;；:：]+$/u, '').toLowerCase();
      const candNorm = normalizeForMatch(candidate);
      let result: { canonical_label: string; aliases: string[] } | null = null;
      if (candNorm) {
        for (const t of existingParsed) {
          if (normalizeForMatch(t.canonical_label) === candNorm) {
            result = { canonical_label: t.canonical_label, aliases: [] };
            break;
          }
          if (t.aliases.some((a) => normalizeForMatch(a) === candNorm)) {
            result = { canonical_label: t.canonical_label, aliases: [candidate] };
            break;
          }
        }
      }
      if (!result) {
        const llmResult = await compressor.normalizeTopic({
          candidate,
          existing_topics: existingParsed,
          memory_title: memory.title,
        });
        result = { canonical_label: llmResult.canonical_label, aliases: llmResult.aliases };
      }

      const { topic_id } = db.upsertTopicAndLinkMemory({
        memory_id,
        scope_key: scopeKey,
        repo: memory.repo,
        canonical_label: result.canonical_label,
        aliases: result.aliases,
      });
      void topic_id;
    });

    runner.start();
    await Bun.sleep(200);
    runner.stop();

    const mem = db.getMemory(mid)!;
    expect(mem.topic_id).not.toBeNull();
    const topic = db.getTopic(mem.topic_id!)!;
    expect(topic.canonical_label).toBe('auth');
    expect(topic.memory_count).toBe(1);
    expect(topic.scope_key).toBe('/proj');
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

  test('production merge handler enqueues topic summary refresh after merge', async () => {
    fakeProvider.setFallback(JSON.stringify({
      title: 'Merged auth rollout',
      summary: 'Merged auth work across multiple turns.',
      request: 'Build auth',
      investigated: 'Login and refresh paths',
      learned: 'Refresh rotation remains important',
      completed: 'Merged active auth turns',
      next_steps: 'Refresh topic summary',
      memory_type: 'feature',
      files_touched: [],
      concepts: ['auth'],
      topic_candidate: 'auth',
      importance_score: 0.8,
      confidence_score: 0.9,
      unresolved_score: 0.1,
    }));

    const topic = db.createTopic({ repo: '/proj', canonical_label: 'auth' });
    db.upsertSessionRef({ session_id: 's1', cwd: '/proj', repo: '/proj' });

    const memIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const turn = db.createTurn({
        session_id: 's1',
        seq: db.allocateNextTurnSeq('s1'),
        cwd: '/proj',
        repo: '/proj',
      });
      db.markTurnClosed(turn.id);
      const mid = db.createTurnMemoryAtomic(turn.id, {
        memory_kind: 'turn',
        repo: '/proj',
        cwd_scope: '/proj',
        title: `Auth step ${i + 1}`,
        summary: `Did auth step ${i + 1}`,
        memory_type: 'feature',
        first_turn_at: turn.started_at,
        last_turn_at: turn.started_at,
      })!;
      memIds.push(mid);
    }

    const config = loadConfig();
    const app = createApp({
      db,
      compressor: new Compressor(fakeProvider),
      config: {
        ...config,
        compression: { ...config.compression, concurrency: 1 },
      },
      enableEmbeddings: false,
      enableAuth: false,
    });

    db.enqueueJob({
      job_type: 'merge_cluster_to_memory',
      dedupe_key: `merge:test:${topic.id}`,
      entity_type: 'topic',
      entity_id: String(topic.id),
      payload_json: JSON.stringify({ memory_ids: memIds, topic_id: topic.id }),
    });

    app.jobRunner.start();
    await Bun.sleep(350);
    app.jobRunner.stop();

    const summaryJobs = db.raw.query(
      `SELECT * FROM jobs
        WHERE job_type = 'summarize_topic'
          AND dedupe_key LIKE ?
        ORDER BY id`,
    ).all(`summary:topic:${topic.id}:merge:%`) as Array<{ state: string; dedupe_key: string }>;

    expect(summaryJobs.length).toBe(1);
    expect(summaryJobs[0]!.dedupe_key).toStartWith(`summary:topic:${topic.id}:merge:`);

    const activeMerged = db.raw.query(
      `SELECT COUNT(*) AS count FROM memories WHERE topic_id = ? AND memory_kind = 'merged' AND state = 'active'`,
    ).get(topic.id) as { count: number };
    expect(activeMerged.count).toBe(1);
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

  test('how-to hint switches with language', () => {
    insertMem({ title: 'Recent work A' });
    const config = loadConfig();

    const zhOutput = buildContext(db, '', config.context, 'zh');
    const enOutput = buildContext(db, '', config.context, 'en');

    expect(zhOutput).toContain('使用 @kiro-mem/search 搜索记忆');
    expect(enOutput).toContain('Use @kiro-mem/search to search memories');
  });
});

describe('WP5 / context-builder — includeSummary', () => {
  test('includeSummary=true renders summary lines under recent memories', () => {
    insertMem({ title: 'Auth refactor', summary: '重构了登录模块的 token 刷新逻辑' });
    insertMem({ title: 'DB migration', summary: 'Added new columns for topic tracking' });

    const config = loadConfig();
    const ctx = { ...config.context, includeSummary: true };
    const output = buildContext(db, '', ctx);

    expect(output).toContain('Auth refactor');
    expect(output).toContain('重构了登录模块的 token 刷新逻辑');
    expect(output).toContain('DB migration');
    expect(output).toContain('Added new columns for topic tracking');
  });

  test('includeSummary=false does NOT render summary lines', () => {
    insertMem({ title: 'Auth refactor', summary: '重构了登录模块的 token 刷新逻辑' });

    const config = loadConfig();
    const ctx = { ...config.context, includeSummary: false };
    const output = buildContext(db, '', ctx);

    expect(output).toContain('Auth refactor');
    expect(output).not.toContain('重构了登录模块的 token 刷新逻辑');
  });

  test('final output respects UTF-8 byte budget and keeps closing tag', () => {
    const longText = '超长中文主题'.repeat(120);
    const pinned = insertMem({
      title: longText,
      summary: longText,
    });
    db.pinMemory(pinned, true);
    for (let i = 0; i < 20; i++) {
      insertMem({
        title: `${longText}-${i}`,
        summary: longText,
      });
    }

    const config = loadConfig();
    const ctx = {
      ...config.context,
      includeSummary: true,
      maxOutputBytes: 300,
    };
    const output = buildContext(db, '', ctx);

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(300);
    expect(output.endsWith('</kiro-mem-context>')).toBe(true);
  });
});

describe('WP5 / summarize_topic job', () => {
  test('writes summary and unresolved_summary to topic', async () => {
    fakeProvider.setFallback(JSON.stringify({
      summary: 'Auth module is 80% done with login and token refresh.',
      unresolved_summary: '还差 refresh token rotation',
    }));

    const topic = db.createTopic({ repo: '/proj', canonical_label: 'auth' });
    // Need at least one active memory under the topic for the handler to proceed
    const mid = insertMem({ title: 'Auth step 1', summary: 'Did login', repo: '/proj' });
    db.raw.run('UPDATE memories SET topic_id = ? WHERE id = ?', [topic.id, mid]);
    db.updateTopic(topic.id, { memory_count_delta: 1 });

    const compressor = new Compressor(fakeProvider);
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });

    runner.register('summarize_topic', async (job) => {
      const { topic_id } = JSON.parse(job.payload_json) as { topic_id: number };
      const t = db.getTopic(topic_id);
      if (!t || t.status === 'archived') return;

      const rows = db.raw.query(
        `SELECT title, summary, learned, next_steps FROM memories WHERE topic_id = ? AND state = 'active' ORDER BY last_turn_at DESC LIMIT 20`,
      ).all(topic_id) as Array<{ title: string; summary: string; learned: string | null; next_steps: string | null }>;
      if (!rows.length) return;

      const result = await compressor.summarizeTopic({
        topic_label: t.canonical_label,
        memories: rows.map((r) => ({ title: r.title, summary: r.summary, learned: r.learned || undefined, next_steps: r.next_steps || undefined })),
      });

      const summaryVal = (result.summary || '').trim();
      const unresolvedVal = (result.unresolved_summary || '').trim();
      if (!summaryVal && !unresolvedVal) return;
      db.updateTopic(topic_id, { summary: summaryVal || undefined, unresolved_summary: unresolvedVal });
    });

    db.enqueueJob({ job_type: 'summarize_topic', payload_json: JSON.stringify({ topic_id: topic.id }) });
    runner.start();
    await Bun.sleep(200);
    runner.stop();

    const updated = db.getTopic(topic.id)!;
    expect(updated.summary).toBe('Auth module is 80% done with login and token refresh.');
    expect(updated.unresolved_summary).toBe('还差 refresh token rotation');
  });

  test('does NOT overwrite existing unresolved_summary on parse fallback', async () => {
    // Simulate LLM returning garbage → parseJSON fallback → both fields empty
    fakeProvider.setFallback('not valid json at all');

    const topic = db.createTopic({ repo: '/proj', canonical_label: 'auth' });
    // Pre-populate with a valid summary
    db.updateTopic(topic.id, { summary: 'Previous good summary', unresolved_summary: '还差登出接口' });
    db.updateTopic(topic.id, { memory_count_delta: 1 });
    const mid = insertMem({ title: 'Auth step', summary: 'Did something', repo: '/proj' });
    db.raw.run('UPDATE memories SET topic_id = ? WHERE id = ?', [topic.id, mid]);

    const compressor = new Compressor(fakeProvider);
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });

    runner.register('summarize_topic', async (job) => {
      const { topic_id } = JSON.parse(job.payload_json) as { topic_id: number };
      const t = db.getTopic(topic_id);
      if (!t || t.status === 'archived') return;

      const rows = db.raw.query(
        `SELECT title, summary, learned, next_steps FROM memories WHERE topic_id = ? AND state = 'active' ORDER BY last_turn_at DESC LIMIT 20`,
      ).all(topic_id) as Array<{ title: string; summary: string; learned: string | null; next_steps: string | null }>;
      if (!rows.length) return;

      const result = await compressor.summarizeTopic({
        topic_label: t.canonical_label,
        memories: rows.map((r) => ({ title: r.title, summary: r.summary, learned: r.learned || undefined, next_steps: r.next_steps || undefined })),
      });

      const summaryVal = (result.summary || '').trim();
      const unresolvedVal = (result.unresolved_summary || '').trim();
      if (!summaryVal && !unresolvedVal) return;
      db.updateTopic(topic_id, { summary: summaryVal || undefined, unresolved_summary: unresolvedVal });
    });

    db.enqueueJob({ job_type: 'summarize_topic', payload_json: JSON.stringify({ topic_id: topic.id }) });
    runner.start();
    await Bun.sleep(200);
    runner.stop();

    const updated = db.getTopic(topic.id)!;
    // Should NOT have been overwritten
    expect(updated.summary).toBe('Previous good summary');
    expect(updated.unresolved_summary).toBe('还差登出接口');
  });
});
