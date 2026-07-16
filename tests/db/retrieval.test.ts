import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;
let sessionSeq = 0;

beforeEach(() => { db = openInMemoryDB(); sessionSeq = 0; });
afterEach(() => { db.close(); });

/** Create a closed turn + its Observation with an explicit turn_stopped_at. */
function seedObs(o: {
  session_id?: string;
  repo?: string | null;
  cwd?: string;
  title?: string;
  summary?: string;
  outcome?: string;
  learned?: string;
  evidence?: string[];
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  stoppedAt: string;
}): number {
  const session_id = o.session_id ?? 's1';
  const cwd = o.cwd ?? '/proj';
  const repo = o.repo === undefined ? '/proj' : o.repo;
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo, prompt_text: o.title ?? 'p' });
  db.markTurnClosed(turn.id);
  return db.insertObservation({
    turn_id: turn.id,
    session_id,
    turn_seq: seq,
    repo,
    cwd_scope: cwd,
    title: o.title ?? 'Title',
    summary: o.summary ?? 'Summary',
    outcome: o.outcome,
    learned: o.learned,
    evidence: o.evidence,
    memory_type: o.type ?? 'change',
    quality: 'normal',
    turn_started_at: o.stoppedAt,
    turn_stopped_at: o.stoppedAt,
  })!;
}

describe('searchObservationsFts', () => {
  test('finds by title keyword and indexes outcome/learned', () => {
    seedObs({ title: 'Fix authentication token refresh', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ title: 'Add pagination to users API', stoppedAt: '2026-07-02T00:00:00Z' });
    seedObs({ title: 'Neutral', outcome: 'zzuniquetoken verified', stoppedAt: '2026-07-03T00:00:00Z' });

    expect(db.searchObservationsFts('authentication').length).toBe(1);
    // outcome is FTS-indexed
    const byOutcome = db.searchObservationsFts('zzuniquetoken');
    expect(byOutcome.length).toBe(1);
    expect(byOutcome[0]!.title).toBe('Neutral');
  });

  test('scope_key hard-isolates results across workspaces', () => {
    seedObs({ session_id: 'a', repo: '/repoA', cwd: '/repoA', title: 'shared concept work', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ session_id: 'b', repo: '/repoB', cwd: '/repoB', title: 'shared concept work', stoppedAt: '2026-07-02T00:00:00Z' });

    const scopedA = db.searchObservationsFts('concept', { scopeKey: computeScopeKey('/repoA', '/repoA') });
    expect(scopedA.length).toBe(1);
    expect(scopedA[0]!.repo).toBe('/repoA');

    // no scope filter => both
    expect(db.searchObservationsFts('concept').length).toBe(2);
  });

  test('filters by memory_type', () => {
    seedObs({ title: 'auth bug here', type: 'bugfix', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ title: 'auth refactor here', type: 'refactor', stoppedAt: '2026-07-02T00:00:00Z' });
    const r = db.searchObservationsFts('auth', { type: 'bugfix' });
    expect(r.length).toBe(1);
    expect(r[0]!.memory_type).toBe('bugfix');
  });

  test('short query (<3 chars) uses LIKE fallback', () => {
    seedObs({ title: 'JWT token handling', stoppedAt: '2026-07-01T00:00:00Z' });
    expect(db.searchObservationsFts('JW').length).toBe(1);
  });
});

describe('observationTimeline (source-turn ordering)', () => {
  test('orders by turn_stopped_at, NOT by observation id', () => {
    // Insert out of chronological order so id order != time order.
    const idMid = seedObs({ title: 'mid', stoppedAt: '2026-07-02T00:00:00Z' }); // id 1
    const idLate = seedObs({ title: 'late', stoppedAt: '2026-07-03T00:00:00Z' }); // id 2
    const idEarly = seedObs({ title: 'early', stoppedAt: '2026-07-01T00:00:00Z' }); // id 3

    const tl = db.observationTimeline(idMid, { before: 3, after: 3 });
    expect(tl.anchor!.id).toBe(idMid);
    // before = earlier by time (the "early" one, id 3 but oldest)
    expect(tl.before.map((o) => o.id)).toEqual([idEarly]);
    // after = later by time (the "late" one)
    expect(tl.after.map((o) => o.id)).toEqual([idLate]);
  });

  test('mode=scope spans sessions; mode=session stays within one session', () => {
    // Two sessions, same repo/scope.
    seedObs({ session_id: 's1', title: 's1 early', stoppedAt: '2026-07-01T00:00:00Z' });
    const anchor = seedObs({ session_id: 's2', title: 's2 anchor', stoppedAt: '2026-07-02T00:00:00Z' });
    seedObs({ session_id: 's1', title: 's1 late', stoppedAt: '2026-07-03T00:00:00Z' });

    const scope = db.observationTimeline(anchor, { mode: 'scope' });
    expect(scope.before.length).toBe(1); // s1 early
    expect(scope.after.length).toBe(1);  // s1 late

    const session = db.observationTimeline(anchor, { mode: 'session' });
    expect(session.before.length).toBe(0); // nothing else in s2
    expect(session.after.length).toBe(0);
  });

  test('returns empty for unknown observation', () => {
    const tl = db.observationTimeline(9999);
    expect(tl.anchor).toBeNull();
    expect(tl.before).toEqual([]);
    expect(tl.after).toEqual([]);
  });
});
