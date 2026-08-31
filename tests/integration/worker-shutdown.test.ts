/**
 * Worker shutdown leaves nothing behind (plan §5 / §9.2).
 *
 * This is the one test that runs the REAL Worker as its own OS process. Every
 * other integration test builds the app in-process, which cannot answer the
 * question that matters for resource governance: when the Worker goes away, do
 * its `kiro-cli acp` children go away too, and are the pid/port files gone?
 *
 * A Worker that exits while leaking its pool would look perfectly healthy in
 * every in-process test and still leave ~38MB per stranded runtime resident
 * until the machine reboots — and `kiro-mem uninstall` would then delete the
 * data dir out from under a process still writing to it.
 *
 * ACP is faked at the transport level: a `kiro-cli` on PATH that ignores its
 * args and `exec`s the fake ACP server, so the spawned PID *is* the server and
 * asserting on it is a complete statement about the process tree.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { MemoryDB } from '../../src/db';

const ROOT = resolve(import.meta.dir, '../..');
const WORKER = join(ROOT, 'src/server/worker.ts');
const FAKE_SERVER = join(ROOT, 'tests/acp/fake-acp-server.ts');
const cleanups: Array<() => void> = [];

afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntilGone(pid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return !isAlive(pid);
}

/** A port nobody is listening on. The Worker writes `config.worker.port` into
 *  `.worker.port`, so it has to be a real chosen value rather than 0. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== 'number') throw new Error('could not obtain a free port');
  return port;
}

function layout(opts: { hang?: boolean } = {}): {
  dataDir: string; port: number; binDir: string; tag: string; hangMarker: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'kiro-mem-shutdown-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const dataDir = join(home, '.kiro-mem');
  const binDir = join(home, 'bin');
  const runtimeHome = join(dataDir, 'kiro-runtime');
  mkdirSync(join(runtimeHome, 'agents'), { recursive: true });
  mkdirSync(binDir);
  mkdirSync(join(dataDir, 'logs'), { recursive: true });

  // The Worker refuses to start against a broken runtime layout, so give it the
  // real contract: one agent, named correctly, with tools: [].
  writeFileSync(
    join(runtimeHome, 'agents', 'kiro-mem-compressor.json'),
    JSON.stringify({ name: 'kiro-mem-compressor', tools: [] }),
  );
  writeFileSync(join(runtimeHome, 'kiro-mem-compressor-prompt.md'), 'compress.\n');

  const port = freePort();
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    language: 'en',
    worker: { port, host: '127.0.0.1', logLevel: 'info' },
    // Long TTL: this test is about shutdown, so idle retirement must not be what
    // removes the processes.
    compression: { concurrency: 2, minWarmRuntimes: 1, idleTtlMs: 600000, timeoutMs: 5000, maxRetries: 0 },
    runtime: { kiroHome: runtimeHome },
  }));

  // `ACPRuntime` spawns the bare name `kiro-cli`, so PATH is the injection point.
  //
  // The tag is passed as an extra argv the fake server ignores. It makes every
  // ACP process of THIS test findable by command line, which is the only way to
  // catch one that was created during the shutdown race — a PID list captured
  // before signalling cannot contain a process that did not exist yet.
  const tag = `kiro-mem-test-${home.split('-').pop()}-${port}`;
  const cli = join(binDir, 'kiro-cli');
  const hangMarker = join(home, 'hanging');
  const hangEnv = opts.hang
    ? 'export KIRO_MEM_FAKE_HANG=1\n' +
      `export KIRO_MEM_FAKE_HANG_MARKER=${hangMarker}\n` +
      // Without this, a leaked replacement dies on its own the instant the Worker
      // exits and closes its stdin — so the leak this test looks for would be
      // invisible and the assertion would pass for the wrong reason.
      'export KIRO_MEM_FAKE_SURVIVE_EOF=1\n'
    : '';
  writeFileSync(cli, `#!/bin/bash\n${hangEnv}exec bun run "${FAKE_SERVER}" --tag ${tag}\n`);
  chmodSync(cli, 0o755);

  return { dataDir, port, binDir, tag, hangMarker };
}

/** Every live process whose command line carries this test's tag. */
async function taggedSurvivors(tag: string): Promise<number[]> {
  const out = await Bun.$`pgrep -f ${tag}`.nothrow().text();
  return out.trim().split('\n').filter(Boolean).map(Number).filter(isAlive);
}

/**
 * Closed turns with pending summarize jobs, so the pool grows past one.
 * `sessions` stands in for separate Kiro windows: distinct session ids arriving
 * at the same Worker, which is exactly the shape the shared-pool claim is about.
 */
