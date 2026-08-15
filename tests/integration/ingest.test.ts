/**
 * Integration test using the REAL production createApp() from worker.ts.
 * Tests exercise actual Hono routes with all production logic (shouldSkip,
 * stripPrivateTags, detectRepo, onError) — only the DB and compressor are
 * injected for isolation.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Hono } from 'hono';

let db: MemoryDB;
let app: Hono;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = openInMemoryDB();
  const fakePool = new FakeACPPool();
  const compressor = new ACPCompressor({}, fakePool);
  // `loadConfig()` reads the developer's own ~/.kiro-mem/config.json, so the
  // gray-release switch is pinned here: otherwise this test would assert /health
  // against whatever profile the machine running it happens to be rolled back to.
  const config = { ...loadConfig(), retrieval: { semanticDiscovery: true } };
  const result = createApp({ db, compressor, config, enableEmbeddings: false, enableAuth: false });
  app = result.app;
});
afterEach(() => { db.close(); });

describe('Integration / real createApp — full ingest cycle', () => {
  test('prompt → observation → stop → turn closed + job enqueued', async () => {
    const r1 = await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'fix bug' });
    expect(r1.status).toBe(200);
    const j1 = await r1.json() as any;
    expect(j1.ok).toBe(true);
    const turnId = j1.turn_id;

    const r2 = await post('/events/observation', { session_id: 'S1', tool_name: 'read', tool_input: { path: '/a.ts' }, tool_response: 'code' });
    expect(r2.status).toBe(202);

    const r3 = await post('/events/stop', { session_id: 'S1' });
    expect(r3.status).toBe(200);
    expect((await r3.json() as any).turn_id).toBe(turnId);

    const turn = db.getTurn(turnId)!;
    expect(turn.state).toBe('closed');
    expect(turn.tool_event_count).toBe(1);
    expect(db.listTurnEvents(turnId).length).toBe(3);

    const jobs = db.listJobsByState('pending');
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.job_type).toBe('summarize_turn');
  });

  test('missing session_id → quarantined, no DB writes', async () => {
    const r = await post('/events/observation', { tool_name: 'write', tool_input: {}, tool_response: '' });
    expect(r.status).toBe(200);
    expect((await r.json() as any).quarantined).toBe(true);

    const cnt = (db.raw.query('SELECT COUNT(*) AS c FROM turns').get() as any).c;
    expect(cnt).toBe(0);
  });

  test('shouldSkip filters configured tools', async () => {
    // 'introspect' is in default skipTools
    await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'hi' });
    const r = await post('/events/observation', { session_id: 'S1', tool_name: 'introspect', tool_input: {}, tool_response: '' });
    expect(r.status).toBe(200);
    expect((await r.json() as any).skipped).toBe(true);

    // @kiro-mem/* pattern
    const r2 = await post('/events/observation', { session_id: 'S1', tool_name: '@kiro-mem/search', tool_input: {}, tool_response: '' });
    expect((await r2.json() as any).skipped).toBe(true);
  });

  test('stripPrivateTags redacts <private> content', async () => {
    await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: '<private>secret</private> visible' });
    const turn = db.getOpenTurnBySession('S1')!;
    expect(turn.prompt_text).toBe('[REDACTED] visible');
  });

  test('two sessions same cwd → fully isolated', async () => {
    await post('/events/prompt', { session_id: 'A', cwd: '/tmp', prompt: 'task A' });
    await post('/events/prompt', { session_id: 'B', cwd: '/tmp', prompt: 'task B' });
    await post('/events/observation', { session_id: 'A', tool_name: 'read', tool_input: {}, tool_response: '' });
    await post('/events/observation', { session_id: 'B', tool_name: 'write', tool_input: {}, tool_response: '' });
    await post('/events/stop', { session_id: 'A' });
    await post('/events/stop', { session_id: 'B' });

    const turns = db.raw.query('SELECT * FROM turns ORDER BY id').all() as any[];
    expect(turns.length).toBe(2);
    expect(turns[0].session_id).toBe('A');
    expect(turns[1].session_id).toBe('B');
  });

  test('stale open turn gets job when force-closed by new prompt', async () => {
    const r1 = await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'first' });
    const turn1Id = ((await r1.json()) as any).turn_id;

    const r2 = await post('/events/prompt', { session_id: 'S1', cwd: '/tmp', prompt: 'second' });
    const turn2Id = ((await r2.json()) as any).turn_id;

    expect(db.getTurn(turn1Id)!.state).toBe('closed');
    expect(db.getTurn(turn2Id)!.state).toBe('open');

    const jobs = db.listJobsByState('pending');
    expect(jobs.find(j => j.dedupe_key === `turn:${turn1Id}`)).not.toBeUndefined();
  });

  test('GET /health exposes V3 observability metrics (§12.4)', async () => {
    const r = await app.request('/health');
    expect(r.status).toBe(200);
    const h = (await r.json()) as any;
    expect(h.status).toBe('ok');
    expect(h.version).toBe('3.0.0');
    // DB-derived V3 metrics are always present, even on an empty DB.
    expect(h.observations).toEqual({ total: 0, normal: 0, fallback: 0, pinned: 0 });
    expect(h.embeddings.ready).toBe(0);
    expect(h.embeddings.coverage).toBe(0);
    // Per-protocol coverage is what answers "is the semantic-en-v1 rebuild
    // done?" — a single `ready` count cannot, since a raw-only Observation is
    // fully ready and invisible to an English query.
    expect(h.embeddings.byProtocol.map((p: { protocol: string }) => p.protocol)).toEqual([
      'raw-v1',
      'semantic-en-v1',
    ]);
    expect(h.embeddings.semanticEn).toEqual({ ready: 0, pending: 0, failed: 0 });
    // One model instance per dataDir is a claim only if it is observable.
    expect(h.embedding_runtime.model_instances).toBe(0);
    expect(h.embedding_runtime.queue_limit).toBeGreaterThan(0);
    expect(h.jobs_24h).toEqual({ succeeded: 0, dead: 0 });
    // Phase 2C added the retrieval dimensions; the zero state is asserted field
    // by field in tests/db/observability.test.ts. Here it only has to be present
    // and zeroed, plus the two numbers the gray release watches.
    expect(h.search_24h.requests).toBe(0);
    expect(h.search_24h.latencyMsP50).toBe(0);
    expect(h.search_24h.semanticEnRate).toBe(0);
    expect(h.search_24h.semanticQueryIssues).toEqual({});
    expect(h.search_24h.semanticOnlyMax).toBe(0);
    // Which retrieval profile this dataDir serves, so a rollback is verifiable
    // without reading code. `bunfig` preload points the data dir at a throwaway
    // tmp dir with no config.json, so this reads the injected fallback above.
    expect(h.retrieval).toEqual({
      semantic_discovery: true,
      profile: 'default',
      semantic_floor: 0.197,
      semantic_only_limit: 2,
      tie_break: 'semantic-rank',
    });
    expect(h.acp_24h).toEqual({ repairs: 0, contaminations: 0 });
    expect(h).toHaveProperty('jobs');
    // The production compressor reports pool stats; the fake pool is a single
    // idle slot. `null` here would mean the worker lost the stats wiring.
    expect(h.acp).toEqual({
      total: 1,
      busy: 0,
      queued: 0,
      restarts: 0,
      contaminations: 0,
      repairs: 0,
      parseFallbacks: 0,
      // Per-slot detail. The aggregates above cannot tell a saturated pool from
      // an idle one holding memory; `tests/acp/pool.test.ts` pins the semantics.
      slots: [{ pid: null, jobCount: 0, idleMs: 0, busy: false }],
    });
  });

  /**
   * Gate C P2 整改：`/health` 的回滚读数必须是**磁盘上的当前值**，不是 Worker 启动时
   * 缓存的那份。
   *
   * 为什么这条会错得很安静：灰度开关按 MCP 进程读取，所以运维改完 config.json，下一个
   * 会话立刻走回滚策略，而常驻 Worker 还拿着自己启动时的值。此时 `/health` 会报
   * `default / semantic_discovery=true`——而 README 承诺的正是"用 /health 确认回滚是否
   * 生效"。测的方式只能是"不重启 app、只改磁盘"。
   */
  test('GET /health 反映磁盘上的灰度开关，无需重启 Worker（Gate C P2）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-health-switch-'));
    const prev = process.env.KIRO_MEMORY_DATA_DIR;
    process.env.KIRO_MEMORY_DATA_DIR = dir;
    try {
      const read = async () => ((await (await app.request('/health')).json()) as any).retrieval;

      // 没有 config.json → 落回注入的配置（beforeEach 里钉的 true）。
      expect((await read()).profile).toBe('default');

      writeFileSync(join(dir, 'config.json'), JSON.stringify({ retrieval: { semanticDiscovery: false } }));
      const rolledBack = await read();
      expect(rolledBack).toEqual({
        semantic_discovery: false,
        profile: 'lexical-anchor-rollback',
        semantic_floor: 0.2,
        // Infinity 不能序列化成 JSON，报 'none' 而不是 null。
        semantic_only_limit: 'none',
        // 回滚是**整份 1b**，所以平局也回到 recency——阶段 2D 的 `semantic-rank` 只在
        // 默认 profile 上。
        tie_break: 'recency',
      });

      // 改回去也要立刻可见，否则"可来回切换"这句话没有观测支撑。
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ retrieval: { semanticDiscovery: true } }));
      expect((await read()).profile).toBe('default');

      // 只有显式 false 才回滚：缺失该键不能被读成"运维要求回滚"。
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ language: 'zh' }));
      expect((await read()).semantic_discovery).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.KIRO_MEMORY_DATA_DIR;
      else process.env.KIRO_MEMORY_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
