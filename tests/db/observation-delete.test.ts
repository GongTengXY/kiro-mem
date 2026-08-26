/**
 * Manual permanent deletion (plan §4, test matrix §10.1).
 *
 * The contract under test is deliberately narrow: one Observation id in, the
 * generated memory AND the turn truth it was projected from out, in a single
 * transaction — or nothing at all.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

interface Fixture {
  turnId: number;
  observationId: number;
  sessionId: string;
  scopeKey: string;
}

/**
 * A complete record: session ref, closed turn, three raw events, artifacts, one
 * Observation, both vector spaces, the semantic-en derived row, and the two jobs
 * the pipeline leaves behind.
 */
function seedRecord(opts?: {
  sessionId?: string;
  cwd?: string;
  repo?: string | null;
  title?: string;
  pinned?: boolean;
}): Fixture {
  const sessionId = opts?.sessionId ?? 'sess-1';
  const cwd = opts?.cwd ?? '/proj/a';
  // Repo follows cwd unless overridden: computeScopeKey prefers repo, so a fixed
  // default here would silently put every fixture in the SAME scope and make the
  // scope-isolation assertions vacuous.
  const repo = opts?.repo === undefined ? cwd : opts.repo;

  db.upsertSessionRef({ session_id: sessionId, cwd, repo });
  const seq = db.allocateNextTurnSeq(sessionId);
  const turn = db.createTurn({ session_id: sessionId, seq, cwd, repo, prompt_text: 'fix the auth token rotation' });

  db.appendTurnEvent({ turn_id: turn.id, session_id: sessionId, hook_event_name: 'userPromptSubmit', payload_json: '{"prompt":"fix the auth token rotation"}' });
  db.appendTurnEvent({ turn_id: turn.id, session_id: sessionId, hook_event_name: 'postToolUse', tool_name: 'shell', payload_json: '{"tool_response":"bun test ok"}' });
  db.appendTurnEvent({ turn_id: turn.id, session_id: sessionId, hook_event_name: 'stop', payload_json: '{}' });
  db.upsertTurnArtifacts(turn.id, { files_touched_json: JSON.stringify(['src/auth.ts']) });
  db.markTurnClosed(turn.id);

  const observationId = db.insertObservation({
    turn_id: turn.id,
    session_id: sessionId,
    turn_seq: turn.seq,
    repo,
    cwd_scope: cwd,
    title: opts?.title ?? 'Rotate auth token safely',
    summary: 'Token rotation now regenerates instead of failing open',
    request: 'fix the auth token rotation',
    outcome: 'verified with bun test',
    learned: null,
    next_steps: null,
    memory_type: 'bugfix',
    files_touched: ['src/auth.ts'],
    concepts: ['auth'],
    evidence: ['bun test (exit 0)'],
    importance_score: 0.7,
    confidence_score: 0.8,
    unresolved_score: 0,
    quality: 'normal',
    turn_started_at: turn.started_at,
    turn_stopped_at: turn.stopped_at ?? turn.started_at,
  })!;
  if (opts?.pinned) db.pinObservation(observationId, true);

  db.upsertObservationEmbedding(observationId, 'all-MiniLM-L6-v2:f32:384:raw-v1', 384, Buffer.alloc(384 * 4, 1));
  db.upsertObservationEmbedding(observationId, 'all-MiniLM-L6-v2:f32:384:semantic-en-v1', 384, Buffer.alloc(384 * 4, 2));
  db.upsertObservationSemanticText({
    observation_id: observationId,
    protocol: 'semantic-en-v1',
    status: 'ready',
    payload: { title: 'Rotate auth token safely', summary: 's', outcome: 'o', learned: '', concepts: ['auth'] },
    translator: 'acp:kiro-mem-compressor',
    translator_version: '3.0.0',
    attempts: 1,
    failure_reason: null,
  });

  // Terminal + active queue rows across BOTH entity kinds.
  db.enqueueJob({ job_type: 'summarize_turn', dedupe_key: `turn:${turn.id}`, entity_type: 'turn', entity_id: String(turn.id), payload_json: JSON.stringify({ turn_id: turn.id }) });
  db.raw.run("UPDATE jobs SET state = 'succeeded' WHERE entity_type = 'turn' AND entity_id = ?", [String(turn.id)]);
  db.enqueueJob({ job_type: 'embed_observation', dedupe_key: `embed:obs:${observationId}`, entity_type: 'observation', entity_id: String(observationId), payload_json: JSON.stringify({ observation_id: observationId }) });

  return { turnId: turn.id, observationId, sessionId, scopeKey: db.getObservation(observationId)!.scope_key };
}

function count(sql: string, ...params: (string | number)[]): number {
  return (db.raw.query(sql).get(...params) as { c: number }).c;
}

