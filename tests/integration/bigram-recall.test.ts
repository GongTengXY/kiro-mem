/**
 * 阶段 3A：中文两字词辅助召回的结构性测试。
 *
 * 与 `retrieval-policy.test.ts` 同样不判断"检索质量好不好"——那是 benchmark 的事。
 * 这里钉住的是三件事：
 *
 *   1. **缺陷机制**：三字窗口对不齐导致的两字词不可达，以及 bigram 腿把它修好；
 *   2. **护栏**：`bigramOnlyLimit` 在融合之后生效并补位，`bigramDfRatioCeiling`
 *      按比例滤掉功能词；
 *   3. **中立性**：不含 CJK 的 query 一个辅助查询都不发，scope/type/days 对第三条腿
 *      与另两条完全一致。
 *
 * 第 2 条里 cap 的位置是最容易写错的一条，理由与 2A 那份文件里 semantic cap 相同：
 * 融合前截断会改变存活候选的名次，于是 cap 与融合权重耦合，矩阵 arm 无法归因。
 *
 * 第 3 条不是锦上添花。3A 的收益必须能指到具体两字词（方案 §10「不把该收益错误归到
 * semantic-en」），而它的代价必须证明只落在中文 query 上。
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey, extractCjkBigrams, extractFtsSearchUnits } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';
import {
  hybridSearchObservations,
  type RetrievalPolicy,
} from '../../src/server/observation-search';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

const SCOPE = computeScopeKey('/proj', '/proj');
const OTHER_SCOPE = computeScopeKey('/other', '/other');
const TEST_VECTOR_SPACE = { embeddingModel: 'test', embeddingDimensions: 4 };
/** query 向量恒为 [1,0,0,0]，于是 cosine == 记录向量的第一维。 */
const queryVec = async () => new Float32Array([1, 0, 0, 0]);
/** 语义腿不可用。用来把纯词面效果隔离出来。 */
const noEmbedder = async (): Promise<Float32Array> => { throw new Error('embedder down'); };

/**
 * 播种。字段比 `retrieval-policy.test.ts` 的 helper 多，因为 3A 的断言要落在
 * **具体某一列**上——「问题」落在 summary 中间和落在 learned 末尾，对索引是两回事。
 */
function seed(o: {
  title: string;
  summary?: string;
  learned?: string;
  concepts?: string[];
  stoppedAt?: string;
  embedding?: number[];
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  cwd?: string;
}): number {
  const cwd = o.cwd ?? '/proj';
  const session_id = cwd === '/proj' ? 's1' : 's2';
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo: cwd });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo: cwd, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const at = o.stoppedAt ?? '2026-08-01T00:00:00.000Z';
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo: cwd, cwd_scope: cwd,
    title: o.title, summary: o.summary ?? o.title,
    ...(o.learned === undefined ? {} : { learned: o.learned }),
    ...(o.concepts === undefined ? {} : { concepts: o.concepts }),
    memory_type: o.type ?? 'change', quality: 'normal',
    turn_started_at: at, turn_stopped_at: at,
  })!;
  if (o.embedding) {
    db.upsertObservationEmbedding(id, 'test', o.embedding.length, embeddingToBlob(new Float32Array(o.embedding)));
  }
  return id;
}

interface Observed {
  results: { id: number; source: string }[];
  ftsCount: number;
  bigramCount: number;
  bigramUnits: { probed: number; dropped: { bigram: string; df: number }[]; zeroDf: number; scopeSize: number };
  bigramOnlyDropped: number;
  bigramOnlyReturned: number;
  bigramVoteMode: string;
  bigramVotesSuppressed: number;
  ranked: readonly { id: number; matchSource: string; score: number; bigramRank: number | null }[];
}

/**
 * 从内核类型里取观测回调的载荷类型，而不是在这里手写一份。
 *
 * 手写一份会让「内核加了字段 / 改了名」的改动在测试里静默通过——而这两个回调正是
 * 3A 归因证据的唯一来源。
 */
