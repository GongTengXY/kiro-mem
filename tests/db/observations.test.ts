import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

/** Create a closed turn ready to receive an Observation. */
function closedTurn(opts?: { session_id?: string; cwd?: string; repo?: string | null; prompt?: string }) {
  const sessionId = opts?.session_id ?? 's1';
  const cwd = opts?.cwd ?? '/proj';
  const repo = opts?.repo === undefined ? '/proj' : opts.repo;
  db.upsertSessionRef({ session_id: sessionId, cwd, repo });
  const seq = db.allocateNextTurnSeq(sessionId);
  const turn = db.createTurn({ session_id: sessionId, seq, cwd, repo, prompt_text: opts?.prompt ?? 'do work' });
  db.markTurnClosed(turn.id);
  return turn;
}

function baseInput(turn: ReturnType<typeof closedTurn>, over?: Record<string, unknown>) {
  return {
    turn_id: turn.id,
    session_id: turn.session_id,
    turn_seq: turn.seq,
    repo: turn.repo,
    cwd_scope: turn.cwd,
    title: 'Title',
    summary: 'Summary',
    memory_type: 'feature' as const,
    quality: 'normal' as const,
    turn_started_at: turn.started_at,
    turn_stopped_at: turn.stopped_at ?? turn.started_at,
    ...over,
  };
}

describe('observations DB layer', () => {
  test('insertObservation writes a row and is retrievable by id and turn_id', () => {
    const turn = closedTurn();
    const id = db.insertObservation(baseInput(turn, {
      title: 'Auth fix', summary: 'Fixed rotation', outcome: 'verified', memory_type: 'bugfix',
      files_touched: ['a.ts'], concepts: ['auth'], evidence: ['bun test (exit 0)'],
      confidence_score: 0.9,
    }));
    expect(id).not.toBeNull();

    const byId = db.getObservation(id!)!;
    const byTurn = db.getObservationByTurnId(turn.id)!;
    expect(byId.id).toBe(byTurn.id);
    expect(byId.title).toBe('Auth fix');
    expect(byId.memory_type).toBe('bugfix');
    expect(byId.quality).toBe('normal');
    expect(JSON.parse(byId.files_touched_json)).toEqual(['a.ts']);
    expect(JSON.parse(byId.evidence_json)).toEqual(['bun test (exit 0)']);
    expect(byId.confidence_score).toBeCloseTo(0.9);
  });

  test('turn_id is the idempotency key — second insert returns null, only one row', () => {
    const turn = closedTurn();
    const id1 = db.insertObservation(baseInput(turn, { title: 'First' }));
    const id2 = db.insertObservation(baseInput(turn, { title: 'Second' }));
    expect(id1).not.toBeNull();
    expect(id2).toBeNull();

    const cnt = (db.raw.query('SELECT COUNT(*) AS c FROM observations WHERE turn_id = ?').get(turn.id) as { c: number }).c;
    expect(cnt).toBe(1);
    // The surviving row is the first one — a retry never overwrites content.
    expect(db.getObservationByTurnId(turn.id)!.title).toBe('First');
  });

  test('scope_key is frozen at write time: git repo -> repo path', () => {
    const turn = closedTurn({ repo: '/proj', cwd: '/proj/sub' });
    const id = db.insertObservation(baseInput(turn, { repo: '/proj', cwd_scope: '/proj/sub' }));
    expect(db.getObservation(id!)!.scope_key).toBe('/proj');
  });

  test('scope_key for a non-git workspace uses the cwd: prefix and isolates by cwd', () => {
    const t1 = closedTurn({ session_id: 'n1', repo: null, cwd: '/tmp/a', prompt: 'p1' });
    const t2 = closedTurn({ session_id: 'n2', repo: null, cwd: '/tmp/b', prompt: 'p2' });
    const id1 = db.insertObservation(baseInput(t1, { repo: null, cwd_scope: '/tmp/a' }));
    const id2 = db.insertObservation(baseInput(t2, { repo: null, cwd_scope: '/tmp/b' }));
    const s1 = db.getObservation(id1!)!.scope_key;
    const s2 = db.getObservation(id2!)!.scope_key;
    expect(s1.startsWith('cwd:')).toBe(true);
    expect(s2.startsWith('cwd:')).toBe(true);
    expect(s1).not.toBe(s2);
  });

  test('FTS indexes outcome, learned and evidence (not just title/summary)', () => {
    const turn = closedTurn();
    // Distinctive tokens that appear ONLY in the respective field.
    db.insertObservation(baseInput(turn, {
      title: 'Neutral title',
      summary: 'Neutral summary',
      outcome: 'zzoutcometoken confirmed',
      learned: 'zzlearnedtoken matters',
      evidence: ['zzevidencetoken exit 0'],
    }));

    const match = (q: string) =>
      (db.raw.query('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?').all(q) as { rowid: number }[]).length;

    expect(match('zzoutcometoken')).toBe(1);
    expect(match('zzlearnedtoken')).toBe(1);
    expect(match('zzevidencetoken')).toBe(1);
  });

  test('immutability: there is no updateObservation; pinning changes only is_pinned, text stays and FTS stays consistent', () => {
    const turn = closedTurn();
    const id = db.insertObservation(baseInput(turn, { title: 'stabletoken title', summary: 'S' }))!;

    // No text mutation API exists on MemoryDB.
    expect((db as unknown as Record<string, unknown>).updateObservation).toBeUndefined();

    db.pinObservation(id, true);
    const obs = db.getObservation(id)!;
    expect(obs.is_pinned).toBe(1);
    expect(obs.title).toBe('stabletoken title'); // text unchanged

    // FTS still finds it after the is_pinned UPDATE (au trigger kept it in sync).
    const hits = db.raw.query('SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?').all('stabletoken') as { rowid: number }[];
    expect(hits.length).toBe(1);
  });

  test('observation embeddings: upsert, get, and batch get', () => {
    const turn = closedTurn();
    const id = db.insertObservation(baseInput(turn))!;
    const blob = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);

    db.upsertObservationEmbedding(id, 'all-MiniLM-L6-v2', 3, blob);
    const row = db.getObservationEmbedding(id)!;
    expect(row.observation_id).toBe(id);
    expect(row.dimensions).toBe(3);

    const batch = db.getObservationEmbeddingsByIds([id]);
    expect(batch.length).toBe(1);
    expect(batch[0]!.observation_id).toBe(id);

    // Upsert overwrites, does not duplicate.
    db.upsertObservationEmbedding(id, 'all-MiniLM-L6-v2', 3, blob);
    const cnt = (db.raw.query('SELECT COUNT(*) AS c FROM observation_embeddings WHERE observation_id = ?').get(id) as { c: number }).c;
    expect(cnt).toBe(1);
  });
});
