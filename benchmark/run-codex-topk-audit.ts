/**
 * Independent acceptance audit for topk-criteria.md §6.4.
 *
 * `precheck` seeds only text and verifies that every relevance query has zero FTS
 * candidates. It does not generate embeddings or execute a semantic arm. `run`
 * requires the exact input SHA to be frozen, then compares:
 *   baseline  = pool 200 / no Top-K truncation
 *   reference = pool Infinity / no Top-K truncation
 *   final     = shipped pool Infinity / semanticTopK 1000
 */
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import {
  DATASET_DIR,
  annotationToResult,
  loadAcpEnFixture,
  loadDataset,
  type DatasetTurn,
} from './dataset';
import type { RetrievalPolicy } from '../src/server/observation-search';

type AuditKind = 'relevance' | 'hard-negative';
interface AuditQuery {
  id: string;
  kind: AuditKind;
  query: string;
  semantic_query_en: string;
  gold: string[];
}
interface AuditInput {
  provenance: Record<string, unknown>;
  queries: AuditQuery[];
}

const arg = (name: string, fallback: string): string => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const mode = arg('mode', 'precheck');
if (mode !== 'precheck' && mode !== 'run') throw new Error('--mode must be precheck or run');

const inputPath = resolve(arg('input', join(import.meta.dir, 'reports/topk/codex-blind-audit-input.json')));
const freezePath = resolve(arg('freeze', join(import.meta.dir, 'reports/topk/codex-blind-audit-freeze.json')));
const jsonPath = resolve(arg('json', join(import.meta.dir, 'reports/topk/codex-blind-audit.json')));
const reportPath = resolve(arg('report', join(import.meta.dir, 'reports/topk/codex-blind-audit.md')));
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha16 = (bytes: string | Buffer): string => sha256(bytes).slice(0, 16);

const inputBytes = readFileSync(inputPath);
const inputSha256 = sha256(inputBytes);
const input = JSON.parse(inputBytes.toString('utf8')) as AuditInput;
const relevance = input.queries.filter((query) => query.kind === 'relevance');
const hardNegatives = input.queries.filter((query) => query.kind === 'hard-negative');
if (relevance.length < 20 || hardNegatives.length < 20) {
  throw new Error(`§6.4 requires at least 20+20 queries; got ${relevance.length}+${hardNegatives.length}`);
}
if (new Set(input.queries.map((query) => query.id)).size !== input.queries.length) {
  throw new Error('audit query ids must be unique');
}
for (const query of input.queries) {
  if ((query.kind === 'relevance') !== (query.gold.length > 0)) {
    throw new Error(`${query.id}: relevance must have gold and hard-negative must not`);
  }
}

const metaBytes = readFileSync(join(DATASET_DIR, 'phase3b-fixture-meta.json'));
const meta = JSON.parse(metaBytes.toString('utf8')) as {
  frozen?: boolean;
  recallScale?: { filler?: { sha256?: string } };
};
const fillerBytes = readFileSync(join(DATASET_DIR, 'phase3b-filler.json'));
const fixtureFillerSha16 = sha16(fillerBytes);
if (!meta.frozen || fixtureFillerSha16 !== meta.recallScale?.filler?.sha256) {
  throw new Error('phase3b 2,000-record fixture is not the registered frozen fixture');
}

if (mode === 'run') {
  const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as {
    frozen?: boolean;
    inputSha256?: string;
    fixtureFillerSha16?: string;
    semanticArmsRunBeforeFreeze?: boolean;
  };
  if (!freeze.frozen || freeze.inputSha256 !== inputSha256) {
    throw new Error(`audit input is not frozen at ${inputSha256}`);
  }
  if (freeze.fixtureFillerSha16 !== fixtureFillerSha16) {
    throw new Error('freeze file names a different phase3b filler fixture');
  }
  if (freeze.semanticArmsRunBeforeFreeze !== false) {
    throw new Error('freeze must explicitly record that no semantic arm ran before freezing');
  }
}

