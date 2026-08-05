/**
 * `RetrievalPolicy` 注入面的结构性测试（阶段 2A）。
 *
 * 这些测试不判断"检索质量好不好"——那是 benchmark 的事。它们只钉住三件在阶段 2B
 * 会被反复依赖的**结构不变量**：
 *
 *   1. 默认策略必须逐字复现阶段 1b 行为（词汇锚点门在、无 cap、等权、recency 平局）；
 *   2. 每个 knob 单独打开时确实生效，且只影响它该影响的那一层；
 *   3. cap 在**融合之后**执行并补位，不是在融合之前截断语义候选表。
 *
 * 第 3 条是最容易实现错的一条。融合前截断会改变存活下来的 hybrid 候选的语义名次，
 * 于是 cap 和融合权重耦合，2B 的 12 个 arm 就无法归因（方案 §4.3）。
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';
import {
  hybridSearchObservations,
  DEFAULT_RETRIEVAL_POLICY,
  LEXICAL_ANCHOR_ROLLBACK_POLICY,
  resolveRetrievalPolicy,
  validateRetrievalPolicy,
  type RetrievalPolicy,
} from '../../src/server/observation-search';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

const SCOPE = computeScopeKey('/proj', '/proj');
const TEST_VECTOR_SPACE = { embeddingModel: 'test', embeddingDimensions: 4 };
/** query 向量恒为 [1,0,0,0]，于是 cosine == 记录向量的第一维。 */
const queryVec = async () => new Float32Array([1, 0, 0, 0]);

function seed(o: {
  title: string;
  stoppedAt: string;
  embedding?: number[];
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
}): number {
  const session_id = 's1';
  const cwd = '/proj';
  const repo = '/proj';
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo, cwd_scope: cwd,
    title: o.title, summary: o.title, memory_type: o.type ?? 'change', quality: 'normal',
    turn_started_at: o.stoppedAt, turn_stopped_at: o.stoppedAt,
  })!;
  if (o.embedding) {
    db.upsertObservationEmbedding(id, 'test', o.embedding.length, embeddingToBlob(new Float32Array(o.embedding)));
  }
  return id;
}

const search = (query: string, policy?: Partial<RetrievalPolicy>, limit?: number) =>
  hybridSearchObservations(
    db,
    query,
    { scopeKey: SCOPE, ...(limit === undefined ? {} : { limit }) },
    { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec, ...(policy ? { policy } : {}) },
  );

/**
 * 要走 discovery 的搜索：额外传 `semanticQueryEn`，因为协议边界要求 discovery 只在
 * `semantic-en-v1` 空间成立。
 *
 * 这里传的就是 query 本身，这是合法的而不是取巧：护栏写明"An English source
 * legitimately normalizes to itself"，只拒绝中文原文的回显。本文件的 fixture query
 * 都是英文，所以恒等就是生产里英文用户那条真实路径。
 */
const discoverySearch = (query: string, policy?: Partial<RetrievalPolicy>, limit?: number) =>
  hybridSearchObservations(
    db,
    query,
    { scopeKey: SCOPE, semanticQueryEn: query, ...(limit === undefined ? {} : { limit }) },
    {
      ...TEST_VECTOR_SPACE,
      generateEmbedding: queryVec,
      policy: { semanticDiscovery: true, ...policy },
    },
  );

describe('流式打分与有界 Top-K（Top-K 轮次阶段一）', () => {
  /**
   * Reference implementation: the pre-streaming algorithm, written out here.
   *
   * The point of a reference rather than a golden file is that it can be run on any
   * fixture, including the tie-heavy ones below that no recorded benchmark contains.
   * It must stay a literal transcription of the old path — fetch every candidate in
   * ONE query, score, stable-sort by score desc — because that is what "equivalent"
   * is being measured against.
   */
  function referenceRanks(ids: number[], queryVector: Float32Array, floor: number) {
    const rows = db.getObservationEmbeddingsByIds(ids, { model: 'test', dimensions: 4 });
    const scored: { id: number; score: number }[] = [];
    for (const r of rows) {
      let dot = 0;
      const v = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, 4);
      for (let i = 0; i < 4; i++) dot += queryVector[i]! * v[i]!;
      if (dot > floor) scored.push({ id: r.observation_id, score: dot });
    }
    scored.sort((a, b) => b.score - a.score); // stable: ties keep SQLite's id-asc order
    return new Map(scored.map((s, i) => [s.id, i + 1]));
  }

  async function streamRanks(policy?: Partial<RetrievalPolicy>) {
    let ranks: ReadonlyMap<number, number> = new Map();
    await hybridSearchObservations(
      db,
      'unrelated wording entirely',
      { scopeKey: SCOPE, semanticQueryEn: 'unrelated wording entirely', limit: 10 },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, ...policy },
        onCandidates: (i) => { ranks = i.semanticRank; },
      },
    );
    return ranks;
  }

  test('无平局时名次与参考实现逐键相同', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) {
      ids.push(seed({ title: `zzz qqq ${i}`, stoppedAt: `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`, embedding: [0.9 - i * 0.02, 1, 0, 0] }));
    }
    const ref = referenceRanks(ids, new Float32Array([1, 0, 0, 0]), DEFAULT_RETRIEVAL_POLICY.semanticFloor);
    const got = await streamRanks();
    expect(got.size).toBe(ref.size);
    for (const [id, rank] of ref) expect(got.get(id)).toBe(rank);
  });

  test('**全部同分**时名次仍与参考实现逐键相同（平局顺序不能因为流式而变）', async () => {
    // 这是最容易出错的形状：稳定排序下平局按 SQLite 返回顺序（id 升序）决出，
    // 流式实现必须用同一个平局键，否则名次会漂移而分数完全相同。
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) {
      ids.push(seed({ title: `zzz qqq ${i}`, stoppedAt: `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`, embedding: [0.5, 1, 0, 0] }));
    }
    const ref = referenceRanks(ids, new Float32Array([1, 0, 0, 0]), DEFAULT_RETRIEVAL_POLICY.semanticFloor);
    const got = await streamRanks();
    expect([...got.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0])).toEqual(
      [...ref.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]),
    );
  });

  test('候选数落在块边界与其附近时结果不变、无重复、无遗漏', async () => {
    // 块大小是 4096，用不到那么多记录；这里验证的是"分块本身不改变名次集合"，
    // 用 topK 强制多次收放来触达同一条代码路径。
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) {
      ids.push(seed({ title: `zzz qqq ${i}`, stoppedAt: `2026-07-01T00:${String(i).padStart(2, '0')}:00Z`, embedding: [0.9 - i * 0.01, 1, 0, 0] }));
    }
    const full = await streamRanks();
    for (const k of [1, 29, 30, 31]) {
      const got = await streamRanks({ semanticTopK: k });
      const kept = [...got.entries()].sort((a, b) => a[1] - b[1]);
      expect(new Set(kept.map((e) => e[0])).size).toBe(kept.length); // 无重复
      expect(kept.length).toBe(Math.min(k, full.size));              // 不多不少
      // 保留下来的必须是全量名次里最靠前的那一批，且名次值不变
      for (const [id, rank] of kept) expect(rank).toBe(full.get(id)!);
    }
  });

  test('FTS 命中的候选即使分数排在 K 名之后也必须保留，且名次是真实全局名次', async () => {
    // 目标：词面命中但语义分最低。K=1 时它排不进 Top-1，仍必须出现在名次表里，
    // 且名次必须是它真实的全局位置，而不是 K+1。
    const anchor = seed({ title: 'boundary anchor token', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.21, 1, 0, 0] });
    for (let i = 0; i < 5; i++) {
      seed({ title: `zzz qqq ${i}`, stoppedAt: `2026-07-01T01:${String(i).padStart(2, '0')}:00Z`, embedding: [0.9 - i * 0.05, 1, 0, 0] });
    }
    let ranks: ReadonlyMap<number, number> = new Map();
    const results = await hybridSearchObservations(
      db,
      'boundary anchor token',
      { scopeKey: SCOPE, semanticQueryEn: 'boundary anchor token', limit: 10 },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, semanticTopK: 1 },
        onCandidates: (i) => { ranks = i.semanticRank; },
      },
    );
    expect(ranks.has(anchor)).toBe(true);
    // 6 条都过 floor，anchor 分数最低 → 真实全局名次 6，不是 K+1 = 2
    expect(ranks.get(anchor)).toBe(6);
    expect(results.find((r) => r.id === anchor)?.match_source).toBe('hybrid');
  });

  test('全部候选都在 floor 之下时语义腿为空而不是抛错', async () => {
    for (let i = 0; i < 5; i++) {
      seed({ title: `zzz qqq ${i}`, stoppedAt: `2026-07-01T00:0${i}:00Z`, embedding: [0.01, 1, 0, 0] });
    }
    const got = await streamRanks();
    expect(got.size).toBe(0);
  });
});

