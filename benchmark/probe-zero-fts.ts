/**
 * 零词面锚点探针（阶段 2A 的量具，方案 §6.2 第 9 项的前置工具）。
 *
 * 它回答一件在起草 Phase 2 校准集之前必须先知道的事：**一条"换了说法"的 query
 * 能不能真的做到 `ftsCount = 0`，产出率是多少。**
 *
 * 为什么必须先测：方案要求 ≥36 条 zero-FTS relevance query，而本 scope 只有 26 条
 * primary Observation，FTS 索引覆盖它们的 **9 个字段**（title / summary / request /
 * outcome / learned / next_steps / concepts_json / files_touched_json /
 * evidence_json）。`ftsCount = 0` 因此不是"与目标记录无词面重叠"，而是"与全库 26 条
 * 记录的 9 个字段都没有三字窗口重叠"——一个比直觉强得多的约束。36 这个数字是否现实，
 * 只能量，不能猜；量不到就如实报数量，不能凑。
 *
 * ## 纪律边界（方案 §6.2 第 9 项）
 *
 * 这个探针**只读 `ftsCount`**。它不加载模型、不算 cosine、不做融合、不看返回结果，
 * 所以它在物理上无法用于"按语义名次挑 query"——那正是 Gate A 要审的污染形式。
 * 筛选依据只有一条：FTS 候选数是不是 0。
 *
 * ## 自证：播种是否与生产等价
 *
 * 探针自己建 FTS 索引，所以它必须先证明这份索引与生产一致，否则测出来的 `ftsCount`
 * 是另一个语料的读数。`--self-check`（默认开）用已提交的 Phase 1b 报告里 42 条 query
 * 的 FTS 候选数作参照表逐条对账，不一致就直接退出。参照值取自
 * `benchmark/reports/gold-phase1b-{semantic-en,raw}.md` 的「逐 query 分路明细」，两份
 * 报告的该列**逐条相同**——FTS 腿吃的是原始中文 query，与向量协议无关，这也是它能
 * 当参照的原因。
 *
 * ## 用法
 *
 *   # 只跑自证（确认播种等价，不需要候选文件）
 *   bun run benchmark/probe-zero-fts.ts
 *
 *   # 测一批候选 query 的 ftsCount
 *   bun run benchmark/probe-zero-fts.ts --candidates=benchmark/dataset/phase2-draft.json
 *
 *   # 落盘报告
 *   bun run benchmark/probe-zero-fts.ts --candidates=... \
 *     --report=benchmark/reports/phase2-zero-fts-yield.md --json=/tmp/yield.json
 *
 * 命中的候选会连**是哪几个 FTS 单元命中了哪几条记录**一起报出来，这样改写是定向的
 * （删掉那个词），而不是靠猜。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadDataset, validateQueries, annotationToResult } from './dataset';
import type { DatasetQuery } from './dataset';

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const candidatesPath = flag('candidates') ? resolve(flag('candidates')!) : undefined;
const reportPath = flag('report') ? resolve(flag('report')!) : undefined;
const jsonPath = flag('json') ? resolve(flag('json')!) : undefined;
const skipSelfCheck = args.includes('--no-self-check');

/**
 * 已提交 Phase 1b 报告的 FTS 候选数参照表（42 条）。
 *
 * 它不是"期望值"而是**对账基准**：这份表由 `benchmark/run.ts` 走完整生产链路
 * （hook → job → insertObservation）产出，本探针走的是直接 `insertObservation`。
 * 两者若逐条相同，就证明本探针的 FTS 索引内容与生产等价；不同则说明播种漂移了，
 * 后面所有 `ftsCount = 0` 的判定都不可信。
 *
 * 来源：`gold-phase1b-semantic-en.md` / `gold-phase1b-raw.md` 的「逐 query 分路明细」
 * 的 `fts候选` 列（两份逐条相同）。
 */
const FTS_ORACLE: Record<string, number> = {
  q01: 4, q02: 6, q03: 8, q04: 3, q05: 1, q06: 8, q07: 4, q08: 0, q09: 5, q10: 3,
  q11: 11, q12: 1, q13: 12, q14: 3, q15: 2, q16: 3, q17: 1, q18: 1, q19: 0, q20: 5,
  q21: 0, q22: 0, q23: 0, q24: 0, q25: 3, q26: 3, q27: 1, q28: 0, q29: 0, q30: 0,
  q31: 1, q32: 0, q33: 0, q34: 1, q35: 1, q36: 0, q37: 0, q38: 5, q39: 1, q40: 0,
  q41: 1, q42: 0,
};

// 隔离：索引建在临时 SQLite 上，绝不碰开发者真实 ~/.kiro-mem（方案 §14 纪律 9）。
const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-probe-zerofts-'));
process.env.KIRO_MEMORY_DATA_DIR = join(workDir, 'data');
mkdirSync(process.env.KIRO_MEMORY_DATA_DIR, { recursive: true });