type SearchDeps = NonNullable<Parameters<typeof hybridSearchObservations>[3]>;
type CandidatesInfo = Parameters<NonNullable<SearchDeps['onCandidates']>>[0];
type FusionInfo = Parameters<NonNullable<SearchDeps['onFusion']>>[0];

/** 走 bigram 腿的搜索。默认不给 embedder，把纯词面效果隔离出来。 */
async function run(
  query: string,
  policy?: Partial<RetrievalPolicy>,
  opts?: { limit?: number; type?: string; days?: number; embedder?: () => Promise<Float32Array>; semanticQueryEn?: string },
): Promise<Observed> {
  let cand: CandidatesInfo | undefined;
  let fus: FusionInfo | undefined;
  const results = await hybridSearchObservations(
    db,
    query,
    {
      scopeKey: SCOPE,
      ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
      ...(opts?.type === undefined ? {} : { type: opts.type }),
      ...(opts?.days === undefined ? {} : { days: opts.days }),
      ...(opts?.semanticQueryEn === undefined ? {} : { semanticQueryEn: opts.semanticQueryEn }),
    },
    {
      ...TEST_VECTOR_SPACE,
      generateEmbedding: opts?.embedder ?? noEmbedder,
      policy: { bigramAux: true, ...policy },
      onCandidates: (i) => { cand = i; },
      onFusion: (i) => { fus = i; },
    },
  );
  return {
    results: results.map((o) => ({ id: o.id, source: o.match_source })),
    ftsCount: cand?.ftsCount ?? 0,
    bigramCount: cand?.bigramCount ?? 0,
    bigramUnits: cand?.bigramUnits ?? { probed: 0, dropped: [], zeroDf: 0, scopeSize: 0 },
    bigramOnlyDropped: fus?.bigramOnlyDropped ?? 0,
    bigramOnlyReturned: fus?.bigramOnlyReturned ?? 0,
    bigramVoteMode: fus?.bigramVoteMode ?? '—',
    bigramVotesSuppressed: fus?.bigramVotesSuppressed ?? 0,
    ranked: fus?.ranked ?? [],
  };
}

// ===========================================================================
// extractCjkBigrams（纯函数）
// ===========================================================================

describe('extractCjkBigrams', () => {
  test('全滑窗，不做分词', () => {
    // 「号或」不是词。它必须被切出来——噪声由 DF 上限和结构 cap 控制，不由切得准
    // 控制。断言这一点是为了防止有人"顺手优化"成只留看起来像词的组合。
    expect(extractCjkBigrams('带引号或')).toEqual(['带引', '引号', '号或']);
  });

  test('无 CJK 的 query 一个都不切', () => {
    expect(extractCjkBigrams('fix FTS5 query escaping')).toEqual([]);
    expect(extractCjkBigrams('src/db/index.ts')).toEqual([]);
  });

  test('单字 CJK 不构成 bigram', () => {
    expect(extractCjkBigrams('修 a 改 b')).toEqual([]);
  });

  test('跨空白不拼接', () => {
    // 「号超」横跨两个 run，不得出现——它在索引里也不存在，因为 FTS5 逐列分词，
    // 而这里逐 run 切分是同一个道理。
    expect(extractCjkBigrams('引号 超时')).toEqual(['引号', '超时']);
  });

  test('去重', () => {
    expect(extractCjkBigrams('超时超时')).toEqual(['超时', '时超']);
  });

  test('预算内均匀取样，尾部必须可达', () => {
    // 20 字的 run 有 19 个窗口，预算 16。关键断言是**最后一个窗口在结果里**：
    // 从头消耗预算会把长句尾部那些真正有区分度的词丢掉，而中文提问恰恰把限定
    // 条件放在后面。
    const run = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸';
    const out = extractCjkBigrams(run);
    expect(out.length).toBeLessThanOrEqual(16);
    expect(out).toContain('一二');
    expect(out).toContain('壬癸');
  });
});

// ===========================================================================
// 机制：三字窗口对不齐 → bigram 腿修好（判据 §7.1）
// ===========================================================================