describe('候选池：全 scope 打分（候选池轮次的产品改动）', () => {
  /**
   * Seed `n` filler records NEWER than the target, none of which share wording
   * with the query, so the only way the target can be found is the semantic leg.
   */
  function seedWindow(n: number): number {
    // Target first = oldest. `title`/`summary` deliberately share no trigram with
    // the query below, so FTS cannot reach it.
    const target = seed({ title: 'zzz qqq vvv', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    for (let i = 0; i < n; i++) {
      seed({
        title: `filler ${i} kkk`,
        stoppedAt: `2026-07-02T${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
        embedding: [0.05, 1, 0, 0],
      });
    }
    return target;
  }

  test('比最近 200 条更老、且没有词面命中的记录，在发布默认下可被语义腿找到', async () => {
    const target = seedWindow(250);
    const results = await discoverySearch('unrelated wording entirely');
    // 这是本轮买到的东西：在 pool=200 下这条记录连一次 cosine 都不会被算。
    expect(results.map((r) => r.id)).toContain(target);
    expect(results.find((r) => r.id === target)!.match_source).toBe('semantic');
  });

  test('同一装置在 pool=200 下结构上不可达——对照，证明上一条不是恒真', async () => {
    const target = seedWindow(250);
    const results = await discoverySearch('unrelated wording entirely', { semanticCandidatePool: 200 });
    expect(results.map((r) => r.id)).not.toContain(target);
  });

  test('S1 结构界：扩池新增的候选只能以 semantic 进页，且仍受 cap 约束', async () => {
    // 5 条老记录都在窗口外、都没有词面命中、cosine 都过 floor。cap=2，所以最多 2 条能进页。
    const olds: number[] = [];
    for (let i = 0; i < 5; i++) {
      olds.push(seed({
        title: `zzz qqq vvv ${i}`,
        stoppedAt: `2026-07-01T00:0${i}:00Z`,
        embedding: [0.9 - i * 0.05, 1, 0, 0],
      }));
    }
    for (let i = 0; i < 250; i++) {
      seed({ title: `filler ${i} kkk`, stoppedAt: `2026-07-02T${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, embedding: [0.02, 1, 0, 0] });
    }
    const results = await discoverySearch('unrelated wording entirely');
    const fromOldWindow = results.filter((r) => olds.includes(r.id));
    expect(fromOldWindow.length).toBeLessThanOrEqual(DEFAULT_RETRIEVAL_POLICY.semanticOnlyLimit);
    expect(fromOldWindow.every((r) => r.match_source === 'semantic')).toBe(true);
  });
});

describe('DEFAULT_RETRIEVAL_POLICY', () => {
  test('冻结在 Gate B/D 选中的工作点上：discovery on / floor 0.197 / cap 2 / semantic-rank 平局', () => {
    // 这条是**回归锁**，不是重复声明。前四个数字是 12 个 arm 的完整链路扫参加三份
    // 确认集选出来的（`benchmark/reports/phase2b-codex-gate-b-decision.md`）；
    // `tieBreak` 是阶段 2D 选出来的（`benchmark/reports/phase2d-selection.md`），
    // 而 `rrfK` 与两个权重是 2D **刻意没有动**的字段。改动其中任何一个，那些报告就
    // 不再描述实际发布的行为。
    expect(DEFAULT_RETRIEVAL_POLICY).toEqual({
      semanticDiscovery: true,
      semanticFloor: 0.197,
      semanticOnlyLimit: 2,
      rrfK: 60,
      ftsWeight: 1,
      semanticWeight: 1,
      tieBreak: 'semantic-rank',
      // 候选池轮次的**分支 B-2**：质量上 `Infinity` 胜出（那 72 条零 FTS 校准 query 从
      // 结构上不可达的 0/72 变成 43/72），但它在裁定的双进程口径下**内存门失败**——
      // 50,000 条真实向量分布回放时检索循环 RSS +720MB > 512MB。20,000 在同一口径下
      // p95 183.15ms / p99 300.24ms / +384MB 六门全过。
      //
      // 20,000 **不等价于全 scope**：超过 20,000 条的 scope 会重新按 recency 截断，
      // 而那部分召回损失未测（召回装置只有 2,000 条）。改这个数字要等"分块读取 → 立即
      // 打分 → 有界 Top-K"那一轮，直接调大它等于把内存失败发出去。
      semanticCandidatePool: 20000,
      // 阶段 3A 的五个字段保持**关闭**。锁住 `bigramAux: false` 的意义与上面那四个数字
      // 相反：那些是「选出来的值不许被改」，这个是「Gate E 判定 3A 未通过，不许被打开」。
      // 15 个 arm 里零个同时满足质量与误召回门槛；架构被认可，工作点不存在。
      // 打开它需要新一轮实验（先建两腿都命中的校准集 + 更大的 empty 集），不是改这一行。
      bigramAux: false,
      bigramDfRatioCeiling: 1,
      bigramMinMatches: 1,
      bigramOnlyLimit: 2,
      bigramWeight: 1,
      // R2 新增。默认必须是 `always`（3A 的行为）：写成 `discovery-only` 等于在没有
      // Gate 的情况下把 R2 的产品改动发出去。工作点由 R2 网格选，不由这一行选。
      bigramVote: 'always',
      // Top-K 轮次阶段一：流式打分只换执行方式，`Infinity` = 不截断 = 换之前的行为。
      // 引入截断是产品改动，要走该轮判据 §6 的 K 矩阵与门槛，不是改这一行。
      semanticTopK: Number.POSITIVE_INFINITY,
    });
  });

  test('回滚 profile 逐字段等于阶段 1b：门在、floor 0.2、无 cap', () => {
    // 回滚必须整份回到 1b，而不是只关门：阶段 2A 证明的是**这一整套**能逐 query
    // 复现 1b 报告；"关门 + 2C 的 floor/cap"这个组合从未被测过。
    expect(LEXICAL_ANCHOR_ROLLBACK_POLICY).toEqual({
      semanticDiscovery: false,
      semanticFloor: 0.2,
      semanticOnlyLimit: Number.POSITIVE_INFINITY,
      rrfK: 60,
      ftsWeight: 1,
      semanticWeight: 1,
      tieBreak: 'recency',
      // 1b 也是给最近 200 条打分，所以回滚到 1b 就是 200。
      semanticCandidatePool: 200,
      // 1b 没有 bigram 腿，所以回滚到 1b 就等于关掉它。锁住这一条也防止回滚开关
      // 把一个 3A 改动夹带进一份「指标是在没有这条腿时测出来的」profile。
      bigramAux: false,
      bigramDfRatioCeiling: 1,
      bigramMinMatches: 1,
      bigramOnlyLimit: 2,
      bigramWeight: 1,
      // R2 新增。默认必须是 `always`（3A 的行为）：写成 `discovery-only` 等于在没有
      // Gate 的情况下把 R2 的产品改动发出去。工作点由 R2 网格选，不由这一行选。
      bigramVote: 'always',
      // Top-K 轮次阶段一：流式打分只换执行方式，`Infinity` = 不截断 = 换之前的行为。
      // 引入截断是产品改动，要走该轮判据 §6 的 K 矩阵与门槛，不是改这一行。
      semanticTopK: Number.POSITIVE_INFINITY,
    });
  });

  test('灰度开关只在两个冻结 profile 之间切换', () => {
    expect(resolveRetrievalPolicy(true)).toEqual(DEFAULT_RETRIEVAL_POLICY);
    expect(resolveRetrievalPolicy(false)).toEqual(LEXICAL_ANCHOR_ROLLBACK_POLICY);
  });

  test('不传 policy 与显式传入默认值，结果逐条相同', async () => {
    seed({ title: 'alpha work', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    seed({ title: 'alpha task', stoppedAt: '2026-07-02T00:00:00Z' });
    seed({ title: 'beta thing', stoppedAt: '2026-07-03T00:00:00Z', embedding: [0.9, 0, 0, 0] });

    const implicit = await search('alpha');
    const explicit = await search('alpha', { ...DEFAULT_RETRIEVAL_POLICY });
    expect(implicit.map((r) => r.id)).toEqual(explicit.map((r) => r.id));
    expect(implicit.map((r) => r.match_source)).toEqual(explicit.map((r) => r.match_source));
  });

  test('默认策略下 zero-FTS 的英文 query 会计算 embedding 并独立召回', async () => {
    // 这是 2C 的产品改动本身：不注入任何 policy，走内核默认值。
    const target = seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    let embedCalls = 0;
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: async () => { embedCalls++; return new Float32Array([1, 0, 0, 0]); },
      },
    );
    expect(embedCalls).toBe(1);
    expect(results.map((r) => r.id)).toEqual([target]);
    expect(results[0]!.match_source).toBe('semantic');
  });

  test('回滚 profile 下同一 query 回到旧行为：不算 embedding、返回空', async () => {
    seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    let embedCalls = 0;
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: async () => { embedCalls++; return new Float32Array([1, 0, 0, 0]); },
        policy: LEXICAL_ANCHOR_ROLLBACK_POLICY,
      },
    );
    expect(results).toEqual([]);
    expect(embedCalls).toBe(0);
  });

  test('默认 cap=2：zero-FTS 的语义候选再多也只返回 2 条', async () => {
    for (let i = 0; i < 5; i++) {
      seed({ title: `beta ${i}`, stoppedAt: `2026-07-0${i + 1}T00:00:00Z`, embedding: [0.9 - i * 0.05, 0, 0, 0] });
    }
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec },
    );
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.match_source).toBe('semantic');
  });

  test('默认 floor 是 0.197 且严格大于：0.197 被丢，0.198 保留', async () => {
    seed({ title: 'beta at floor', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.197, 0, 0, 0] });
    const atFloor = await hybridSearchObservations(
      db, 'zzzznomatch', { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec },
    );
    expect(atFloor).toEqual([]);
    const above = seed({ title: 'beta above floor', stoppedAt: '2026-07-02T00:00:00Z', embedding: [0.198, 0, 0, 0] });
    const justAbove = await hybridSearchObservations(
      db, 'zzzznomatch', { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec },
    );
    expect(justAbove.map((r) => r.id)).toEqual([above]);
  });
});

