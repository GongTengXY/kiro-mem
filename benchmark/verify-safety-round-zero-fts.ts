/**
 * P2 第 4 步：**零 FTS 声明的确认**（判据 §4.6）。
 *
 * 判据 §8.4 明确允许用 FTS 执行确认 `ftsCount = 0`——那是词面事实，不是相关性判断。
 * 本脚本只做这一件事，**不建向量、不跑语义腿、不产出任何 arm**：
 * 它 import 不到 `observation-search`，也 import 不到 embedding。
 *
 * 两类声明分别验：
 *
 *   - `empty-zero-fts` 40 条：`ftsCount` 必须为 **0**；任何一条非零即失败。
 *   - `lexical-anchor` 30 条：`ftsCount` 必须 **> 0**——判据 §4.4 的整个立意就是
 *     "有词面锚点但事实不成立"，锚点不命中的话这一层就退化成普通零 FTS 负例，
 *     覆盖不到 FTS / hybrid 绕过配额那条暴露面。
 *
 * ## 语料口径（判据 §4.6 冻结）
 *
 * 新 40 条 + 旧 26 条 primary + `pool-policy-filler-10k.json` 的 10,000 条原文。
 *
 * **副本不必真的播 5 份**：5 份副本是同一段文本，FTS 命中数会按份数成倍，但
 * "零 / 非零"这个判定与份数无关。因此这里播 1 份并把这一点写进报告——
 * 结论是"零"时，播 5 份仍然是零。
 *
 * 用法：bun run benchmark/verify-safety-round-zero-fts.ts
 */

import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { DATASET_DIR, annotationToResult, loadDataset } from './dataset';
import type { Annotation } from './dataset';
import { MemoryDB, computeScopeKey } from '../src/db';

const read = (p: string): any => JSON.parse(readFileSync(p, 'utf-8'));
const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const die = (m: string): never => { console.error(`[fts] ✗ ${m}`); process.exit(1); };

const OUT_DIR = join(import.meta.dir, 'reports', 'safety-round');
const freeze = read(join(OUT_DIR, 'p2-calibration-freeze.json'));
if (sha256(freeze.criteria) !== freeze.criteriaSha256) die('判据已被改动，冻结失效');

const QUERIES = join(DATASET_DIR, 'queries-safety-round.json');
const RECORDS = join(DATASET_DIR, 'turns-safety-round.json');
const FILLER = join(DATASET_DIR, 'pool-policy-filler-10k.json');
if (sha256(FILLER) !== freeze.ftsZeroCorpus.fillerSha256) die('filler 与冻结记录不一致');
if (sha256(join(DATASET_DIR, 'turns.json')) !== freeze.ftsZeroCorpus.oldPrimarySha256) die('旧语料与冻结记录不一致');

const newRecords = (read(RECORDS) as { records: { id: string; annotation: Annotation }[] }).records;
const queries = (read(QUERIES) as {
  queries: { id: string; kind: string; cohort: string; query: string; lexical_anchor?: string }[];
}).queries;
const filler = read(FILLER) as {
  id: string; title: string; summary: string; outcome: string; learned: string; concepts: string[]; files: string[];
}[];

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-p2-zero-fts-'));
const db = new MemoryDB(join(workDir, 'verify.sqlite'));
const cwd = '/safety-round/primary';
const scopeKey = computeScopeKey(cwd, cwd);
const idToLabel = new Map<number, string>();
let clock = 0;

const insert = (label: string, session: string, r: {
  title: string; summary: string; outcome: string | null; learned: string | null;
  concepts: string[]; files: string[]; memoryType: string;
}): void => {
  if (!db.getSessionRef(session)) db.upsertSessionRef({ session_id: session, cwd, repo: cwd });
  const seq = db.allocateNextTurnSeq(session);
  const turn = db.createTurn({ session_id: session, seq, cwd, repo: cwd, prompt_text: r.title });
  const ts = new Date(Date.UTC(2025, 0, 1) + clock++ * 60_000).toISOString();
  db.markTurnClosed(turn.id, ts);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: session, turn_seq: seq, repo: cwd, cwd_scope: cwd,
    title: r.title, summary: r.summary, outcome: r.outcome, learned: r.learned,
    memory_type: r.memoryType as never, files_touched: r.files, concepts: r.concepts,
    quality: 'normal', turn_started_at: ts, turn_stopped_at: ts,
  });
  if (id == null) throw new Error(`插入失败：${label}`);
  idToLabel.set(id, label);
};

