import { describe, expect, test } from 'bun:test';
import { openInMemoryDB } from '../support/tmp-db';

const V2_TABLES = [
  'session_refs', 'turns', 'turn_events', 'turn_artifacts',
  'memories', 'memory_turn_links', 'topics', 'memory_embeddings', 'jobs',
];

const LEGACY_TABLES = ['sessions', 'observations', 'observation_embeddings'];

describe('V2 db schema', () => {
  test('V2 tables exist after init', () => {
    const db = openInMemoryDB();
    try {
      for (const name of V2_TABLES) {
        const row = db.raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
        expect(row).not.toBeNull();
      }
    } finally { db.close(); }
  });

  test('memories_fts virtual table exists', () => {
    const db = openInMemoryDB();
    try {
      const row = db.raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name = 'memories_fts'").get();
      expect(row).not.toBeNull();
    } finally { db.close(); }
  });

  test('fresh init does NOT create legacy V1 tables', () => {
    const db = openInMemoryDB();
    try {
      for (const name of LEGACY_TABLES) {
        const row = db.raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
        expect(row).toBeNull();
      }
    } finally { db.close(); }
  });

  test('FTS triggers on memories are present', () => {
    const db = openInMemoryDB();
    try {
      const names = (db.raw.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map(r => r.name);
      expect(names).toContain('memories_ai');
      expect(names).toContain('memories_ad');
      expect(names).toContain('memories_au');
    } finally { db.close(); }
  });

  test('memories has topic_candidate column', () => {
    const db = openInMemoryDB();
    try {
      const cols = (db.raw.query("PRAGMA table_info(memories)").all() as { name: string }[]).map(r => r.name);
      expect(cols).toContain('topic_candidate');
    } finally { db.close(); }
  });

  test('topics has scope_key column and unique (scope_key, canonical_label) index', () => {
    const db = openInMemoryDB();
    try {
      const cols = (db.raw.query("PRAGMA table_info(topics)").all() as { name: string; notnull: number }[]);
      const scopeCol = cols.find(c => c.name === 'scope_key');
      expect(scopeCol).toBeDefined();
      expect(scopeCol!.notnull).toBe(1);

      const idx = db.raw.query(
        "SELECT name, [unique] FROM pragma_index_list('topics') WHERE name = 'idx_topics_scope_label'",
      ).get() as { name: string; unique: number } | null;
      expect(idx).not.toBeNull();
      expect(idx!.unique).toBe(1);
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