describe('semanticDiscovery', () => {
  test('false（回滚 profile）：FTS 零命中时不计算 query embedding，直接返回空', async () => {
    seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    let embedCalls = 0;
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: async () => { embedCalls++; return new Float32Array([1, 0, 0, 0]); },
        // 2C 之后这不再是默认值，必须显式选回滚 profile 才能拿到旧行为。
        policy: { semanticDiscovery: false },
      },
    );
    expect(results).toEqual([]);
    // 门在 embedding 之前，这是它存在的全部意义：省掉的不只是名次，是那次推理。
    expect(embedCalls).toBe(0);
  });

  test('true：FTS 零命中时仍计算 embedding，并可只靠语义召回', async () => {
    const target = seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    let embedCalls = 0;
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      // 合法英文形式：协议边界要求 discovery 只在 semantic-en-v1 空间成立。
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: async () => { embedCalls++; return new Float32Array([1, 0, 0, 0]); },
        policy: { semanticDiscovery: true },
      },
    );
    expect(embedCalls).toBe(1);
    expect(results.map((r) => r.id)).toEqual([target]);
    expect(results[0]!.match_source).toBe('semantic');
  });

  test('true 但语义候选全部低于 floor：返回空，且这是"两路都没候选"而非前置门', async () => {
    seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.1, 0, 0, 0] });
    const seen: { ftsCount: number; semanticCount: number }[] = [];
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, semanticFloor: 0.2 },
        onCandidates: (i) => seen.push({ ftsCount: i.ftsCount, semanticCount: i.semanticCount }),
      },
    );
    expect(results).toEqual([]);
    expect(seen).toEqual([{ ftsCount: 0, semanticCount: 0 }]);
  });
});

describe('semanticFloor', () => {
  test('比较是严格大于：恰好等于 floor 的候选被丢弃', async () => {
    seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.5, 0, 0, 0] });
    const atFloor = await discoverySearch('zzzznomatch', { semanticFloor: 0.5 });
    expect(atFloor).toEqual([]);
    const justBelow = await discoverySearch('zzzznomatch', { semanticFloor: 0.4999 });
    expect(justBelow).toHaveLength(1);
  });
});

describe('semanticOnlyLimit', () => {
  /** 1 条 FTS+语义双命中 + 4 条纯语义候选，语义分数递减保证名次确定。 */
  function seedCapFixture(): { hybrid: number; semantic: number[] } {
    const hybrid = seed({ title: 'alpha anchor', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.99, 0, 0, 0] });
    const semantic = [
      seed({ title: 'beta one', stoppedAt: '2026-07-02T00:00:00Z', embedding: [0.98, 0, 0, 0] }),
      seed({ title: 'beta two', stoppedAt: '2026-07-03T00:00:00Z', embedding: [0.97, 0, 0, 0] }),
      seed({ title: 'beta three', stoppedAt: '2026-07-04T00:00:00Z', embedding: [0.96, 0, 0, 0] }),
      seed({ title: 'beta four', stoppedAt: '2026-07-05T00:00:00Z', embedding: [0.95, 0, 0, 0] }),
    ];
    return { hybrid, semantic };
  }

  test.each([1, 2, 3, 5])('cap=%i 时 semantic-only 条数不超过 cap', async (cap) => {
    seedCapFixture();
    const results = await search('alpha', { semanticOnlyLimit: cap });
    const semanticOnly = results.filter((r) => r.match_source === 'semantic');
    expect(semanticOnly.length).toBeLessThanOrEqual(cap);
    // 所有 semantic-only 结果都必须带明确来源标记（方案 §7.4 结构不变量）。
    for (const r of semanticOnly) expect(r.semantic_score).not.toBeNull();
  });

  test('cap=Infinity（回滚 profile 的取值）：4 条纯语义候选全部返回', async () => {
    const { semantic } = seedCapFixture();
    const results = await search('alpha', { semanticOnlyLimit: Number.POSITIVE_INFINITY });
    const ids = results.filter((r) => r.match_source === 'semantic').map((r) => r.id);
    expect(ids.sort()).toEqual([...semantic].sort());
  });

  test('默认 cap=2：同一 fixture 只保留 2 条 semantic-only，其余被丢弃', async () => {
    seedCapFixture();
    const results = await search('alpha');
    expect(results.filter((r) => r.match_source === 'semantic')).toHaveLength(2);
  });

  test('cap 丢弃的候选不占 limit：被丢弃后继续补入后续结果', async () => {
    // 语义分数最高的 2 条纯语义候选之后，还有 2 条 FTS 命中在等着补位。
    seed({ title: 'alpha anchor one', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.99, 0, 0, 0] });
    seed({ title: 'beta one', stoppedAt: '2026-07-02T00:00:00Z', embedding: [0.98, 0, 0, 0] });
    seed({ title: 'beta two', stoppedAt: '2026-07-03T00:00:00Z', embedding: [0.97, 0, 0, 0] });
    const ftsB = seed({ title: 'alpha anchor two', stoppedAt: '2026-06-01T00:00:00Z' });
    const ftsC = seed({ title: 'alpha anchor three', stoppedAt: '2026-05-01T00:00:00Z' });

    const capped = await search('alpha', { semanticOnlyLimit: 1 }, 3);
    // limit=3 必须被填满：1 条 hybrid + 1 条 semantic + 补进来的 FTS。
    expect(capped).toHaveLength(3);
    expect(capped.filter((r) => r.match_source === 'semantic')).toHaveLength(1);
    const ids = capped.map((r) => r.id);
    expect(ids.includes(ftsB) || ids.includes(ftsC)).toBe(true);
  });

  test('limit 小于 cap 时以 limit 为准', async () => {
    seedCapFixture();
    const results = await search('alpha', { semanticOnlyLimit: 5 }, 2);
    expect(results).toHaveLength(2);
  });

  test('onFusion 报出被 cap 丢弃的数量与实际融合分排序', async () => {
    const { hybrid, semantic } = seedCapFixture();
    const seen: {
      semanticOnlyDropped: number;
      semanticOnlyReturned: number;
      ranked: readonly { id: number; score: number; matchSource: string; semRank: number | null }[];
    }[] = [];
    await hybridSearchObservations(
      db,
      'alpha',
      { scopeKey: SCOPE },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticOnlyLimit: 1 },
        onFusion: (i) => seen.push(i),
      },
    );
    expect(seen.length).toBe(1);
    expect(seen[0]!.semanticOnlyDropped).toBe(3);
    expect(seen[0]!.semanticOnlyReturned).toBe(1);

    // `ranked` 是 cap 与 limit **之前**的完整融合排序，带内核自己算出的分数——
    // Gate D P2 的平局枚举就读这个，所以它必须是全量而不是返回页。
    const ranked = seen[0]!.ranked;
    expect(ranked.map((r) => r.id)).toEqual([hybrid, ...semantic]);
    expect(ranked[0]!.matchSource).toBe('hybrid');
    expect(ranked[0]!.semRank).toBe(1);
    // 分数就是内核用的那个值，可以按公式复算到 float64 精度。
    expect(ranked[0]!.score).toBe(1 / 61 + 1 / 61);
    expect(ranked[1]!.score).toBe(1 / 62);
  });

  test('onFusion 不在词汇锚点提前返回时触发', async () => {
    seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    let fired = 0;
    await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec, onFusion: () => { fired++; } },
    );
    expect(fired).toBe(0);
  });
});

