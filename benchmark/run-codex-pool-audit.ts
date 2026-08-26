/**
 * Independent acceptance audit for pool-policy criteria §12.7.
 *
 * `--mode=precheck` only seeds the frozen fixture and checks lexical reachability.
 * It never executes a semantic arm. `--mode=run` additionally requires a freeze
 * file whose full SHA-256 matches the audit input, then compares pool 200 with
 * the shipped pool 20,000 and mechanically evaluates G7/G8/G10/G5'.
 */
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import {
  DATASET_DIR,
  annotationToResult,
  loadAcpEnFixture,
  loadDataset,
  type DatasetTurn,
} from './dataset';

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
  return process.argv.find((v) => v.startsWith(prefix))?.slice(prefix.length) ?? fallback;
};
const mode = arg('mode', 'precheck');
if (mode !== 'precheck' && mode !== 'run') throw new Error('--mode must be precheck or run');

const inputPath = resolve(arg('input', join(import.meta.dir, 'reports/pool-policy/codex-blind-audit-input.json')));
const freezePath = resolve(arg('freeze', join(import.meta.dir, 'reports/pool-policy/codex-blind-audit-freeze.json')));
const jsonPath = resolve(arg('json', join(import.meta.dir, 'reports/pool-policy/codex-blind-audit.json')));
const reportPath = resolve(arg('report', join(import.meta.dir, 'reports/pool-policy/codex-blind-audit.md')));
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const sha16 = (bytes: string | Buffer): string => sha256(bytes).slice(0, 16);

const inputBytes = readFileSync(inputPath);
const inputSha256 = sha256(inputBytes);
const input = JSON.parse(inputBytes.toString('utf8')) as AuditInput;
const relevance = input.queries.filter((q) => q.kind === 'relevance');
const hardNegatives = input.queries.filter((q) => q.kind === 'hard-negative');
if (relevance.length < 20 || hardNegatives.length < 20) {
  throw new Error(`§12.7 requires at least 20+20 queries; got ${relevance.length}+${hardNegatives.length}`);
}
if (new Set(input.queries.map((q) => q.id)).size !== input.queries.length) {
  throw new Error('audit query ids must be unique');
}
for (const q of input.queries) {
  if ((q.kind === 'relevance') !== (q.gold.length > 0)) {
    throw new Error(`${q.id}: relevance must have gold and hard-negative must not`);
  }
}

const metaBytes = readFileSync(join(DATASET_DIR, 'phase3b-fixture-meta.json'));
const meta = JSON.parse(metaBytes.toString('utf8')) as {
  frozen?: boolean;
  recallScale?: { filler?: { sha256?: string } };
};
const fillerBytes = readFileSync(join(DATASET_DIR, 'phase3b-filler.json'));
if (!meta.frozen || sha16(fillerBytes) !== meta.recallScale?.filler?.sha256) {
  throw new Error('phase3b 2,000-record fixture is not the registered frozen fixture');
}

if (mode === 'run') {
  const freeze = JSON.parse(readFileSync(freezePath, 'utf8')) as {
    frozen?: boolean;
    inputSha256?: string;
    fixtureFillerSha16?: string;
  };
  if (!freeze.frozen || freeze.inputSha256 !== inputSha256) {
    throw new Error(`audit input is not frozen at ${inputSha256}`);
  }
  if (freeze.fixtureFillerSha16 !== sha16(fillerBytes)) {
    throw new Error('freeze file names a different phase3b filler fixture');
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

for (const q of input.queries) {
  const checked = checkSemanticEnQuery(q.semantic_query_en, q.query);
  if (!checked.ok) throw new Error(`${q.id}: invalid semantic_query_en (${checked.reason}: ${checked.detail})`);
}

if (DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool !== 20_000) {
  throw new Error(`shipped semanticCandidatePool is ${DEFAULT_RETRIEVAL_POLICY.semanticCandidatePool}, expected 20000`);
}
if (DEFAULT_RETRIEVAL_POLICY.bigramAux !== false) {
  throw new Error('blind audit requires the frozen production policy with bigramAux=false');
}
for (const pool of [200, 20_000]) {
  const errors = validateRetrievalPolicy({ ...DEFAULT_RETRIEVAL_POLICY, semanticCandidatePool: pool });
  if (errors.length) throw new Error(`invalid pool=${pool} policy: ${errors.join('; ')}`);
}

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-codex-pool-audit-'));
const db = new MemoryDB(join(workDir, 'audit.sqlite'));
const SPACE_KEY = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const SCOPE_CWD = { primary: '/proj/kiro-mem', other: '/proj/other-app' } as const;
const primaryScope = computeScopeKey(SCOPE_CWD.primary, SCOPE_CWD.primary);
const targetByDataset = new Map<string, number>();
const datasetByObs = new Map<number, string>();

const baseMs = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 30 * 86_400_000;
})();
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
  const ts = new Date(baseMs + clock++ * 60_000).toISOString();
  db.markTurnClosed(turn.id, ts);
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
    turn_started_at: ts,
    turn_stopped_at: ts,
  });
  if (id == null) throw new Error(`failed to insert ${record.title}`);
  return id;
};
const embed = async (id: number, text: string): Promise<void> => {
  db.upsertObservationEmbedding(id, SPACE_KEY, DIMENSIONS, embeddingToBlob(await generateEmbedding(text)));
};

