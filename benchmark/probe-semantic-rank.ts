/**
 * 离线语义排名探针（检索优化方案 §4.3）。
 *
 * 它回答一个别的指标都回答不了的问题：**纯语义单独能不能把对的记录排上来。**
 *
 * 为什么必须绕开完整检索链路：`observation-search.ts` 有一道词汇锚点门——本
 * scope 的 FTS 一条都没命中就直接返回空，而且这道门在语义步骤**之前**。于是
 * 换编码器对那批零锚点 query 的端到端读数**结构上就是不动的**，把
 * "heldout hit@5 上升"当成换编码器的验收指标，等于把一个正确的改动判成失败
 * （方案 §5.5 记录了这个错误）。这个探针不查 FTS、不做融合、不截断，直接用
 * cosine 在同 scope 的全部记录上排序，所以它是阶段 1 → 阶段 2 之间唯一的
 * 传导路径。
 *
 * 用途按子集分开（方案 §5.6 的统一划分），而且是**强制**的：
 *   - `--subset=tuned`   校准集。选编码器只能读这 18 条。
 *   - `--subset=heldout` 验证集。每阶段只读一次，不得据此回头改参数。
 *   - `--subset=all`     两者都跑，用于建立 phase0 基线。
 * 被用于选择的样本不再是该选择的泛化证据——所以阶段 1a 必须显式跑
 * `--subset=tuned`，报告里那行命令本身就是"heldout 没被烧掉"的凭据。
 *
 * `zeroAnchor` 子集（当前 9 条）由脚本**当场**按"FTS 候选数为 0"算出来，绝不
 * 硬编码 query 名单：名单会随 FTS 侧的改动变化，硬编码会让子读数悄悄测错对象。
 *
 * 主读数是 MRR 而不是 Top-5。Top-5 是阶跃函数，期望记录从第 4 位升到第 1 位它
 * 一动不动；MRR 也不是连续量（它是离散 rank 的函数），但细得多。单条 query 对
 * 它的**最大**贡献是 1/n（未命中升到第 1 位），不是每条固定 1/n。
 *
 * 用法：
 *   bun run benchmark/probe-semantic-rank.ts
 *   bun run benchmark/probe-semantic-rank.ts --subset=tuned
 *   bun run benchmark/probe-semantic-rank.ts --report=path.md --json=path.json
 *
 * 阶段 1a 换候选编码器（不改任何产品代码）：
 *   bun run benchmark/probe-semantic-rank.ts --subset=tuned \
 *     --model=Xenova/multilingual-e5-small --label=e5-small \
 *     --query-prefix='query: ' --doc-prefix='passage: '
 *
 * `--model` 缺省即生产模型；那条读数必须逐位复现 phase0 基线，否则说明 probe 的
 * 加载器与生产不等价，任何候选对比都不成立（见 `benchmark/encoder.ts`）。
 *
 * 它不进 CI 门槛——它测的不是产品行为。但每个阶段的报告都要附一次读数。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadDataset, validateQueries, recordSearchText, queryText, mirroredRecordIds, annotationToResult, usesEnRecords, applyEnMirrorOverlay } from './dataset';
import type { DatasetQuery, DatasetTurn, ProbeLang } from './dataset';
import { loadEncoder, specFromArgs } from './encoder';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const subset = flag('subset', 'all') as 'tuned' | 'heldout' | 'all';
if (subset !== 'tuned' && subset !== 'heldout' && subset !== 'all') {
  console.error(`unknown --subset=${subset} (expected tuned|heldout|all)`);
  process.exit(2);
}
const encoderSpec = specFromArgs(flag);

const lang = flag('lang', 'zh') as ProbeLang;
if (lang !== 'zh' && lang !== 'en' && lang !== 'cross' && lang !== 'zh2en') {
  console.error(`unknown --lang=${lang} (expected zh|en|cross|zh2en)`);
  process.exit(2);
}
// 英文镜像只覆盖 tuned + empty（heldout 不能在选型期间消耗，other scope 不参与嵌入
// 对比）。跑一个镜像没覆盖的子集会中途抛错，不如在这里明确拒绝。
if (lang !== 'zh' && subset !== 'tuned') {
  console.error(
    `--lang=${lang} 只覆盖 tuned 子集（英文镜像不含 heldout）。请显式传 --subset=tuned。`,
  );
  process.exit(2);
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '');

// 英文镜像覆盖（可传多份，逗号分隔）。用来把任一侧换成独立产出的译文，读出
// "两次互不参照的翻译"的真实分数——mirror-en.json 的读数是同一译者同时译两侧的上界。
const mirrorOverlays = (flag('en-mirror', '') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => resolve(p));
if (mirrorOverlays.length && lang === 'zh') {
  console.error('--en-mirror 对 --lang=zh 无意义（该模式两侧都是中文）');
  process.exit(2);
}
const overlayApplied = { records: 0, queries: 0 };
for (const p of mirrorOverlays) {
  const n = applyEnMirrorOverlay(p);
  overlayApplied.records += n.records;
  overlayApplied.queries += n.queries;
  console.log(`[probe] 镜像覆盖 ${p} → records ${n.records} / queries ${n.queries}`);
}
// `--tag` 只影响默认报告文件名。加它的原因很具体：覆盖运行用的是生产模型（没有
// `--model`），默认名会算成 `probe-semantic-rank-tuned-en.md`，正好**覆盖掉手写镜像
// 那份基线报告**——而那份是本实验唯一的对照。
const tag = flag('tag', '');
const reportPath = resolve(
  flag(
    'report',
    join(
      import.meta.dir,
      'reports',
      `probe-semantic-rank-${subset}${lang === 'zh' ? '' : `-${lang}`}${flag('model') ? `-${slug(encoderSpec.label)}` : ''}${tag ? `-${slug(tag)}` : ''}.md`,
    ),
  )!,
);
const jsonPath = flag('json') ? resolve(flag('json')!) : undefined;

// 隔离：FTS 索引要建在临时 SQLite 上，绝不碰开发者真实 ~/.kiro-mem。
const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-probe-rank-'));
process.env.KIRO_MEMORY_DATA_DIR = join(workDir, 'data');
mkdirSync(process.env.KIRO_MEMORY_DATA_DIR, { recursive: true });

const { MemoryDB, computeScopeKey } = await import('../src/db');
const { cosineSimilarity } = await import('../src/embedding');

const encoder = await loadEncoder(encoderSpec);

const { turns, queries } = loadDataset();
const datasetErrors = validateQueries(queries);
if (datasetErrors.length) {
  for (const e of datasetErrors) console.error(`[probe] ${e}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 语料：按 scope 分组，嵌入文本走生产拼接规则
// ---------------------------------------------------------------------------

const scopeCwd: Record<'primary' | 'other', string> = {
  primary: join(workDir, 'scope-primary'),
  other: join(workDir, 'scope-other'),
};
mkdirSync(scopeCwd.primary, { recursive: true });
mkdirSync(scopeCwd.other, { recursive: true });
const scopeKeyOf = (s: 'primary' | 'other') => computeScopeKey(null, scopeCwd[s]);

interface Record_ {
  turn: DatasetTurn;
  searchText: string;
  vector: Float32Array;
}

// 记录侧取英文镜像时（`en` / `zh2en`）语料只取镜像覆盖到的记录（26 条 primary）。
// `scope: other` 的 4 条只为跨 scope 隔离检查而存在，从不进入 primary 排序池，所以
// 没有翻译它们。
const corpus = usesEnRecords(lang) ? turns.filter((t) => mirroredRecordIds().has(t.id)) : turns;

console.log(
  `[probe] 嵌入 ${corpus.length} 条记录（${encoderSpec.label} / ${encoder.dimensions}d / lang=${lang}` +
    `${encoderSpec.docPrefix ? `, doc 前缀 ${JSON.stringify(encoderSpec.docPrefix)}` : ''}）…`,
);
const records: Record_[] = [];
for (const t of corpus) {
  const searchText = recordSearchText(t, lang);
  records.push({ turn: t, searchText, vector: await encoder.embedDocument(searchText) });
}
const recordsByScope = {
  primary: records.filter((r) => r.turn.scope === 'primary'),
  other: records.filter((r) => r.turn.scope === 'other'),
};

// ---------------------------------------------------------------------------
// FTS 候选数：只为算出 zeroAnchor 子集的成员
// ---------------------------------------------------------------------------
//
// 走真实 `searchObservationsFts`（同样的 limit: 50 / days: 90），而不是在这里
// 复制一份匹配逻辑——后者会随 FTS 侧改动漂移，然后把"零锚点"这个子集算错。
//
// **只在 lang=zh 下做。** 英文镜像只翻译了参与嵌入的字段（title/summary/outcome/
// learned/concepts），`request` / `next_steps` / `evidence` 仍是中文，所以记录侧取镜像
// 的模式（`en` / `zh2en`）下建出来的 FTS 索引是半中半英的，它的命中数不代表任何真实
// 配置；`cross` 的 query 侧是英文，对中文 trigram 索引同样测不出真实命中。zeroAnchor
// 子集本来也只为与 §1.1 的中文历史数字对齐而存在，跨语言对比看的是纯语义排名。

const db = lang === 'zh' ? new MemoryDB(join(workDir, 'probe.sqlite')) : null;
const obsIdOf = new Map<string, number>();
if (db) {
  const base = Date.now();
  turns.forEach((t, i) => {
    const at = new Date(base - (turns.length - i) * 60_000).toISOString();
    db.upsertSessionRef({ session_id: t.session, cwd: scopeCwd[t.scope], repo: null });
    const seq = db.allocateNextTurnSeq(t.session);
    const turnRow = db.createTurn({
      session_id: t.session,
      seq,
      cwd: scopeCwd[t.scope],
      repo: null,
      prompt_text: t.prompt,
      started_at: at,
    });
    const r = annotationToResult(t.annotation);
    const id = db.insertObservation({
      turn_id: turnRow.id,
      session_id: t.session,
      turn_seq: seq,
      repo: null,
      cwd_scope: scopeCwd[t.scope],
      title: r.title,
      summary: r.summary,
      request: r.request,
      outcome: r.outcome,
      learned: r.learned,
      next_steps: r.next_steps,
      memory_type: r.memory_type as never,
      files_touched: r.files_touched,
      concepts: r.concepts,
      evidence: r.evidence,
      importance_score: r.importance_score,
      confidence_score: r.confidence_score,
      unresolved_score: r.unresolved_score,
      quality: 'normal',
      turn_started_at: at,
      turn_stopped_at: at,
    });
    obsIdOf.set(t.id, id!);
  });
}

/**
 * 生产 FTS 腿的口径：limit 50、days 90（`hybridSearchObservations` 的默认值）。
 * 返回 -1 表示"本次运行不适用"（非中文模式，见上）。
 */
