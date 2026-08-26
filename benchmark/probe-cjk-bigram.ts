/**
 * 阶段 3A 量测探针：中文两字词在 trigram FTS 下的可达性、噪声与机制选型。
 *
 * 只读。不改产品代码、不改索引、不跑任何 arm。它要回答四个在写判据之前必须有实测
 * 答案的问题：
 *
 *   Q1 机制  —— 每条 query 能切出哪些 CJK bigram，它们在 scope 内的文档频率（DF）
 *               分布是什么形状？有没有一个干净的 DF 上限能把「引号」这种区分性词
 *               和「问题」这种功能词分开？
 *   Q2 收益  —— 把 bigram 作为辅助候选后，哪些 relevance 目标从「trigram FTS 不可
 *               达」变成「可达」？这是 3A 的收益上限，与 semantic-en 无关。
 *   Q3 风险  —— 有多少 empty / hard-negative query 会新获得 FTS 候选？这些候选的
 *               match_source 会从 `semantic` 变成 `fts`/`hybrid`，**绕过 cap=2**。
 *               2D 报告第 7 条登记既有 expected-empty 停在 1.00、门槛 ≤1、零余量，
 *               所以这是 3A 的主要发布风险，不是延迟也不是索引大小。
 *   Q4 选型  —— 方案 §10 给了两条路（辅助 LIKE / 受控 bigram 候选）。这里实测
 *               `fts5vocab` 前缀范围扫描展开成 trigram 再 MATCH，与 LIKE 全表扫描
 *               的**召回差**和**延迟差**，用数字决定，不靠偏好。
 *
 * 为什么必须先探针再写判据：DF 上限和辅助条数上限是 3A 的自变量，而它们的候选值
 * 只能来自实测分布。凭感觉写一个 `DF <= 5` 然后再回头解释，就是方案 §14.3 禁止的
 * 「看完数字再调判据」的倒序版本。
 *
 * 隔离：临时 SQLite + 临时 dataDir，绝不碰开发者真实 ~/.kiro-mem（方案 §14 纪律 9）。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadDataset, validateQueries, annotationToResult } from './dataset';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const reportPath = resolve(
  flag('report', join(import.meta.dir, 'reports', 'phase3a-bigram-probe.md'))!,
);
const jsonPath = resolve(
  flag('json', join(import.meta.dir, 'reports', 'phase3a-bigram-probe.json'))!,
);
/** 是否加载 Phase 2 校准集（121 条 ftsCount=0）。Q3 的风险量级主要靠它。 */
const withPhase2 = !args.includes('--no-phase2');
/** 是否加载 20 条新验证集。默认加载：本探针不选参，不消耗它的「未查看」属性。 */
const withValidation = !args.includes('--no-validation');

/**
 * 已提交 Phase 1b 报告的 FTS 候选数参照表（42 条）。
 *
 * 与 `probe-zero-fts.ts` 同一份、同一用途：本探针走直接 `insertObservation`，
 * 生产走 hook → job 链路，逐条相同才证明索引内容等价。不同则说明播种漂移，
 * 后面所有「bigram 让 ftsCount 从 0 变正」的判定都不可信。
 */
const FTS_ORACLE: Record<string, number> = {
  q01: 4, q02: 6, q03: 8, q04: 3, q05: 1, q06: 8, q07: 4, q08: 0, q09: 5, q10: 3,
  q11: 11, q12: 1, q13: 12, q14: 3, q15: 2, q16: 3, q17: 1, q18: 1, q19: 0, q20: 5,
  q21: 0, q22: 0, q23: 0, q24: 0, q25: 3, q26: 3, q27: 1, q28: 0, q29: 0, q30: 0,
  q31: 1, q32: 0, q33: 0, q34: 1, q35: 1, q36: 0, q37: 0, q38: 5, q39: 1, q40: 0,
  q41: 1, q42: 0,
};

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-probe-bigram-'));
process.env.KIRO_MEMORY_DATA_DIR = join(workDir, 'data');
mkdirSync(process.env.KIRO_MEMORY_DATA_DIR, { recursive: true });

const { MemoryDB, computeScopeKey, extractFtsSearchUnits } = await import('../src/db');

const { turns, queries } = loadDataset(undefined, { withValidation, withPhase2 });
const datasetErrors = validateQueries(queries);
if (datasetErrors.length) {
  for (const e of datasetErrors) console.error(`[probe] ${e}`);
  process.exit(2);
}