function rowCounts(f: Fixture) {
  return {
    observations: count('SELECT COUNT(*) AS c FROM observations WHERE id = ?', f.observationId),
    embeddings: count('SELECT COUNT(*) AS c FROM observation_embeddings WHERE observation_id = ?', f.observationId),
    semanticTexts: count('SELECT COUNT(*) AS c FROM observation_semantic_texts WHERE observation_id = ?', f.observationId),
    turns: count('SELECT COUNT(*) AS c FROM turns WHERE id = ?', f.turnId),
    events: count('SELECT COUNT(*) AS c FROM turn_events WHERE turn_id = ?', f.turnId),
    artifacts: count('SELECT COUNT(*) AS c FROM turn_artifacts WHERE turn_id = ?', f.turnId),
    jobs: count(
      "SELECT COUNT(*) AS c FROM jobs WHERE (entity_type = 'turn' AND entity_id = ?) OR (entity_type = 'observation' AND entity_id = ?)",
      String(f.turnId),
      String(f.observationId),
    ),
    sessionRefs: count('SELECT COUNT(*) AS c FROM session_refs WHERE session_id = ?', f.sessionId),
  };
}

describe('deleteObservationWithTruth', () => {
  test('§10.1-1 removes the Observation, both derived tables, the turn truth and related jobs', () => {
    const f = seedRecord();
    expect(rowCounts(f)).toEqual({
      observations: 1, embeddings: 2, semanticTexts: 1,
      turns: 1, events: 3, artifacts: 1, jobs: 2, sessionRefs: 1,
    });

    const result = db.deleteObservationWithTruth(f.observationId);
    expect(result).toEqual({
      ok: true, observationId: f.observationId, turnId: f.turnId, scopeKey: f.scopeKey,
    });

    expect(rowCounts(f)).toEqual({
      observations: 0, embeddings: 0, semanticTexts: 0,
      turns: 0, events: 0, artifacts: 0, jobs: 0,
      // The session is still `active`, so its isolation metadata stays — it has
      // to keep allocating turn seqs for the conversation that is running.
      // §10.1-6 covers the idle case where the ref is cleaned up.
      sessionRefs: 1,
    });
    // And it is gone from every read surface, not just its own table.
    expect(db.getObservation(f.observationId)).toBeNull();
    expect(db.getObservationByTurnId(f.turnId)).toBeNull();
    expect(db.getObservationsByIds([f.observationId])).toEqual([]);
    expect(db.getRecentObservations({ scopeKey: f.scopeKey, limit: 10 })).toEqual([]);
    expect(db.getTurn(f.turnId)).toBeNull();
  });

  test('§10.1-2 FTS no longer matches the deleted text and foreign_key_check is empty', () => {
    const f = seedRecord({ title: 'Rotate auth token safely' });
    expect(db.searchObservationsFts('rotation', { limit: 10 }).length).toBeGreaterThan(0);

    expect(db.deleteObservationWithTruth(f.observationId).ok).toBe(true);

    expect(db.searchObservationsFts('rotation', { limit: 10 })).toEqual([]);
    // The external-content FTS index must be consistent, not merely empty of hits.
    const ftsRows = count('SELECT COUNT(*) AS c FROM observations_fts');
    expect(ftsRows).toBe(0);
    expect(db.raw.query("INSERT INTO observations_fts(observations_fts) VALUES('integrity-check')").all()).toEqual([]);
    expect(db.raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('§10.1-3 a failure mid-transaction leaves every table byte-identical', () => {
    const f = seedRecord();
    const before = rowCounts(f);

    // A trigger that raises on the turn delete: the Observation and both derived
    // tables are already gone at that point, so anything less than a full
    // rollback would leave a half-deleted record.
    db.raw.exec(`
      CREATE TRIGGER inject_failure BEFORE DELETE ON turns BEGIN
        SELECT RAISE(ABORT, 'injected');
      END;
    `);
    expect(() => db.deleteObservationWithTruth(f.observationId)).toThrow();
    db.raw.exec('DROP TRIGGER inject_failure');

    expect(rowCounts(f)).toEqual(before);
    expect(db.getObservation(f.observationId)).not.toBeNull();
    expect(db.searchObservationsFts('rotation', { limit: 10 }).length).toBeGreaterThan(0);
    expect(db.raw.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('§10.1-4 both turn-entity and observation-entity jobs are recognised and deleted', () => {
    const f = seedRecord();
    // A dead turn job and a pending observation job — the two shapes a real
    // pipeline leaves behind, under different entity_type values.
    db.raw.run("UPDATE jobs SET state = 'dead' WHERE entity_type = 'turn'");
    const before = count(
      "SELECT COUNT(*) AS c FROM jobs WHERE entity_type IN ('turn','observation')",
    );
    expect(before).toBe(2);

    expect(db.deleteObservationWithTruth(f.observationId).ok).toBe(true);
    expect(count("SELECT COUNT(*) AS c FROM jobs WHERE entity_type IN ('turn','observation')")).toBe(0);
  });

  test('§10.1-5 a leased related job blocks the delete and changes nothing', () => {
    for (const entity of ['turn', 'observation'] as const) {
      const f = seedRecord({ sessionId: `sess-${entity}`, cwd: `/proj/${entity}` });
      const before = rowCounts(f);
      const entityId = entity === 'turn' ? String(f.turnId) : String(f.observationId);
      db.raw.run(
        "UPDATE jobs SET state = 'leased', leased_at = ?, lease_owner = 'runner' WHERE entity_type = ? AND entity_id = ?",
        [new Date().toISOString(), entity, entityId],
      );

      expect(db.deleteObservationWithTruth(f.observationId)).toEqual({
        ok: false, reason: 'deletion_in_progress',
      });
      expect(rowCounts(f)).toEqual(before);
    }
  });

  test('§10.1-6 the session_ref goes only when it has no other turn and is not active', () => {
    // Shared session: two turns, one deleted.
    const first = seedRecord({ sessionId: 'shared', cwd: '/proj/shared' });
    const second = seedRecord({ sessionId: 'shared', cwd: '/proj/shared' });
    db.setSessionRefState('shared', 'idle');
    expect(db.deleteObservationWithTruth(first.observationId).ok).toBe(true);
    expect(db.getSessionRef('shared')).not.toBeNull();

    // Last turn of an idle session: the isolation metadata goes with it.
    expect(db.deleteObservationWithTruth(second.observationId).ok).toBe(true);
    expect(db.getSessionRef('shared')).toBeNull();

    // An ACTIVE session keeps its ref even with no turns left — it still has to
    // allocate the next turn seq for the conversation that is running.
    const live = seedRecord({ sessionId: 'live', cwd: '/proj/live' });
    expect(db.getSessionRef('live')!.state).toBe('active');
    expect(db.deleteObservationWithTruth(live.observationId).ok).toBe(true);
    expect(db.getSessionRef('live')).not.toBeNull();
  });

  test('§10.1-7 repair does not resurrect a deleted turn', () => {
    const f = seedRecord();
    expect(db.deleteObservationWithTruth(f.observationId).ok).toBe(true);

    const orphans = db.findOrphans({ embeddingModel: 'all-MiniLM-L6-v2:f32:384:raw-v1', embeddingDimensions: 384 });
    expect(orphans.turnsWithoutObservation).toEqual([]);
    expect(orphans.observationsWithoutEmbedding).toEqual([]);

    const requeued = db.requeueOrphans({ embeddingModel: 'all-MiniLM-L6-v2:f32:384:raw-v1', embeddingDimensions: 384 });
    expect(requeued).toEqual({ summarize: 0, embed: 0 });
    expect(count("SELECT COUNT(*) AS c FROM jobs WHERE job_type = 'summarize_turn'")).toBe(0);
    expect(count('SELECT COUNT(*) AS c FROM observations')).toBe(0);
  });

  test('§10.1-8 a repeated delete is 404 and never touches another scope', () => {
    const mine = seedRecord({ sessionId: 'mine', cwd: '/proj/mine' });
    const other = seedRecord({ sessionId: 'other', cwd: '/proj/other' });

    expect(db.deleteObservationWithTruth(mine.observationId).ok).toBe(true);
    expect(db.deleteObservationWithTruth(mine.observationId)).toEqual({ ok: false, reason: 'not_found' });

    // The other workspace is untouched, and a scoped delete cannot reach it.
    expect(rowCounts(other)).toEqual({
      observations: 1, embeddings: 2, semanticTexts: 1,
      turns: 1, events: 3, artifacts: 1, jobs: 2, sessionRefs: 1,
    });
    expect(db.deleteObservationWithTruth(other.observationId, { scopeKey: mine.scopeKey })).toEqual({
      ok: false, reason: 'not_found',
    });
    expect(rowCounts(other).observations).toBe(1);
  });

  test('pinned is not a delete guard — pin only affects display priority', () => {
    const f = seedRecord({ pinned: true });
    expect(db.getPinnedObservations({ scopeKey: f.scopeKey, limit: 5 }).length).toBe(1);
    expect(db.deleteObservationWithTruth(f.observationId).ok).toBe(true);
    expect(db.getPinnedObservations({ scopeKey: f.scopeKey, limit: 5 })).toEqual([]);
  });
});