const ftsCountOf = (q: DatasetQuery): number =>
  db
    ? db.searchObservationsFts(q.query, {
        scopeKey: scopeKeyOf(q.scope),
        days: 90,
        limit: 50,
      }).length
    : -1;

// ---------------------------------------------------------------------------
// 纯 cosine 排名
// ---------------------------------------------------------------------------

interface RankRow {
  id: string;
  origin: 'tuned' | 'heldout';
  query: string;
  expect: string[];
  /** 最靠前的 expected 名次；0 = 全 scope 排序里一条都没进（不可能，除非 scope 空）。 */
  rank: number;
  /** 各 expected 的名次，用于多正例 query 的完整读数。 */
  ranks: number[];
  reciprocalRank: number;
  ftsCount: number;
  zeroAnchor: boolean;
  /** 最靠前 expected 的 cosine，便于与分布探针对照。 */
  topExpectedScore: number;
  /** 排第 1 的记录（不一定是 expected），用于看"最近邻被谁占了"。 */
  nearest: string;
  nearestScore: number;
}

const relevance = queries.filter((q) => q.kind === 'relevance');
const selected = relevance.filter((q) => subset === 'all' || q.origin === subset);
if (!selected.length) {
  console.error(`[probe] --subset=${subset} 选中 0 条 query`);
  process.exit(2);
}