describe('机制 fixture：两字词在 trigram 下不可达', () => {
  test('q32 最小复现：两侧都有「引号」，三字窗口一个都对不上', () => {
    const target = seed({
      title: 'FTS5 查询按字面量处理',
      summary: '未闭合引号等普通文本被解析为查询语法而抛错',
      learned: '双引号翻倍是转义方式',
    });
    seed({ title: '安装脚本注册 launchd', summary: '完全无关的一条记录' });

    const query = '搜索词里带引号或括号会不会崩';

    // 先把缺陷本身钉住：两侧的三字单元集合没有交集。
    const queryUnits = extractFtsSearchUnits(query);
    expect(queryUnits).toContain('带引号');
    expect(queryUnits).toContain('引号或');
    expect(db.searchObservationsFts(query, { scopeKey: SCOPE, limit: 50 })).toEqual([]);

    // 再钉住 bigram 腿修好了它，且来源标记诚实。
    return run(query, { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2 }).then((r) => {
      expect(r.ftsCount).toBe(0);
      expect(r.results).toEqual([{ id: target, source: 'bigram' }]);
      // 13 个 bigram 里只有「引号」在语料中。这个数字是归因证据：收益指到了
      // 具体某个两字词，不是"FTS 整体变好了"。
      expect(r.bigramCount).toBe(1);
      expect(r.bigramUnits.zeroDf).toBe(12);
    });
  });

  test.each([
    ['超时', '向量算不出来会不会超时降级', 'embedding 请求超时后回退到关键词'],
    ['降级', '搜索什么时候会降级', 'search 降级成 FTS-only 的两个条件'],
    ['查询', '这个查询是怎么转义的', 'FTS5 查询表达式必须先字面量化'],
  ])('技术两字词「%s」：三字窗口错位仍可达', async (word, query, recordText) => {
    const target = seed({ title: `关于${word}的记录`, summary: recordText });
    seed({ title: '无关记录', summary: '安装脚本注册 launchd 与 systemd' });

    const r = await run(query, { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2 });
    expect(r.results.map((x) => x.id)).toContain(target);
    expect(r.bigramCount).toBeGreaterThan(0);
  });

  test('反向：两字词只在 query 里、记录里没有 → 不得凭空产出候选', async () => {
    seed({ title: '安装脚本注册 launchd', summary: '完全无关的一条记录' });
    const r = await run('引号转义怎么写', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2 });
    expect(r.bigramCount).toBe(0);
    expect(r.results).toEqual([]);
    // 全部 bigram 都不在语料里，这是 zeroDf 而不是"被上限滤掉"。两者混淆会让
    // 报告把"语料里没有"说成"被护栏拦下"。
    expect(r.bigramUnits.zeroDf).toBe(r.bigramUnits.probed);
    expect(r.bigramUnits.dropped).toEqual([]);
  });
});

// ===========================================================================
// 护栏：bigramOnlyLimit（判据 §7.2）
// ===========================================================================