try {
  for (const turn of dataset.turns as DatasetTurn[]) {
    const normalized = enFixture.records[turn.id];
    if (!normalized) throw new Error(`missing frozen semantic English record for ${turn.id}`);
    const result = annotationToResult(turn.annotation);
    const cwd = SCOPE_CWD[turn.scope];
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
      translator: 'codex-audit(frozen phase3b target)',
    });
    await embed(id, buildObservationSearchText(semanticEnSearchTextFields(normalized, result.files_touched)));
    targetByDataset.set(turn.id, id);
    datasetByObs.set(id, turn.id);
  }

  for (const record of filler) {
    const id = insert({
      session: 's-primary',
      cwd: SCOPE_CWD.primary,
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
      translator: 'codex-audit(frozen phase3b filler)',
    });
    await embed(id, buildObservationSearchText(semanticEnSearchTextFields(normalized, record.files)));
  }

  const newest200 = new Set(db.getRecentObservationIds({ scopeKey: primaryScope, days: 90, limit: 200 }));
  if (newest200.size !== 200) throw new Error(`fixture returned only ${newest200.size} recent ids`);
  for (const q of relevance) {
    for (const gold of q.gold) {
      const id = targetByDataset.get(gold);
      if (id == null) throw new Error(`${q.id}: unknown gold ${gold}`);
      if (newest200.has(id)) throw new Error(`${q.id}: gold ${gold} is inside the recent-200 pool`);
    }
  }

  const lexicalRows = input.queries.map((q) => ({
    id: q.id,
    kind: q.kind,
    ftsIds: db.searchObservationsFts(q.query, { scopeKey: primaryScope, days: 90, limit: 50 }).map((r) => r.id),
  }));
  const lexicalViolations = lexicalRows.filter((r) => r.kind === 'relevance' && r.ftsIds.length > 0);
  if (lexicalViolations.length) {
    throw new Error(`zero-FTS relevance precheck failed: ${lexicalViolations.map((r) => `${r.id}=${r.ftsIds.length}`).join(', ')}`);
  }

  if (mode === 'precheck') {
    console.log(JSON.stringify({
      mode,
      inputSha256,
      fixtureFillerSha16: sha16(fillerBytes),
      relevance: relevance.length,
      hardNegatives: hardNegatives.length,
      zeroFtsRelevance: relevance.length,
      hardNegativeFtsCounts: lexicalRows.filter((r) => r.kind === 'hard-negative').map((r) => ({ id: r.id, fts: r.ftsIds.length })),
      allGoldOutsideRecent200: true,
    }, null, 2));
    process.exitCode = 0;
  } else {
    interface QueryResult {
      id: string;
      kind: AuditKind;
      gold: string[];
      ftsIds: string[];
      semanticIds: string[];
      comparableVectors: number;
      degraded: boolean;
      resultIds: string[];
      resultSources: string[];
      goldRank: number | null;
      semanticReachedGold: boolean;
      returned: number;
      semanticOnly: number;
    }
    const label = (id: number): string => datasetByObs.get(id) ?? `db:${id}`;
    const runPool = async (pool: number): Promise<QueryResult[]> => {
      const rows: QueryResult[] = [];
      for (const q of input.queries) {
        let ftsIds: number[] = [];
        let semanticIds: number[] = [];
        let comparableVectors = 0;
        let degraded = false;
        const results = await hybridSearchObservations(
          db,
          q.query,
          { scopeKey: primaryScope, days: 90, limit: 10, semanticQueryEn: q.semantic_query_en },
          {
            policy: { ...DEFAULT_RETRIEVAL_POLICY, semanticCandidatePool: pool },
            onCandidates: (info) => {
              ftsIds = [...info.ftsRank.keys()];
              semanticIds = [...info.semanticRank.keys()];
              comparableVectors = info.comparableVectors;
            },
            onDegrade: () => { degraded = true; },
          },
        );
        const goldIds = new Set(q.gold.map((id) => targetByDataset.get(id)!));
        const index = results.findIndex((r) => goldIds.has(r.id));
        rows.push({
          id: q.id,
          kind: q.kind,
          gold: q.gold,
          ftsIds: ftsIds.map(label),
          semanticIds: semanticIds.map(label),
          comparableVectors,
          degraded,
          resultIds: results.map((r) => label(r.id)),
          resultSources: results.map((r) => r.match_source),
          goldRank: index < 0 ? null : index + 1,
          semanticReachedGold: semanticIds.some((id) => goldIds.has(id)),
          returned: results.length,
          semanticOnly: results.filter((r) => r.match_source === 'semantic').length,
        });
      }
      return rows;
    };

    const baseline = await runPool(200);
    const final = await runPool(20_000);
    const mean = (xs: number[]): number => xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
    const summarize = (rows: QueryResult[]) => {
      const rel = rows.filter((r) => r.kind === 'relevance');
      const neg = rows.filter((r) => r.kind === 'hard-negative');
      return {
        relevance: {
          n: rel.length,
          reached: rel.filter((r) => r.semanticReachedGold).length,
          hitAt5: rel.filter((r) => r.goldRank != null && r.goldRank <= 5).length / rel.length,
          mrr: mean(rel.map((r) => r.goldRank == null ? 0 : 1 / r.goldRank)),
        },
        hardNegative: {
          n: neg.length,
          meanReturned: mean(neg.map((r) => r.returned)),
          worstReturned: Math.max(...neg.map((r) => r.returned)),
          semanticOnlyMean: mean(neg.map((r) => r.semanticOnly)),
          semanticOnlyMax: Math.max(...neg.map((r) => r.semanticOnly)),
        },
        degraded: rows.filter((r) => r.degraded).length,
      };
    };
    const baselineSummary = summarize(baseline);
    const finalSummary = summarize(final);
    const baselineById = new Map(baseline.map((r) => [r.id, r]));
    const improvements = final.filter((r) => {
      const before = baselineById.get(r.id)!;
      return r.kind === 'relevance' && !(before.goldRank != null && before.goldRank <= 5) && r.goldRank != null && r.goldRank <= 5;
    }).map((r) => r.id);
    const regressions = final.filter((r) => {
      const before = baselineById.get(r.id)!;
      return r.kind === 'relevance' && before.goldRank != null && before.goldRank <= 5 && !(r.goldRank != null && r.goldRank <= 5);
    }).map((r) => r.id);

    const g5Violations: Array<{ query: string; id: string; source: string }> = [];
    for (const after of final) {
      const before = baselineById.get(after.id)!;
      const beforePage = new Set(before.resultIds);
      const beforeFts = new Set(before.ftsIds);
      const newSemantic = after.resultIds.filter((id, i) => !beforePage.has(id) && after.resultSources[i] === 'semantic');
      for (const [index, id] of after.resultIds.entries()) {
        if (beforePage.has(id)) continue;
        const source = after.resultSources[index]!;
        const semanticBound = source === 'semantic' && newSemantic.length <= DEFAULT_RETRIEVAL_POLICY.semanticOnlyLimit;
        if (!semanticBound && !beforeFts.has(id)) g5Violations.push({ query: after.id, id, source });
      }
    }

    const gates = {
      G7: { pass: improvements.length > regressions.length, improvements, regressions },
      G8: {
        pass: finalSummary.hardNegative.meanReturned <= baselineSummary.hardNegative.meanReturned + 0.5 &&
          finalSummary.hardNegative.meanReturned <= 4.06,
        baselineMean: baselineSummary.hardNegative.meanReturned,
        finalMean: finalSummary.hardNegative.meanReturned,
        relativeCeiling: baselineSummary.hardNegative.meanReturned + 0.5,
        absoluteCeiling: 4.06,
      },
      G10: {
        pass: finalSummary.hardNegative.semanticOnlyMean <= baselineSummary.hardNegative.semanticOnlyMean + 0.5 &&
          finalSummary.hardNegative.semanticOnlyMax <= 2,
        baselineMean: baselineSummary.hardNegative.semanticOnlyMean,
        finalMean: finalSummary.hardNegative.semanticOnlyMean,
        meanCeiling: baselineSummary.hardNegative.semanticOnlyMean + 0.5,
        finalMax: finalSummary.hardNegative.semanticOnlyMax,
        maxCeiling: 2,
      },
      "G5'": { pass: g5Violations.length === 0, violations: g5Violations },
      invariants: {
        pass: baselineSummary.degraded === 0 && finalSummary.degraded === 0 && lexicalViolations.length === 0,
        baselineDegraded: baselineSummary.degraded,
        finalDegraded: finalSummary.degraded,
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
        fixtureFillerSha16: sha16(fillerBytes),
        policyBaseline: 200,
        policyFinal: 20_000,
        generatedAt: new Date().toISOString(),
      },
      pass,
      baseline: baselineSummary,
      final: finalSummary,
      gates,
      rows: { baseline, final },
    };
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, JSON.stringify(result, null, 2) + '\n');
    const lines = [
      '# Codex pool-policy blind audit',
      '',
      `Result: **${pass ? 'PASS' : 'FAIL'}**`,
      '',
      `- frozen input SHA-256: \`${inputSha256}\``,
      `- fixture filler SHA-16: \`${sha16(fillerBytes)}\``,
      `- queries: ${relevance.length} zero-FTS relevance + ${hardNegatives.length} hard-negative`,
      `- pool 200: reached ${baselineSummary.relevance.reached}/${relevance.length}, hit@5 ${(baselineSummary.relevance.hitAt5 * 100).toFixed(1)}%, hard-negative mean ${baselineSummary.hardNegative.meanReturned.toFixed(2)}, semantic-only mean/max ${baselineSummary.hardNegative.semanticOnlyMean.toFixed(2)}/${baselineSummary.hardNegative.semanticOnlyMax}`,
      `- pool 20000: reached ${finalSummary.relevance.reached}/${relevance.length}, hit@5 ${(finalSummary.relevance.hitAt5 * 100).toFixed(1)}%, hard-negative mean ${finalSummary.hardNegative.meanReturned.toFixed(2)}, semantic-only mean/max ${finalSummary.hardNegative.semanticOnlyMean.toFixed(2)}/${finalSummary.hardNegative.semanticOnlyMax}`,
      '',
      '## Gates',
      '',
      `- G7: ${gates.G7.pass ? 'PASS' : 'FAIL'} (${improvements.length} improved vs ${regressions.length} regressed)`,
      `- G8: ${gates.G8.pass ? 'PASS' : 'FAIL'} (${gates.G8.finalMean.toFixed(2)} <= relative ${gates.G8.relativeCeiling.toFixed(2)} and absolute 4.06)`,
      `- G10: ${gates.G10.pass ? 'PASS' : 'FAIL'} (mean ${gates.G10.finalMean.toFixed(2)} <= ${gates.G10.meanCeiling.toFixed(2)}, max ${gates.G10.finalMax} <= 2)`,
      `- G5': ${gates["G5'"].pass ? 'PASS' : 'FAIL'} (${g5Violations.length} violations)`,
      `- invariants: ${gates.invariants.pass ? 'PASS' : 'FAIL'} (degrade ${baselineSummary.degraded}/${finalSummary.degraded})`,
      '',
      'The JSON report contains every candidate set, result id, source, and gold rank for independent recomputation.',
    ];
    writeFileSync(reportPath, lines.join('\n') + '\n');
    console.log(JSON.stringify({ pass, baseline: baselineSummary, final: finalSummary, gates }, null, 2));
    if (!pass) process.exitCode = 1;
  }
} finally {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
}