console.log(`[probe] 纯 cosine 排名 ${selected.length} 条 relevance query（subset=${subset}）…`);
const rows: RankRow[] = [];
for (const q of selected) {
  const pool = recordsByScope[q.scope];
  const qv = await encoder.embedQuery(queryText(q, lang));
  const scored = pool
    .map((r) => ({ id: r.turn.id, score: cosineSimilarity(qv, r.vector) }))
    .sort((a, b) => b.score - a.score);

  const ranks = q.expect
    .map((e) => scored.findIndex((s) => s.id === e) + 1)
    .filter((r) => r > 0);
  const rank = ranks.length ? Math.min(...ranks) : 0;
  const bestExpectedId = rank > 0 ? scored[rank - 1]!.id : null;
  rows.push({
    id: q.id,
    // 这支探针的分层只有 tuned / heldout（1b 的 validation 走完整链路，不在此测）。
    origin: q.origin as 'tuned' | 'heldout',
    query: q.query,
    expect: q.expect,
    rank,
    ranks,
    reciprocalRank: rank > 0 ? 1 / rank : 0,
    ftsCount: ftsCountOf(q),
    zeroAnchor: false, // 下面统一填
    topExpectedScore: bestExpectedId ? scored[rank - 1]!.score : 0,
    nearest: scored[0]?.id ?? '—',
    nearestScore: scored[0]?.score ?? 0,
  });
}
// ftsCount = -1 表示本次运行不适用（非中文模式），此时 zeroAnchor 恒为 false。
for (const r of rows) r.zeroAnchor = r.ftsCount === 0;

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** 名次分位数。未命中（rank=0）按池大小+1 计，否则它会被当成"排第 0 名"。 */
const rankValue = (r: RankRow, poolSize: number) => (r.rank > 0 ? r.rank : poolSize + 1);
const quantile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((s.length - 1) * p));
  return s[idx]!;
};