describe('bigramOnlyLimit 在融合之后生效', () => {
  /** 四条只能被「超时」这个两字词找到的记录，外加一条 trigram 直接命中的。 */
  function seedCapFixture(): { bigramOnly: number[]; ftsHit: number } {
    // 记录里是「请求超时后」，query 里是「会超时吗」——三字窗口 请求超/求超时/超时后
    // vs 会超时/超时吗，对不上。
    const bigramOnly = [
      seed({ title: 'A', summary: '第一次请求超时后回退', stoppedAt: '2026-08-01T00:04:00.000Z' }),
      seed({ title: 'B', summary: '第二次请求超时后回退', stoppedAt: '2026-08-01T00:03:00.000Z' }),
      seed({ title: 'C', summary: '第三次请求超时后回退', stoppedAt: '2026-08-01T00:02:00.000Z' }),
      seed({ title: 'D', summary: '第四次请求超时后回退', stoppedAt: '2026-08-01T00:01:00.000Z' }),
    ];
    // 这条含 query 的完整三字单元，所以 trigram 腿直接命中它。
    const ftsHit = seed({ title: 'E', summary: '这里写着会超时吗三个字', stoppedAt: '2026-08-01T00:00:00.000Z' });
    return { bigramOnly, ftsHit };
  }

  test.each([[0, 0], [1, 1], [2, 2], [3, 3], [Number.POSITIVE_INFINITY, 4]])(
    'cap=%p → 恰好保留 %i 条 bigram-only',
    async (cap, expected) => {
      seedCapFixture();
      const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: cap }, { limit: 10 });
      const bigramResults = r.results.filter((x) => x.source === 'bigram');
      expect(bigramResults.length).toBe(expected);
      expect(r.bigramOnlyReturned).toBe(expected);
      expect(r.bigramOnlyDropped).toBe(4 - expected);
    },
  );

  test('被 cap 丢弃的候选不占 limit —— 后面的 fts 结果照样进页', async () => {
    const { ftsHit } = seedCapFixture();
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 1 }, { limit: 10 });
    // cap=1 丢掉 3 条 bigram-only，但 trigram 命中的那条**不能**因此被挤掉。
    expect(r.bigramOnlyDropped).toBe(3);
    expect(r.results.map((x) => x.id)).toContain(ftsHit);
    expect(r.results.filter((x) => x.source === 'bigram').length).toBe(1);
  });

  test('limit < cap 时按 limit 收口，不按 cap', async () => {
    seedCapFixture();
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 }, { limit: 2 });
    expect(r.results.length).toBe(2);
    // cap=3 但 limit=2：min(cap, limit) 生效，报出的 returned 不得超过 limit。
    expect(r.bigramOnlyReturned).toBeLessThanOrEqual(2);
  });

  test('两个 cap 各自独立计数，不共享预算', async () => {
    // 一条只能被 bigram 找到，一条只能被语义找到（cosine 高、无词面重叠）。
    const bigramOne = seed({ title: 'A', summary: '第一次请求超时后回退' });
    const semanticOne = seed({ title: 'zzz unrelated wording', embedding: [0.9, 0.1, 0, 0] });
    const r = await run(
      '会超时吗',
      { bigramDfRatioCeiling: 1, bigramOnlyLimit: 1, semanticOnlyLimit: 1, semanticFloor: 0.1 },
      { limit: 10, embedder: queryVec, semanticQueryEn: 'will it time out' },
    );
    const ids = r.results.map((x) => x.id);
    // 若两者共享一个预算，其中一条会被丢掉。它们衡量的是两种不同的未核实线索。
    expect(ids).toContain(bigramOne);
    expect(ids).toContain(semanticOne);
    expect(r.bigramOnlyDropped).toBe(0);
  });
});

// ===========================================================================
// 护栏：bigramDfRatioCeiling（判据 §7.2）
// ===========================================================================

describe('bigramDfRatioCeiling 按比例滤掉功能词', () => {
  test('高 DF 的两字词被滤掉，低 DF 的保留', async () => {
    // 「测试」占 4/5 = 80%，「引号」占 1/5 = 20%。
    for (const t of ['A', 'B', 'C', 'D']) seed({ title: t, summary: `${t} 单元测试都通过了` });
    const distinctive = seed({ title: 'E', summary: '未闭合引号等文本被解析为语法' });

    const r = await run('测试里带引号会怎样', { bigramDfRatioCeiling: 0.5, bigramOnlyLimit: 3 });
    expect(r.bigramUnits.scopeSize).toBe(5);
    expect(r.bigramUnits.dropped.map((d) => d.bigram)).toContain('测试');
    // 只有那条含「引号」的进了候选，四条含「测试」的没进。
    expect(r.results.map((x) => x.id)).toEqual([distinctive]);
  });

  test('比例上限把全部两字词滤光时，行为等同关闭', async () => {
    for (const t of ['A', 'B', 'C']) seed({ title: t, summary: `${t} 单元测试都通过了` });
    const tight = await run('单元测试怎么跑', { bigramDfRatioCeiling: 0.1, bigramOnlyLimit: 3 });
    const off = await run('单元测试怎么跑', { bigramAux: false });
    expect(tight.bigramCount).toBe(0);
    expect(tight.results).toEqual(off.results);
    // 但两者的可观测状态必须不同：一个是被护栏拦下，一个是根本没跑。
    expect(tight.bigramUnits.dropped.length).toBeGreaterThan(0);
    expect(off.bigramUnits.probed).toBe(0);
  });
});