describe('tieBreak', () => {
  /**
   * 精确平局 fixture（阶段 1b 在真实 ACP 里发现的形状）：
   * 一条只靠语义命中且语义第 1，一条只靠词面命中且 FTS 第 1。
   * 等权下两者得分都是 `1/(60+1)`，完全相等。
   */
  function seedTieFixture(): { semanticOnly: number; ftsOnly: number } {
    // fts-only 更新，所以 recency 会把它排前面。
    const semanticOnly = seed({ title: 'beta target', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const ftsOnly = seed({ title: 'alpha other', stoppedAt: '2026-07-09T00:00:00Z' });
    return { semanticOnly, ftsOnly };
  }

  test('recency：更新的 fts-only 压过语义第 1', async () => {
    // 显式传 `recency`：阶段 2D 之后生产默认是 `semantic-rank`，这条用例测的是
    // `recency` 这个取值本身（也是回滚 profile 的取值），不是"默认值"。
    const { semanticOnly, ftsOnly } = seedTieFixture();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'recency' });
    expect(results.map((r) => r.id)).toEqual([ftsOnly, semanticOnly]);
  });

  test('source-confidence：语义第 1 排到更新的 fts-only 之前', async () => {
    const { semanticOnly, ftsOnly } = seedTieFixture();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'source-confidence' });
    expect(results.map((r) => r.id)).toEqual([semanticOnly, ftsOnly]);
  });

  test('source-confidence 不污染非精确平局：分数不同时仍按分数排', async () => {
    // hybrid 命中分数严格更高，两种 tie-break 下都必须第一。
    const hybrid = seed({ title: 'alpha both', stoppedAt: '2026-06-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    seed({ title: 'alpha other', stoppedAt: '2026-07-09T00:00:00Z' });
    for (const tieBreak of ['recency', 'source-confidence'] as const) {
      const results = await search('alpha', { semanticDiscovery: true, tieBreak });
      expect(results[0]!.id).toBe(hybrid);
      expect(results[0]!.match_source).toBe('hybrid');
    }
  });

  test('semantic-rank（生产默认）：跨腿平局上与 source-confidence 同解', async () => {
    const { semanticOnly, ftsOnly } = seedTieFixture();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'semantic-rank' });
    expect(results.map((r) => r.id)).toEqual([semanticOnly, ftsOnly]);
  });

  /**
   * 阶段 2D 的**主**平局形状：同源、两腿名次互换的 hybrid。
   *
   * A 词面第 1、语义第 2；B 词面第 2、语义第 1。等权下两者得分都是
   * `1/(60+1) + 1/(60+2)`，精确相等——而两条都是 `hybrid`，所以按 match_source 分档的
   * `source-confidence` **看不见它们的差别**，会一路落到 recency。
   *
   * 这不是构造出来的极端情况：gold 语料 145 行里由精确平局决定的 4 行中，q03 与 q14
   * 正是这个形状，各让期望目标丢掉了第 1 位（`benchmark/reports/phase2d-selection.md`）。
   */
  async function seedTransposedHybridTie(): Promise<{ semFirst: number; ftsFirst: number }> {
    // 短标题在 bm25 下更靠前，长标题靠后；语义名次由向量第一维决定，刻意与词面相反。
    const ftsFirst = seed({
      title: 'alpha', stoppedAt: '2026-07-09T00:00:00Z', embedding: [0.8, 0, 0, 0],
    });
    const semFirst = seed({
      title: 'alpha beta gamma delta epsilon', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.9, 0, 0, 0],
    });
    // fixture 的前提必须被断言，不能假设：如果 bm25 或 floor 的行为变了，这个用例应该
    // 在前提上失败，而不是在结论上给出一个看似有意义的错误结论。
    let ranks: { fts: ReadonlyMap<number, number>; sem: ReadonlyMap<number, number> } | null = null;
    await hybridSearchObservations(
      db,
      'alpha',
      { scopeKey: SCOPE },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true },
        onCandidates: (info) => { ranks = { fts: info.ftsRank, sem: info.semanticRank }; },
      },
    );
    const r = ranks as { fts: ReadonlyMap<number, number>; sem: ReadonlyMap<number, number> } | null;
    expect(r).not.toBeNull();
    expect(r!.fts.get(ftsFirst)).toBe(1);
    expect(r!.fts.get(semFirst)).toBe(2);
    expect(r!.sem.get(semFirst)).toBe(1);
    expect(r!.sem.get(ftsFirst)).toBe(2);
    return { semFirst, ftsFirst };
  }

  test('同源 hybrid 平局：recency 把更新的那条排前面', async () => {
    const { semFirst, ftsFirst } = await seedTransposedHybridTie();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'recency' });
    expect(results.map((r) => r.id)).toEqual([ftsFirst, semFirst]);
  });

  test('同源 hybrid 平局：source-confidence 分辨不出，结果与 recency 相同', async () => {
    // 这是 §9.1 登记的 tie-break 触及不到主导平局形状的可执行证据。
    const { semFirst, ftsFirst } = await seedTransposedHybridTie();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'source-confidence' });
    expect(results.map((r) => r.id)).toEqual([ftsFirst, semFirst]);
  });

  test('同源 hybrid 平局：semantic-rank 让语义第 1 的那条胜出', async () => {
    const { semFirst, ftsFirst } = await seedTransposedHybridTie();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'semantic-rank' });
    expect(results.map((r) => r.id)).toEqual([semFirst, ftsFirst]);
  });

  test('semantic-rank 不污染非精确平局：任何分数严格不同的候选对，三种策略下次序一致', async () => {
    // 混合 fixture：hybrid、fts-only、semantic-only 都有，并且**刻意含一对精确平局**。
    // 等权下"fts-only 第 r 名"与"semantic-only 第 r 名"必然同分，所以一个完全不含平局
    // 的小 fixture 本身就是不真实的构造。断言因此只针对分数严格不同的候选对——那正是
    // "tie-break 不得越界"这句话的精确含义。
    const ids = [
      seed({ title: 'alpha', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] }),
      seed({ title: 'alpha beta', stoppedAt: '2026-07-02T00:00:00Z', embedding: [0.9, 0, 0, 0] }),
      seed({ title: 'alpha beta gamma delta', stoppedAt: '2026-07-03T00:00:00Z' }),
      seed({ title: 'zeta one', stoppedAt: '2026-07-04T00:00:00Z', embedding: [0.8, 0, 0, 0] }),
      seed({ title: 'zeta two', stoppedAt: '2026-07-05T00:00:00Z', embedding: [0.7, 0, 0, 0] }),
    ];

    const order = new Map<string, number[]>();
    let score: Map<number, number> | null = null;
    for (const tieBreak of ['recency', 'source-confidence', 'semantic-rank'] as const) {
      let captured: { ftsRank: ReadonlyMap<number, number>; semanticRank: ReadonlyMap<number, number> } | null = null;
      const results = await hybridSearchObservations(
        db,
        'alpha',
        { scopeKey: SCOPE, semanticQueryEn: 'alpha', limit: 20 },
        {
          ...TEST_VECTOR_SPACE,
          generateEmbedding: queryVec,
          policy: { semanticDiscovery: true, semanticOnlyLimit: Number.POSITIVE_INFINITY, tieBreak },
          onCandidates: (info) => { captured = info; },
        },
      );
      order.set(tieBreak, results.map((r) => r.id));
      // 分数按内核里同样的公式与同样的累加顺序算，避免浮点比较错位。
      const c = captured as unknown as { ftsRank: ReadonlyMap<number, number>; semanticRank: ReadonlyMap<number, number> };
      const s = new Map<number, number>();
      for (const id of ids) {
        let v = 0;
        const f = c.ftsRank.get(id);
        const m = c.semanticRank.get(id);
        if (f !== undefined) v += 1 / (60 + f);
        if (m !== undefined) v += 1 / (60 + m);
        s.set(id, v);
      }
      score ??= s;
    }

    // fixture 前提：五条候选全部进了结果页，且其中确实存在一对精确平局。
    for (const list of order.values()) expect(list.length).toBe(ids.length);
    const values = ids.map((id) => score!.get(id)!);
    expect(new Set(values).size).toBeLessThan(values.length);

    let comparedPairs = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (score!.get(a) === score!.get(b)) continue;
        comparedPairs++;
        const rel = [...order.values()].map((list) => Math.sign(list.indexOf(a) - list.indexOf(b)));
        expect(new Set(rel).size).toBe(1);
      }
    }
    // 没有可比对时"全部通过"是假通过。
    expect(comparedPairs).toBeGreaterThanOrEqual(8);
  });

  test('semantic-rank 平局里没有语义名次的排在后面', async () => {
    // fts-only 没有语义名次，语义名次视为 +∞，所以它在平局里永远靠后——
    // 这正是跨腿平局那条用例的机制，这里把"没有名次"这个边界单独钉住。
    const { semanticOnly, ftsOnly } = seedTieFixture();
    const results = await search('alpha', { semanticDiscovery: true, tieBreak: 'semantic-rank' });
    expect(results[0]!.id).toBe(semanticOnly);
    expect(results[0]!.match_source).toBe('semantic');
    expect(results[1]!.id).toBe(ftsOnly);
    expect(results[1]!.match_source).toBe('fts');
  });

  /**
   * 跨**腿数**精确平局：一条 hybrid 与一条单腿候选得分完全相等（Gate D P1-2）。
   *
   * 2D 第一版声称这不可能，理由是 `1/(K+r)` 取不到 `1/(K+f) + 1/(K+s)`。这是错的：
   *
   * ```text
   * rrfK=60:  1/93 + 1/186 === 1/62      （hybrid fts=33 sem=126 撞单腿 rank=2）
   * ```
   *
   * float64 下精确相等，且在候选范围内（`ftsRank ≤ 50` 是 FTS 内部 limit，
   * `semRank ≤ 250` 是候选池上界）**共有 17 组解**。所以按语义名次优先会把这些平局判给
   * semantic-only，与方案登记的 `source-confidence` 结论相反——那是一条未经校准的新边界。
   * 修正后的 `semantic-rank` 把分档放在语义名次之前，于是在这个形状上与
   * `source-confidence` 逐条同解。
   *
   * 用 `rrfK=1` 建 fixture 的理由：同一套算术在 K=1 下的最小解是 `1/4 + 1/4 === 1/2`
   * （hybrid fts=3 sem=3 撞单腿 rank=1），只要 3 条词面候选 + 3 条语义候选，而 K=60 的实例
   * 需要 126 条语义候选。被检验的性质（平局上的分档顺序）与 K 无关；K=60 的可达性由上面
   * 那行算术单独断言。
   */
  test('K=60 下跨腿数精确平局确实可达：1/93 + 1/186 === 1/62', () => {
    expect(1 / (60 + 33) + 1 / (60 + 126)).toBe(1 / (60 + 2));
    // 不是孤例：候选范围内穷举出的解不止一组。
    const solutions: string[] = [];
    for (let f = 1; f <= 50; f++) {
      for (let s = 1; s <= 250; s++) {
        const v = 1 / (60 + f) + 1 / (60 + s);
        for (let r = 1; r <= 250; r++) if (v === 1 / (60 + r)) solutions.push(`${f}/${s}=${r}`);
      }
    }
    expect(solutions.length).toBeGreaterThanOrEqual(17);
  });

  test('跨腿数精确平局：semantic-rank 与 source-confidence 同解（hybrid 优先）', async () => {
    // K=1 下：hybrid(fts=3, sem=3) = 1/4 + 1/4 = 0.5；fts-only(fts=1) = 1/2 = 0.5；
    // semantic-only(sem=1) = 1/2 = 0.5。三条精确相等，且腿数不同。
    const ftsFirst = seed({ title: 'alpha', stoppedAt: '2026-07-09T00:00:00Z' });
    seed({ title: 'alpha beta', stoppedAt: '2026-07-08T00:00:00Z' });
    const hybrid = seed({
      title: 'alpha beta gamma delta', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.7, 0, 0, 0],
    });
    const semFirst = seed({ title: 'zeta one', stoppedAt: '2026-07-07T00:00:00Z', embedding: [0.9, 0, 0, 0] });
    seed({ title: 'zeta two', stoppedAt: '2026-07-06T00:00:00Z', embedding: [0.8, 0, 0, 0] });

    const policy = { semanticDiscovery: true, rrfK: 1, semanticOnlyLimit: Number.POSITIVE_INFINITY };

    // fixture 前提：三条候选的融合分必须精确相等，否则这条用例测的不是平局。
    let fused: readonly { id: number; score: number }[] = [];
    await hybridSearchObservations(
      db,
      'alpha',
      { scopeKey: SCOPE, semanticQueryEn: 'alpha', limit: 20 },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { ...policy, tieBreak: 'recency' },
        onFusion: (info) => { fused = info.ranked; },
      },
    );
    const scoreOf = (id: number) => fused.find((f) => f.id === id)!.score;
    expect(scoreOf(hybrid)).toBe(scoreOf(ftsFirst));
    expect(scoreOf(hybrid)).toBe(scoreOf(semFirst));

    // 方案登记的 profile：hybrid > semantic-only > fts-only。
    const sc = await search('alpha', { ...policy, tieBreak: 'source-confidence' }, 20);
    expect(sc.slice(0, 3).map((r) => r.id)).toEqual([hybrid, semFirst, ftsFirst]);

    // 修正后的候选必须给出同一答案——它是保守扩展，不是新策略。
    const sr = await search('alpha', { ...policy, tieBreak: 'semantic-rank' }, 20);
    expect(sr.map((r) => r.id)).toEqual(sc.map((r) => r.id));

    // 反向锁：如果哪天有人把分档去掉、只按语义名次排，这条会失败。
    expect(sr[0]!.match_source).toBe('hybrid');
  });
});

