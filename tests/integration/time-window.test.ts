/**
 * Phase 3C：bootstrap 与默认 search 的时间窗口径必须一致。
 *
 * 判据：`benchmark/reports/phase3c-criteria.md`，A0 `366ce756b0d6ebd0`，
 * 冻结于 `2026-08-06T12:10:40Z`，先于任何实现改动。
 *
 * 这个文件测的是**可见范围**，不是相关性排序。它钉住四件事：
 *
 *   1. bootstrap 索引里能看到的记录，默认 `search` 也必须能搜到（判据 P0/P1）；
 *   2. 显式 `days=N` 仍然收窄（判据 P2）——放宽默认不等于删掉这个能力；
 *   3. scope 与 type 过滤对 >90 天的记录一样生效（判据 P3/P4）；
 *   4. 语义腿**单独**也能召回 >90 天的记录（判据 P5）。
 *
 * 第 4 条必须单独测：语义候选池走的是 `getRecentObservationIds(days)` 这条独立路径，
 * 只把 FTS 腿的窗口去掉，"索引里看得到、语义搜不到"这个矛盾会原地保留，而 FTS 腿的
 * 断言全部通过。
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';
import { hybridSearchObservations } from '../../src/server/observation-search';
import { buildBootstrapContext } from '../../src/bootstrap-context';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

/**
 * scope 口径必须和 bootstrap 自己算出来的一致。
 *
 * `buildBootstrapContext` 内部走 `computeScopeKey(detectRepo(cwd), cwd)`，而 `/proj`
 * 不是 git 仓库，`detectRepo` 返回 `null`，于是 scope key 是 `cwd:/proj`。播种时若传
 * `repo: '/proj'`，scope key 会变成 `/proj`，两侧就比不到同一批记录——那是装置错误，
 * 不是产品缺陷。所以这里统一用 `repo: null`。
 */
const CWD = '/proj';
const SCOPE = computeScopeKey(null, CWD);
const FOREIGN_CWD = '/other';
const FOREIGN_SCOPE = computeScopeKey(null, FOREIGN_CWD);
const TEST_VECTOR_SPACE = { embeddingModel: 'test', embeddingDimensions: 4 };

/** query 向量恒为 [1,0,0,0]，于是 cosine == 记录向量的第一维。 */
const queryVec = async () => new Float32Array([1, 0, 0, 0]);

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

function seed(o: {
  title: string;
  daysAgo: number;
  cwd?: string;
  embedding?: number[];
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
}): number {
  const cwd = o.cwd ?? CWD;
  const session_id = `s-${cwd}`;
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo: null });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo: null, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const at = daysAgo(o.daysAgo);
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo: null, cwd_scope: cwd,
    title: o.title, summary: o.title, memory_type: o.type ?? 'change', quality: 'normal',
    turn_started_at: at, turn_stopped_at: at,
  })!;
  if (o.embedding) {
    db.upsertObservationEmbedding(id, 'test', o.embedding.length, embeddingToBlob(new Float32Array(o.embedding)));
  }
  return id;
}

/**
 * 四条同 scope 记录跨越 90 天边界，外加一条外部 scope 的同龄记录。
 *
 * 词面刻意共享 `zzmarker`，这样一个 query 就能同时命中四条，返回集合的差异只能来自
 * 时间过滤而不是相关性差异。向量第一维全为 0.9（远高于 floor 0.197），所以语义腿在
 * "能看到它"的前提下一定会给出候选。
 */
function seedAcrossBoundary() {
  const recent = seed({ title: 'zzmarker recent entry', daysAgo: 1, embedding: [0.9, 0.1, 0, 0] });
  const inWindow = seed({ title: 'zzmarker mid window entry', daysAgo: 45, embedding: [0.9, 0.1, 0, 0] });
  const justOutside = seed({ title: 'zzmarker just outside entry', daysAgo: 100, embedding: [0.9, 0.1, 0, 0] });
  const longAgo = seed({ title: 'zzmarker long ago entry', daysAgo: 400, embedding: [0.9, 0.1, 0, 0] });
  // 外部 scope，同样老、cosine 同样完美：泄漏守卫的对照物。
  const foreign = seed({
    title: 'zzmarker long ago foreign entry', daysAgo: 400, cwd: FOREIGN_CWD, embedding: [0.9, 0.1, 0, 0],
  });
  return { recent, inWindow, justOutside, longAgo, foreign };
}

const search = (
  query: string,
  opts?: { days?: number; type?: string; semanticQueryEn?: string; scopeKey?: string },
) =>
  hybridSearchObservations(
    db,
    query,
    { scopeKey: opts?.scopeKey ?? SCOPE, limit: 20, ...opts },
    { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec },
  );