// ===========================================================================
// 平局分档：bigram 是最弱的一档，且不改动 2D 已校准的前三档（判据 §7.2）
// ===========================================================================

describe('三腿平局', () => {
  test('bigram-only 与 fts-only 精确平局时 fts 优先，且不被 recency 反超', async () => {
    // 造纯 fts 腿命中要用 **Latin** 单元：任何含 query 中文三字窗口的记录，必然
    // 也含该窗口里的两字词，所以"中文 trigram 命中但 bigram 不命中"在结构上不可能。
    // 这一点本身就是 3A 的机制陈述——bigram 是 trigram 的真子集条件。
    const ftsOnly = seed({
      title: 'A', summary: 'FTS5 literal escaping only, no CJK here',
      stoppedAt: '2026-08-01T00:00:00.000Z',
    });
    const bigramOnly = seed({
      title: 'B', summary: '第一次请求超时后回退',
      stoppedAt: '2026-08-02T00:00:00.000Z', // 故意更新：分档没生效时 recency 会把它排前面
    });

    const r = await run('会超时吗 FTS5', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 });

    const pair = r.ranked.filter((x) => x.id === ftsOnly || x.id === bigramOnly) as unknown as
      { id: number; score: number; matchSource: string }[];
    expect(pair.length).toBe(2);
    // 先证明前提成立：这确实是精确平局，不是"接近"。两条都是单腿 rank 1 → 1/(60+1)。
    expect(pair[0]!.score).toBe(pair[1]!.score);
    expect(new Set(pair.map((p) => p.matchSource))).toEqual(new Set(['fts', 'bigram']));
    // 分档：fts(2) 优于 bigram(3)，且压过更新的时间戳。
    expect(r.results.map((x) => x.id)).toEqual([ftsOnly, bigramOnly]);
  });

  test('trigram + bigram 同时命中（无语义）→ fts，不是 hybrid', async () => {
    // 这是中文 query 的**常态**而非边角：命中三字窗口的记录必然含窗口里的两字词。
    // 若把 hybrid 定义成"腿数 > 1"，大部分中文 fts 结果会被改写成 hybrid，向调用方
    // 声称了并不存在的语义证据，还会被挪进平局的最高档。
    const both = seed({ title: 'A', summary: '这里写着会超时吗，也写着请求超时后回退' });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 });
    expect(r.results).toEqual([{ id: both, source: 'fts' }]);
    expect(r.bigramOnlyReturned).toBe(0);
  });

  test('bigram + 语义命中（无 trigram）→ hybrid', async () => {
    // hybrid 的契约是「词面与语义均支持」。bigram 是词面证据，所以这一条算 hybrid，
    // 而且它不再是未核实线索，不该占 bigramOnlyLimit 的额度。
    const target = seed({ title: 'A', summary: '第一次请求超时后回退', embedding: [0.9, 0.1, 0, 0] });
    const r = await run(
      '会超时吗',
      { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3, semanticFloor: 0.1 },
      { embedder: queryVec, semanticQueryEn: 'will it time out' },
    );
    expect(r.results).toEqual([{ id: target, source: 'hybrid' }]);
    expect(r.bigramOnlyReturned).toBe(0);
  });
});

// ===========================================================================
// 隔离与中立性（判据 §7.2 / §6.4）
// ===========================================================================

