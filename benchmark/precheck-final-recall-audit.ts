/**
 * Text-only precheck for the final recall blind audit.
 *
 * This file deliberately does not import embedding or observation-search code.
 * It may validate labels, semantic_query_en guard outcomes, and FTS reachability,
 * but it cannot execute a semantic arm or expose a strategy result before freeze.
 */
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { DATASET_DIR, annotationToResult, loadDataset } from './dataset';
import { MemoryDB, computeScopeKey } from '../src/db';
import { checkSemanticEnQuery } from '../src/semantic-en';

type QueryKind = 'relevance' | 'hard-negative';
interface AuditQuery {
  id: string;
  kind: QueryKind;
  query: string;
  semantic_query_en: string;
  gold: string[];
}
interface RawControl {
  id: string;
  query: string;
  semantic_input_case: string;
  semantic_query_en: string | null;
  expected_lexical_gold: string[];
}
interface AuditInput {
  queries: AuditQuery[];
  raw_controls: RawControl[];
}
interface Filler {
  id: string;
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
  files: string[];
}

const inputPath = resolve(
  process.argv.find((value) => value.startsWith('--input='))?.slice('--input='.length) ??
    join(import.meta.dir, 'reports/final-recall/codex-blind-audit-input.json'),
);
const inputBytes = readFileSync(inputPath);
const input = JSON.parse(inputBytes.toString('utf8')) as AuditInput;
const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

if (new Set([...input.queries, ...input.raw_controls].map((query) => query.id)).size !==
    input.queries.length + input.raw_controls.length) {
  throw new Error('audit ids must be unique');
}
if (input.queries.filter((query) => query.kind === 'relevance').length < 20 ||
    input.queries.filter((query) => query.kind === 'hard-negative').length < 20) {
  throw new Error('audit requires at least 20 relevance and 20 hard-negative queries');
}

for (const query of input.queries) {
  const checked = checkSemanticEnQuery(query.semantic_query_en, query.query);
  if (!checked.ok) {
    throw new Error(`${query.id}: invalid semantic_query_en (${checked.reason}: ${checked.detail})`);
  }
  if ((query.kind === 'relevance') !== (query.gold.length > 0)) {
    throw new Error(`${query.id}: kind/gold mismatch`);
  }
}
for (const control of input.raw_controls) {
  const checked = control.semantic_query_en == null
    ? null
    : checkSemanticEnQuery(control.semantic_query_en, control.query);
  const actual = checked == null ? 'missing' : checked.ok ? 'ok' : checked.reason;
  if (actual !== control.semantic_input_case) {
    throw new Error(`${control.id}: expected ${control.semantic_input_case}, guard produced ${actual}`);
  }
}

const fillerPath = join(DATASET_DIR, 'pool-policy-filler-10k.json');
const fillerBytes = readFileSync(fillerPath);
const filler = JSON.parse(fillerBytes.toString('utf8')) as Filler[];
if (filler.length !== 10_000) throw new Error(`expected 10,000 filler records, got ${filler.length}`);

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-final-recall-precheck-'));
const db = new MemoryDB(join(workDir, 'precheck.sqlite'));
const cwd = '/final-recall/primary';
const scopeKey = computeScopeKey(cwd, cwd);
const observationByDataset = new Map<string, number>();
const datasetByObservation = new Map<number, string>();
let clock = 0;

const insert = (record: {
  session: string;
  title: string;
  summary: string;
  outcome: string | null;
  learned: string | null;
  concepts: string[];
  files: string[];
  memoryType: string;
}): number => {
  if (!db.getSessionRef(record.session)) {
    db.upsertSessionRef({ session_id: record.session, cwd, repo: cwd });
  }
  const seq = db.allocateNextTurnSeq(record.session);
  const turn = db.createTurn({
    session_id: record.session,
    seq,
    cwd,
    repo: cwd,
    prompt_text: record.title,
  });
  const timestamp = new Date(Date.UTC(2025, 0, 1) + clock++ * 60_000).toISOString();
  db.markTurnClosed(turn.id, timestamp);
  const id = db.insertObservation({
    turn_id: turn.id,
    session_id: record.session,
    turn_seq: seq,
    repo: cwd,
    cwd_scope: cwd,
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

try {
  for (const turn of loadDataset(DATASET_DIR).turns) {
    if (turn.scope !== 'primary') continue;
    const result = annotationToResult(turn.annotation);
    const id = insert({
      session: 'gold',
      title: result.title,
      summary: result.summary,
      outcome: result.outcome,
      learned: result.learned,
      concepts: result.concepts,
      files: result.files_touched,
      memoryType: result.memory_type,
    });
    observationByDataset.set(turn.id, id);
    datasetByObservation.set(id, turn.id);
  }
  for (const record of filler) {
    insert({
      session: 'filler',
      title: record.title,
      summary: record.summary,
      outcome: record.outcome,
      learned: record.learned,
      concepts: record.concepts,
      files: record.files,
      memoryType: 'change',
    });
  }

  const lexical = input.queries.map((query) => {
    const rows = db.searchObservationsFts(query.query, { scopeKey, limit: 50 });
    return {
      id: query.id,
      ftsCount: rows.length,
      ftsIds: rows.map((row) => datasetByObservation.get(row.id) ?? `filler:${row.id}`),
    };
  });
  const violations = lexical.filter((row) => row.ftsCount !== 0);
  if (violations.length) {
    throw new Error(`main query FTS precheck failed: ${JSON.stringify(violations)}`);
  }

  const raw = input.raw_controls.map((control) => {
    const rows = db.searchObservationsFts(control.query, { scopeKey, limit: 50 });
    const ids = rows.map((row) => datasetByObservation.get(row.id) ?? `filler:${row.id}`);
    const missingGold = control.expected_lexical_gold.filter((gold) => !ids.includes(gold));
    if (missingGold.length) {
      throw new Error(`${control.id}: FTS missed expected gold ${missingGold.join(', ')}`);
    }
    return { id: control.id, ftsCount: rows.length, ftsIds: ids };
  });

  console.log(JSON.stringify({
    mode: 'text-only-precheck',
    inputSha256: sha256(inputBytes),
    turnsSha256: sha256(readFileSync(join(DATASET_DIR, 'turns.json'))),
    fillerSha256: sha256(fillerBytes),
    relevance: input.queries.filter((query) => query.kind === 'relevance').length,
    hardNegatives: input.queries.filter((query) => query.kind === 'hard-negative').length,
    zeroFtsMainQueries: lexical.length,
    rawControls: raw,
    queryEmbeddingsGenerated: 0,
    storedVectorsRead: 0,
    semanticArmsExecuted: 0,
  }, null, 2));
} finally {
  db.close();
  rmSync(workDir, { recursive: true, force: true });
}