try {
  for (const r of newRecords) {
    const a = annotationToResult(r.annotation);
    insert(r.id, 'safety-round-new', {
      title: a.title, summary: a.summary, outcome: a.outcome, learned: a.learned,
      concepts: a.concepts, files: a.files_touched, memoryType: a.memory_type,
    });
  }
  for (const t of loadDataset(DATASET_DIR).turns) {
    if (t.scope !== 'primary') continue;
    const a = annotationToResult(t.annotation);
    insert(t.id, 'old-gold', {
      title: a.title, summary: a.summary, outcome: a.outcome, learned: a.learned,
      concepts: a.concepts, files: a.files_touched, memoryType: a.memory_type,
    });
  }
  for (const f of filler) {
    insert(`filler:${f.id}`, 'filler', {
      title: f.title, summary: f.summary, outcome: f.outcome, learned: f.learned,
      concepts: f.concepts, files: f.files, memoryType: 'change',
    });
  }
  console.log(`[fts] 播种完成：新 ${newRecords.length} + 旧 26 + filler ${filler.length} = ${idToLabel.size} 行`);

  const rows = queries.map((q) => {
    const hits = db.searchObservationsFts(q.query, { scopeKey, limit: 50 });
    return {
      id: q.id,
      kind: q.kind,
      cohort: q.cohort,
      ftsCount: hits.length,
      ftsHits: hits.slice(0, 8).map((h) => idToLabel.get(h.id) ?? `id:${h.id}`),
      lexicalAnchor: q.lexical_anchor ?? null,
    };
  });

  const empty = rows.filter((r) => r.cohort === 'empty-zero-fts');
  const anchor = rows.filter((r) => r.cohort === 'lexical-anchor');
  const emptyViolations = empty.filter((r) => r.ftsCount !== 0);
  const anchorViolations = anchor.filter((r) => r.ftsCount === 0);

  const report = {
    step: 'P2 第 4 步：零 FTS 声明确认',
    criteria: { path: freeze.criteria, sha256: freeze.criteriaSha256, section: '§4.6 / §8.4' },
    corpus: {
      newRecords: newRecords.length,
      oldPrimary: 26,
      fillerDistinctTexts: filler.length,
      rowsSeeded: idToLabel.size,
      copiesNote:
        '判据 §4.6 的装置是 filler ×5 副本。副本是同一段文本，FTS 命中数按份数成倍，但零/非零判定与份数无关，因此这里播 1 份；结论为零时播 5 份仍为零。',
      vectorsBuilt: 0,
      semanticArmsExecuted: 0,
    },
    emptyZeroFts: {
      count: empty.length,
      allZero: emptyViolations.length === 0,
      violations: emptyViolations,
    },
    lexicalAnchor: {
      count: anchor.length,
      allHit: anchorViolations.length === 0,
      violations: anchorViolations,
      ftsCountMin: anchor.length ? Math.min(...anchor.map((r) => r.ftsCount)) : null,
      ftsCountMax: anchor.length ? Math.max(...anchor.map((r) => r.ftsCount)) : null,
    },
    perQuery: rows,
  };
  writeFileSync(join(OUT_DIR, 'p2-zero-fts-verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');

  console.log(`[fts] empty 零 FTS：${empty.length} 条，全为 0 = ${emptyViolations.length === 0}`);
  for (const v of emptyViolations) console.log(`   ✗ ${v.id} ftsCount=${v.ftsCount} → ${v.ftsHits.join(', ')}`);
  console.log(`[fts] 词面锚点：${anchor.length} 条，全部命中 = ${anchorViolations.length === 0}（ftsCount ${report.lexicalAnchor.ftsCountMin}…${report.lexicalAnchor.ftsCountMax}）`);
  for (const v of anchorViolations) console.log(`   ✗ ${v.id} 锚点「${v.lexicalAnchor}」未命中任何记录`);
  console.log(`[fts] 写入 ${join(OUT_DIR, 'p2-zero-fts-verification.json')}`);

  if (emptyViolations.length || anchorViolations.length) {
    die(`零 FTS 确认未通过：empty 违规 ${emptyViolations.length} 条 / 锚点未命中 ${anchorViolations.length} 条`);
  }
} finally {
  db.close?.();
  rmSync(workDir, { recursive: true, force: true });
}