describe('第三条腿与另两条受同样的硬过滤', () => {
  test('跨 scope 的完美 bigram 命中必须不可见', async () => {
    seed({ title: 'foreign', summary: '第一次请求超时后回退', cwd: '/other' });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 });
    expect(r.results).toEqual([]);
    expect(r.bigramCount).toBe(0);
    // DF 比例的分母也必须是本 scope 的记录数，不能把外域记录算进去。
    expect(r.bigramUnits.scopeSize).toBe(0);
    // 反向确认 fixture 本身是有效的：换到那个 scope 就能找到。
    const cross = await hybridSearchObservations(
      db, '会超时吗', { scopeKey: OTHER_SCOPE },
      { ...TEST_VECTOR_SPACE, generateEmbedding: noEmbedder,
        policy: { bigramAux: true, bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 } },
    );
    expect(cross.length).toBe(1);
  });

  test('type 过滤对 bigram 候选生效', async () => {
    seed({ title: 'A', summary: '第一次请求超时后回退', type: 'bugfix' });
    const kept = seed({ title: 'B', summary: '第二次请求超时后回退', type: 'decision' });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 }, { type: 'decision' });
    expect(r.results.map((x) => x.id)).toEqual([kept]);
  });

  test('days 窗口对 bigram 候选生效', async () => {
    const old = new Date(Date.now() - 200 * 86400000).toISOString();
    seed({ title: 'A', summary: '第一次请求超时后回退', stoppedAt: old });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 }, { days: 90 });
    expect(r.results).toEqual([]);
    expect(r.bigramCount).toBe(0);
  });
});

describe('中立性：不含 CJK 的 query 不受影响', () => {
  test('纯英文 query 一个辅助查询都不发', async () => {
    seed({ title: 'fix FTS5 escaping', summary: 'quoted string literal doubling' });
    const on = await run('FTS5 escaping', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 3 });
    const off = await run('FTS5 escaping', { bigramAux: false });
    // probed=0 是性能不变量：英文 query 连一次扫描都不该触发。
    expect(on.bigramUnits.probed).toBe(0);
    expect(on.bigramUnits.scopeSize).toBe(0);
    expect(on.results).toEqual(off.results);
  });

  test('开关关闭时不发辅助查询', async () => {
    seed({ title: 'A', summary: '第一次请求超时后回退' });
    const off = await run('会超时吗', { bigramAux: false });
    expect(off.bigramUnits.probed).toBe(0);
    expect(off.bigramCount).toBe(0);
    expect(off.results).toEqual([]);
  });
});

// ===========================================================================
// 降级与边界（判据 §7.3）
// ===========================================================================

describe('降级与边界', () => {
  test('语义腿挂掉时 bigram 腿仍然工作', async () => {
    // 上面所有用例默认就是这个状态（noEmbedder），这里显式钉一次，
    // 因为它是 3A 的一个独立价值点：向量不可用时词面召回仍然改善了。
    const target = seed({ title: 'A', summary: '第一次请求超时后回退' });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2 }, { embedder: noEmbedder });
    expect(r.results).toEqual([{ id: target, source: 'bigram' }]);
  });

  test('bigram 命中充当词面锚点：无英文派生值时也不再直接返回空', async () => {
    // 没有 semanticQueryEn，所以 discovery 不生效；trigram 零命中。改动之前这里
    // 必然返回空。bigram 命中是**词面**证据，所以它有资格开这道门。
    const target = seed({ title: 'A', summary: '第一次请求超时后回退' });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2, semanticDiscovery: false });
    expect(r.results).toEqual([{ id: target, source: 'bigram' }]);
  });

  test('三腿全空时返回空，且能从观测上区分"没候选"与"被拦下"', async () => {
    seed({ title: 'unrelated', summary: '安装脚本注册 launchd' });
    const r = await run('引号转义怎么写', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2 });
    expect(r.results).toEqual([]);
    expect(r.ftsCount).toBe(0);
    expect(r.bigramCount).toBe(0);
    expect(r.bigramUnits.dropped).toEqual([]);
  });

  test('空库不炸', async () => {
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramOnlyLimit: 2 });
    expect(r.results).toEqual([]);
    expect(r.bigramUnits.scopeSize).toBe(0);
  });
});

