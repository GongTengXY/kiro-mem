/**
 * Topic normalization tests.
 *
 * The topic pipeline has four correctness contracts and this file covers all
 * of them:
 *
 *   1. `topic_candidate` from summarize_turn is persisted on memories and
 *      takes precedence over concepts/title when normalize_topic runs.
 *   2. Topic upsert + memory link + memory_count increment + alias union
 *      all happen atomically inside one transaction.
 *   3. `scope_key` is derived via `computeScopeKey(repo, cwd)` with path
 *      normalization so superficial string differences don't fragment
 *      a single workspace across multiple buckets.
 *   4. Scopes (git repo vs non-git cwd) stay isolated from each other.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;

function insertMem(overrides: Partial<Parameters<typeof db.insertMemory>[0]> = {}) {
  return db.insertMemory({
    memory_kind: 'turn',
    title: 'Test',
    summary: 'Summary',
    memory_type: 'change',
    first_turn_at: new Date().toISOString(),
    last_turn_at: new Date().toISOString(),
    ...overrides,
  });
}

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

// ---------------------------------------------------------------------------
// 1. topic_candidate persistence
// ---------------------------------------------------------------------------

describe('topic_candidate persistence', () => {
  test('createTurnMemoryAtomic stores topic_candidate', () => {
    db.upsertSessionRef({ session_id: 's1', cwd: '/p' });
    const turn = db.createTurn({
      session_id: 's1', seq: db.allocateNextTurnSeq('s1'),
      cwd: '/p', repo: '/p',
    });
    db.markTurnClosed(turn.id);
    const mid = db.createTurnMemoryAtomic(turn.id, {
      memory_kind: 'turn', title: 't', summary: 's', memory_type: 'change',
      first_turn_at: turn.started_at, last_turn_at: turn.started_at,
      topic_candidate: 'auth token refresh',
    })!;
    expect(db.getMemory(mid)!.topic_candidate).toBe('auth token refresh');
  });

  test('insertMemory stores topic_candidate on the merge path', () => {
    const mid = insertMem({ topic_candidate: 'auth' });
    expect(db.getMemory(mid)!.topic_candidate).toBe('auth');
  });
});

// ---------------------------------------------------------------------------
// 2. Atomic upsert — topic row, memory link, memory_count, aliases
// ---------------------------------------------------------------------------

describe('upsertTopicAndLinkMemory — single call semantics', () => {
  test('first call creates topic with memory_count=1 and links the memory', () => {
    const mid = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    const res = db.upsertTopicAndLinkMemory({
      memory_id: mid,
      scope_key: '/proj',
      repo: '/proj',
      canonical_label: 'auth',
    });
    expect(res.linked).toBe(true);

    const topic = db.getTopic(res.topic_id)!;
    expect(topic.memory_count).toBe(1);
    expect(topic.scope_key).toBe('/proj');
    expect(topic.canonical_label).toBe('auth');
    expect(db.getMemory(mid)!.topic_id).toBe(res.topic_id);
  });

  test('subsequent upsert on same (scope_key, label) bumps count, never duplicates', () => {
    const m1 = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    const m2 = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    const r1 = db.upsertTopicAndLinkMemory({
      memory_id: m1, scope_key: '/proj', repo: '/proj', canonical_label: 'auth',
    });
    const r2 = db.upsertTopicAndLinkMemory({
      memory_id: m2, scope_key: '/proj', repo: '/proj', canonical_label: 'auth',
    });
    expect(r2.topic_id).toBe(r1.topic_id);

    const rows = db.raw.query(
      `SELECT COUNT(*) AS cnt FROM topics WHERE scope_key = ? AND canonical_label = ?`,
    ).get('/proj', 'auth') as { cnt: number };
    expect(rows.cnt).toBe(1);
    expect(db.getTopic(r1.topic_id)!.memory_count).toBe(2);
  });

  test('second call for the same memory is a no-op (no count inflation on retry)', () => {
    const mid = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    const r1 = db.upsertTopicAndLinkMemory({
      memory_id: mid, scope_key: '/proj', repo: '/proj', canonical_label: 'auth',
    });
    expect(r1.linked).toBe(true);

    const r2 = db.upsertTopicAndLinkMemory({
      memory_id: mid, scope_key: '/proj', repo: '/proj', canonical_label: 'auth',
    });
    expect(r2.linked).toBe(false);
    expect(r2.topic_id).toBe(r1.topic_id);
    expect(db.getTopic(r1.topic_id)!.memory_count).toBe(1);
  });

  test('upsert on an archived topic reactivates it', () => {
    const m1 = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    const r1 = db.upsertTopicAndLinkMemory({
      memory_id: m1, scope_key: '/proj', repo: '/proj', canonical_label: 'auth',
    });
    db.raw.run(`UPDATE topics SET status = 'archived' WHERE id = ?`, [r1.topic_id]);

    const m2 = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    db.upsertTopicAndLinkMemory({
      memory_id: m2, scope_key: '/proj', repo: '/proj', canonical_label: 'auth',
    });

    const topic = db.getTopic(r1.topic_id)!;
    expect(topic.status).toBe('active');
    expect(topic.memory_count).toBe(2);
  });
});

describe('upsertTopicAndLinkMemory — alias union', () => {
  test('INSERT path writes aliases verbatim (deduplicated)', () => {
    const mid = insertMem({ repo: '/p', cwd_scope: '/p' });
    const { topic_id } = db.upsertTopicAndLinkMemory({
      memory_id: mid, scope_key: '/p', repo: '/p',
      canonical_label: 'auth',
      aliases: ['login', 'signin', 'login'],
    });
    const aliases = JSON.parse(db.getTopic(topic_id)!.aliases_json) as string[];
    expect(aliases.sort()).toEqual(['login', 'signin'].sort());
  });

  test('ON CONFLICT path unions new aliases with existing ones', () => {
    const m1 = insertMem({ repo: '/p', cwd_scope: '/p' });
    const m2 = insertMem({ repo: '/p', cwd_scope: '/p' });

    db.upsertTopicAndLinkMemory({
      memory_id: m1, scope_key: '/p', repo: '/p',
      canonical_label: 'auth',
      aliases: ['login', 'signin'],
    });
    const { topic_id } = db.upsertTopicAndLinkMemory({
      memory_id: m2, scope_key: '/p', repo: '/p',
      canonical_label: 'auth',
      aliases: ['signin', 'auth-flow'],
    });

    const aliases = JSON.parse(db.getTopic(topic_id)!.aliases_json) as string[];
    expect(aliases.sort()).toEqual(['auth-flow', 'login', 'signin'].sort());
  });

  test('omitted / empty aliases do not clobber an existing set', () => {
    const m1 = insertMem({ repo: '/p', cwd_scope: '/p' });
    const m2 = insertMem({ repo: '/p', cwd_scope: '/p' });

    db.upsertTopicAndLinkMemory({
      memory_id: m1, scope_key: '/p', repo: '/p',
      canonical_label: 'auth',
      aliases: ['login'],
    });
    const { topic_id } = db.upsertTopicAndLinkMemory({
      memory_id: m2, scope_key: '/p', repo: '/p',
      canonical_label: 'auth',
      // no aliases
    });

    const aliases = JSON.parse(db.getTopic(topic_id)!.aliases_json) as string[];
    expect(aliases).toEqual(['login']);
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency — atomic guarantees hold under parallel load
// ---------------------------------------------------------------------------

describe('upsertTopicAndLinkMemory — concurrency', () => {
  test('20 parallel upserts on same (scope_key, label) converge to one topic, count=20', async () => {
    const memIds = Array.from({ length: 20 }, () =>
      insertMem({ repo: '/proj', cwd_scope: '/proj' }),
    );

    const results = await Promise.all(
      memIds.map((mid) =>
        Promise.resolve(
          db.upsertTopicAndLinkMemory({
            memory_id: mid,
            scope_key: '/proj',
            repo: '/proj',
            canonical_label: 'auth',
          }),
        ),
      ),
    );

    const topicIds = new Set(results.map((r) => r.topic_id));
    expect(topicIds.size).toBe(1);

    const rows = db.raw.query(
      `SELECT COUNT(*) AS cnt FROM topics WHERE scope_key = ? AND canonical_label = ?`,
    ).get('/proj', 'auth') as { cnt: number };
    expect(rows.cnt).toBe(1);

    const [topicId] = [...topicIds];
    expect(db.getTopic(topicId!)!.memory_count).toBe(20);
    for (const mid of memIds) {
      expect(db.getMemory(mid)!.topic_id).toBe(topicId!);
    }
  });

  test('10 parallel upserts on the same memory never inflate count beyond 1', async () => {
    const mid = insertMem({ repo: '/proj', cwd_scope: '/proj' });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve(
          db.upsertTopicAndLinkMemory({
            memory_id: mid,
            scope_key: '/proj',
            repo: '/proj',
            canonical_label: 'auth',
          }),
        ),
      ),
    );
    const topicIds = new Set(results.map((r) => r.topic_id));
    expect(topicIds.size).toBe(1);
    expect(db.getTopic([...topicIds][0]!)!.memory_count).toBe(1);
  });

  test('concurrent alias writes never lose entries (pure-SQL union)', async () => {
    // 12 memories each contributing a distinct alias + one shared alias.
    const sharedAlias = 'auth';
    const uniqueAliases = Array.from({ length: 12 }, (_, i) => `alias-${i}`);
    const memIds = uniqueAliases.map(() =>
      insertMem({ repo: '/proj', cwd_scope: '/proj' }),
    );

    await Promise.all(
      memIds.map((mid, i) =>
        Promise.resolve(
          db.upsertTopicAndLinkMemory({
            memory_id: mid,
            scope_key: '/proj',
            repo: '/proj',
            canonical_label: 'topic-x',
            aliases: [sharedAlias, uniqueAliases[i]!],
          }),
        ),
      ),
    );

    const topic = db.findTopicByScope('/proj', 'topic-x')!;
    expect(topic).not.toBeNull();
    expect(topic.memory_count).toBe(memIds.length);

    const aliases = new Set(JSON.parse(topic.aliases_json) as string[]);
    for (const a of [sharedAlias, ...uniqueAliases]) {
      expect(aliases.has(a)).toBe(true);
    }
    // And no stray entries.
    expect(aliases.size).toBe(uniqueAliases.length + 1);
  });
});

// ---------------------------------------------------------------------------
// 4. scope_key derivation + path normalization
// ---------------------------------------------------------------------------

describe('computeScopeKey — precedence', () => {
  test('prefers repo over cwd', () => {
    expect(computeScopeKey('/a/repo', '/somewhere')).toBe('/a/repo');
  });
  test('falls back to cwd: prefix when repo is missing', () => {
    expect(computeScopeKey(null, '/workspace/foo')).toBe('cwd:/workspace/foo');
  });
  test('uses __global__ sentinel when neither input is usable', () => {
    expect(computeScopeKey(null, null)).toBe('__global__');
    expect(computeScopeKey(undefined, undefined)).toBe('__global__');
    expect(computeScopeKey('', '')).toBe('__global__');
    expect(computeScopeKey('   ', '   ')).toBe('__global__');
  });
});

describe('computeScopeKey — path normalization', () => {
  let tmp: string;
  beforeEach(() => {
    // realpathSync resolves /tmp on macOS to /private/tmp; do the same so
    // assertions compare apples to apples.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kiro-mem-scope-')));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  test('trailing slash is stripped so /a/b and /a/b/ produce the same scope', () => {
    const a = computeScopeKey(tmp, null);
    const b = computeScopeKey(`${tmp}/`, null);
    expect(a).toBe(b);
    expect(a).toBe(tmp);
  });

  test('relative path is resolved to the same absolute scope as its absolute form', () => {
    const rel = relative(process.cwd(), tmp);
    // Sanity: relative form should not be absolute.
    expect(rel.startsWith('/')).toBe(false);
    expect(computeScopeKey(rel, null)).toBe(computeScopeKey(tmp, null));
  });

  test('symlink resolves to its realpath target', () => {
    const link = join(tmpdir(), `kiro-mem-link-${Date.now()}-${Math.random()}`);
    try {
      symlinkSync(tmp, link);
      expect(computeScopeKey(link, null)).toBe(tmp);
    } finally {
      try { rmSync(link, { force: true }); } catch {}
    }
  });

  test('non-existent path falls back gracefully to the resolved-but-not-real form', () => {
    const ghost = '/definitely/not/a/real/dir/for/kiro-mem-test';
    expect(computeScopeKey(ghost, null)).toBe(ghost);
  });

  test('cwd scope uses the same normalization and stays prefixed', () => {
    const a = computeScopeKey(null, tmp);
    const b = computeScopeKey(null, `${tmp}/`);
    expect(a).toBe(b);
    expect(a).toBe(`cwd:${tmp}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Scope isolation between workspaces
// ---------------------------------------------------------------------------

describe('scope isolation', () => {
  test('two non-git sessions under the same cwd collapse to one topic', () => {
    const m1 = insertMem({ repo: null, cwd_scope: '/workspace/a' });
    const m2 = insertMem({ repo: null, cwd_scope: '/workspace/a' });

    const scope = computeScopeKey(null, '/workspace/a');
    const r1 = db.upsertTopicAndLinkMemory({
      memory_id: m1, scope_key: scope, repo: null, canonical_label: 'auth',
    });
    const r2 = db.upsertTopicAndLinkMemory({
      memory_id: m2, scope_key: scope, repo: null, canonical_label: 'auth',
    });
    expect(r2.topic_id).toBe(r1.topic_id);
    expect(db.getTopic(r1.topic_id)!.memory_count).toBe(2);
  });

  test('different cwd namespaces keep same-label topics isolated', () => {
    const mA = insertMem({ repo: null, cwd_scope: '/workspace/a' });
    const mB = insertMem({ repo: null, cwd_scope: '/workspace/b' });

    const rA = db.upsertTopicAndLinkMemory({
      memory_id: mA,
      scope_key: computeScopeKey(null, '/workspace/a'),
      repo: null,
      canonical_label: 'auth',
    });
    const rB = db.upsertTopicAndLinkMemory({
      memory_id: mB,
      scope_key: computeScopeKey(null, '/workspace/b'),
      repo: null,
      canonical_label: 'auth',
    });
    expect(rA.topic_id).not.toBe(rB.topic_id);
  });
});

// ---------------------------------------------------------------------------
// 6. Scope-aware topic listing (browse)
// ---------------------------------------------------------------------------

describe('getActiveTopics — scope filtering', () => {
  test('filters by derived scope_key when repo is given', () => {
    const a = db.createTopic({ repo: '/projA', canonical_label: 'auth' });
    const b = db.createTopic({ repo: '/projB', canonical_label: 'auth' });
    db.updateTopic(a.id, { memory_count_delta: 1, last_active_at: new Date().toISOString() });
    db.updateTopic(b.id, { memory_count_delta: 1, last_active_at: new Date().toISOString() });

    const onlyA = db.getActiveTopics({ repo: '/projA', cwd: '/projA' });
    expect(onlyA.map((t) => t.id)).toEqual([a.id]);
  });

  test('non-git scope (repo=null) uses cwd namespace', () => {
    const a = db.createTopic({ repo: null, cwd: '/ws/a', canonical_label: 'auth' });
    db.createTopic({ repo: null, cwd: '/ws/b', canonical_label: 'auth' });
    db.updateTopic(a.id, { memory_count_delta: 1, last_active_at: new Date().toISOString() });

    const onlyA = db.getActiveTopics({ repo: null, cwd: '/ws/a' });
    expect(onlyA.map((t) => t.id)).toEqual([a.id]);
  });

  test('returns all active topics when no scope is given', () => {
    db.createTopic({ repo: '/projA', canonical_label: 't1' });
    db.createTopic({ repo: '/projB', canonical_label: 't2' });
    db.createTopic({ repo: null, cwd: '/ws/c', canonical_label: 't3' });

    expect(db.getActiveTopics().length).toBe(3);
  });
});
