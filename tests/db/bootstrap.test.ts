import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { buildBootstrapContext } from '../../src/bootstrap-context';

let db: MemoryDB;
const CTX = { maxOutputBytes: 8192 };

beforeEach(() => { db = openInMemoryDB(); });
afterEach(() => { db.close(); });

function byteLen(s: string): number { return Buffer.byteLength(s, 'utf8'); }

/**
 * Seed a closed turn + Observation. Uses repo=null so scope_key resolves to
 * `cwd:<realpath>` — matching what buildBootstrapContext computes for a
 * non-git cwd, making the tests deterministic without a git repo.
 */
function seed(o: {
  cwd: string;
  session_id?: string;
  title: string;
  stoppedAt: string;
  outcome?: string;
  next_steps?: string;
  pinned?: boolean;
}): number {
  const session_id = o.session_id ?? 's1';
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd: o.cwd, repo: null });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd: o.cwd, repo: null, prompt_text: o.title });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id, turn_seq: seq, repo: null, cwd_scope: o.cwd,
    title: o.title, summary: `summary of ${o.title}`, outcome: o.outcome, next_steps: o.next_steps,
    memory_type: 'change', quality: 'normal',
    turn_started_at: o.stoppedAt, turn_stopped_at: o.stoppedAt,
  })!;
  if (o.pinned) db.pinObservation(id, true);
  return id;
}

describe('bootstrap DB methods', () => {
  test('getPinnedObservations is scope-filtered and recency-ordered', () => {
    const dirA = '/wsA';
    seed({ cwd: dirA, title: 'pinned old', stoppedAt: '2026-07-01T00:00:00Z', pinned: true });
    seed({ cwd: dirA, title: 'pinned new', stoppedAt: '2026-07-05T00:00:00Z', pinned: true });
    seed({ cwd: dirA, title: 'not pinned', stoppedAt: '2026-07-06T00:00:00Z' });
    seed({ cwd: '/wsB', session_id: 'b', title: 'other scope pinned', stoppedAt: '2026-07-07T00:00:00Z', pinned: true });

    const pinned = db.getPinnedObservations({ scopeKey: computeScopeKey(null, dirA), limit: 5 });
    expect(pinned.map((o) => o.title)).toEqual(['pinned new', 'pinned old']); // newest first, scope A only
  });

  test('getRecentObservations is scope-filtered, recency-ordered, limited', () => {
    const dir = '/wsR';
    for (let i = 1; i <= 6; i++) seed({ cwd: dir, title: `obs ${i}`, stoppedAt: `2026-07-0${i}T00:00:00Z` });
    seed({ cwd: '/wsOther', session_id: 'o', title: 'other', stoppedAt: '2026-07-09T00:00:00Z' });

    const recent = db.getRecentObservations({ scopeKey: computeScopeKey(null, dir), limit: 3 });
    expect(recent.map((o) => o.title)).toEqual(['obs 6', 'obs 5', 'obs 4']);
  });
});

describe('buildBootstrapContext', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kiro-boot-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  test('renders usage note, pinned, recent detail and recent index with cost estimate', () => {
    seed({ cwd: dir, title: 'Pinned decision', stoppedAt: '2026-07-01T00:00:00Z', pinned: true, next_steps: 'follow up later' });
    for (let i = 1; i <= 10; i++) {
      seed({ cwd: dir, title: `Work item ${i}`, stoppedAt: `2026-07-1${i % 10}T00:00:00Z`, outcome: `did thing ${i}` });
    }

    const out = buildBootstrapContext(db, dir, CTX, 'en');

    expect(out.startsWith('<kiro-mem-context>')).toBe(true);
    expect(out.endsWith('</kiro-mem-context>')).toBe(true);
    expect(out).toContain('@kiro-mem/search'); // usage note
    expect(out).toContain('Pinned');
    expect(out).toContain('#O'); // observation references
    expect(out).toMatch(/\(~\d+t\)/); // read-cost estimate on index lines
    // No topics / no LLM-synthesized state.
    expect(out).not.toContain('Active Topics');
    expect(out).not.toContain('Topic');
  });

  test('output stays within the byte budget', () => {
    for (let i = 1; i <= 80; i++) {
      seed({ cwd: dir, title: `Observation number ${i} with a reasonably long descriptive title`, stoppedAt: `2026-07-13T00:${String(i).padStart(2, '0')}:00Z`, outcome: 'x'.repeat(300) });
    }
    const out = buildBootstrapContext(db, dir, CTX, 'zh');
    expect(byteLen(out)).toBeLessThanOrEqual(8192);
    expect(out.endsWith('</kiro-mem-context>')).toBe(true); // wrapper still valid
  });

  test('scope isolation: another workspace never appears', () => {
    const other = mkdtempSync(join(tmpdir(), 'kiro-boot-other-'));
    try {
      seed({ cwd: dir, title: 'MINE alpha', stoppedAt: '2026-07-01T00:00:00Z' });
      seed({ cwd: other, session_id: 'o', title: 'THEIRS beta', stoppedAt: '2026-07-02T00:00:00Z' });

      const out = buildBootstrapContext(db, dir, CTX, 'en');
      expect(out).toContain('MINE alpha');
      expect(out).not.toContain('THEIRS beta');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('empty scope yields just the usage note, no crash', () => {
    const out = buildBootstrapContext(db, dir, CTX, 'en');
    expect(out.startsWith('<kiro-mem-context>')).toBe(true);
    expect(out.endsWith('</kiro-mem-context>')).toBe(true);
    expect(out).toContain('@kiro-mem/search');
    // No real observation entries (usage note may mention the "#O{id}" format).
    expect(out).not.toMatch(/#O\d/);
    expect(out).not.toContain('## Recent');
    expect(out).not.toContain('## 📌');
  });
});
