/**
 * raw-v1 降级路径 = FTS-only（裁定第 2 步）。
 *
 * 判据：`benchmark/reports/raw-degrade-criteria.md`，A0 `fde489c146c7210e`，
 * 冻结于 `2026-08-07T06:19:31Z`，**先于任何实现改动**。
 *
 * 冻结的产品语义（判据 §2）：`semantic_query_en` 缺失或被护栏拒绝时，一律不生成 query
 * embedding、不读取或比较 raw 向量，只返回词面检索结果；该规则**不受 `semanticDiscovery`
 * 开关影响**。
 *
 * 为什么 `embedCalls` 必须单独断言、不能只看 `comparableVectors`：
 * `comparableVectors === 0` 也可能是"算了 embedding 但一条向量都没读到"，那不满足裁定第 1 条
 * 的"不生成 query embedding"。两者是不同的事实，必须分开钉住。
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { embeddingToBlob } from '../../src/embedding';
import {
  hybridSearchObservations,
  LEXICAL_ANCHOR_ROLLBACK_POLICY,
  type RetrievalPolicy,
} from '../../src/server/observation-search';

let db: MemoryDB;
beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

const CWD = '/proj';
const SCOPE = computeScopeKey(null, CWD);
const DIM = 4;
const SPACE = { embeddingModel: 'test', embeddingDimensions: DIM };

function seed(o: { title: string; daysAgo: number; first: number; type?: string }): number {
  const session_id = 's1';
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd: CWD, repo: null });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd: CWD, repo: null, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const at = new Date(Date.now() - o.daysAgo * 86400000).toISOString();
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo: null, cwd_scope: CWD,
    title: o.title, summary: o.title,
    memory_type: (o.type ?? 'change') as 'change', quality: 'normal',
    turn_started_at: at, turn_stopped_at: at,
  })!;
  db.upsertObservationEmbedding(id, 'test', DIM, embeddingToBlob(new Float32Array([o.first, 1, 0, 0])));
  return id;
}

/**
 * 判据 §5.1 G6 的装置，与调查报告 §2 完全同形：302 条记录，ghost 落在"最近 200 条"之外。
 *
 * ghost 的 cosine 0.30 是刻意选的：它落在 raw-v1 的重叠区间内（标注正例 0.080–0.607 与最坏
 * 噪声 0.431 重叠），同时高于为英文空间校准的 floor 0.197 与 Phase 1b 的 0.2。所以只要语义腿
 * 在 raw 空间里跑起来，它就会进页——它是"降级路径是否真的不打分"的探测物。
 */
function seedGhostFixture() {
  const ghost = seed({ title: 'completely different wording nothing shared', daysAgo: 900, first: 0.30 });
  for (let i = 0; i < 300; i++) {
    seed({ title: `filler record ${i} about unrelated matters`, daysAgo: 300 - i, first: 0.05 });
  }
  const anchor = seed({ title: 'zzanchor lexical hit record', daysAgo: 1, first: 0.05 });
  return { ghost, anchor };
}

interface RunResult {
  ids: number[];
  sources: string[];
  embedCalls: number;
  comparableVectors: number;
  semanticCount: number;
  aboveFloorCount: number;
  scopeVectors: number | null;
  protocol: string;
  rejected: string | null;
  degraded: boolean;
}

async function run(
  query: string,
  opts?: {
    en?: string;
    policy?: Partial<RetrievalPolicy>;
    type?: string;
    days?: number;
    limit?: number;
    embedder?: (text: string) => Promise<Float32Array>;
  },
): Promise<RunResult> {
  let embedCalls = 0;
  let info: Partial<RunResult> = {};
  let degraded = false;
  const embedder = opts?.embedder ?? (async () => new Float32Array([1, 0, 0, 0]));
  const res = await hybridSearchObservations(
    db,
    query,
    {
      scopeKey: SCOPE,
      limit: opts?.limit ?? 10,
      ...(opts?.en === undefined ? {} : { semanticQueryEn: opts.en }),
      ...(opts?.type === undefined ? {} : { type: opts.type }),
      ...(opts?.days === undefined ? {} : { days: opts.days }),
    },
    {
      ...SPACE,
      generateEmbedding: async (t) => { embedCalls++; return embedder(t); },
      ...(opts?.policy ? { policy: opts.policy } : {}),
      onDegrade: () => { degraded = true; },
      onCandidates: (i) => {
        info = {
          comparableVectors: i.comparableVectors,
          semanticCount: i.semanticCount,
          aboveFloorCount: i.aboveFloorCount,
          scopeVectors: i.scopeVectors,
          protocol: i.protocol,
          rejected: i.semanticQueryRejected,
        };
      },
    },
  );
  return {
    ids: res.map((r) => r.id),
    sources: res.map((r) => r.match_source),
    embedCalls,
    comparableVectors: info.comparableVectors ?? -1,
    semanticCount: info.semanticCount ?? -1,
    aboveFloorCount: info.aboveFloorCount ?? -1,
    scopeVectors: info.scopeVectors === undefined ? -1 : info.scopeVectors,
    protocol: info.protocol ?? '?',
    rejected: info.rejected ?? null,
    degraded,
  };
}