function seedWork(dataDir: string, opts: { sessions?: number; turnsPerSession?: number } = {}): void {
  const sessions = opts.sessions ?? 1;
  const perSession = opts.turnsPerSession ?? 2;
  const db = new MemoryDB(join(dataDir, 'kiro-mem.db'));
  try {
    for (let s = 0; s < sessions; s++) {
      const sessionId = `s${s + 1}`;
      db.upsertSessionRef({ session_id: sessionId, cwd: '/proj', repo: '/proj' });
      for (let i = 0; i < perSession; i++) {
        const seq = db.allocateNextTurnSeq(sessionId);
        const turn = db.createTurn({
          session_id: sessionId, seq, cwd: '/proj', repo: '/proj',
          prompt_text: `work ${sessionId}-${i}`,
        });
        db.appendTurnEvent({
          turn_id: turn.id, session_id: sessionId, hook_event_name: 'stop',
          payload_json: JSON.stringify({ assistant_response: `done ${sessionId}-${i}` }),
        });
        db.markTurnClosed(turn.id);
        db.enqueueJob({
          job_type: 'summarize_turn',
          dedupe_key: `sum:${turn.id}`,
          entity_type: 'turn',
          entity_id: String(turn.id),
          payload_json: JSON.stringify({ turn_id: turn.id }),
        });
      }
    }
  } finally {
    db.close();
  }
}

async function health(port: number): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function spawnWorker(dataDir: string, binDir: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', WORKER],
    cwd: ROOT,
    env: {
      ...process.env,
      KIRO_MEMORY_DATA_DIR: dataDir,
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  cleanups.push(() => { try { proc.kill(9); } catch {} });
  return proc;
}

function acpPidsOf(h: any): number[] {
  const slots: any[] = h?.memory?.acpSlots ?? [];
  return slots
    .map((s) => s.pid)
    .filter((p: unknown): p is number => typeof p === 'number');
}

/** Wait until the seeded jobs have driven the pool into existence. */
async function waitForAcpPids(port: number, timeoutMs = 30_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = acpPidsOf(await health(port));
    if (found.length > 0) return found;
    await Bun.sleep(100);
  }
  return [];
}

async function stopWorker(proc: Bun.Subprocess): Promise<'exited' | 'timeout'> {
  proc.kill('SIGTERM');
  const outcome = await Promise.race([
    proc.exited,
    Bun.sleep(20_000).then(() => 'timeout' as const),
  ]);
  return outcome === 'timeout' ? 'timeout' : 'exited';
}

describe('Worker shutdown', () => {
  test('SIGTERM closes every ACP subprocess and removes the pid/port files', async () => {
    const { dataDir, port, binDir, tag } = layout();
    seedWork(dataDir);

    const proc = spawnWorker(dataDir, binDir);

    const acpPids = await waitForAcpPids(port);
    expect(acpPids.length).toBeGreaterThan(0);
    for (const pid of acpPids) expect(isAlive(pid)).toBe(true);
    expect(existsSync(join(dataDir, '.worker.pid'))).toBe(true);
    expect(existsSync(join(dataDir, '.worker.port'))).toBe(true);

    expect(await stopWorker(proc)).toBe('exited');

    // The whole promise of the shutdown ordering: the pool is closed before the
    // process leaves, so no ACP child outlives its Worker.
    for (const pid of acpPids) {
      expect(await waitUntilGone(pid)).toBe(true);
    }
    // Stronger than the PID list above, which was captured before the signal and
    // therefore cannot contain a process created during the shutdown itself.
    expect(await taggedSurvivors(tag)).toEqual([]);
    // Left behind, these make `kiro-mem status` report a Worker that is not
    // there and `kiro-mem start` decline to start a new one.
    expect(existsSync(join(dataDir, '.worker.pid'))).toBe(false);
    expect(existsSync(join(dataDir, '.worker.port'))).toBe(false);
  }, 90_000);

  test('SIGTERM during an in-flight compression leaves no replacement behind', async () => {
    // Every prompt hangs, so the Worker is shut down with a compression still in
    // flight. That rejection used to look like an ordinary ACP error, which
    // recycled the slot and started a replacement runtime after the pool had
    // already emptied — an orphan invisible to `/health` and to any PID list
    // captured before the signal.
    const { dataDir, port, binDir, tag, hangMarker } = layout({ hang: true });
    seedWork(dataDir, { sessions: 1, turnsPerSession: 2 });

    const proc = spawnWorker(dataDir, binDir);
    const acpPids = await waitForAcpPids(port);
    expect(acpPids.length).toBeGreaterThan(0);

    // Wait for the ACP server to confirm it is holding a prompt. `/health` shows
    // a busy slot from the moment the slot is reserved, so it cannot distinguish
    // "still starting" from "prompt in flight" — and signalling during the
    // handshake never reaches the recycle path this test targets.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !existsSync(hangMarker)) await Bun.sleep(50);
    expect(existsSync(hangMarker)).toBe(true);
    expect((await health(port))?.acp?.busy).toBeGreaterThan(0);

    expect(await stopWorker(proc)).toBe('exited');
    // Generous: a replacement would need a spawn plus an ACP handshake.
    await Bun.sleep(1500);

    for (const pid of acpPids) expect(await waitUntilGone(pid)).toBe(true);
    expect(await taggedSurvivors(tag)).toEqual([]);
    expect(existsSync(join(dataDir, '.worker.pid'))).toBe(false);
  }, 90_000);
});