// ===========================================================================
// bigramVote：投票范围（阶段 3A-R2，判据 §9.1 / §9.2）
// ===========================================================================

describe('bigramVote', () => {
  /** RRF 单项的值，用来断言"这一票到底有没有计进去"。 */
  const term = (rank: number, w = 1) => w / (60 + rank);

  test('discovery-only：被 trigram 找到的候选拿不到 bigram 票', async () => {
    // 这条记录 trigram 与 bigram 都命中（中文 query 下这是常态：命中三字窗口的记录
    // 必然含窗口里的两字词）。语义腿关掉，所以分数里只该有 FTS 一项。
    const both = seed({ title: 'A', summary: '这里写着会超时吗，也写着请求超时后回退' });

    const always = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'always' });
    const disc = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'discovery-only' });

    const a = always.ranked.find((x) => x.id === both) as unknown as { score: number };
    const d = disc.ranked.find((x) => x.id === both) as unknown as { score: number };
    // always：FTS 第 1 + bigram 第 1 两项。
    expect(a.score).toBeCloseTo(term(1) + term(1), 12);
    // discovery-only：只有 FTS 一项。
    expect(d.score).toBeCloseTo(term(1), 12);
    expect(disc.results).toEqual([{ id: both, source: 'fts' }]);
  });

  test('discovery-only：被语义腿找到的候选拿不到 bigram 票，且标记为 semantic', async () => {
    // 判据附录 A1 定下的那条：抑制是彻底的，所以这条记录变成 semantic-only，
    // 于是受 semanticOnlyLimit 约束。代价是登记过的、可测的。
    const target = seed({ title: 'A', summary: '第一次请求超时后回退', embedding: [0.9, 0.1, 0, 0] });

    const disc = await run(
      '会超时吗',
      { bigramDfRatioCeiling: 1, bigramVote: 'discovery-only', semanticFloor: 0.1 },
      { embedder: queryVec, semanticQueryEn: 'will it time out' },
    );
    const d = disc.ranked.find((x) => x.id === target) as unknown as { score: number };
    expect(d.score).toBeCloseTo(term(1), 12); // 只有语义一项
    expect(disc.results).toEqual([{ id: target, source: 'semantic' }]);

    // 对照：always 下它是 hybrid，两项都在。
    const always = await run(
      '会超时吗',
      { bigramDfRatioCeiling: 1, bigramVote: 'always', semanticFloor: 0.1 },
      { embedder: queryVec, semanticQueryEn: 'will it time out' },
    );
    const a = always.ranked.find((x) => x.id === target) as unknown as { score: number };
    expect(a.score).toBeCloseTo(term(1) + term(1), 12);
    expect(always.results).toEqual([{ id: target, source: 'hybrid' }]);
  });

  test('discovery-only：两条腿都没找到的候选仍然拿到 bigram 票', async () => {
    // 否则这个开关就等于把整条腿关掉了。
    const target = seed({ title: 'A', summary: '第一次请求超时后回退' });
    const r = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'discovery-only' });
    const x = r.ranked.find((y) => y.id === target) as unknown as { score: number };
    expect(x.score).toBeCloseTo(term(1), 12);
    expect(r.results).toEqual([{ id: target, source: 'bigram' }]);
  });

  test('两种模式在"只有 bigram 命中"的候选上完全一致', async () => {
    // 锁住开关只影响加票、不影响发现。
    seed({ title: 'A', summary: '第一次请求超时后回退' });
    seed({ title: 'B', summary: '第二次请求超时后回退' });
    const always = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'always', bigramOnlyLimit: 3 });
    const disc = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'discovery-only', bigramOnlyLimit: 3 });
    expect(disc.results).toEqual(always.results);
    expect(disc.bigramOnlyReturned).toBe(always.bigramOnlyReturned);
  });

  test('bigramVotesSuppressed 等于"bigram 命中且另有腿命中"的候选数', async () => {
    // 一条 trigram+bigram、一条只有 bigram：discovery-only 下只该抑制前者。
    seed({ title: 'A', summary: '这里写着会超时吗，也写着请求超时后回退' });
    seed({ title: 'B', summary: '第一次请求超时后回退' });

    const disc = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'discovery-only', bigramOnlyLimit: 3 });
    expect(disc.bigramVotesSuppressed).toBe(1);
    expect(disc.bigramVoteMode).toBe('discovery-only');

    // always 下恒为 0，是构造保证而不是巧合。
    const always = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramVote: 'always', bigramOnlyLimit: 3 });
    expect(always.bigramVotesSuppressed).toBe(0);
    expect(always.bigramVoteMode).toBe('always');
  });

  test('bigramWeight 线性生效：w=0.5 的 bigram 项恰好是 w=1 的一半', async () => {
    const target = seed({ title: 'A', summary: '第一次请求超时后回退' });
    const w1 = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramWeight: 1 });
    const wHalf = await run('会超时吗', { bigramDfRatioCeiling: 1, bigramWeight: 0.5 });
    const a = (w1.ranked.find((x) => x.id === target) as unknown as { score: number }).score;
    const b = (wHalf.ranked.find((x) => x.id === target) as unknown as { score: number }).score;
    expect(b).toBeCloseTo(a / 2, 12);
  });

  test('bigramWeight 在 discovery-only 下仍作用于纯发现候选', async () => {
    // 它决定这些候选排在哪；若被忽略，降权就无法用来控制发现候选的位置。
    const target = seed({ title: 'A', summary: '第一次请求超时后回退' });
    const r = await run('会超时吗', {
      bigramDfRatioCeiling: 1, bigramVote: 'discovery-only', bigramWeight: 0.25,
    });
    const x = r.ranked.find((y) => y.id === target) as unknown as { score: number };
    expect(x.score).toBeCloseTo(term(1, 0.25), 12);
  });

  test('高文档频率两字词命中已有语义候选时，discovery-only 不给它加票', async () => {
    // 判据 §11.3 第 15 条的反例：这正是 3A §5.2 的失败形状——一个噪声两字词把一条
    // 已有语义候选往前推。
    for (const t of ['A', 'B', 'C']) seed({ title: t, summary: `${t} 单元测试都通过了` });
    const semanticOne = seed({ title: 'D', summary: 'D 单元测试都通过了', embedding: [0.9, 0.1, 0, 0] });

    const opts = { limit: 10, embedder: queryVec, semanticQueryEn: 'how to run the unit tests' };
    const base = { bigramDfRatioCeiling: 1, semanticFloor: 0.1, bigramOnlyLimit: 3 };
    const always = await run('单元测试怎么跑', { ...base, bigramVote: 'always' }, opts);
    const disc = await run('单元测试怎么跑', { ...base, bigramVote: 'discovery-only' }, opts);

    const scoreOf = (r: Observed, id: number) =>
      (r.ranked.find((x) => x.id === id) as unknown as { score: number }).score;
    const bigramRankOf = (r: Observed, id: number) =>
      (r.ranked.find((x) => x.id === id) as unknown as { bigramRank: number | null }).bigramRank;

    // 不写死 bm25 名次（这条记录实际是 FTS 第 4）：断言两种模式的分差**恰好**等于
    // 那一项被抑制的 bigram 票。这样断言不依赖任何排序实现细节。
    const rank = bigramRankOf(always, semanticOne)!;
    expect(rank).toBeGreaterThan(0);
    expect(scoreOf(always, semanticOne) - scoreOf(disc, semanticOne)).toBeCloseTo(term(rank), 12);

    // bigramRank 即使没参与打分也必须如实上报（判据 §3.1 第 2 点）——否则
    // 「这条腿本来会投给谁」这个事实在报告里消失，无法验证开关生效。
    expect(bigramRankOf(disc, semanticOne)).toBe(rank);
    expect(disc.bigramVotesSuppressed).toBeGreaterThan(0);
  });
});