/**
 * 判据 §4 的 8 种降级情形，覆盖 `checkSemanticEnQuery` 的**全部** reason 枚举 + missing。
 *
 * 只测被裁定点名的四项（missing / placeholder / 中文回显 / protected-token 丢失）会让分支覆盖
 * 看起来完整而实际按 reason 分叉，所以另外三项一并纳入（判据 §4 已写明理由）。
 */
const DEGRADED_CASES: { label: string; query: string; en?: string; expectReason: string | null }[] = [
  { label: 'missing：完全不传', query: 'zzanchor 引号 转义', expectReason: null },
  { label: 'empty：传纯空白', query: 'zzanchor 引号 转义', en: '   ', expectReason: null },
  { label: 'placeholder：占位文本', query: 'zzanchor 引号 转义', en: 'TODO', expectReason: 'placeholder' },
  { label: 'untranslated：中文回显（CJK 比例）', query: 'zzanchor 引号 转义怎么修的', en: '引号 转义怎么修的', expectReason: 'untranslated' },
  { label: 'untranslated：原样回显', query: '引号转义崩溃', en: '引号转义崩溃', expectReason: 'untranslated' },
  // `FTS5` 不是受保护 token（初版用它，护栏直接放行、协议是 semantic-en-v1，测的就不是降级路径
  // 了）。真正受保护的是标识符形状：`observation_search.ts`。这条如实登记为装置修正。
  { label: 'lost_tokens：丢掉受保护 token', query: 'zzanchor observation_search.ts 引号转义崩溃是怎么修的', en: 'how the quoting crash in the search module was fixed', expectReason: 'lost_tokens' },
  { label: 'too_long：超长', query: 'zzanchor 引号 转义', en: 'x'.repeat(5000), expectReason: 'too_long' },
  { label: 'length_ratio：长度比越界', query: 'zzanchor 引号 转义崩溃修复过程详细说明一下当时的做法', en: 'a b', expectReason: 'length_ratio' },
];

describe('raw-v1 降级路径 = FTS-only（G 组）', () => {
  test('G1/G2/G3：8 种降级情形 + FTS 有命中 —— 不生成 embedding、三个计数为 0、只有 fts 来源', async () => {
    for (const c of DEGRADED_CASES) {
      db.close();
      db = openInMemoryDB();
      seedGhostFixture();

      const r = await run(c.query, c.en === undefined ? {} : { en: c.en });

      // 协议必须是 raw-v1（说明这条 query 确实走了降级分支，测试本身没测错东西）。
      expect(r.protocol, c.label).toBe('raw-v1');
      if (c.expectReason) expect(r.rejected, c.label).toBe(c.expectReason);

      // G1：一次 embedding 都不能算。
      expect(r.embedCalls, `${c.label} → embedCalls`).toBe(0);
      // G2：三个计数全为 0。
      expect(r.comparableVectors, `${c.label} → comparableVectors`).toBe(0);
      expect(r.semanticCount, `${c.label} → semanticCount`).toBe(0);
      expect(r.aboveFloorCount, `${c.label} → aboveFloorCount`).toBe(0);
      // G3：不得出现由 raw 打分产生的 semantic / hybrid。
      expect(r.sources.filter((s) => s !== 'fts'), `${c.label} → 非 fts 来源`).toEqual([]);
      // 降级不是能力失败，不该报 degraded。
      expect(r.degraded, `${c.label} → degraded`).toBe(false);
      // `scopeVectors` 必须是 null 而不是 0：null = "语义步骤从未运行"，0 = "scope 里没有向量"。
      // 判据 §5.4 要求四种事件可分辨，这一项是其中"协议不适用"与"scope 未建向量"的分界。
      expect(r.scopeVectors, `${c.label} → scopeVectors`).toBe(null);
    }
  }, 60_000);

  test('G4：降级返回与纯 FTS 的有序结果逐位相同', async () => {
    seedGhostFixture();
    const query = 'zzanchor 引号 转义';

    const degraded = await run(query);
    // 参照物：直接问 db 层的 FTS，绕过整个融合层。
    const ftsOnly = db
      .searchObservationsFts(query, { scopeKey: SCOPE, limit: 50 })
      .slice(0, 10)
      .map((o) => o.id);

    expect(degraded.ids).toEqual(ftsOnly);
  });

  test('G5：降级 + 零 FTS 命中 —— 返回空且不生成 embedding', async () => {
    seedGhostFixture();
    const r = await run('zzznothingmatchesthisquery');
    expect(r.ids).toEqual([]);
    expect(r.embedCalls).toBe(0);
    expect(r.comparableVectors).toBe(0);
  });

  test('G6：302 条 / 900 天 ghost 装置 —— 任何降级情形下 ghost 都不进页', async () => {
    for (const c of DEGRADED_CASES) {
      db.close();
      db = openInMemoryDB();
      const { ghost } = seedGhostFixture();
      const r = await run(c.query, c.en === undefined ? {} : { en: c.en });
      expect(r.ids.includes(ghost), `${c.label} → ghost 进页`).toBe(false);
    }
  }, 60_000);

  test('G7：显式回滚 profile + 缺失英文形式 —— 仍是 FTS-only（裁定第 2 条）', async () => {
    seedGhostFixture();
    const r = await run('zzanchor 引号 转义', { policy: LEXICAL_ANCHOR_ROLLBACK_POLICY });
    expect(r.protocol).toBe('raw-v1');
    expect(r.embedCalls).toBe(0);
    expect(r.comparableVectors).toBe(0);
    expect(r.sources.filter((s) => s !== 'fts')).toEqual([]);
  });
});