describe('fusion weights', () => {
  test('提高语义权重可以打破 1/(K+1) 平局，且不需要改 tie-break', async () => {
    const { semanticOnly, ftsOnly } = (() => {
      const s = seed({ title: 'beta target', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
      const f = seed({ title: 'alpha other', stoppedAt: '2026-07-09T00:00:00Z' });
      return { semanticOnly: s, ftsOnly: f };
    })();
    const equal = await search('alpha', { semanticDiscovery: true, tieBreak: 'recency' });
    expect(equal.map((r) => r.id)).toEqual([ftsOnly, semanticOnly]);
    const weighted = await search('alpha', {
      semanticDiscovery: true, tieBreak: 'recency', semanticWeight: 1.1,
    });
    expect(weighted.map((r) => r.id)).toEqual([semanticOnly, ftsOnly]);
  });

  test('rrfK 参与打分：改 K 改变单路命中之间的相对差距', async () => {
    // 两条纯语义候选，语义名次 1 与 2。K 越小，名次差距的权重越大。
    seed({ title: 'beta one', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.9, 0, 0, 0] });
    seed({ title: 'beta two', stoppedAt: '2026-07-02T00:00:00Z', embedding: [0.8, 0, 0, 0] });
    const seen: number[] = [];
    for (const rrfK of [30, 60, 90]) {
      const results = await hybridSearchObservations(
        db,
        'zzzznomatch',
        { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
        {
          ...TEST_VECTOR_SPACE,
          generateEmbedding: queryVec,
          policy: { semanticDiscovery: true, rrfK },
        },
      );
      seen.push(results.length);
      // 名次顺序与 K 无关（单调变换），这正是 RRF 的性质；K 只影响与另一路的可比性。
      expect(results.map((r) => r.match_source)).toEqual(['semantic', 'semantic']);
    }
    expect(seen).toEqual([2, 2, 2]);
  });
});

describe('semanticDiscovery 的协议边界（Gate A 整改）', () => {
  /**
   * discovery 只在 `semantic-en-v1` 空间里成立。
   *
   * 为什么这是不变量而不是 knob：`raw-v1` 没有能把信号与噪声分开的 floor（正例
   * 0.080…0.607 与噪声最坏 0.431 重叠），而 2B 只校准英文空间那一个 floor。把英文
   * 空间选出来的 floor 套到 raw 腿上，等于用一个没有依据的数字放开独立召回。
   *
   * 中文原文不含拉丁 token / 数字，避免 `missingTokens` 这条与本测试无关的护栏。
   */
  const ZH_QUERY = '这条中文问句故意不含任何词面重叠';
  const LEGAL_EN = 'this Chinese question deliberately shares no lexical overlap';

  function seedSemanticTarget(): number {
    return seed({ title: 'beta thing', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
  }

  /** 三组的共同跑法：只变 `semanticQueryEn`，policy 恒为 discovery=on。 */
  async function run(semanticQueryEn: string | undefined, query = ZH_QUERY) {
    let embedCalls = 0;
    const seen: {
      protocol: string;
      rejected: string | null;
      requested: boolean;
      effective: boolean;
    }[] = [];
    const results = await hybridSearchObservations(
      db,
      query,
      { scopeKey: SCOPE, ...(semanticQueryEn === undefined ? {} : { semanticQueryEn }) },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: async () => { embedCalls++; return new Float32Array([1, 0, 0, 0]); },
        policy: { semanticDiscovery: true },
        onCandidates: (i) => seen.push({
          protocol: i.protocol,
          rejected: i.semanticQueryRejected,
          requested: i.discoveryRequested,
          effective: i.discoveryEffective,
        }),
      },
    );
    return { results, embedCalls, info: seen[0]! };
  }

  test('valid：合法英文形式 → semantic-en-v1，discovery 生效，可独立召回', async () => {
    const target = seedSemanticTarget();
    const { results, embedCalls, info } = await run(LEGAL_EN);
    expect(info.protocol).toBe('semantic-en-v1');
    expect(info.rejected).toBeNull();
    expect(info.requested).toBe(true);
    expect(info.effective).toBe(true);
    expect(embedCalls).toBe(1);
    expect(results.map((r) => r.id)).toEqual([target]);
    expect(results[0]!.match_source).toBe('semantic');
  });

  test('missing：未传英文形式 → raw-v1，discovery 不生效，返回空且不算 embedding', async () => {
    seedSemanticTarget();
    const { results, embedCalls, info } = await run(undefined);
    expect(info.protocol).toBe('raw-v1');
    expect(info.rejected).toBeNull();
    // 请求了但没生效——这个差值就是这两个字段分开报的理由。
    expect(info.requested).toBe(true);
    expect(info.effective).toBe(false);
    expect(results).toEqual([]);
    expect(embedCalls).toBe(0);
  });

  test('rejected：英文形式被护栏拒 → raw-v1，discovery 不生效，返回空', async () => {
    seedSemanticTarget();
    // `...` 是护栏 `placeholder` 分支的实测来源（阶段 1a q16），也是本轮 ACP 真的
    // 返回过的那个值（见 phase2-calibration-set.md §6.3）。
    const { results, embedCalls, info } = await run('...');
    expect(info.protocol).toBe('raw-v1');
    expect(info.rejected).toBe('placeholder');
    expect(info.requested).toBe(true);
    expect(info.effective).toBe(false);
    expect(results).toEqual([]);
    expect(embedCalls).toBe(0);
  });

  test('rejected：中文回显被拒（untranslated）同样不开门', async () => {
    seedSemanticTarget();
    const { results, info } = await run(ZH_QUERY);
    expect(info.protocol).toBe('raw-v1');
    expect(info.rejected).toBe('untranslated');
    expect(info.effective).toBe(false);
    expect(results).toEqual([]);
  });

  test('discovery=off（回滚 profile）+ 合法英文形式：仍然不开门（requested 为假）', async () => {
    seedSemanticTarget();
    const seen: { requested: boolean; effective: boolean; protocol: string }[] = [];
    const results = await hybridSearchObservations(
      db,
      ZH_QUERY,
      { scopeKey: SCOPE, semanticQueryEn: LEGAL_EN },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: false },
        onCandidates: (i) => seen.push({
          requested: i.discoveryRequested,
          effective: i.discoveryEffective,
          protocol: i.protocol,
        }),
      },
    );
    expect(seen[0]).toEqual({ requested: false, effective: false, protocol: 'semantic-en-v1' });
    expect(results).toEqual([]);
  });

  describe('FTS 有候选时行为中立（Phase 1b 的 raw 重排必须一个字不变）', () => {
    /**
     * 协议边界**只**作用于 `ftsCount === 0`。FTS 有命中时语义腿照旧在它所处的空间里
     * 重排，包括 `raw-v1`——那是 Phase 1b 行为，不能因为加了边界而改变。
     */
    function seedAnchored(): { hybrid: number; semanticOnly: number } {
      const hybrid = seed({ title: 'alpha anchor', stoppedAt: '2026-07-01T00:00:00Z', embedding: [0.99, 0, 0, 0] });
      const semanticOnly = seed({ title: 'beta extra', stoppedAt: '2026-07-02T00:00:00Z', embedding: [0.98, 0, 0, 0] });
      return { hybrid, semanticOnly };
    }

    test.each([
      ['missing', undefined],
      ['rejected(placeholder)', '...'],
    ])('raw-v1（%s）在 FTS 有命中时仍然重排并可补入 semantic-only', async (_label, en) => {
      const { hybrid, semanticOnly } = seedAnchored();
      const seen: { protocol: string; effective: boolean }[] = [];
      const results = await hybridSearchObservations(
        db,
        'alpha',
        { scopeKey: SCOPE, ...(en === undefined ? {} : { semanticQueryEn: en }) },
        {
          ...TEST_VECTOR_SPACE,
          generateEmbedding: queryVec,
          policy: { semanticDiscovery: true },
          onCandidates: (i) => seen.push({ protocol: i.protocol, effective: i.discoveryEffective }),
        },
      );
      expect(seen[0]!.protocol).toBe('raw-v1');
      // discovery 不生效，但这与"语义腿是否参与重排"无关。
      expect(seen[0]!.effective).toBe(false);
      const ids = results.map((r) => r.id);
      expect(ids).toContain(hybrid);
      expect(ids).toContain(semanticOnly);
      expect(results.find((r) => r.id === hybrid)!.match_source).toBe('hybrid');
      expect(results.find((r) => r.id === semanticOnly)!.match_source).toBe('semantic');
    });

    test('discovery=on/off 在 FTS 有命中时结果逐条相同', async () => {
      seedAnchored();
      const off = await hybridSearchObservations(
        db, 'alpha', { scopeKey: SCOPE },
        { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec, policy: { semanticDiscovery: false } },
      );
      const on = await hybridSearchObservations(
        db, 'alpha', { scopeKey: SCOPE },
        { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec, policy: { semanticDiscovery: true } },
      );
      expect(on.map((r) => r.id)).toEqual(off.map((r) => r.id));
      expect(on.map((r) => r.match_source)).toEqual(off.map((r) => r.match_source));
    });
  });
});

describe('validateRetrievalPolicy（Gate A 整改）', () => {
  const P = (over: Partial<RetrievalPolicy>): RetrievalPolicy => ({ ...DEFAULT_RETRIEVAL_POLICY, ...over });

  test('默认策略合法', () => {
    expect(validateRetrievalPolicy(DEFAULT_RETRIEVAL_POLICY)).toEqual([]);
  });

  test.each([
    ['semanticFloor 上界外', { semanticFloor: 1.01 }],
    ['semanticFloor 下界外', { semanticFloor: -1.01 }],
    ['semanticFloor NaN', { semanticFloor: Number.NaN }],
    ['semanticFloor Infinity', { semanticFloor: Number.POSITIVE_INFINITY }],
    ['semanticOnlyLimit 负数', { semanticOnlyLimit: -1 }],
    ['semanticOnlyLimit 小数', { semanticOnlyLimit: 2.5 }],
    ['semanticOnlyLimit NaN', { semanticOnlyLimit: Number.NaN }],
    ['semanticOnlyLimit -Infinity', { semanticOnlyLimit: Number.NEGATIVE_INFINITY }],
    ['rrfK 为 0', { rrfK: 0 }],
    ['rrfK 负数', { rrfK: -60 }],
    ['rrfK 小数', { rrfK: 60.5 }],
    ['rrfK NaN', { rrfK: Number.NaN }],
    ['rrfK Infinity', { rrfK: Number.POSITIVE_INFINITY }],
    ['ftsWeight 为 0', { ftsWeight: 0 }],
    ['ftsWeight 负数', { ftsWeight: -1 }],
    ['ftsWeight NaN', { ftsWeight: Number.NaN }],
    ['ftsWeight Infinity', { ftsWeight: Number.POSITIVE_INFINITY }],
    ['semanticWeight 为 0', { semanticWeight: 0 }],
    ['semanticWeight 负数', { semanticWeight: -0.5 }],
    ['semanticWeight NaN', { semanticWeight: Number.NaN }],
    ['tieBreak 非法', { tieBreak: 'newest' as never }],
    ['semanticDiscovery 非布尔', { semanticDiscovery: 'on' as never }],
    // 阶段 3B：池为 0 会静默清空语义腿，而 FTS 并集仍在出结果——那份报告会把
    // 「池的效应」写成「floor 或 cap 的效应」。小数更坏：SQLite 会强转，实际生效的池
    // 与报告里写的池不一致，任何地方都不报错。
    ['semanticCandidatePool 为 0', { semanticCandidatePool: 0 }],
    ['semanticCandidatePool 负数', { semanticCandidatePool: -200 }],
    ['semanticCandidatePool 小数', { semanticCandidatePool: 200.5 }],
    ['semanticCandidatePool NaN', { semanticCandidatePool: Number.NaN }],
    ['semanticCandidatePool -Infinity', { semanticCandidatePool: Number.NEGATIVE_INFINITY }],
  ])('拒绝：%s', (_label, over) => {
    const errors = validateRetrievalPolicy(P(over as Partial<RetrievalPolicy>));
    expect(errors.length).toBeGreaterThan(0);
  });

  test.each([
    ['floor 恰好 1', { semanticFloor: 1 }],
    ['floor 恰好 -1', { semanticFloor: -1 }],
    ['floor 为 0', { semanticFloor: 0 }],
    ['cap 为 0（等于关掉 semantic-only）', { semanticOnlyLimit: 0 }],
    ['cap 为 Infinity（无上限）', { semanticOnlyLimit: Number.POSITIVE_INFINITY }],
    ['rrfK 为 1', { rrfK: 1 }],
    ['权重为小数', { ftsWeight: 0.5, semanticWeight: 1.25 }],
    ['tieBreak=source-confidence', { tieBreak: 'source-confidence' as const }],
    ['tieBreak=recency（阶段 1b / 回滚 profile 的取值）', { tieBreak: 'recency' as const }],
    ['tieBreak=semantic-rank（阶段 2D 选中值）', { tieBreak: 'semantic-rank' as const }],
    ['池为 1（最小合法值）', { semanticCandidatePool: 1 }],
    ['池为 Infinity（全 scope brute-force，阶段 3B 的 pool-full arm）', { semanticCandidatePool: Number.POSITIVE_INFINITY }],
  ])('接受边界值：%s', (_label, over) => {
    expect(validateRetrievalPolicy(P(over))).toEqual([]);
  });

  test('多处非法时逐项报出，不在第一处停下', () => {
    const errors = validateRetrievalPolicy(P({ semanticFloor: 2, rrfK: 0, semanticWeight: -1 }));
    expect(errors).toHaveLength(3);
    expect(errors.join(' ')).toContain('semanticFloor');
    expect(errors.join(' ')).toContain('rrfK');
    expect(errors.join(' ')).toContain('semanticWeight');
  });
});

describe('semanticCandidatePool：按日期截断候选池（阶段 3B 量具）', () => {
  const recent = (minutesAgo: number) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();

  /**
   * 造一个「目标在池外」的最小 fixture。
   *
   * 目标是**最老**的一条，且 cosine 最高（0.9）。填充比它新，cosine 刚好过 floor
   * （0.2 > 0.197）。所以：
   *   - 池装得下目标时，它必须排第 1；
   *   - 池装不下时，它连打分都轮不到 —— 不是排在后面，是不存在。
   *
   * query 用一个词面上谁都不命中的词，保证 FTS 并集不会把目标从另一条路带进来
   * （候选池是并集，不是过滤器；忘了这点会让这个测试永远通过）。
   */
  const seedPoolFixture = (fillerCount: number): number => {
    const target = seed({
      title: 'target record about quoting',
      stoppedAt: recent(fillerCount + 10),
      embedding: [0.9, 0.1, 0, 0],
    });
    for (let i = 0; i < fillerCount; i++) {
      seed({
        title: `filler ${i}`,
        stoppedAt: recent(fillerCount - i),
        embedding: [0.2, 0.9, 0, 0],
      });
    }
    return target;
  };

  test('池小于语料时，池外的目标拿不到语义名次——不是排在后面，是没被打分', async () => {
    const target = seedPoolFixture(5);
    let semanticIds: number[] = [];
    await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, semanticCandidatePool: 3 },
        onCandidates: (i) => { semanticIds = [...i.semanticRank.keys()]; },
      },
    );
    // 池 = 最近 3 条 filler；目标是最老的一条，不在其中。
    expect(semanticIds).not.toContain(target);
    expect(semanticIds).toHaveLength(3);
  });

  test('池放大到覆盖全 scope 时，同一个目标以最高 cosine 排第 1', async () => {
    const target = seedPoolFixture(5);
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, semanticCandidatePool: Number.POSITIVE_INFINITY },
      },
    );
    expect(results[0]!.id).toBe(target);
    expect(results[0]!.match_source).toBe('semantic');
  });

  test('Infinity 不被当成数字绑进 SQL：全 scope 的每条记录都进池', async () => {
    // `LIMIT Infinity` 在 SQLite 里不会报错，它会强转——于是实际生效的池大小由驱动
    // 决定，而报告里写的是 inf。这条断言钉住「无上限」真的是无上限。
    seedPoolFixture(11);
    let comparable = 0;
    await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, semanticCandidatePool: Number.POSITIVE_INFINITY },
        onCandidates: (i) => { comparable = i.comparableVectors; },
      },
    );
    expect(comparable).toBe(12); // 1 目标 + 11 填充
  });

  test('池仍受 scope 硬过滤约束：放大池不会带进别的 workspace', async () => {
    seedPoolFixture(3);
    // 另一个 scope 里放一条 cosine 完美的记录。
    const otherCwd = '/other';
    db.upsertSessionRef({ session_id: 's-other', cwd: otherCwd, repo: otherCwd });
    const seq = db.allocateNextTurnSeq('s-other');
    const t = db.createTurn({ session_id: 's-other', seq, cwd: otherCwd, repo: otherCwd, prompt_text: 'x' });
    db.markTurnClosed(t.id);
    const foreign = db.insertObservation({
      turn_id: t.id, session_id: 's-other', turn_seq: seq, repo: otherCwd, cwd_scope: otherCwd,
      title: 'foreign perfect match', summary: 'foreign perfect match',
      memory_type: 'change', quality: 'normal',
      turn_started_at: recent(1), turn_stopped_at: recent(1),
    })!;
    db.upsertObservationEmbedding(foreign, 'test', 4, embeddingToBlob(new Float32Array([1, 0, 0, 0])));

    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticDiscovery: true, semanticCandidatePool: Number.POSITIVE_INFINITY },
      },
    );
    expect(results.map((r) => r.id)).not.toContain(foreign);
  });

  test('默认值 200 与显式传 200 逐条相同（量具行为中立）', async () => {
    seedPoolFixture(5);
    const implicit = await discoverySearch('zzzznomatch');
    const explicit = await discoverySearch('zzzznomatch', { semanticCandidatePool: 200 });
    expect(implicit.map((r) => r.id)).toEqual(explicit.map((r) => r.id));
  });
});