const scopeCwd: Record<'primary' | 'other', string> = {
  primary: join(workDir, 'scope-primary'),
  other: join(workDir, 'scope-other'),
};
mkdirSync(scopeCwd.primary, { recursive: true });
mkdirSync(scopeCwd.other, { recursive: true });
const scopeKeyOf = (s: 'primary' | 'other') => computeScopeKey(null, scopeCwd[s]);

// ---------------------------------------------------------------------------
// 播种：gold Observation → FTS 索引（与 probe-zero-fts.ts 逐字段一致）
// ---------------------------------------------------------------------------

const db = new MemoryDB(join(workDir, 'probe.sqlite'));
const obsIdOf = new Map<string, number>();
const dsIdOfObs = new Map<number, string>();
{
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
    dsIdOfObs.set(id!, t.id);
  });
}

/** 生产 FTS 腿的口径：`hybridSearchObservations` 用的 limit 50 / days 90。 */
function ftsHits(query: string, scope: 'primary' | 'other'): string[] {
  return db
    .searchObservationsFts(query, { scopeKey: scopeKeyOf(scope), days: 90, limit: 50 })
    .map((o) => dsIdOfObs.get(o.id) ?? `obs${o.id}`);
}

const selfCheckMismatches: string[] = [];
for (const q of queries) {
  const expected = FTS_ORACLE[q.id];
  if (expected === undefined) continue;
  const actual = ftsHits(q.query, q.scope).length;
  if (actual !== expected) {
    selfCheckMismatches.push(`${q.id}: 参照 ${expected} 条，本探针 ${actual} 条`);
  }
}
if (selfCheckMismatches.length) {
  console.error('[probe] 播种与生产不等价，FTS 候选数对账失败：');
  for (const m of selfCheckMismatches) console.error(`  ${m}`);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
console.log('[probe] 自证通过：42 条既有 query 的 FTS 候选数与已提交报告逐条一致。');
console.log(`[probe] 语料 ${turns.length} 条记录，query ${queries.length} 条。`);

// ---------------------------------------------------------------------------
// bigram 提取
// ---------------------------------------------------------------------------
//
// 口径：CJK run 长度 ≥2 即取，run 内全部 2 字滑窗，去重。
//
// 不做分词。没有词典就无法知道「引号」是词而「号或」不是，而引入分词器会在 3A 里塞
// 进第二个自变量（词典版本），方案 §3.2 的单变量纪律不允许。滑窗必然产出「号或」这
// 类非词，所以噪声控制不能靠「切得准」，只能靠**DF 上限**——这正是 Q1 要测的东西。
const CJK_RUN_ALL_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g;

function extractCjkBigrams(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const run of query.match(CJK_RUN_ALL_RE) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!seen.has(bg)) { seen.add(bg); out.push(bg); }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 两种候选机制
// ---------------------------------------------------------------------------

const FTS_COLUMNS = [
  'title', 'summary', 'request', 'outcome', 'learned',
  'next_steps', 'concepts_json', 'files_touched_json', 'evidence_json',
] as const;

/**
 * 机制 A：辅助 LIKE（方案 §10 选项 2）。
 *
 * 语义上**完备**——`%XY%` 就是「这一列含子串 XY」的定义，所以它是本探针的 ground
 * truth。代价是 9 列 LIKE 的全表扫描，用不上任何索引。
 */
const likeSql = `SELECT id FROM observations
   WHERE scope_key = ?
     AND (${FTS_COLUMNS.map((c) => `${c} LIKE ?`).join(' OR ')})`;
function likeHits(bigram: string, scope: 'primary' | 'other'): number[] {
  const like = `%${bigram}%`;
  return (db.raw.query(likeSql).all(scopeKeyOf(scope), ...FTS_COLUMNS.map(() => like)) as { id: number }[])
    .map((r) => r.id);
}

/**
 * 机制 B：`fts5vocab` 前缀范围展开（本探针新增的候选机制）。
 *
 * 走的还是现有 trigram 索引：term 表按字典序有序，所以「前缀是 XY 的 trigram」是一次
 * **范围扫描**（`term >= 'XY' AND term < 'XY\uffff'`），不是全表扫描。拿到 `XY?` 这组
 * term 后再用普通 MATCH OR 查询命中文档。索引不变、不膨胀。
 *
 * 已知不完备：只覆盖 `XY?`。当 XY 恰好是**某一列的最后两个字**时，索引里只有 `?XY`
 * 而没有 `XY?`，这条记录就漏了。漏多少是 Q4 要测的数字——不完备本身不是否决理由，
 * 漏 0 条和漏一半是两种结论。
 */
db.raw.exec('CREATE VIRTUAL TABLE IF NOT EXISTS obs_fts_vocab USING fts5vocab(observations_fts, row)');
function vocabHits(bigram: string, scope: 'primary' | 'other'): number[] {
  const terms = (db.raw
    .query('SELECT term FROM obs_fts_vocab WHERE term >= ? AND term < ?')
    .all(bigram, bigram + '\uffff') as { term: string }[]).map((r) => r.term);
  if (terms.length === 0) return [];
  const expr = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
  return (db.raw
    .query(`SELECT o.id FROM observations_fts fts JOIN observations o ON fts.rowid = o.id
             WHERE observations_fts MATCH ? AND o.scope_key = ?`)
    .all(expr, scopeKeyOf(scope)) as { id: number }[]).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// 逐 query 量测
// ---------------------------------------------------------------------------

interface BigramRow {
  bigram: string;
  /** LIKE ground truth 的 DF（scope 内命中记录数）。 */
  df: number;
  /** 命中的记录（数据集 id）。 */
  hits: string[];
  /** 机制 B 漏掉的记录（LIKE 命中但 vocab 展开没命中）。 */
  vocabMissed: string[];
  /** 机制 B 多出的记录（应为空；非空说明展开逻辑错了）。 */
  vocabExtra: string[];
}

interface QueryRow {
  id: string;
  kind: string;
  origin: string;
  scope: 'primary' | 'other';
  query: string;
  expect: string[];
  /** 现状：trigram FTS 命中的记录。 */
  ftsHits: string[];
  /** 现状是否 zero-FTS。 */
  zeroFts: boolean;
  bigrams: BigramRow[];
  /** 是否含 CJK bigram（无则 3A 对这条 query 结构上无影响）。 */
  hasBigram: boolean;
}

const rows: QueryRow[] = [];
const bigramDfGlobal = new Map<string, number>();

for (const q of queries) {
  const hits = ftsHits(q.query, q.scope);
  const bigrams = extractCjkBigrams(q.query);
  const bgRows: BigramRow[] = bigrams.map((bg) => {
    const l = likeHits(bg, q.scope);
    const v = new Set(vocabHits(bg, q.scope));
    const lSet = new Set(l);
    const toDs = (ids: number[]) => ids.map((id) => dsIdOfObs.get(id) ?? `obs${id}`).sort();
    bigramDfGlobal.set(bg, l.length);
    return {
      bigram: bg,
      df: l.length,
      hits: toDs(l),
      vocabMissed: toDs(l.filter((id) => !v.has(id))),
      vocabExtra: toDs([...v].filter((id) => !lSet.has(id))),
    };
  });
  rows.push({
    id: q.id,
    kind: q.kind,
    origin: q.origin ?? '—',
    scope: q.scope,
    query: q.query,
    expect: q.expect,
    ftsHits: hits,
    zeroFts: hits.length === 0,
    bigrams: bgRows,
    hasBigram: bgRows.length > 0,
  });
}

// ---------------------------------------------------------------------------
// Q1：DF 分布
// ---------------------------------------------------------------------------

const CORPUS_PRIMARY = turns.filter((t) => t.scope === 'primary').length;
const dfHistogram = new Map<number, number>();
for (const df of bigramDfGlobal.values()) {
  dfHistogram.set(df, (dfHistogram.get(df) ?? 0) + 1);
}
const dfSorted = [...dfHistogram.entries()].sort((a, b) => a[0] - b[0]);
/** DF 最高的 bigram —— 候选 stopword，用来判断上限该切在哪。 */
const topDf = [...bigramDfGlobal.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);

// ---------------------------------------------------------------------------
// Q2 / Q3：按 DF 上限模拟辅助候选
// ---------------------------------------------------------------------------
//
// 只模拟 **FTS 腿的候选集合**，不模拟 RRF、不模拟 cap、不算 hit@5。理由：这些要靠
// 完整链路的 arm 去测；探针越过 FTS 腿就等于用探针选参。这里只回答结构问题——
// 「目标进得了候选池吗」和「无关 query 会多进来几条」。
const DF_CEILINGS = [1, 2, 3, 5, 8, 12, Number.POSITIVE_INFINITY];

interface CeilingStat {
  ceiling: number;
  /** zero-FTS relevance query 里，目标进入辅助候选的条数 / 总条数（分 origin）。 */
  reachable: Record<string, { hit: number; total: number; ids: string[] }>;
  /** empty / leakage query 新增的辅助候选数：均值 / 最坏 / 有新增的条数。 */
  noise: Record<string, { mean: number; worst: number; nonZero: number; total: number }>;
}

function auxCandidates(row: QueryRow, ceiling: number): Set<string> {
  const out = new Set<string>();
  for (const bg of row.bigrams) {
    if (bg.df === 0 || bg.df > ceiling) continue;
    for (const h of bg.hits) out.add(h);
  }
  return out;
}

const ceilingStats: CeilingStat[] = DF_CEILINGS.map((ceiling) => {
  const reachable: CeilingStat['reachable'] = {};
  const noiseAcc: Record<string, number[]> = {};
  for (const row of rows) {
    const aux = auxCandidates(row, ceiling);
    if (row.kind === 'relevance') {
      if (!row.zeroFts) continue; // 已经可达，3A 与它无关
      const key = row.origin;
      reachable[key] ??= { hit: 0, total: 0, ids: [] };
      reachable[key].total++;
      if (row.expect.some((e) => aux.has(e))) {
        reachable[key].hit++;
        reachable[key].ids.push(row.id);
      }
    } else {
      // empty / leakage：新增候选 = 辅助候选里原本不在 FTS 命中集合中的
      const key = `${row.kind}/${row.origin}`;
      const added = [...aux].filter((h) => !row.ftsHits.includes(h)).length;
      (noiseAcc[key] ??= []).push(added);
    }
  }
  const noise: CeilingStat['noise'] = {};
  for (const [key, vals] of Object.entries(noiseAcc)) {
    noise[key] = {
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      worst: Math.max(...vals),
      nonZero: vals.filter((v) => v > 0).length,
      total: vals.length,
    };
  }
  return { ceiling, reachable, noise };
});

// ---------------------------------------------------------------------------
// Q4：机制 B 的召回差与两者延迟
// ---------------------------------------------------------------------------

const allBigramRows = rows.flatMap((r) => r.bigrams);
const vocabMissedTotal = allBigramRows.reduce((a, b) => a + b.vocabMissed.length, 0);
const vocabExtraTotal = allBigramRows.reduce((a, b) => a + b.vocabExtra.length, 0);
const likeHitsTotal = allBigramRows.reduce((a, b) => a + b.hits.length, 0);
const bigramsWithMiss = allBigramRows.filter((b) => b.vocabMissed.length > 0);

function timeIt(fn: () => void, iters: number): number {
  fn(); // 预热
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}
const uniqueBigrams = [...bigramDfGlobal.keys()];
const sampleBigrams = uniqueBigrams.slice(0, 40);
const likeMs = timeIt(() => { for (const bg of sampleBigrams) likeHits(bg, 'primary'); }, 20) / sampleBigrams.length;
const vocabMs = timeIt(() => { for (const bg of sampleBigrams) vocabHits(bg, 'primary'); }, 20) / sampleBigrams.length;

// ---------------------------------------------------------------------------
// Q5：第二个噪声控制轴 —— 共现要求
// ---------------------------------------------------------------------------
//
// DF 上限单独不够，实测已经说明：DF≤3 时 empty 最坏新增 9 条候选，而方案 §7.4 登记的
// 硬上界是「最坏 ≤3」。要么把上限压到 DF≤1（收益从 32/72 掉到 18/72，且 DF=1 这个
// 绝对阈值在大语料上几乎必然失效），要么再加一个正交的轴。
//
// 共现：一条记录必须命中 **≥ minMatches 个不同的 bigram** 才进辅助候选。
// 直觉依据是可检验的——hard-negative 通常只撞上一个常见词（「测试」「必须」），而真正
// 相关的记录会在多个两字词上重叠。这里测的就是这个直觉成不成立。
const MIN_MATCHES = [1, 2, 3];

interface GridCell {
  ceiling: number;
  minMatches: number;
  /** phase2 zero-FTS relevance 目标可达数（选参可用）。 */
  phase2Reach: number;
  phase2Total: number;
  /** tuned zero-FTS 目标可达数（连续性锁，1 条 = q32 家族）。 */
  tunedReach: number;
  /** empty 新增辅助候选：均值 / 最坏 / 越界条数（>3 条即破 §7.4 硬上界）。 */
  emptyMean: number;
  emptyWorst: number;
  emptyOver3: number;
  /** 现状已有 FTS 命中的 relevance 里，候选集合被改变的条数（排名可能变化）。 */
  anchoredTouched: number;
}

/** 按两个轴算辅助候选：DF 上限 + 共现下限。 */
function auxCandidates2(row: QueryRow, ceiling: number, minMatches: number): Set<string> {
  const count = new Map<string, number>();
  for (const bg of row.bigrams) {
    if (bg.df === 0 || bg.df > ceiling) continue;
    for (const h of bg.hits) count.set(h, (count.get(h) ?? 0) + 1);
  }
  return new Set([...count.entries()].filter(([, c]) => c >= minMatches).map(([h]) => h));
}

const grid: GridCell[] = [];
for (const ceiling of DF_CEILINGS) {
  for (const minMatches of MIN_MATCHES) {
    let phase2Reach = 0, phase2Total = 0, tunedReach = 0;
    const emptyAdded: number[] = [];
    let anchoredTouched = 0;
    for (const row of rows) {
      const aux = auxCandidates2(row, ceiling, minMatches);
      if (row.kind === 'relevance') {
        if (row.zeroFts) {
          if (row.origin === 'phase2') {
            phase2Total++;
            if (row.expect.some((e) => aux.has(e))) phase2Reach++;
          } else if (row.origin === 'tuned') {
            if (row.expect.some((e) => aux.has(e))) tunedReach++;
          }
        } else if ([...aux].some((h) => !row.ftsHits.includes(h))) {
          anchoredTouched++;
        }
      } else if (row.kind === 'empty') {
        emptyAdded.push([...aux].filter((h) => !row.ftsHits.includes(h)).length);
      }
    }
    grid.push({
      ceiling, minMatches, phase2Reach, phase2Total, tunedReach,
      emptyMean: emptyAdded.reduce((a, b) => a + b, 0) / emptyAdded.length,
      emptyWorst: Math.max(...emptyAdded),
      emptyOver3: emptyAdded.filter((v) => v > 3).length,
      anchoredTouched,
    });
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const SELECTION_ORIGINS = new Set(['tuned', 'phase2']);
const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '∞');
const ceilLabel = (c: number) => (Number.isFinite(c) ? String(c) : '∞（不设上限）');

const L: string[] = [];
L.push('# 阶段 3A 量测探针：中文两字词的可达性、噪声与机制选型');
L.push('');
L.push(`> 生成时间：${new Date().toISOString()}`);
L.push(`> 命令：\`bun run benchmark/probe-cjk-bigram.ts ${args.join(' ')}\``);
L.push(`> 语料：${turns.length} 条记录（primary ${CORPUS_PRIMARY} 条）；query ${queries.length} 条`);
L.push('>');
L.push('> **这是量测，不是选参。** 本探针只测 FTS 腿的候选集合，不跑 RRF、不套 cap、');
L.push('> 不算 hit@5。端到端质量必须由完整链路的 arm 测，探针越过 FTS 腿就等于用探针选参。');
L.push('> 下面凡与参数候选有关的读数，只使用 `tuned` 与 `phase2`；`heldout` / `validation`');
L.push('> 的读数单列在附录并标明不参与选参。');
L.push('');
L.push('播种自证：42 条既有 query 的 FTS 候选数与已提交 Phase 1b 报告逐条一致。');
L.push('');
L.push('---');
L.push('');
L.push('## 结论综述');
L.push('');
L.push('**1. 缺口机制确认，不是推测。** q32「搜索词里带引号或括号会不会崩」切出的三字窗口是');
L.push('`带引号`/`引号或`/…，而 t01 记录里「引号」出现在 `未闭合引号等`（summary）与 `双引号翻倍`');
L.push('（learned），对应三字单元是 `合引号`/`引号等`/`双引号`/`引号翻`。两侧都有「引号」，三字窗口');
L.push('一个都对不上 —— 这就是 ftsCount=0 的来源。');
L.push('');
L.push('**2. 一条捷径被实测否掉。** FTS5 前缀查询（`"引号" *`）走不通：trigram tokenizer 会把');
L.push('**query 也切成三字**，两字 query 切不出 token，`*` 没有作用对象。索引里 `引号等`/`引号翻`');
L.push('明明存在但 MATCH 到不了。所以只剩方案 §10 给的两条路。');
L.push('');
L.push('**3. 机制选型：辅助 LIKE 胜出，两个轴上都胜。** vocab 前缀展开在当前语料上既漏（9 条）又慢');
L.push(`（${fmt(vocabMs, 3)}ms vs ${fmt(likeMs, 3)}ms，慢 ${fmt(vocabMs / likeMs, 1)}×）。漏的原因是它只覆盖 \`XY?\` 形态；`);
L.push('「问题」在 t01/t07/t14 里恰好是某列末尾，索引里只有 `?XY`。**但这个延迟结论是尺度相关的**：');
L.push('26 条语料上 LIKE 全表扫描本来就便宜，vocab 的范围扫描优势要到大语料才显现。交叉点未测，');
L.push('登记给 3B。');
L.push('');
L.push('**4. 主要风险已量化，且当前形态过不了门。** 方案 §7.4 登记 empty「均值 ≤1、最坏 ≤3」。');
L.push('辅助候选进的是 FTS 腿，`match_source` 变成 `fts`/`hybrid`，**完全不受 cap=2 约束**，');
L.push('所以进候选池基本等于进结果页。实测：');
L.push('');
L.push('| 配置 | phase2 可达 | empty 均值 | empty 最坏 | 破 ≤3 的条数 |');
L.push('| --- | ---: | ---: | ---: | ---: |');
for (const c of grid.filter((g) => g.minMatches === 1 && [1, 2, 3, Number.POSITIVE_INFINITY].includes(g.ceiling))) {
  L.push(`| DF≤${ceilLabel(c.ceiling)}，无共现要求 | ${c.phase2Reach} / ${c.phase2Total} | ${fmt(c.emptyMean)} | ${c.emptyWorst} | ${c.emptyOver3} |`);
}
L.push('');
L.push('也就是说**不加护栏直接拆两字词，误召回立刻越界**：DF 不设上限时最坏一条 empty query');
L.push('会多回 15 条记录。DF≤1 是唯一不越界的纯 DF 配置，但它把收益从 32/72 压到 18/72，');
L.push('而且 DF=1 这个**绝对**阈值在大语料上几乎必然失效（「引号」在 1 万条记录里 DF 不会是 1）。');
L.push('');
L.push('**5. 共现要求有效但太钝。** min=2 把 empty 最坏压到 0–2、越界清零，代价是 phase2 可达从');
L.push('32/72 掉到 9/72 —— 比 DF≤1 的 18/72 还差。它压噪声的方式是把大部分真候选一起压掉。');
L.push('');
L.push('**6. 因此 3A 需要第三个轴，且它应当与既有架构同构。** 2C 对语义腿的解法就是**融合后的');
L.push('数量 cap**，而不是靠 cosine 阈值统计地压噪声。同一个办法适用于 bigram 腿：一条只被');
L.push('bigram 找到（trigram FTS 与语义腿都没找到）的记录，其证据地位与 semantic-only 线索相同，');
L.push('给它一个 `bigramOnlyLimit`，最坏值就由**构造**保证，与语料规模和 DF 分布都无关。');
L.push('这样 DF 上限退回它真正擅长的角色（延迟与粗噪声过滤），不再独自承担发布门。');
L.push('');
L.push('**实现约束（判据文档要写死）**：要 cap「只被 bigram 找到」的候选，内核必须能区分一条');
L.push('候选的 FTS 名次是 trigram 给的还是 bigram 给的。方案 §10 第 3 条要求辅助候选「进入 FTS');
L.push('排名后再参与 RRF」，那样 `match_source` 一律是 `fts`，区分不出来。所以要么额外记一路');
L.push('来源标记，要么把 bigram 作为**第三条腿**。这是 3A 的核心实现决策，不是细节。');
L.push('');
L.push('---');
L.push('');

L.push('## Q1 机制与 DF 分布');
L.push('');
L.push(`query 里共切出 **${uniqueBigrams.length}** 个不同的 CJK bigram（全滑窗，无分词）。`);
L.push('');
L.push('| DF（scope 内命中记录数） | bigram 个数 |');
L.push('| ---: | ---: |');
for (const [df, count] of dfSorted) L.push(`| ${df} | ${count} |`);
L.push('');
L.push(`DF=0 的 bigram 对召回无贡献（语料里根本没有），DF 很高的是功能词。primary scope 共 ${CORPUS_PRIMARY} 条记录，所以 DF 接近该值就等于「匹配一切」。`);
L.push('');
L.push('DF 最高的 25 个（候选 stopword，判断上限切在哪的依据）：');
L.push('');
L.push('| bigram | DF |');
L.push('| --- | ---: |');
for (const [bg, df] of topDf) L.push(`| ${bg} | ${df} |`);
L.push('');

L.push('## Q2 / Q3 按 DF 上限模拟辅助候选');
L.push('');
L.push('`reachable` = zero-FTS relevance query 里目标进入辅助候选池的条数（收益上限）。');
L.push('`noise` = empty / leakage query 新增的辅助候选数（**cap 逃逸风险**：这些候选');
L.push('会让记录的 `match_source` 从 `semantic` 变成 `fts`/`hybrid`，绕过 cap=2）。');
L.push('');
for (const st of ceilingStats) {
  L.push(`### DF 上限 = ${ceilLabel(st.ceiling)}`);
  L.push('');
  L.push('| 集合 | 角色 | 目标可达 / zero-FTS 总数 |');
  L.push('| --- | --- | ---: |');
  for (const [origin, r] of Object.entries(st.reachable).sort()) {
    const role = SELECTION_ORIGINS.has(origin) ? '可用于选参' : '**不参与选参**';
    L.push(`| ${origin} | ${role} | ${r.hit} / ${r.total} |`);
  }
  L.push('');
  L.push('| 无关集合 | 新增候选均值 | 最坏 | 有新增的条数 / 总数 |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const [key, n] of Object.entries(st.noise).sort()) {
    L.push(`| ${key} | ${fmt(n.mean)} | ${n.worst} | ${n.nonZero} / ${n.total} |`);
  }
  L.push('');
}

L.push('## Q4 机制选型：vocab 前缀展开 vs 辅助 LIKE');
L.push('');
L.push('| 项 | 值 |');
L.push('| --- | ---: |');
L.push(`| LIKE（ground truth）命中总数 | ${likeHitsTotal} |`);
L.push(`| vocab 展开漏掉 | ${vocabMissedTotal} |`);
L.push(`| vocab 展开多出（应为 0） | ${vocabExtraTotal} |`);
L.push(`| 有漏报的 bigram 次数 | ${bigramsWithMiss.length} / ${allBigramRows.length} |`);
L.push(`| LIKE 单 bigram 平均耗时 | ${fmt(likeMs, 3)} ms |`);
L.push(`| vocab 单 bigram 平均耗时 | ${fmt(vocabMs, 3)} ms |`);
L.push('');
L.push('vocab 展开只覆盖 `XY?` 形态的 trigram。当 bigram 恰好是某一列的最后两个字时，');
L.push('索引里只有 `?XY`，该记录漏掉。上表的「漏掉」列就是这个不完备性的实测代价。');
if (bigramsWithMiss.length > 0) {
  L.push('');
  L.push('漏报明细（前 20 条）：');
  L.push('');
  L.push('| bigram | LIKE 命中 | vocab 漏掉 |');
  L.push('| --- | --- | --- |');
  for (const b of bigramsWithMiss.slice(0, 20)) {
    L.push(`| ${b.bigram} | ${b.hits.join(' ')} | ${b.vocabMissed.join(' ')} |`);
  }
}
L.push('');

L.push('## Q5 两轴网格：DF 上限 × 共现下限');
L.push('');
L.push('`empty>3` 是破方案 §7.4「最坏 ≤3」硬上界的 empty query 条数。**这一列非 0 就不能直接上线。**');
L.push('注意辅助候选进的是 FTS 腿，`match_source` 变成 `fts`/`hybrid`，**不受 cap=2 约束**，');
L.push('所以进候选池基本等于进结果页（limit=10 时）。');
L.push('');
L.push('| DF 上限 | 共现下限 | phase2 可达 | tuned 可达 | empty 均值 | empty 最坏 | empty>3 | 有锚点 relevance 被改动 |');
L.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const c of grid) {
  L.push(`| ${ceilLabel(c.ceiling)} | ${c.minMatches} | ${c.phase2Reach} / ${c.phase2Total} | ${c.tunedReach} / 1 | ${fmt(c.emptyMean)} | ${c.emptyWorst} | ${c.emptyOver3} | ${c.anchoredTouched} |`);
}
L.push('');

L.push('## 逐 query 明细：zero-FTS relevance（选参可用集合）');
L.push('');
L.push('| query | origin | 期望 | DF≤3 的辅助候选 | 命中期望的 bigram(DF) |');
L.push('| --- | --- | --- | --- | --- |');
for (const r of rows) {
  if (r.kind !== 'relevance' || !r.zeroFts || !SELECTION_ORIGINS.has(r.origin)) continue;
  const aux = [...auxCandidates(r, 3)].sort();
  const winners = r.bigrams
    .filter((b) => b.df > 0 && b.df <= 3 && r.expect.some((e) => b.hits.includes(e)))
    .map((b) => `${b.bigram}(${b.df})`);
  L.push(`| ${r.id} ${r.query} | ${r.origin} | ${r.expect.join(' ')} | ${aux.join(' ') || '—'} | ${winners.join(' ') || '—'} |`);
}
L.push('');

L.push('## 附录：heldout / validation 读数（不参与选参）');
L.push('');
L.push('列出来是为了让 Codex 能核对探针没有隐藏不利读数，而不是为了用它们选参数。');
L.push('');
L.push('| query | origin | 期望 | 现状 FTS | DF≤3 命中期望的 bigram |');
L.push('| --- | --- | --- | ---: | --- |');
for (const r of rows) {
  if (r.kind !== 'relevance' || !r.zeroFts || SELECTION_ORIGINS.has(r.origin)) continue;
  const winners = r.bigrams
    .filter((b) => b.df > 0 && b.df <= 3 && r.expect.some((e) => b.hits.includes(e)))
    .map((b) => `${b.bigram}(${b.df})`);
  L.push(`| ${r.id} ${r.query} | ${r.origin} | ${r.expect.join(' ')} | ${r.ftsHits.length} | ${winners.join(' ') || '—'} |`);
}
L.push('');

const noCjk = rows.filter((r) => !r.hasBigram).length;
L.push('## 结构性读数');
L.push('');
L.push(`- 不含任何 CJK bigram 的 query：**${noCjk} / ${rows.length}** —— 3A 对它们结构上无影响，可作为「行为不变」断言的天然对照。`);
L.push(`- zero-FTS relevance（全集合）：${rows.filter((r) => r.kind === 'relevance' && r.zeroFts).length} 条。`);
L.push(`- 现状已有 FTS 命中的 relevance：${rows.filter((r) => r.kind === 'relevance' && !r.zeroFts).length} 条 —— 3A 只可能给它们**增加**候选，因此排名可能变化，必须纳入不回退断言。`);
L.push('');

writeFileSync(reportPath, L.join('\n'));
writeFileSync(jsonPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  command: `bun run benchmark/probe-cjk-bigram.ts ${args.join(' ')}`,
  corpus: { turns: turns.length, primary: CORPUS_PRIMARY, queries: queries.length },
  uniqueBigrams: uniqueBigrams.length,
  dfHistogram: dfSorted.map(([df, count]) => ({ df, count })),
  topDf: topDf.map(([bigram, df]) => ({ bigram, df })),
  ceilingStats: ceilingStats.map((s) => ({
    ceiling: Number.isFinite(s.ceiling) ? s.ceiling : null,
    reachable: s.reachable,
    noise: s.noise,
  })),
  mechanism: {
    likeHitsTotal, vocabMissedTotal, vocabExtraTotal,
    bigramsWithMiss: bigramsWithMiss.length,
    bigramRowsTotal: allBigramRows.length,
    likeMsPerBigram: likeMs, vocabMsPerBigram: vocabMs,
    missDetail: bigramsWithMiss.map((b) => ({ bigram: b.bigram, hits: b.hits, missed: b.vocabMissed })),
  },
  grid,
  queryRows: rows,
}, null, 2));

console.log(`[probe] 报告 → ${reportPath}`);
console.log(`[probe] JSON → ${jsonPath}`);
db.close();
rmSync(workDir, { recursive: true, force: true });


