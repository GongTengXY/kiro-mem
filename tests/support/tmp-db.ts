/**
 * Test-only helper for spinning up an isolated `MemoryDB` against an in-memory
 * SQLite (or a tmp file when the test needs persistence across reopen).
 *
 * The production `MemoryDB` constructor will fall back to `~/.kiro-mem/` when
 * no path is provided. Tests MUST always pass an explicit path so they never
 * pollute the user's real data dir.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemoryDB } from '../../src/db';

export function openInMemoryDB(): MemoryDB {
  return new MemoryDB(':memory:');
}

export interface TmpDbHandle {
  db: MemoryDB;
  path: string;
  dir: string;
  reopen: () => MemoryDB;
  close: () => void;
}

/**
 * Creates a tmp-dir-backed SQLite file. Useful for tests that need to close &
 * reopen the DB (e.g. Worker restart recovery scenarios in WP2). Returns a
 * handle; call `handle.close()` to remove the dir.
 */
export function openTmpFileDB(prefix = 'kiro-mem-test-'): TmpDbHandle {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, 'db.sqlite');
  let db = new MemoryDB(path);

  const handle: TmpDbHandle = {
    db,
    path,
    dir,
    reopen: () => {
      handle.db.close();
      handle.db = new MemoryDB(path);
      return handle.db;
    },
    close: () => {
      try {
        handle.db.close();
      } catch {}
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    },
  };
  return handle;
}