const { MemoryDB, computeScopeKey, extractFtsSearchUnits } = await import('../src/db');

const { turns, queries } = loadDataset();
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
// 播种：gold Observation → FTS 索引
// ---------------------------------------------------------------------------
//
// 字段映射走 `annotationToResult()`（dataset.ts 里那个唯一的"标注 → gold
// Observation"映射），列名对齐 `worker.ts` 的 `insertObservation` 调用。不加载模型、
// 不建向量、不跑 job：本探针只测 FTS 腿。

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

// ---------------------------------------------------------------------------
// 自证：与已提交报告对账
// ---------------------------------------------------------------------------

let selfCheckMismatches: string[] = [];
if (!skipSelfCheck) {
  for (const q of queries) {
    const expected = FTS_ORACLE[q.id];
    if (expected === undefined) continue; // 验证集不在参照表里（默认也不加载）
    const actual = ftsHits(q.query, q.scope).length;
    if (actual !== expected) {
      selfCheckMismatches.push(`${q.id}: 参照 ${expected} 条，本探针 ${actual} 条`);
    }
  }
  if (selfCheckMismatches.length) {
    console.error('[probe] 播种与生产不等价，FTS 候选数对账失败：');
    for (const m of selfCheckMismatches) console.error(`  ${m}`);
    console.error('[probe] 在修好之前，任何 ftsCount=0 的判定都不可信。');
    rmSync(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`[probe] 自证通过：42 条既有 query 的 FTS 候选数与已提交报告逐条一致。`);
}

// ---------------------------------------------------------------------------
// 候选评估
// ---------------------------------------------------------------------------

/** 候选草稿。字段是 `DatasetQuery` 的超集，通过后可直接提升进校准集。 */
interface Candidate extends DatasetQuery {
  /** 改写形状：口语改写 / 抽象概括 / 因果问法 / 故障表现 / 实现机制 / hard-negative 等。 */
  shape?: string;
}

interface CandidateRow {
  id: string;
  kind: string;
  shape: string;
  query: string;
  expect: string[];
  ftsCount: number;
  /** 命中的记录（数据集 id）。 */
  hits: string[];
  /** query 被切出的 FTS 单元。 */
  units: string[];
  /** 单独拿出来就能命中的单元 → 该单元命中了哪些记录。改写时删它。 */
  offenders: { unit: string; hits: string[] }[];
}

const candidateRows: CandidateRow[] = [];

if (candidatesPath) {
  if (!existsSync(candidatesPath)) {
    console.error(`[probe] 候选文件不存在：${candidatesPath}`);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(2);
  }
  const candidates = JSON.parse(readFileSync(candidatesPath, 'utf-8')) as Candidate[];

  // 起草期的自检：id 唯一、expect 指向真实记录、kind 与 expect 不矛盾。
  // 标注错的候选会静默变成一条"永远召回不到"的假 relevance。
  const draftErrors: string[] = [];
  const seenIds = new Set<string>();
  for (const c of candidates) {
    if (seenIds.has(c.id)) draftErrors.push(`${c.id}: id 重复`);
    seenIds.add(c.id);
    if (FTS_ORACLE[c.id] !== undefined) draftErrors.push(`${c.id}: id 与既有数据集冲突`);
    for (const e of c.expect) {
      if (!obsIdOf.has(e)) draftErrors.push(`${c.id}: expect 的 ${e} 不是数据集里的记录`);
    }
  }
  draftErrors.push(...validateQueries(candidates));
  if (draftErrors.length) {
    console.error('[probe] 候选草稿自检失败：');
    for (const e of draftErrors) console.error(`  ${e}`);
    rmSync(workDir, { recursive: true, force: true });
    process.exit(2);
  }

  for (const c of candidates) {
    const hits = ftsHits(c.query, c.scope);
    const units = extractFtsSearchUnits(c.query);
    // 逐单元定位命中来源。只在整条命中时做——没命中就没有要改的东西。
    const offenders = hits.length
      ? units
          .map((u) => ({ unit: u, hits: ftsHits(u, c.scope) }))
          .filter((x) => x.hits.length > 0)
      : [];
    candidateRows.push({
      id: c.id,
      kind: c.kind,
      shape: c.shape ?? '—',
      query: c.query,
      expect: c.expect,
      ftsCount: hits.length,
      hits,
      units,
      offenders,
    });
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const byKind = (k: string) => candidateRows.filter((r) => r.kind === k);
const zeroOf = (rows: CandidateRow[]) => rows.filter((r) => r.ftsCount === 0);
const rel = byKind('relevance');
const emp = byKind('empty');
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

const summary = {
  candidates: candidateRows.length,
  relevance: rel.length,
  relevanceZeroFts: zeroOf(rel).length,
  empty: emp.length,
  emptyZeroFts: zeroOf(emp).length,
  /** zero-FTS relevance 覆盖到的 primary 记录数（方案要求"覆盖尽可能多的记录"）。 */
  coveredRecords: new Set(zeroOf(rel).flatMap((r) => r.expect)).size,
  primaryRecords: turns.filter((t) => t.scope === 'primary').length,
};

console.log(
  `[probe] 候选 ${summary.candidates} 条：relevance ${summary.relevanceZeroFts}/${summary.relevance} 达到 ftsCount=0` +
    `（${pct(summary.relevanceZeroFts, summary.relevance)}）；` +
    `empty ${summary.emptyZeroFts}/${summary.empty}（${pct(summary.emptyZeroFts, summary.empty)}）；` +
    `覆盖记录 ${summary.coveredRecords}/${summary.primaryRecords}`,
);

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

if (reportPath) {
  const git = (a: string[]): string => {
    try {
      const p = Bun.spawnSync(['git', ...a], { cwd: join(import.meta.dir, '..') });
      return p.exitCode === 0 ? p.stdout.toString().trim() : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  const hashFile = (p: string): string => {
    try {
      const h = new Bun.CryptoHasher('sha256');
      h.update(readFileSync(p));
      return h.digest('hex').slice(0, 12);
    } catch {
      return 'unknown';
    }
  };

  const lines: string[] = [
    '# 零词面锚点产出率（阶段 2A 前置量具）',
    '',
    `> 生成时间：${new Date().toISOString()}`,
    `> commit：${git(['rev-parse', '--short', 'HEAD'])}（dirty=${git(['status', '--porcelain']) !== ''}）`,
    `> turns.json：${hashFile(join(import.meta.dir, 'dataset', 'turns.json'))}`,
    `> queries.json：${hashFile(join(import.meta.dir, 'dataset', 'queries.json'))}`,
    candidatesPath ? `> 候选文件：${candidatesPath}（${hashFile(candidatesPath)}）` : '> 候选文件：未提供（仅自证）',
    `> 探针：${hashFile(resolve(import.meta.path))}`,
    '',
    '本探针只读 FTS 候选数，不加载模型、不算 cosine、不做融合。筛选依据只有',
    '`ftsCount === 0` 一条（方案 §6.2 第 9 项）。',
    '',
    '## 播种自证',
    '',
    skipSelfCheck
      ? '⚠️ 本次运行跳过了自证（`--no-self-check`），读数不可用于校准集决策。'
      : '42 条既有 query 的 FTS 候选数与已提交 Phase 1b 报告**逐条一致**，'
        + '说明本探针的 FTS 索引内容与生产链路等价。',
    '',
  ];

  if (candidateRows.length) {
    lines.push(
      '## 产出率',
      '',
      '| 子集 | 候选数 | ftsCount=0 | 产出率 |',
      '| --- | ---: | ---: | ---: |',
      `| relevance | ${summary.relevance} | ${summary.relevanceZeroFts} | ${pct(summary.relevanceZeroFts, summary.relevance)} |`,
      `| empty | ${summary.empty} | ${summary.emptyZeroFts} | ${pct(summary.emptyZeroFts, summary.empty)} |`,
      '',
      `zero-FTS relevance 覆盖 primary 记录：**${summary.coveredRecords} / ${summary.primaryRecords}**`,
      '',
      '## 逐条明细',
      '',
      '| id | 类型 | 形状 | expect | ftsCount | 命中记录 | 命中单元 |',
      '| --- | --- | --- | --- | ---: | --- | --- |',
    );
    for (const r of candidateRows) {
      const off = r.offenders.map((o) => `\`${o.unit}\`→${o.hits.join(',')}`).join('; ') || '—';
      lines.push(
        `| ${r.id} | ${r.kind} | ${r.shape} | ${r.expect.join(',') || '—'} | ${r.ftsCount} | ${r.hits.join(',') || '—'} | ${off} |`,
      );
    }
    lines.push('', '### query 原文', '', '| id | query | FTS 单元 |', '| --- | --- | --- |');
    for (const r of candidateRows) {
      lines.push(`| ${r.id} | ${r.query} | ${r.units.map((u) => `\`${u}\``).join(' ')} |`);
    }
    lines.push('');
  }

  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  console.log(`[probe] 报告：${reportPath}`);
}

if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify({ summary, selfCheckSkipped: skipSelfCheck, rows: candidateRows }, null, 2),
    'utf-8',
  );
  console.log(`[probe] JSON：${jsonPath}`);
}

db.close();
rmSync(workDir, { recursive: true, force: true });