/** bootstrap 注入文本里出现的 Observation id 集合。 */
function bootstrapIds(): Set<number> {
  const text = buildBootstrapContext(db, CWD, { maxOutputBytes: 8192 }, 'en');
  const ids = new Set<number>();
  for (const m of text.matchAll(/#O(\d+)/g)) ids.add(Number(m[1]));
  return ids;
}

describe('Phase 3C：bootstrap 与默认 search 的可见范围一致', () => {
  test('P0/P1：bootstrap 索引里的 >90 天记录，默认 search 也能搜到', async () => {
    const { recent, inWindow, justOutside, longAgo } = seedAcrossBoundary();

    // P0 的前提：bootstrap 本来就没有时间过滤，四条全都在索引里。
    const injected = bootstrapIds();
    for (const id of [recent, inWindow, justOutside, longAgo]) {
      expect(injected.has(id)).toBe(true);
    }

    // P1：默认 search（不传 days）必须能搜到同样的四条。
    // 改动之前这里会少掉 justOutside 与 longAgo —— 那正是本轮要消除的产品矛盾。
    const found = new Set((await search('zzmarker')).map((r) => r.id));
    for (const id of [recent, inWindow, justOutside, longAgo]) {
      expect(found.has(id)).toBe(true);
    }

    // 一致性本身也断言一次：bootstrap 能看到的本 scope 记录，默认 search 一条都不少。
    expect([...injected].sort((a, b) => a - b)).toEqual([...found].sort((a, b) => a - b));
  });

  test('P2：显式 days=90 仍然收窄到最近 90 天', async () => {
    const { recent, inWindow, justOutside, longAgo } = seedAcrossBoundary();

    const found = new Set((await search('zzmarker', { days: 90 })).map((r) => r.id));
    expect(found.has(recent)).toBe(true);
    expect(found.has(inWindow)).toBe(true);
    // 放宽默认不等于删掉收窄能力。
    expect(found.has(justOutside)).toBe(false);
    expect(found.has(longAgo)).toBe(false);
  });

  test('P3：跨 scope 泄漏 0 —— 外部 scope 的 400 天前记录即使 cosine 完美也不返回', async () => {
    const { foreign } = seedAcrossBoundary();

    const found = new Set((await search('zzmarker')).map((r) => r.id));
    expect(found.has(foreign)).toBe(false);

    // 反过来也成立：显式搜外部 scope 时它可见，证明上面那条 false 来自 scope 过滤
    // 而不是这条记录压根没被写进去。
    const foreignFound = new Set((await search('zzmarker', { scopeKey: FOREIGN_SCOPE })).map((r) => r.id));
    expect(foreignFound.has(foreign)).toBe(true);
  });

  test('P4：type 过滤对 >90 天记录仍然生效', async () => {
    const oldBugfix = seed({ title: 'zzmarker old bugfix', daysAgo: 400, type: 'bugfix', embedding: [0.9, 0.1, 0, 0] });
    const oldFeature = seed({ title: 'zzmarker old feature', daysAgo: 400, type: 'feature', embedding: [0.9, 0.1, 0, 0] });

    const found = new Set((await search('zzmarker', { type: 'bugfix' })).map((r) => r.id));
    expect(found.has(oldBugfix)).toBe(true);
    expect(found.has(oldFeature)).toBe(false);
  });

  test('P5：语义腿单独也能召回 >90 天记录（零词面重叠）', async () => {
    // 400 天前的记录，词面与 query 毫无重叠；只有语义腿能找到它。
    const longAgo = seed({
      title: 'quarterly billing reconciliation rewrite', daysAgo: 400, embedding: [0.9, 0.1, 0, 0],
    });

    const results = await search('completely unrelated phrasing here', {
      semanticQueryEn: 'completely unrelated phrasing here',
    });
    const hit = results.find((r) => r.id === longAgo);

    // 改动之前候选池被 getRecentObservationIds(days=90) 挡住，这条记录压根不会被打分。
    expect(hit).toBeDefined();
    expect(hit!.match_source).toBe('semantic');
  });

  test('P5 补充：语义腿的候选池确实把 >90 天记录算进去了', async () => {
    seed({ title: 'quarterly billing reconciliation rewrite', daysAgo: 400, embedding: [0.9, 0.1, 0, 0] });
    seed({ title: 'another old unrelated record', daysAgo: 200, embedding: [0.8, 0.1, 0, 0] });

    let comparableVectors = -1;
    await hybridSearchObservations(
      db,
      'completely unrelated phrasing here',
      { scopeKey: SCOPE, semanticQueryEn: 'completely unrelated phrasing here', limit: 20 },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        onCandidates: (i) => { comparableVectors = i.comparableVectors; },
      },
    );

    // 两条记录都在 90 天外；打分过的向量数必须是 2，而不是 0。
    expect(comparableVectors).toBe(2);
  });
});