function summarize(label: string, group: RankRow[]) {
  const poolSize = recordsByScope.primary.length;
  const rankVals = group.map((r) => rankValue(r, poolSize));
  return {
    label,
    queries: group.length,
    mrr: mean(group.map((r) => r.reciprocalRank)),
    medianRank: quantile(rankVals, 0.5),
    p90Rank: quantile(rankVals, 0.9),
    top5: group.filter((r) => r.rank > 0 && r.rank <= 5).length,
    top10: group.filter((r) => r.rank > 0 && r.rank <= 10).length,
    zeroAnchorCount: group.filter((r) => r.zeroAnchor).length,
  };
}

const groups: { label: string; rows: RankRow[] }[] = [];
if (subset === 'all') groups.push({ label: 'all', rows });
if (subset === 'all' || subset === 'tuned') {
  groups.push({ label: 'tuned（校准集，选型用）', rows: rows.filter((r) => r.origin === 'tuned') });
}
if (subset === 'all' || subset === 'heldout') {
  groups.push({ label: 'heldout（验证集，1a 不跑）', rows: rows.filter((r) => r.origin === 'heldout') });
}
groups.push({ label: 'zeroAnchor（FTS 候选数为 0，当场计算）', rows: rows.filter((r) => r.zeroAnchor) });