describe('discovery 路径的降级、limit 与硬过滤（方案 §7.7）', () => {
  const recent = () => new Date(Date.now() - 60_000).toISOString();
  const old = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

  test('zero FTS + embedder 超时：等到 deadline 后返回空并记录 degrade', async () => {
    seed({ title: 'beta thing', stoppedAt: recent(), embedding: [1, 0, 0, 0] });
    let degraded = 0;
    const t0 = performance.now();
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        // 永不 resolve：拆门后这条路径第一次变得可达（门在时它压根跑不到 embedding）。
        generateEmbedding: () => new Promise<Float32Array>(() => {}),
        embeddingTimeoutMs: 60,
        policy: { semanticDiscovery: true },
        onDegrade: () => { degraded++; },
      },
    );
    const elapsed = performance.now() - t0;
    expect(results).toEqual([]);
    expect(degraded).toBe(1);
    // 真的等到了 deadline 才放弃，而不是立刻返回；也没有把整个搜索挂死。
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(2000);
  });

  test('zero FTS + embedder 抛错：返回空并记录 degrade', async () => {
    seed({ title: 'beta thing', stoppedAt: recent(), embedding: [1, 0, 0, 0] });
    let degraded = 0;
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch' },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: async () => { throw new Error('worker down'); },
        policy: { semanticDiscovery: true },
        onDegrade: () => { degraded++; },
      },
    );
    expect(results).toEqual([]);
    expect(degraded).toBe(1);
  });

  test.each([1, 5, 20])('limit=%i 时 semantic-only 结果数不超过 limit', async (limit) => {
    // 6 条纯语义候选，分数递减。
    for (let i = 0; i < 6; i++) {
      seed({ title: `beta ${i}`, stoppedAt: recent(), embedding: [0.9 - i * 0.05, 0, 0, 0] });
    }
    const results = await discoverySearch('zzzznomatch', { semanticOnlyLimit: 5 }, limit);
    expect(results.length).toBeLessThanOrEqual(limit);
    // cap=5 且候选 6 条：limit 更小则 limit 生效，limit 更大则 cap 生效。
    expect(results.length).toBe(Math.min(limit, 5));
    for (const r of results) expect(r.match_source).toBe('semantic');
  });

  test('type 过滤对纯语义候选生效', async () => {
    const bug = seed({ title: 'beta one', stoppedAt: recent(), embedding: [0.9, 0, 0, 0], type: 'bugfix' });
    seed({ title: 'beta two', stoppedAt: recent(), embedding: [0.95, 0, 0, 0], type: 'feature' });
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch', type: 'bugfix' },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec, policy: { semanticDiscovery: true } },
    );
    // 分数更高的 feature 条目必须被过滤掉，哪怕它 cosine 更高。
    expect(results.map((r) => r.id)).toEqual([bug]);
  });

  test('days 过滤对纯语义候选生效', async () => {
    const fresh = seed({ title: 'beta fresh', stoppedAt: recent(), embedding: [0.9, 0, 0, 0] });
    seed({ title: 'beta stale', stoppedAt: old(200), embedding: [0.99, 0, 0, 0] });
    const results = await hybridSearchObservations(
      db,
      'zzzznomatch',
      { scopeKey: SCOPE, semanticQueryEn: 'zzzznomatch', days: 90 },
      { ...TEST_VECTOR_SPACE, generateEmbedding: queryVec, policy: { semanticDiscovery: true } },
    );
    expect(results.map((r) => r.id)).toEqual([fresh]);
  });

  test('scope 过滤对纯语义候选生效：外部 scope 的完美 cosine 也不返回', async () => {
    // 另一个 workspace 里放一条 cosine 完美的记录。
    db.upsertSessionRef({ session_id: 's2', cwd: '/other', repo: '/other' });
    const seq = db.allocateNextTurnSeq('s2');
    const turn = db.createTurn({ session_id: 's2', seq, cwd: '/other', repo: '/other', prompt_text: 'foreign' });
    db.markTurnClosed(turn.id);
    const foreign = db.insertObservation({
      turn_id: turn.id, session_id: 's2', turn_seq: seq, repo: '/other', cwd_scope: '/other',
      title: 'beta foreign', summary: 'beta foreign', memory_type: 'change', quality: 'normal',
      turn_started_at: recent(), turn_stopped_at: recent(),
    })!;
    db.upsertObservationEmbedding(foreign, 'test', 4, embeddingToBlob(new Float32Array([1, 0, 0, 0])));

    const results = await discoverySearch('zzzznomatch');
    expect(results).toEqual([]);
  });
});

describe('policy 不泄漏给调用方', () => {
  test('onCandidates 报出实际生效的 policy', async () => {
    seed({ title: 'alpha work', stoppedAt: '2026-07-01T00:00:00Z', embedding: [1, 0, 0, 0] });
    const seen: RetrievalPolicy[] = [];
    await hybridSearchObservations(
      db,
      'alpha',
      { scopeKey: SCOPE },
      {
        ...TEST_VECTOR_SPACE,
        generateEmbedding: queryVec,
        policy: { semanticFloor: 0.31, semanticOnlyLimit: 2 },
        onCandidates: (i) => seen.push(i.policy),
      },
    );
    // 部分覆盖必须与默认值逐字段合并，不能整体替换后留下 undefined。
    expect(seen[0]).toEqual({
      ...DEFAULT_RETRIEVAL_POLICY,
      semanticFloor: 0.31,
      semanticOnlyLimit: 2,
    });
  });
});