const dataset = loadDataset(DATASET_DIR);
const enFixture = loadAcpEnFixture(DATASET_DIR);
const filler = JSON.parse(fillerBytes.toString('utf8')) as Array<{
  id: string;
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
  files: string[];
}>;

const { MemoryDB, computeScopeKey } = await import('../src/db');
const {
  DEFAULT_RETRIEVAL_POLICY,
  hybridSearchObservations,
  validateRetrievalPolicy,
} = await import('../src/server/observation-search');
const {
  SEMANTIC_EN_PROTOCOL,
  checkSemanticEnQuery,
  embeddingSpaceKey,
  semanticEnSearchTextFields,
} = await import('../src/semantic-en');
const {
  DIMENSIONS,
  buildObservationSearchText,
  embeddingToBlob,
  generateEmbedding,
} = await import('../src/embedding');

for (const query of input.queries) {
  const checked = checkSemanticEnQuery(query.semantic_query_en, query.query);
  if (!checked.ok) {
    throw new Error(`${query.id}: invalid semantic_query_en (${checked.reason}: ${checked.detail})`);
  }
}
if (DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool !== Number.POSITIVE_INFINITY ||
    DEFAULT_RETRIEVAL_POLICY.semanticTopK !== 1000) {
  throw new Error(
    `shipped policy is pool=${DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool}, ` +
    `topK=${DEFAULT_RETRIEVAL_POLICY.semanticTopK}; expected Infinity + 1000`,
  );
}
if (DEFAULT_RETRIEVAL_POLICY.bigramAux !== false) {
  throw new Error('blind audit requires the frozen production policy with bigramAux=false');
}
const policies = {
  baseline: {
    ...DEFAULT_RETRIEVAL_POLICY,
    semanticCandidatePool: 200,
    semanticTopK: Number.POSITIVE_INFINITY,
  },
  reference: {
    ...DEFAULT_RETRIEVAL_POLICY,
    semanticCandidatePool: Number.POSITIVE_INFINITY,
    semanticTopK: Number.POSITIVE_INFINITY,
  },
  final: { ...DEFAULT_RETRIEVAL_POLICY },
} as const;
for (const [name, policy] of Object.entries(policies)) {
  const errors = validateRetrievalPolicy(policy);
  if (errors.length) throw new Error(`invalid ${name} policy: ${errors.join('; ')}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-codex-topk-audit-'));
const db = new MemoryDB(join(workDir, 'audit.sqlite'));
const spaceKey = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const scopeCwd = { primary: '/proj/kiro-mem', other: '/proj/other-app' } as const;
const primaryScope = computeScopeKey(scopeCwd.primary, scopeCwd.primary);
const targetByDataset = new Map<string, number>();
const datasetByObservation = new Map<number, string>();
const baseMs = Date.UTC(2026, 6, 1);
let clock = 0;

const insert = (record: {
  session: string;
  cwd: string;
  title: string;
  summary: string;
  outcome: string | null;
  learned: string | null;
  concepts: string[];
  files: string[];
  memoryType: string;
  prompt: string;
}): number => {
  if (!db.getSessionRef(record.session)) {
    db.upsertSessionRef({ session_id: record.session, cwd: record.cwd, repo: record.cwd });
  }
  const seq = db.allocateNextTurnSeq(record.session);
  const turn = db.createTurn({
    session_id: record.session,
    seq,
    cwd: record.cwd,
    repo: record.cwd,
    prompt_text: record.prompt,
  });
  const timestamp = new Date(baseMs + clock++ * 60_000).toISOString();
  db.markTurnClosed(turn.id, timestamp);
  const id = db.insertObservation({
    turn_id: turn.id,
    session_id: record.session,
    turn_seq: seq,
    repo: record.cwd,
    cwd_scope: record.cwd,
    title: record.title,
    summary: record.summary,
    outcome: record.outcome,
    learned: record.learned,
    memory_type: record.memoryType as never,
    files_touched: record.files,
    concepts: record.concepts,
    quality: 'normal',
    turn_started_at: timestamp,
    turn_stopped_at: timestamp,
  });
  if (id == null) throw new Error(`failed to insert ${record.title}`);
  return id;
};
const embed = async (id: number, text: string): Promise<void> => {
  const vector = await generateEmbedding(text);
  db.upsertObservationEmbedding(id, spaceKey, DIMENSIONS, embeddingToBlob(vector));
};

try {
  for (const turn of dataset.turns as DatasetTurn[]) {
    const normalized = enFixture.records[turn.id];
    if (!normalized) throw new Error(`missing frozen semantic English record for ${turn.id}`);
    const result = annotationToResult(turn.annotation);
    const cwd = scopeCwd[turn.scope];
    const id = insert({
      session: `s-${turn.scope}`,
      cwd,
      title: result.title,
      summary: result.summary,
      outcome: result.outcome,
      learned: result.learned,
      concepts: result.concepts,
      files: result.files_touched,
      memoryType: result.memory_type,
      prompt: turn.prompt,
    });
    db.upsertObservationSemanticText({
      observation_id: id,
      protocol: SEMANTIC_EN_PROTOCOL,
      status: 'ready',
      payload: normalized,
      translator: 'codex-topk-audit(frozen target)',
    });
    if (mode === 'run') {
      await embed(id, buildObservationSearchText(semanticEnSearchTextFields(normalized, result.files_touched)));
    }
    targetByDataset.set(turn.id, id);
    datasetByObservation.set(id, turn.id);
  }

  for (const record of filler) {
    const id = insert({
      session: 's-primary',
      cwd: scopeCwd.primary,
      title: record.title,
      summary: record.summary,
      outcome: record.outcome,
      learned: record.learned,
      concepts: record.concepts,
      files: record.files,
      memoryType: 'change',
      prompt: record.title,
    });
    const normalized = {
      title: record.title,
      summary: record.summary,
      outcome: record.outcome,
      learned: record.learned,
      concepts: record.concepts,
    };
    db.upsertObservationSemanticText({
      observation_id: id,
      protocol: SEMANTIC_EN_PROTOCOL,
      status: 'ready',
      payload: normalized,
      translator: 'codex-topk-audit(frozen filler)',
    });
    if (mode === 'run') {
      await embed(id, buildObservationSearchText(semanticEnSearchTextFields(normalized, record.files)));
    }
  }

  const newest200 = new Set(db.getRecentObservationIds({ scopeKey: primaryScope, days: 90, limit: 200 }));
  if (newest200.size !== 200) throw new Error(`fixture returned only ${newest200.size} recent ids`);
  for (const query of relevance) {
    for (const gold of query.gold) {
      const id = targetByDataset.get(gold);
      if (id == null) throw new Error(`${query.id}: unknown gold ${gold}`);
      if (newest200.has(id)) throw new Error(`${query.id}: gold ${gold} is inside the recent-200 pool`);
    }
  }

  const lexicalRows = input.queries.map((query) => {
    const ftsRows = db.searchObservationsFts(query.query, {
      scopeKey: primaryScope,
      days: 90,
      limit: 50,
    });
    return {
      id: query.id,
      kind: query.kind,
      ftsIds: ftsRows.map((row) => row.id),
      ftsTitles: ftsRows.map((row) => row.title),
    };
  });
  const lexicalViolations = lexicalRows.filter((row) => row.kind === 'relevance' && row.ftsIds.length > 0);
  if (lexicalViolations.length) {
    throw new Error(
      `zero-FTS relevance precheck failed: ` +
      lexicalViolations.map((row) => `${row.id}=${JSON.stringify(row.ftsTitles)}`).join(', '),
    );
  }

  if (mode === 'precheck') {
    console.log(JSON.stringify({
      mode,
      inputSha256,
      fixtureFillerSha16,
      relevance: relevance.length,
      hardNegatives: hardNegatives.length,
      zeroFtsRelevance: relevance.length,
      hardNegativeFtsCounts: lexicalRows
        .filter((row) => row.kind === 'hard-negative')
        .map((row) => ({ id: row.id, fts: row.ftsIds.length })),
      allGoldOutsideRecent200: true,
      semanticArmsExecuted: 0,
    }, null, 2));
  } else {
    interface QueryResult {
      id: string;
      kind: AuditKind;
      gold: string[];
      ftsIds: string[];
      semanticIds: string[];
      comparableVectors: number;
      aboveFloorCount: number;
      degraded: boolean;
      resultIds: string[];
      resultSources: string[];
      goldRank: number | null;
      semanticReachedGold: boolean;
      returned: number;
      semanticOnly: number;
    }
    const label = (id: number): string => datasetByObservation.get(id) ?? `db:${id}`;
    const runArm = async (policy: RetrievalPolicy): Promise<QueryResult[]> => {
      const rows: QueryResult[] = [];
      for (const query of input.queries) {
        let ftsIds: number[] = [];
        let semanticIds: number[] = [];
        let comparableVectors = 0;
        let aboveFloorCount = 0;
        let degraded = false;
        const results = await hybridSearchObservations(
          db,
          query.query,
          { scopeKey: primaryScope, days: 90, limit: 10, semanticQueryEn: query.semantic_query_en },
          {
            policy,
            onCandidates: (info) => {
              ftsIds = [...info.ftsRank.keys()];
              semanticIds = [...info.semanticRank.keys()];
              comparableVectors = info.comparableVectors;
              aboveFloorCount = info.aboveFloorCount;
            },
            onDegrade: () => { degraded = true; },
          },
        );
        const goldIds = new Set(query.gold.map((gold) => targetByDataset.get(gold)!));
        const goldIndex = results.findIndex((result) => goldIds.has(result.id));
        rows.push({
          id: query.id,
          kind: query.kind,
          gold: query.gold,
          ftsIds: ftsIds.map(label),
          semanticIds: semanticIds.map(label),
          comparableVectors,
          aboveFloorCount,
          degraded,
          resultIds: results.map((result) => label(result.id)),
          resultSources: results.map((result) => result.match_source),
          goldRank: goldIndex < 0 ? null : goldIndex + 1,
          semanticReachedGold: semanticIds.some((id) => goldIds.has(id)),
          returned: results.length,
          semanticOnly: results.filter((result) => result.match_source === 'semantic').length,
        });
      }
      return rows;
    };

    const baseline = await runArm(policies.baseline);
    const reference = await runArm(policies.reference);
    const final = await runArm(policies.final);
    const mean = (values: number[]): number => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
    const summarize = (rows: QueryResult[]) => {
      const rel = rows.filter((row) => row.kind === 'relevance');
      const neg = rows.filter((row) => row.kind === 'hard-negative');
      return {
        relevance: {
          n: rel.length,
          reached: rel.filter((row) => row.semanticReachedGold).length,
          hitAt5: rel.filter((row) => row.goldRank != null && row.goldRank <= 5).length / rel.length,
          mrr: mean(rel.map((row) => row.goldRank == null ? 0 : 1 / row.goldRank)),
        },
        hardNegative: {
          n: neg.length,
          meanReturned: mean(neg.map((row) => row.returned)),
          worstReturned: Math.max(...neg.map((row) => row.returned)),
          semanticOnlyMean: mean(neg.map((row) => row.semanticOnly)),
          semanticOnlyMax: Math.max(...neg.map((row) => row.semanticOnly)),
        },
        degraded: rows.filter((row) => row.degraded).length,
      };
    };
    const summaries = {
      baseline: summarize(baseline),
      reference: summarize(reference),
      final: summarize(final),
    };
    const baselineById = new Map(baseline.map((row) => [row.id, row]));
    const referenceById = new Map(reference.map((row) => [row.id, row]));
    const improvements = final.filter((after) => {
      const before = baselineById.get(after.id)!;
      return after.kind === 'relevance' &&
        !(before.goldRank != null && before.goldRank <= 5) &&
        after.goldRank != null && after.goldRank <= 5;
    }).map((row) => row.id);
    const regressions = final.filter((after) => {
      const before = baselineById.get(after.id)!;
      return after.kind === 'relevance' &&
        before.goldRank != null && before.goldRank <= 5 &&
        !(after.goldRank != null && after.goldRank <= 5);
    }).map((row) => row.id);

    const g5Violations: Array<{ query: string; id: string; source: string }> = [];
    const semanticCapViolations: Array<{ query: string; count: number }> = [];
    for (const after of final) {
      const before = baselineById.get(after.id)!;
      const beforePage = new Set(before.resultIds);
      const beforeFts = new Set(before.ftsIds);
      const semanticNew = after.resultIds.filter(
        (id, index) => !beforePage.has(id) && after.resultSources[index] === 'semantic',
      );
      if (semanticNew.length > DEFAULT_RETRIEVAL_POLICY.semanticOnlyLimit) {
        semanticCapViolations.push({ query: after.id, count: semanticNew.length });
      }
      for (const [index, id] of after.resultIds.entries()) {
        if (beforePage.has(id)) continue;
        const source = after.resultSources[index]!;
        if (source !== 'semantic' && !beforeFts.has(id)) {
          g5Violations.push({ query: after.id, id, source });
        }
      }
    }

    const pageDifferences: string[] = [];
    const sourceDifferences: string[] = [];
    const referenceGoldLostTop5: string[] = [];
    const referenceGoldLostPage: string[] = [];
    for (const after of final) {
      const ref = referenceById.get(after.id)!;
      if (JSON.stringify(after.resultIds) !== JSON.stringify(ref.resultIds)) pageDifferences.push(after.id);
      if (JSON.stringify(after.resultSources) !== JSON.stringify(ref.resultSources)) sourceDifferences.push(after.id);
      if (after.kind === 'relevance') {
        if (ref.goldRank != null && ref.goldRank <= 5 && !(after.goldRank != null && after.goldRank <= 5)) {
          referenceGoldLostTop5.push(after.id);
        }
        if (ref.goldRank != null && after.goldRank == null) referenceGoldLostPage.push(after.id);
      }
    }

    const gates = {
      "G5'": {
        pass: g5Violations.length === 0 && semanticCapViolations.length === 0,
        unexplainedAdditions: g5Violations,
        semanticCapViolations,
      },
      "G6'": {
        pass: referenceGoldLostTop5.length === 0 && referenceGoldLostPage.length === 0 &&
          pageDifferences.length === 0 && sourceDifferences.length === 0,
        referenceGoldLostTop5,
        referenceGoldLostPage,
        exactOrderedPageDifferences: pageDifferences,
        exactSourceDifferences: sourceDifferences,
      },
      G7: { pass: improvements.length > regressions.length, improvements, regressions },
      G8: {
        pass: summaries.final.hardNegative.meanReturned <= summaries.baseline.hardNegative.meanReturned + 0.5 &&
          summaries.final.hardNegative.meanReturned <= 4.06,
        baselineMean: summaries.baseline.hardNegative.meanReturned,
        finalMean: summaries.final.hardNegative.meanReturned,
        relativeCeiling: summaries.baseline.hardNegative.meanReturned + 0.5,
        absoluteCeiling: 4.06,
      },
      G10: {
        pass: summaries.final.hardNegative.semanticOnlyMean <= summaries.baseline.hardNegative.semanticOnlyMean + 0.5 &&
          summaries.final.hardNegative.semanticOnlyMax <= 2,
        baselineMean: summaries.baseline.hardNegative.semanticOnlyMean,
        finalMean: summaries.final.hardNegative.semanticOnlyMean,
        meanCeiling: summaries.baseline.hardNegative.semanticOnlyMean + 0.5,
        finalMax: summaries.final.hardNegative.semanticOnlyMax,
        maxCeiling: 2,
      },
      invariants: {
        pass: summaries.baseline.degraded === 0 && summaries.reference.degraded === 0 &&
          summaries.final.degraded === 0 && lexicalViolations.length === 0,
        baselineDegraded: summaries.baseline.degraded,
        referenceDegraded: summaries.reference.degraded,
        finalDegraded: summaries.final.degraded,
        zeroFtsRelevance: relevance.length,
        allGoldOutsideRecent200: true,
      },
    };
    const pass = Object.values(gates).every((gate) => gate.pass);
    const result = {
      provenance: {
        ...input.provenance,
        inputPath,
        inputSha256,
        freezePath,
        fixtureFillerSha16,
        policies: {
          baseline: 'semanticCandidatePool=200, semanticTopK=Infinity',
          reference: 'semanticCandidatePool=Infinity, semanticTopK=Infinity',
          final: 'semanticCandidatePool=Infinity, semanticTopK=1000',
        },
        generatedAt: new Date().toISOString(),
      },
      pass,
      summaries,
      gates,
      rows: { baseline, reference, final },
    };
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
    const lines = [
      '# Codex Top-K blind audit',
      '',
      `Result: **${pass ? 'PASS' : 'FAIL'}**`,
      '',
      `- Frozen input SHA-256: \`${inputSha256}\``,
      `- Fixture filler SHA-256/16: \`${fixtureFillerSha16}\``,
      `- Queries: ${relevance.length} zero-FTS relevance + ${hardNegatives.length} hard-negative`,
      `- Arms: pool 200 / no K; pool Infinity / no K reference; pool Infinity / K=1000 final`,
      '',
      '## Relevance',
      '',
      `- Baseline: reached ${summaries.baseline.relevance.reached}/${relevance.length}, hit@5 ${(summaries.baseline.relevance.hitAt5 * 100).toFixed(1)}%`,
      `- Reference: reached ${summaries.reference.relevance.reached}/${relevance.length}, hit@5 ${(summaries.reference.relevance.hitAt5 * 100).toFixed(1)}%`,
      `- Final: reached ${summaries.final.relevance.reached}/${relevance.length}, hit@5 ${(summaries.final.relevance.hitAt5 * 100).toFixed(1)}%`,
      '',
      '## Hard negatives',
      '',
      `- Baseline: mean returned ${summaries.baseline.hardNegative.meanReturned.toFixed(2)}, semantic-only mean/max ${summaries.baseline.hardNegative.semanticOnlyMean.toFixed(2)}/${summaries.baseline.hardNegative.semanticOnlyMax}`,
      `- Final: mean returned ${summaries.final.hardNegative.meanReturned.toFixed(2)}, semantic-only mean/max ${summaries.final.hardNegative.semanticOnlyMean.toFixed(2)}/${summaries.final.hardNegative.semanticOnlyMax}`,
      '',
      '## Gates',
      '',
      `- G5': ${gates["G5'"].pass ? 'PASS' : 'FAIL'} (${g5Violations.length} unexplained additions, ${semanticCapViolations.length} cap violations)`,
      `- G6': ${gates["G6'"].pass ? 'PASS' : 'FAIL'} (${pageDifferences.length} page differences vs full-scoring reference, ${sourceDifferences.length} source differences)`,
      `- G7: ${gates.G7.pass ? 'PASS' : 'FAIL'} (${improvements.length} improved vs ${regressions.length} regressed)`,
      `- G8: ${gates.G8.pass ? 'PASS' : 'FAIL'} (${gates.G8.finalMean.toFixed(2)} <= relative ${gates.G8.relativeCeiling.toFixed(2)} and absolute 4.06)`,
      `- G10: ${gates.G10.pass ? 'PASS' : 'FAIL'} (mean ${gates.G10.finalMean.toFixed(2)} <= ${gates.G10.meanCeiling.toFixed(2)}, max ${gates.G10.finalMax} <= 2)`,
      `- Invariants: ${gates.invariants.pass ? 'PASS' : 'FAIL'} (degrade ${summaries.baseline.degraded}/${summaries.reference.degraded}/${summaries.final.degraded})`,
      '',
      `Machine-readable detail: \`${jsonPath}\``,
      '',
    ];
    writeFileSync(reportPath, lines.join('\n'));
    console.log(lines.join('\n'));
    if (!pass) process.exitCode = 1;
  }
} finally {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
}
