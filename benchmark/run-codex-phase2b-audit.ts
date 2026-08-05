/**
 * Codex Gate B audit runner.
 *
 * This deliberately bypasses benchmark/run.ts selection metrics: the audit
 * input is a separate file and the report includes every returned id/score.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB, computeScopeKey } from '../src/db';
import type { MemoryType } from '../src/db/types';
import { annotationToResult, loadAcpEnFixture, loadDataset, type DatasetQuery } from './dataset';
import { buildObservationSearchText, embeddingToBlob, DIMENSIONS, generateEmbedding } from '../src/embedding';
import { SEMANTIC_EN_PROTOCOL, embeddingSpaceKey, checkSemanticEnQuery } from '../src/semantic-en';
import { hybridSearchObservations, type RetrievalPolicy } from '../src/server/observation-search';

function argValue(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  return resolve(value || fallback);
}

const inputPath = argValue(
  'input',
  join(import.meta.dir, 'reports/phase2b-codex-audit-input.json'),
);
const reportPath = argValue(
  'report',
  join(import.meta.dir, 'reports/phase2b-codex-audit.md'),
);
const jsonPath = argValue(
  'json',
  join(import.meta.dir, 'reports/phase2b-codex-audit.json'),
);
const ftsOnly = process.argv.includes('--fts-only');
const inputBytes = readFileSync(inputPath);
const inputSha256 = createHash('sha256').update(inputBytes).digest('hex');
const expectedShaPrefix = '--expected-input-sha256=';
const expectedInputSha256 = process.argv
  .find((arg) => arg.startsWith(expectedShaPrefix))
  ?.slice(expectedShaPrefix.length);
if (expectedInputSha256 && expectedInputSha256 !== inputSha256) {
  throw new Error(
    `audit input checksum mismatch: expected ${expectedInputSha256}, got ${inputSha256}`,
  );
}
const input = JSON.parse(inputBytes.toString('utf8')) as {
  provenance: Record<string, unknown>;
  queries: Array<DatasetQuery & { semantic_query_en: string; expect: string | null }>;
};
const dataset = loadDataset();
const fixture = loadAcpEnFixture();
const primary = dataset.turns.filter((t) => t.scope === 'primary');
const byId = new Map(primary.map((t) => [t.id, t]));
const scope = computeScopeKey(null, '/codex-gate-b-audit');
const otherScope = computeScopeKey(null, '/codex-gate-b-audit-other');
const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-codex-audit-'));
const db = new MemoryDB(join(workDir, 'audit.sqlite'));
const enSpace = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const obsIds = new Map<string, number>();

for (const turn of dataset.turns) {
  const cwd = turn.scope === 'primary' ? '/codex-gate-b-audit' : '/codex-gate-b-audit-other';
  const session = `codex-audit-${turn.id}`;
  db.upsertSessionRef({ session_id: session, cwd, repo: null });
  const seq = db.allocateNextTurnSeq(session);
  const sourceTurn = db.createTurn({ session_id: session, seq, cwd, repo: null, prompt_text: turn.prompt });
  db.markTurnClosed(sourceTurn.id);
  const result = annotationToResult(turn.annotation);
  const id = db.insertObservation({
    turn_id: sourceTurn.id,
    session_id: session,
    turn_seq: seq,
    repo: null,
    cwd_scope: cwd,
    ...result,
    memory_type: result.memory_type as MemoryType,
    quality: 'normal',
    turn_started_at: sourceTurn.started_at,
    turn_stopped_at: sourceTurn.stopped_at ?? sourceTurn.started_at,
  });
  if (id == null) throw new Error(`failed to seed ${turn.id}`);
  obsIds.set(turn.id, id);
  const rec = fixture.records[turn.id];
  if (rec) {
    const text = buildObservationSearchText({ ...rec, files: result.files_touched });
    db.upsertObservationEmbedding(id, enSpace, DIMENSIONS, embeddingToBlob(await generateEmbedding(text)));
  }
}

const rows: Array<Record<string, unknown>> = [];
// tie-break 是唯一可注入的字段（phase 2D）。floor / cap / rrfK / 权重刻意写死为 Gate B
// 选中值：这个 runner 的用途是在**冻结策略**上复算审计集，不是扫参入口。
const tieBreakArg =
  process.argv.find((arg) => arg.startsWith('--tie-break='))?.slice('--tie-break='.length) ??
  'recency';
if (tieBreakArg !== 'recency' && tieBreakArg !== 'source-confidence' && tieBreakArg !== 'semantic-rank') {
  throw new Error(`--tie-break=${tieBreakArg} 只接受 recency | source-confidence | semantic-rank`);
}
const policy: RetrievalPolicy = {
  semanticDiscovery: true,
  semanticFloor: 0.197,
  semanticOnlyLimit: 2,
  rrfK: 60,
  ftsWeight: 1,
  semanticWeight: 1,
  tieBreak: tieBreakArg,
  // 盲审集只有 40 条 query、语料 30 条，远小于 200，所以池大小对这份审计**不可能**有
  // 影响。写死 200 是为了让复跑得到的仍是当初被审的那个策略，而不是依赖默认值不变。
  semanticCandidatePool: 200,
  // 盲审集是 Gate B 建立的，那时没有 bigram 腿。保持关闭，否则复跑这份审计得到的
  // 就不是当初被审的那个策略。
  bigramAux: false,
  bigramDfRatioCeiling: 1,
  bigramMinMatches: 1,
  bigramOnlyLimit: 2,
  bigramWeight: 1,
  bigramVote: 'always',
  semanticTopK: Number.POSITIVE_INFINITY,
};

for (const q of input.queries) {
  const check = checkSemanticEnQuery(q.semantic_query_en, q.query);
  if (!check.ok) throw new Error(`${q.id}: invalid semantic_query_en (${check.reason})`);
  const fts = db.searchObservationsFts(q.query, { scopeKey: scope, days: 90, limit: 50 });
  let semanticCount = 0;
  const results = ftsOnly ? [] : await hybridSearchObservations(
      db,
      q.query,
      { scopeKey: scope, days: 90, limit: 10, semanticQueryEn: q.semantic_query_en },
      {
        policy,
        onCandidates: (info) => { semanticCount = info.semanticCount; },
      },
    );
  const expected = q.expect ? obsIds.get(q.expect) : undefined;
  const rank = expected == null ? 0 : results.findIndex((r) => r.id === expected) + 1;
  rows.push({
    id: q.id,
    kind: q.kind,
    query: q.query,
    expect: q.expect,
    ftsCount: fts.length,
    semanticCount,
    returned: results.length,
    hitAt5: q.kind === 'relevance' && rank > 0 && rank <= 5,
    reciprocalRank: q.kind === 'relevance' && rank > 0 ? 1 / rank : 0,
    expectedRank: rank,
    results: results.map((r) => ({ id: r.id, match_source: r.match_source, semantic_score: r.semantic_score })),
  });
}

const relevance = rows.filter((r) => r.kind === 'relevance');
const empty = rows.filter((r) => r.kind === 'empty');
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const hit = relevance.filter((r) => r.hitAt5).length;
const emptyReturns = empty.map((r) => Number(r.returned));
const result = {
  provenance: {
    ...input.provenance,
    policy,
    inputPath,
    inputSha256,
    expectedInputSha256: expectedInputSha256 ?? null,
    runMode: ftsOnly ? 'fts-only' : 'semantic',
    commandLine: process.argv,
    scope,
    generatedAt: new Date().toISOString(),
  },
  summary: {
    relevanceQueries: relevance.length,
    relevanceHitAt5: relevance.length ? hit / relevance.length : 0,
    relevanceMrr: mean(relevance.map((r) => Number(r.reciprocalRank))),
    emptyQueries: empty.length,
    emptyMeanReturned: mean(emptyReturns),
    emptyWorstReturned: Math.max(0, ...emptyReturns),
    allFtsCountsZero: rows.every((r) => r.ftsCount === 0),
    maxSemanticOnlyReturned: Math.max(0, ...rows.map((r) => Number(r.results instanceof Array ? r.results.filter((x: any) => x.match_source === 'semantic').length : 0))),
  },
  rows,
};
writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
const lines = [
  '# Codex Gate B audit', '',
  `Input: \`${inputPath}\``,
  `Input SHA-256: \`${inputSha256}\``,
  `Policy: discovery=on floor=${policy.semanticFloor} cap=${policy.semanticOnlyLimit} rrfK=${policy.rrfK} weights=${policy.ftsWeight}:${policy.semanticWeight} tie=${policy.tieBreak}`, '',
  `- relevance: ${relevance.length}`,
  `- relevance hit@5: ${(result.summary.relevanceHitAt5 * 100).toFixed(1)}%`,
  `- relevance MRR: ${result.summary.relevanceMrr.toFixed(3)}`,
  `- empty: ${empty.length}, mean/worst returned: ${result.summary.emptyMeanReturned.toFixed(2)} / ${result.summary.emptyWorstReturned}`,
  `- all FTS counts zero: ${result.summary.allFtsCountsZero ? 'yes' : 'NO'}`,
  `- max semantic-only returned: ${result.summary.maxSemanticOnlyReturned}`,
  '', '## Per-query results', '',
  '| id | kind | fts | semantic | returned | rank | results (id/source/score) |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- |',
];
for (const r of rows) lines.push(`| ${r.id} | ${r.kind} | ${r.ftsCount} | ${r.semanticCount} | ${r.returned} | ${r.expectedRank} | ${JSON.stringify(r.results)} |`);
writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(JSON.stringify({ mode: ftsOnly ? 'fts-only' : 'semantic', ...result.summary }, null, 2));