const summaries = groups.filter((g) => g.rows.length).map((g) => summarize(g.label, g.rows));

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const fmt = (x: number, d = 3) => x.toFixed(d);
const lines: string[] = [];
lines.push('# 离线语义排名探针（方案 §4.3）');
lines.push('');
lines.push('纯 cosine 在同 scope **全部记录**上排序，不查 FTS、不做 RRF、不截断。');
lines.push('它测的是"语义腿单独能不能把对的记录排上来"——阶段 2 拆门之后所依赖的');
lines.push('正是这个能力，而端到端指标因为词汇锚点门在语义步骤之前，读不出它。');
lines.push('');
lines.push('| 项 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 生成时间 | ${new Date().toISOString()} |`);
lines.push(`| 命令行 | \`bun run benchmark/probe-semantic-rank.ts ${args.join(' ')}\` |`);
lines.push(`| subset | \`${subset}\` |`);
const LANG_DESC: Record<ProbeLang, string> = {
  zh: '（原始中文语料 + 中文 query）',
  en: '（英文镜像语料 + 英文 query）',
  cross: '（中文语料 + 英文 query，跨语言对齐）',
  zh2en: '（英文镜像语料 + 中文 query，方向与 cross 相反）',
};
lines.push(`| 语料 / query 语言 | \`${lang}\`${LANG_DESC[lang]} |`);
if (mirrorOverlays.length) {
  lines.push(
    `| 镜像覆盖 | ${mirrorOverlays.map((p) => `\`${p.split('/').pop()}\``).join(' + ')}（records ${overlayApplied.records} / queries ${overlayApplied.queries}） |`,
  );
  lines.push('| 译文来源 | **非手写镜像**：被覆盖的那一侧来自独立翻译事件，未覆盖的一侧仍是手写镜像 |');
} else if (lang !== 'zh') {
  lines.push('| 译文来源 | 手写机械镜像（`mirror-en.json`，两侧同一译者同时产出 → 读数是**上界**） |');
}
if (lang !== 'zh') {
  lines.push('| zeroAnchor / FTS 候选数 | 不适用（英文镜像只翻译参与嵌入的字段，索引会是半中半英） |');
}
lines.push(`| 编码器 | ${encoderSpec.label} |`);
lines.push(`| 模型 | \`${encoderSpec.model}\` |`);
lines.push(`| 实测输出维度 | ${encoder.dimensions} |`);
lines.push(
  `| 前缀协议 | query=${encoderSpec.queryPrefix ? `\`${encoderSpec.queryPrefix}\`` : '无'} / doc=${encoderSpec.docPrefix ? `\`${encoderSpec.docPrefix}\`` : '无'} |`,
);
lines.push(`| 记录池 | primary ${recordsByScope.primary.length} 条 / other ${recordsByScope.other.length} 条 |`);
lines.push(`| 运行环境 | Bun ${Bun.version} / ${process.platform} ${process.arch} |`);
lines.push('');
lines.push('## 分层读数');
lines.push('');
lines.push('主指标是 **MRR**：Top-5 是阶跃函数，读不出"名次从第 4 升到第 1"这种改进。');
lines.push('`medianRank` / `p90Rank` 里未命中按池大小+1 计。');
lines.push('');
lines.push('| 子集 | query 数 | MRR | 名次中位数 | p90 名次 | Top-5 | Top-10 | 零锚点条数 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const s of summaries) {
  lines.push(
    `| ${s.label} | ${s.queries} | **${fmt(s.mrr)}** | ${s.medianRank} | ${s.p90Rank} | ${s.top5}/${s.queries} | ${s.top10}/${s.queries} | ${s.zeroAnchorCount} |`,
  );
}
lines.push('');
lines.push('## 逐 query 名次（rankDistribution）');
lines.push('');
lines.push('`最近邻` 是纯 cosine 排第 1 的记录，不一定是 expected——同一条无关记录反复');
lines.push('成为多条 query 的最近邻，是编码器把输入压进退化区域的直接症状。');
lines.push('');
lines.push('| query | 子集 | 期望 | 语义名次 | 1/rank | expected cosine | 最近邻 | 最近邻 cosine | FTS候选 |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
  lines.push(
    `| ${r.id} ${r.query} | ${r.origin}${r.zeroAnchor ? ' /零锚点' : ''} | ${r.expect.join(',')} | ${r.rank || '未进'} | ${fmt(r.reciprocalRank)} | ${fmt(r.topExpectedScore)} | ${r.nearest} | ${fmt(r.nearestScore)} | ${r.ftsCount} |`,
  );
}
lines.push('');
lines.push('## 最近邻占用统计');
lines.push('');
lines.push('| 记录 | 成为最近邻的次数 |');
lines.push('| --- | --- |');
{
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.nearest, (counts.get(r.nearest) ?? 0) + 1);
  for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (n > 1) lines.push(`| ${id} | ${n} |`);
  }
}
lines.push('');

mkdirSync(join(import.meta.dir, 'reports'), { recursive: true });
writeFileSync(reportPath, lines.join('\n'), 'utf-8');

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        subset,
        encoder: encoderSpec,
        dimensions: encoder.dimensions,
        poolSize: recordsByScope.primary.length,
        summaries,
        rankDistribution: rows.map((r) => ({
          id: r.id,
          origin: r.origin,
          rank: r.rank,
          ranks: r.ranks,
          reciprocalRank: r.reciprocalRank,
          ftsCount: r.ftsCount,
          zeroAnchor: r.zeroAnchor,
          topExpectedScore: r.topExpectedScore,
          nearest: r.nearest,
          nearestScore: r.nearestScore,
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

console.log('');
for (const s of summaries) {
  console.log(
    `  ${s.label.padEnd(34)} n=${String(s.queries).padStart(2)}  MRR=${fmt(s.mrr)}  ` +
      `median=${String(s.medianRank).padStart(2)}  p90=${String(s.p90Rank).padStart(2)}  ` +
      `top5=${s.top5}/${s.queries}  零锚点=${s.zeroAnchorCount}`,
  );
}
console.log('');
console.log(`[probe] 报告已写入 ${reportPath}`);

if (db) db.close();
rmSync(workDir, { recursive: true, force: true });
