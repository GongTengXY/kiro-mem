/**
 * raw-v1 降级路径调查探针（裁定第 2 步的前置调查，**不是**判据实验）。
 *
 * 回答一个结构问题：`semantic_query_en` 缺失/被拒、但 FTS 有命中时，语义腿在 `raw-v1`
 * 空间里用的是哪套参数，以及它能不能把一条**词面毫无关系**的记录以 `match_source: semantic`
 * 塞进页面。
 *
 * 为什么要问：词面锚点门的条件是 `!discoveryEffective && ftsCount === 0 && bigramCount === 0`，
 * 只拦"零 FTS"。FTS 命中 ≥1 条时门不生效，语义腿照跑，而它读的是
 * `policy.semanticFloor` / `semanticCandidatePool` / `semanticTopK` —— 这三个值都是为
 * `semantic-en-v1` 校准的（floor 0.197 来自 2B 的英文空间扫参；池与 K 来自候选池 / Top-K 两轮）。
 *
 * 本探针只读、只报告，不改任何生产值。
 */

import { MemoryDB, computeScopeKey } from '../src/db';
import {
  hybridSearchObservations,
  DEFAULT_RETRIEVAL_POLICY,
  LEXICAL_ANCHOR_ROLLBACK_POLICY,
} from '../src/server/observation-search';
import { embeddingToBlob } from '../src/embedding';

const CWD = '/raw-probe';
const SCOPE = computeScopeKey(null, CWD);
const DIM = 4;
const SPACE = { embeddingModel: 'test', embeddingDimensions: DIM };
/** query 向量恒为 [1,0,0,0]，于是 cosine == 记录向量第一维。 */
const queryVec = async () => new Float32Array([1, 0, 0, 0]);

const db = new MemoryDB(':memory:');
const session = 's-raw';
db.upsertSessionRef({ session_id: session, cwd: CWD, repo: null });

function seed(o: { title: string; daysAgo: number; first: number }): number {
  const seq = db.allocateNextTurnSeq(session);
  const turn = db.createTurn({ session_id: session, seq, cwd: CWD, repo: null, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const at = new Date(Date.now() - o.daysAgo * 86400000).toISOString();
  const id = db.insertObservation({
    turn_id: turn.id, session_id: session, turn_seq: seq, repo: null, cwd_scope: CWD,
    title: o.title, summary: o.title, memory_type: 'change', quality: 'normal',
    turn_started_at: at, turn_stopped_at: at,
  })!;
  db.upsertObservationEmbedding(id, 'test', DIM, embeddingToBlob(new Float32Array([o.first, 1, 0, 0])));
  return id;
}

// 装置的时间顺序是**刻意**的：要隔离"候选池"这个变量。
//
// ghost 必须落在"最近 200 条"之外，否则 Phase 1b 的 pool=200 也会打到它，
// 对照臂就分不出是池的作用还是 floor 的作用。所以：ghost 最旧，300 条 filler 都比它新。
const ghost = seed({ title: 'completely different wording nothing shared', daysAgo: 900, first: 0.30 });
// 300 条填充（> Phase 1b 的 200 条池），词面与 query 无关，cosine 远低于任何 floor。
for (let i = 0; i < 300; i++) {
  seed({ title: `filler record ${i} about unrelated matters`, daysAgo: 300 - i, first: 0.05 });
}
// 一条**词面命中**的记录（最新）：query 里会出现 zzanchor。
const anchor = seed({ title: 'zzanchor lexical hit record', daysAgo: 1, first: 0.05 });

async function run(label: string, opts: { en?: string; policy?: object; query?: string }) {
  const query = opts.query ?? 'zzanchor';
  let info: Record<string, unknown> = {};
  const res = await hybridSearchObservations(
    db,
    query,
    { scopeKey: SCOPE, limit: 10, ...(opts.en ? { semanticQueryEn: opts.en } : {}) },
    {
      ...SPACE,
      generateEmbedding: queryVec,
      ...(opts.policy ? { policy: opts.policy } : {}),
      onCandidates: (i) => {
        info = {
          protocol: i.protocol,
          discoveryRequested: i.discoveryRequested,
          discoveryEffective: i.discoveryEffective,
          ftsCount: i.ftsCount,
          comparableVectors: i.comparableVectors,
          aboveFloorCount: i.aboveFloorCount,
          semanticRankSize: i.semanticRank.size,
        };
      },
    },
  );
  const semOnly = res.filter((r) => r.match_source === 'semantic');
  console.log(`\n--- ${label}`);
  console.log(`    protocol=${info.protocol} discoveryEffective=${info.discoveryEffective} ` +
    `ftsCount=${info.ftsCount} comparableVectors=${info.comparableVectors} aboveFloor=${info.aboveFloorCount}`);
  console.log(`    返回 ${res.length} 条：${res.map((r) => `#${r.id}(${r.match_source})`).join(' ')}`);
  console.log(`    semantic-only ${semOnly.length} 条；ghost(#${ghost}) 是否进页：` +
    `${res.some((r) => r.id === ghost) ? `**是**，来源 ${res.find((r) => r.id === ghost)!.match_source}` : '否'}`);
  return { info, ids: res.map((r) => r.id), semOnly: semOnly.length };
}

console.log(`装置：302 条同 scope 记录（300 条 filler + 1 条词面锚点 #${anchor} + 1 条 ghost #${ghost}）`);
console.log(`生产策略：floor=${DEFAULT_RETRIEVAL_POLICY.semanticFloor} ` +
  `pool=${DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool} topK=${DEFAULT_RETRIEVAL_POLICY.semanticTopK}`);
console.log(`Phase 1b raw profile：floor=${LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticFloor} ` +
  `pool=${LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticCandidatePool} topK=${LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticTopK}`);

await run('A. 正常路径：有合法 semantic_query_en（英文空间）', { en: 'zzanchor' });
await run('B. 降级路径：缺 semantic_query_en，FTS 有命中（生产默认策略）', {});
await run('C. 对照：降级路径 + Phase 1b raw profile 的池与 floor', {
  policy: {
    semanticFloor: LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticFloor,
    semanticCandidatePool: LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticCandidatePool,
    semanticTopK: LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticTopK,
  },
});
await run('D. 降级路径 + 零 FTS 命中（词面锚点门应生效，必须返回空）',
  { query: 'zzznothingmatchesthis' });
await run('E. 对照：正常路径 + 零 FTS 命中（discovery 生效，ghost 应可达）',
  { query: 'zzznothingmatchesthis', en: 'zzznothingmatchesthis' });

db.close();
