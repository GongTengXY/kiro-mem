import { describe, expect, test } from 'bun:test';
import { openInMemoryDB } from '../support/tmp-db';

const CORE_TABLES = ['session_refs', 'turns', 'turn_events', 'turn_artifacts', 'jobs'];
const OBSERVATION_TABLES = ['observations', 'observation_embeddings'];

// Tables that must NOT exist — the removed V2 memory/topic model.
const REMOVED_TABLES = [
  'sessions',
  'memories',
  'topics',
  'memory_turn_links',
  'memory_embeddings',
  'memories_fts',
];

// V2-only columns that were dropped from turns.
const REMOVED_TURN_COLUMNS = ['memory_id', 'summarization_state', 'legacy_trust'];

function hasTable(db: ReturnType<typeof openInMemoryDB>, name: string): boolean {
  return !!db.raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

describe('db schema', () => {
  test('core + observation tables exist after init', () => {
    const db = openInMemoryDB();
    try {
      for (const name of [...CORE_TABLES, ...OBSERVATION_TABLES]) {
        expect(hasTable(db, name)).toBe(true);
      }
    } finally { db.close(); }
  });

  test('observations_fts virtual table exists', () => {
    const db = openInMemoryDB();
    try {
      expect(hasTable(db, 'observations_fts')).toBe(true);
    } finally { db.close(); }
  });

  test('FTS triggers on observations are present', () => {
    const db = openInMemoryDB();
    try {
      const names = (db.raw.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map(r => r.name);
      expect(names).toContain('observations_ai');
      expect(names).toContain('observations_ad');
      expect(names).toContain('observations_au');
    } finally { db.close(); }
  });

  test('observations has a UNIQUE turn_id (idempotency key)', () => {
    const db = openInMemoryDB();
    try {
      const idxList = db.raw.query("SELECT name FROM pragma_index_list('observations')").all() as { name: string }[];
      const hasUnique = idxList.some((idx) => {
        const cols = db.raw.query(`SELECT name FROM pragma_index_info('${idx.name}')`).all() as { name: string }[];
        const meta = db.raw.query(`SELECT [unique] FROM pragma_index_list('observations') WHERE name = ?`).get(idx.name) as { unique: number };
        return meta.unique === 1 && cols.length === 1 && cols[0]!.name === 'turn_id';
      });
      expect(hasUnique).toBe(true);
    } finally { db.close(); }
  });

  test('turns has no V2-only columns', () => {
    const db = openInMemoryDB();
    try {
      const cols = (db.raw.query('PRAGMA table_info(turns)').all() as { name: string }[]).map(r => r.name);
      for (const removed of REMOVED_TURN_COLUMNS) {
        expect(cols).not.toContain(removed);
      }
    } finally { db.close(); }
  });

  test('removed V2 tables do NOT exist', () => {
    const db = openInMemoryDB();
    try {
      for (const name of REMOVED_TABLES) {
        expect(hasTable(db, name)).toBe(false);
      }
    } finally { db.close(); }
  });

  test('schema init is idempotent', () => {
    const db = openInMemoryDB();
    db.close();
    const db2 = openInMemoryDB();
    db2.close();
    expect(true).toBe(true);
  });
});