describe('合法 semantic-en-v1 路径不受影响（N/D 组）', () => {
  test('N5：合法英文形式 + 显式回滚 —— 仍是"有词面锚点才重排"', async () => {
    const { ghost, anchor } = seedGhostFixture();

    // 有词面锚点：语义腿要跑（回滚 profile 的 pool=200 会把 ghost 挡在池外）。
    const anchored = await run('zzanchor', {
      en: 'zzanchor', policy: LEXICAL_ANCHOR_ROLLBACK_POLICY,
    });
    expect(anchored.protocol).toBe('semantic-en-v1');
    expect(anchored.embedCalls).toBe(1);
    expect(anchored.ids).toContain(anchor);
    expect(anchored.ids).not.toContain(ghost);

    // 零词面锚点 + 回滚：Phase 1b 行为是返回空，且不该跑 discovery。
    const unanchored = await run('zzznothingmatchesthisquery', {
      en: 'zzznothingmatchesthisquery', policy: LEXICAL_ANCHOR_ROLLBACK_POLICY,
    });
    expect(unanchored.ids).toEqual([]);
  });

  test('合法英文形式 + discovery 开启 —— 语义腿照常执行（本轮不得改变它）', async () => {
    const { ghost } = seedGhostFixture();
    const r = await run('zzanchor', { en: 'zzanchor' });
    expect(r.protocol).toBe('semantic-en-v1');
    expect(r.embedCalls).toBe(1);
    expect(r.comparableVectors).toBe(302);
    // 生产策略下 ghost 是**允许**进页的（受 cap 限制、标记为 semantic）——这是 2C 冻结的行为，
    // 与本轮无关。钉住它是为了证明本轮的短路没有顺手关掉合法路径的 discovery。
    expect(r.ids).toContain(ghost);
    expect(r.sources[r.ids.indexOf(ghost)]).toBe('semantic');
  });

  test('D1/D2：合法英文形式 + embedding 失败 —— FTS-only 且报 degraded（与降级情形事件不同）', async () => {
    seedGhostFixture();
    const r = await run('zzanchor', {
      en: 'zzanchor',
      embedder: async () => { throw new Error('worker down'); },
    });
    expect(r.protocol).toBe('semantic-en-v1');
    // 能力失败：embedding **被尝试过**，所以 embedCalls 是 1，而且必须报 degraded。
    expect(r.embedCalls).toBe(1);
    expect(r.degraded).toBe(true);
    // D2：仍返回 FTS 结果，不是空。
    expect(r.ids.length).toBeGreaterThan(0);
    expect(r.sources.filter((s) => s !== 'fts')).toEqual([]);
  });

  test('D3：降级路径上 type / days / limit 过滤仍然生效', async () => {
    seed({ title: 'zzanchor bugfix record', daysAgo: 1, first: 0.05, type: 'bugfix' });
    seed({ title: 'zzanchor feature record', daysAgo: 1, first: 0.05, type: 'feature' });
    seed({ title: 'zzanchor ancient record', daysAgo: 400, first: 0.05 });

    const typed = await run('zzanchor', { type: 'bugfix' });
    expect(typed.embedCalls).toBe(0);
    expect(typed.ids.length).toBe(1);

    const narrowed = await run('zzanchor', { days: 90 });
    expect(narrowed.embedCalls).toBe(0);
    expect(narrowed.ids.length).toBe(2);

    const limited = await run('zzanchor', { limit: 1 });
    expect(limited.ids.length).toBe(1);
  });
});
