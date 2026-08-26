/**
 * `kiro-mem repair` must operate on the data dir the environment names, and it
 * must report the two rebuild queues separately.
 *
 * The isolation half exists because it already went wrong once: this CLI derived
 * its data dir from `HOME` alone while the Worker, the MCP server and every hook
 * use `getDataDir()`, which prefers `KIRO_MEMORY_DATA_DIR`. So a command run as
 * `KIRO_MEMORY_DATA_DIR=<tmp> kiro-mem repair` looked isolated and actually
 * read, MIGRATED and enqueued jobs into the developer's real database. The
 * existing CLI tests isolate by overriding `HOME`, so none of them could catch
 * it — hence this test overrides `KIRO_MEMORY_DATA_DIR` specifically, with
 * `HOME` pointing somewhere else entirely.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';
import { SEMANTIC_EN_PROTOCOL } from '../../src/semantic-en';

const ROOT = resolve(import.meta.dir, '../..');
const SETUP = join(ROOT, 'scripts/setup.ts');
const cleanups: Array<() => void> = [];

afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Seed one Observation per requested derived-value state. */
function seed(dataDir: string): void {
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  db.upsertSessionRef({ session_id: 's', cwd: '/proj', repo: '/proj' });
  const mk = (title: string, status: 'pending' | 'failed' | null) => {
    const seq = db.allocateNextTurnSeq('s');
    const turn = db.createTurn({ session_id: 's', seq, cwd: '/proj', repo: '/proj', prompt_text: title });
    db.markTurnClosed(turn.id);
    const id = db.insertObservation({
      turn_id: turn.id, session_id: 's', turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
      title, summary: title, memory_type: 'change', quality: 'normal',
      turn_started_at: '2026-07-20T00:00:00Z', turn_stopped_at: '2026-07-20T00:00:00Z',
    })!;
    if (status) {
      db.upsertObservationSemanticText({
        observation_id: id, protocol: SEMANTIC_EN_PROTOCOL, status,
        translator: 'acp:kiro-mem-compressor', attempts: status === 'failed' ? 2 : 1,
        failure_reason: status === 'failed' ? 'placeholder|placeholder:summary' : 'retry_error:TimeoutError',
      });
    }
  };
  mk('待补一', 'pending');
  mk('待补二', null);
  mk('被拒的', 'failed');
  db.close();
}

async function runRepair(env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', SETUP, 'repair'],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  // Strip ANSI so assertions match on content, not colour codes.
  return (out + err).replace(/\u001b\[[0-9;]*m/g, '');
}

describe('kiro-mem repair', () => {
  test('honours KIRO_MEMORY_DATA_DIR and leaves the HOME data dir untouched', async () => {
    const fakeHome = tempDir('kiro-mem-home-');
    const dataDir = join(tempDir('kiro-mem-data-'), 'data');
    mkdirSync(dataDir, { recursive: true });
    seed(dataDir);

    const output = await runRepair({ HOME: fakeHome, KIRO_MEMORY_DATA_DIR: dataDir });

    // Counts come from the seeded DB: 3 Observations need vectors, 2 need a
    // derived value (the `failed` one is deliberately excluded), 1 is refused.
    expect(output).toContain('3');
    expect(output).toMatch(/renormalize_observation/);
    // The decoy HOME must not have acquired a database.
    expect(existsSync(join(fakeHome, '.kiro-mem', 'kiro-mem.db'))).toBe(false);

    const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
    const queued = db.raw
      .query("SELECT job_type, COUNT(*) AS c FROM jobs GROUP BY job_type ORDER BY job_type")
      .all() as { job_type: string; c: number }[];
    db.close();
    expect(queued).toEqual([
      { job_type: 'embed_observation', c: 3 },
      // 2, not 3: a `failed` derived value is never requeued, because the
      // guardrails already refused that exact content twice.
      { job_type: 'renormalize_observation', c: 2 },
    ]);
  }, 20_000);

  test('a second pass enqueues nothing while the first batch is in flight', async () => {
    const fakeHome = tempDir('kiro-mem-home-');
    const dataDir = join(tempDir('kiro-mem-data-'), 'data');
    mkdirSync(dataDir, { recursive: true });
    seed(dataDir);

    await runRepair({ HOME: fakeHome, KIRO_MEMORY_DATA_DIR: dataDir });
    await runRepair({ HOME: fakeHome, KIRO_MEMORY_DATA_DIR: dataDir });

    const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
    const total = db.raw
      .query("SELECT COUNT(*) AS c FROM jobs WHERE job_type = 'renormalize_observation'")
      .get() as { c: number };
    db.close();
    // Repeated repairs must not pile up duplicate ACP translation work.
    expect(total.c).toBe(2);
  }, 30_000);
});
