/**
 * Test-only preload (wired via `bunfig.toml`).
 *
 * `logError()` resolves its log path through `getDataDir()`, which falls back
 * to the developer's real `~/.kiro-mem` when `KIRO_MEMORY_DATA_DIR` is unset.
 * Any in-process test that exercises a failure path (job retries, ACP
 * contamination, quarantined events) would therefore append noise to real
 * worker logs. Pointing the whole test run at a throwaway dir keeps the
 * developer's data dir untouched, per the V3 rule that tests never operate on
 * the real HOME.
 *
 * Tests that spawn a child process and assert a HOME-derived layout (e.g.
 * `setup.test.ts`) must drop this variable from the child env.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDataDir = mkdtempSync(join(tmpdir(), 'kiro-mem-test-data-'));
process.env.KIRO_MEMORY_DATA_DIR = testDataDir;

process.on('exit', () => {
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch {}
});
