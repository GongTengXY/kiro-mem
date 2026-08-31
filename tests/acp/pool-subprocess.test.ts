/**
 * Idle governance against REAL subprocesses (plan §9.2).
 *
 * The unit tests in `pool.test.ts` prove the pool's bookkeeping with runtime
 * doubles. They cannot prove the thing this round actually promises: that a
 * retired runtime's `kiro-cli acp` process is gone from the process table. A
 * pool that decremented `total` while leaking the OS process would pass every
 * one of those tests and still hold ~38MB per stranded runtime.
 *
 * `ACPRuntime` hardcodes its args as `['acp']`, so the transport is swapped the
 * same way `client.test.ts` does it: a tiny bash wrapper that ignores its args
 * and `exec`s the fake ACP server. Because it `exec`s, the spawned PID IS the
 * server — there is no grandchild hiding behind it, so asserting on that one PID
 * is a complete statement about the process tree.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ACPPool } from '../../src/acp/pool';
import { ACPRuntime } from '../../src/acp/runtime';

const FAKE_SERVER = resolve(import.meta.dir, 'fake-acp-server.ts');

/** Regenerated per run so the embedded path always matches this checkout. */
function fakeCliPath(opts: { tag?: string; hangMarker?: string } = {}): string {
  const wrapper = resolve(
    import.meta.dir,
    opts.tag ? `fake-acp-wrapper-${opts.tag}.sh` : 'fake-acp-wrapper.sh',
  );
  const env = opts.hangMarker
    ? `export KIRO_MEM_FAKE_HANG_MARKER=${opts.hangMarker}\n`
    : '';
  // The tag is an extra argv the server ignores. It makes this test's ACP
  // processes findable by command line, which is the only way to catch one that
  // was created DURING shutdown — a PID list captured beforehand cannot contain
  // a process that did not exist yet.
  const tagArg = opts.tag ? ` --tag ${opts.tag}` : '';
  writeFileSync(wrapper, `#!/bin/bash\n${env}exec bun run "${FAKE_SERVER}"${tagArg}\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** Live processes carrying a given tag, whether or not the test ever saw the pid. */
async function taggedSurvivors(tag: string): Promise<number[]> {
  const out = await Bun.$`pgrep -f ${tag}`.nothrow().text();
  return out.trim().split('\n').filter(Boolean).map(Number).filter(isAlive);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(20);
  }
  return !isAlive(pid);
}

function makePool(opts: { concurrency: number; minWarmRuntimes: number; idleTtlMs: number }) {
  return new ACPPool({
    kiroCliPath: fakeCliPath(),
    timeoutMs: 5000,
    ...opts,
  });
}

/** PIDs currently held by the pool, in slot order. */
function pids(pool: ACPPool): number[] {
  return pool.stats.slots
    .map((s) => s.pid)
    .filter((p): p is number => typeof p === 'number');
}

describe('ACPPool with real ACP subprocesses', () => {
  test('an idle-TTL retirement actually kills the process, and the warm one keeps serving', async () => {
    const pool = makePool({ concurrency: 2, minWarmRuntimes: 1, idleTtlMs: 1 });
    try {
      // Two concurrent prompts, so the pool grows to two real subprocesses.
      await Promise.all([pool.run('echo: one'), pool.run('echo: two')]);
      const started = pids(pool);
      expect(started).toHaveLength(2);
      for (const pid of started) expect(isAlive(pid)).toBe(true);

      await Bun.sleep(10);
      await pool.sweepIdle();

      // The floor keeps exactly one.
      const remaining = pids(pool);
      expect(remaining).toHaveLength(1);
      expect(pool.stats.idleRecycles).toBe(1);

      const retired = started.filter((p) => !remaining.includes(p));
      expect(retired).toHaveLength(1);
      // The whole point: not merely dropped from the pool's bookkeeping.
      expect(await waitUntilGone(retired[0]!)).toBe(true);

      // The survivor is genuinely warm — same PID serves the next prompt, so no
      // cold start was paid.
      const warm = remaining[0]!;
      expect(isAlive(warm)).toBe(true);
      const result = await pool.run('echo: three');
      expect(result.text).toBe('three');
      expect(pids(pool)).toEqual([warm]);
    } finally {
      await pool.close();
    }
  }, 30_000);

  test('close kills every remaining process, leaving nothing behind', async () => {
    const pool = makePool({ concurrency: 3, minWarmRuntimes: 1, idleTtlMs: 600000 });
    await Promise.all([pool.run('echo: a'), pool.run('echo: b'), pool.run('echo: c')]);
    const started = pids(pool);
    expect(started).toHaveLength(3);

    await pool.close();
    expect(pool.stats.total).toBe(0);
    for (const pid of started) {
      expect(await waitUntilGone(pid)).toBe(true);
    }
  }, 30_000);

  test('a burst never has more than `concurrency` processes alive at once', async () => {
    const pool = makePool({ concurrency: 2, minWarmRuntimes: 1, idleTtlMs: 600000 });
    const seen = new Set<number>();
    let maxAlive = 0;
    let sampling = true;

    const sampler = (async () => {
      while (sampling) {
        for (const pid of pids(pool)) seen.add(pid);
        // Counted at the OS level, over every PID this pool has ever produced —
        // a replacement started while an old process was still shutting down
        // would show up here even though `stats.total` looked correct.
        const live = [...seen].filter(isAlive).length;
        if (live > maxAlive) maxAlive = live;
        await Bun.sleep(5);
      }
    })();

    try {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => pool.run(`echo: burst-${i}`)),
      );
      await Bun.sleep(30);
    } finally {
      sampling = false;
      await sampler;
    }

    expect(maxAlive).toBeGreaterThan(0);
    expect(maxAlive).toBeLessThanOrEqual(2);
    expect(pool.stats.total).toBeLessThanOrEqual(2);
    await pool.close();
  }, 30_000);
});

/**
 * Shutdown races (acceptance blockers, 2026-08-28).
 *
 * Both defects were invisible to every earlier test because both tests and
 * production only ever inspected PIDs recorded BEFORE the signal, and only ever
 * checked liveness by polling with a deadline:
 *
 *  1. `close()` rejects in-flight prompts. `run()`'s catch treated that like any
 *     other ACP error and recycled the slot, which started a REPLACEMENT runtime
 *     after the pool had already emptied `slots` — a process nothing held a
 *     reference to and nothing would ever close. `stats.total` read 0 while an
 *     ACP process stayed resident.
 *  2. `ACPClient.close()` sent SIGTERM and returned immediately, so "closed" meant
 *     "asked to close". That silently broke the concurrency-budget promise: a
 *     retiring slot released its budget while its process was still running.
 */
describe('ACPPool shutdown races', () => {
  test('closing during an in-flight prompt creates no replacement runtime', async () => {
    const tag = `race-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const marker = resolve(import.meta.dir, `${tag}.hanging`);
    rmSync(marker, { force: true });
    const cli = fakeCliPath({ tag, hangMarker: marker });
    const pool = new ACPPool({
      kiroCliPath: cli,
      concurrency: 1,
      minWarmRuntimes: 1,
      idleTtlMs: 600000,
      timeoutMs: 30_000,
    });
    let created: number[] = [];
    try {
      // `hang:` is never answered, so this prompt is still in flight at close
      // time. The handler is attached NOW, before `close()`: the rejection lands
      // during `close()`, and an unobserved rejection at that moment is reported
      // as a failure by the test runner.
      const inflight = pool.run('hang: forever');
      const settled = inflight.then(() => 'resolved' as const, (e: unknown) => e);

      // Wait for the SERVER to confirm it is holding the prompt. Waiting on "a
      // pid exists" is not enough: slots are reserved before `start()` resolves,
      // so closing on that signal interrupts the ACP handshake instead of the
      // prompt — the recycle path is never entered and the test passes vacuously.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !existsSync(marker)) await Bun.sleep(10);
      expect(existsSync(marker)).toBe(true);
      created = pids(pool);
      expect(created).toHaveLength(1);

      await pool.close();
      expect(await settled).toBeInstanceOf(Error);
      // Generous: a replacement would need a spawn plus an ACP handshake.
      await Bun.sleep(1500);

      expect(pool.stats.total).toBe(0);
      // The old behaviour recycled on the close-driven rejection, which is what
      // started the orphan. No recycle must be recorded at all.
      expect(pool.stats.errorRecycles).toBe(0);
      expect(pool.stats.restarts).toBe(0);
      // The decisive assertion: no process carrying this tag is left, including
      // one the pool never told anybody about.
      expect(await taggedSurvivors(tag)).toEqual([]);
      expect(created.filter(isAlive)).toEqual([]);
    } finally {
      await pool.close();
      // A leaked subprocess keeps its stdout pipe open, which would stop the test
      // runner from ever exiting — so never leave one behind, even on failure.
      for (const pid of await taggedSurvivors(tag)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      rmSync(marker, { force: true });
      rmSync(cli, { force: true });
    }
  }, 30_000);

  test('close resolves only after the process has actually exited', async () => {
    const pool = makePool({ concurrency: 1, minWarmRuntimes: 1, idleTtlMs: 600000 });
    await pool.run('echo: one');
    const [pid] = pids(pool);
    expect(typeof pid).toBe('number');

    await pool.close();
    // Checked with no polling and no grace period: the promise is that `close()`
    // does not resolve while the process is alive.
    expect(isAlive(pid!)).toBe(false);
  }, 30_000);

  test('a closed client refuses to spawn again, so a shutdown race cannot resurrect it', async () => {
    const tag = `resurrect-${Date.now()}`;
    const cli = fakeCliPath({ tag });
    const runtime = new ACPRuntime({ kiroCliPath: cli, timeoutMs: 5000 });
    try {
      // The pool reserves a slot — and may therefore close it — before the
      // handshake begins, so `close()` legitimately runs before `start()`.
      await runtime.close();
      expect(() => runtime.start()).toThrow('already closed');
      // Nothing was spawned. Before this guard, `start()` reset the closed flag
      // and launched a process that no slot list and no prior close covered: two
      // leaked per Worker shutdown, while the test asserting on tagged survivors
      // still passed because they appeared after it looked.
      expect(await taggedSurvivors(tag)).toEqual([]);
    } finally {
      for (const pid of await taggedSurvivors(tag)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      rmSync(cli, { force: true });
    }
  }, 30_000);

  test('a runtime that ignores SIGTERM is escalated to SIGKILL rather than leaked', async () => {
    // Defers its exit well past the grace period. An empty SIGTERM handler is
    // not enough — measured on Bun, the process still exits promptly, so it would
    // never reach the escalation this test exists to cover.
    const stubborn = resolve(import.meta.dir, 'fake-acp-stubborn.sh');
    const script = resolve(import.meta.dir, 'fake-acp-stubborn.ts');
    const ready = resolve(import.meta.dir, 'fake-acp-stubborn.ready');
    rmSync(ready, { force: true });
    writeFileSync(
      script,
      "process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 30000); });\n" +
        `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ok');\n` +
        'setInterval(() => {}, 1000);\n',
    );
    writeFileSync(stubborn, `#!/bin/bash\nexec bun run "${script}"\n`);
    chmodSync(stubborn, 0o755);

    const runtime = new ACPRuntime({ kiroCliPath: stubborn, timeoutMs: 1000 });
    let pid: number | null = null;
    try {
      // `start()` never completes: this fixture speaks no ACP. Observed, so its
      // rejection is not reported as an unhandled one.
      const startAttempt = runtime.start().then(() => null, (e: unknown) => e);
      // Wait for the handler to be REGISTERED, not merely for the pid to exist.
      // Signalling during `bun run`'s startup arrives before the handler is
      // installed, the process dies on the default action, and the escalation
      // path is never reached — which is how this test first passed vacuously
      // with a 1ms close.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !existsSync(ready)) await Bun.sleep(10);
      expect(existsSync(ready)).toBe(true);
      pid = runtime.pid;
      expect(typeof pid).toBe('number');

      const before = Date.now();
      await runtime.close();
      const elapsed = Date.now() - before;

      // The promise is unconditional: `close()` does not return while the process
      // is alive, however badly the process behaves.
      expect(isAlive(pid!)).toBe(false);
      // Proof it went through the escalation rather than exiting on SIGTERM.
      expect(elapsed).toBeGreaterThanOrEqual(1900);
      await startAttempt;
    } finally {
      if (pid != null && isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      rmSync(stubborn, { force: true });
      rmSync(script, { force: true });
      rmSync(ready, { force: true });
    }
  }, 30_000);
});