/**
 * The shared-pool claim (plan §3.1).
 *
 * The README tells users that several Kiro windows do NOT each get a Worker —
 * they all reach the same one over loopback and reuse the same ACP runtimes. If
 * that were wrong, resident memory would scale with the number of open windows
 * and every parameter in this round would be governing the wrong thing.
 */
describe('Worker ACP pool sharing', () => {
  test('work from several sessions shares one pool and stays within concurrency', async () => {
    const { dataDir, port, binDir } = layout();
    // Three simulated windows, four turns each.
    seedWork(dataDir, { sessions: 3, turnsPerSession: 4 });

    const proc = spawnWorker(dataDir, binDir);
    const first = await waitForAcpPids(port);
    expect(first.length).toBeGreaterThan(0);

    // Sample while the backlog drains. `concurrency` is 2 in this layout, so if
    // the pool were per-session or per-client this count would reach 3+.
    const seen = new Set<number>(first);
    let maxAlive = 0;
    // Exit on the pool going quiet, not on the job queue emptying: the seeded
    // turns also enqueue `embed_observation`, which has no model here and sits in
    // retry backoff forever. Waiting on that would just burn the whole deadline.
    let quietSamples = 0;
    const deadline = Date.now() + 15_000;
    let h: any = null;
    while (Date.now() < deadline) {
      h = await health(port);
      for (const pid of acpPidsOf(h)) seen.add(pid);
      const live = [...seen].filter(isAlive).length;
      if (live > maxAlive) maxAlive = live;
      const acp = h?.acp;
      if (acp && acp.total > 0 && acp.busy === 0 && acp.queued === 0) {
        if (++quietSamples >= 5) break;
      } else {
        quietSamples = 0;
      }
      await Bun.sleep(50);
    }

    expect(maxAlive).toBeGreaterThan(0);
    expect(maxAlive).toBeLessThanOrEqual(2);
    expect(h?.acp?.config?.concurrency).toBe(2);
    // One Worker, therefore one pool — not one per session.
    expect(h?.acp?.total).toBeLessThanOrEqual(2);

    expect(await stopWorker(proc)).toBe('exited');
    for (const pid of seen) expect(await waitUntilGone(pid)).toBe(true);
  }, 90_000);
});

/**
 * Independent data dirs stay independent (plan §10, "多个独立 Worker 各自保留一个
 * warm runtime").
 *
 * The plan accepts that two Workers each hold their own warm runtime — that is
 * the documented cost of an isolated data dir. What it must NOT do is let them
 * share or steal each other's runtimes, because then stopping one would break
 * compression for the other, and `uninstall --purge` on one data dir would kill
 * processes belonging to the other.
 */
describe('Worker isolation across data dirs', () => {
  test('two Workers own disjoint ACP processes, and stopping one spares the other', async () => {
    const a = layout();
    const b = layout();
    seedWork(a.dataDir);
    seedWork(b.dataDir);

    const procA = spawnWorker(a.dataDir, a.binDir);
    const procB = spawnWorker(b.dataDir, b.binDir);

    const pidsA = await waitForAcpPids(a.port);
    const pidsB = await waitForAcpPids(b.port);
    expect(pidsA.length).toBeGreaterThan(0);
    expect(pidsB.length).toBeGreaterThan(0);

    // No PID is claimed by both pools.
    const overlap = pidsA.filter((p) => pidsB.includes(p));
    expect(overlap).toEqual([]);

    // Separate Workers, separate pid files, separate ports.
    const readPid = (dir: string) => Bun.file(join(dir, '.worker.pid')).text();
    const [pidFileA, pidFileB] = await Promise.all([readPid(a.dataDir), readPid(b.dataDir)]);
    expect(pidFileA).not.toBe(pidFileB);
    expect(a.port).not.toBe(b.port);

    // Stopping A must not touch B's processes or its files.
    expect(await stopWorker(procA)).toBe('exited');
    for (const pid of pidsA) expect(await waitUntilGone(pid)).toBe(true);
    for (const pid of pidsB) expect(isAlive(pid)).toBe(true);
    expect(existsSync(join(a.dataDir, '.worker.pid'))).toBe(false);
    expect(existsSync(join(b.dataDir, '.worker.pid'))).toBe(true);

    expect(await stopWorker(procB)).toBe('exited');
    for (const pid of pidsB) expect(await waitUntilGone(pid)).toBe(true);
  }, 90_000);
});
