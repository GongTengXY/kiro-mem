import { describe, expect, test } from 'bun:test';
import { ACPPool } from '../../src/acp/pool';

class FakeRuntime {
  alive = true;
  isContaminated = false;
  pid: number | null = null;
  constructor(
    private startError?: Error,
    private promptError?: Error,
    private text = 'ok',
  ) {}
  async start() { if (this.startError) { this.alive = false; throw this.startError; } return {} as any; }
  async createSession() { return 's'; }
  async prompt() { if (this.promptError) { this.alive = false; throw this.promptError; } return { text: this.text }; }
  async close() { this.alive = false; }
}

describe('ACPPool recycle failure', () => {
  test('removes a dead slot so the next task can create a fresh runtime', async () => {
    const runtimes = [
      new FakeRuntime(undefined, new Error('prompt failed')),
      new FakeRuntime(new Error('replacement start failed')),
      new FakeRuntime(undefined, undefined, 'recovered'),
    ];
    const pool = new ACPPool({
      concurrency: 1,
      runtimeFactory: () => runtimes.shift() as any,
    });

    await expect(pool.run('first')).rejects.toThrow('replacement start failed');
    expect(pool.stats.total).toBe(0);

    const result = await Promise.race([
      pool.run('second'),
      Bun.sleep(250).then(() => { throw new Error('pool hung after recycle failure'); }),
    ]);
    expect(result.text).toBe('recovered');
    await pool.close();
  });
});

/**
 * Per-slot stats.
 *
 * These readings decide whether two suspected defects are real, so they must be
 * falsifiable rather than decorative:
 *  - `jobCount` says whether `maxJobsPerProcess` is ever reached in real use. If
 *    it stays in single digits on testers' machines, session accumulation inside
 *    one runtime needs no fix at all.
 *  - `idleMs` + `busy` separate "the pool is saturated" from "the pool is idle
 *    holding memory", which call for opposite decisions on idle recycling.
 */
describe('ACPPool slot stats', () => {
  test('reports no slots before the first job (lazy start)', () => {
    const pool = new ACPPool({ runtimeFactory: () => new FakeRuntime() as any });
    expect(pool.stats.slots).toEqual([]);
    expect(pool.stats.total).toBe(0);
  });

  test('counts jobs per slot and reports it as idle after release', async () => {
    const pool = new ACPPool({
      concurrency: 1,
      runtimeFactory: () => new FakeRuntime() as any,
    });
    await pool.run('one');
    await pool.run('two');

    const [slot] = pool.stats.slots;
    expect(slot!.jobCount).toBe(2);
    expect(slot!.busy).toBe(false);
    // Released, so idle time is running rather than pinned at 0.
    expect(slot!.idleMs).toBeGreaterThanOrEqual(0);
    // A runtime double exposes no subprocess; `null` must not become `undefined`,
    // which would serialize as a missing key on /health.
    expect(slot!.pid).toBeNull();
    await pool.close();
  });

  test('reports idleMs 0 while a slot is busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class BlockingRuntime extends FakeRuntime {
      override async prompt() { await gate; return { text: 'ok' }; }
    }
    const pool = new ACPPool({
      concurrency: 1,
      runtimeFactory: () => new BlockingRuntime() as any,
    });

    const inflight = pool.run('slow');
    // Wait for the slot to exist and be marked busy.
    while (pool.stats.slots.length === 0) await Bun.sleep(1);
    const busySlot = pool.stats.slots[0]!;
    expect(busySlot.busy).toBe(true);
    expect(busySlot.idleMs).toBe(0);

    release();
    await inflight;
    expect(pool.stats.slots[0]!.busy).toBe(false);
    await pool.close();
  });

  test('a recycled slot resets its job count', async () => {
    const pool = new ACPPool({
      concurrency: 1,
      maxJobsPerProcess: 1,
      runtimeFactory: () => new FakeRuntime() as any,
    });
    await pool.run('one');
    expect(pool.stats.slots[0]!.jobCount).toBe(1);
    // Second acquire hits the job limit and recycles before running.
    await pool.run('two');
    // jobCount is per-runtime, so the reading answers "how much has THIS
    // process accumulated", not "how many jobs has the pool ever served" —
    // `restarts` is the cumulative counter.
    expect(pool.stats.slots[0]!.jobCount).toBe(1);
    expect(pool.stats.restarts).toBe(1);
    await pool.close();
  });
});

/**
 * Lifecycle-focused double. Separate from `FakeRuntime` above because these
 * tests need a controllable `alive` (to simulate a process that died on its
 * own, without contamination or a prompt error the pool ever saw) and a
 * countable `close()`.
 */
class LifecycleRuntime {
  alive = true;
  isContaminated = false;
  pid: number | null;
  closeCalls = 0;
  private closeError?: Error;
  constructor(opts: { pid?: number; closeError?: Error } = {}) {
    this.pid = opts.pid ?? null;
    this.closeError = opts.closeError;
  }
  async start() { return {} as any; }
  async createSession() { return 's'; }
  async prompt(): Promise<{ text: string }> { return { text: 'ok' }; }
  async close() {
    this.closeCalls++;
    this.alive = false;
    if (this.closeError) throw this.closeError;
  }
}

/** Factory that records what it handed out, so "was this runtime reused or
 *  replaced?" is answerable rather than inferred from counters. */
function recordingFactory(make: (index: number) => LifecycleRuntime = () => new LifecycleRuntime()) {
  const created: LifecycleRuntime[] = [];
  return {
    created,
    factory: () => {
      const runtime = make(created.length);
      created.push(runtime);
      return runtime as any;
    },
  };
}

/**
 * Observes the global timer functions so "the timer was unref'd" and "close
 * cleared it" are asserted behaviourally rather than by reaching into a private
 * field that a rename would silently break.
 */
async function withTimerSpy<T>(
  body: (spy: { intervals: number; unrefs: number; clears: number }) => Promise<T>,
): Promise<T> {
  const spy = { intervals: 0, unrefs: 0, clears: 0 };
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const tracked = new Set<unknown>();
  (globalThis as any).setInterval = (handler: any, ms?: number) => {
    const timer: any = (originalSet as any)(handler, ms);
    spy.intervals++;
    tracked.add(timer);
    const unref = timer?.unref?.bind(timer);
    if (timer) timer.unref = () => { spy.unrefs++; return unref?.(); };
    return timer;
  };
  (globalThis as any).clearInterval = (timer: any) => {
    if (tracked.has(timer)) spy.clears++;
    return (originalClear as any)(timer);
  };
  try {
    return await body(spy);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
}

/** Hold every slot busy until `release()` is called. */
function blockingFactory() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class Blocking extends LifecycleRuntime {
    override async prompt() { await gate; return { text: 'ok' }; }
  }
  const recorder = recordingFactory(() => new Blocking());
  return { ...recorder, release: () => release() };
}

/**
 * Idle governance (plan §4.2 / §9.1).
 *
 * The pool's cost is resident memory: one runtime measured 38MB (9.8MB parent +
 * a 28.1MB child), and before this round nothing ever reduced that count — the
 * only "recycle" path closed a runtime and immediately started a replacement.
 * So these tests are mostly about which path was taken, not just how many slots
 * survived: a retirement that quietly restarts is indistinguishable from a leak
 * when read through `total` alone.
 */
describe('ACPPool idle governance', () => {
  test('reuses the same runtime for a later job instead of starting a second', async () => {
    const { created, factory } = recordingFactory();
    const pool = new ACPPool({ concurrency: 3, runtimeFactory: factory });
    await pool.run('one');
    await pool.run('two');
    expect(created).toHaveLength(1);
    expect(pool.stats.total).toBe(1);
    await pool.close();
  });

  test('never creates more runtimes than `concurrency`', async () => {
    const { created, factory, release } = blockingFactory();
    const pool = new ACPPool({ concurrency: 2, runtimeFactory: factory });
    const inflight = [pool.run('a'), pool.run('b'), pool.run('c')];
    while (pool.stats.total < 2) await Bun.sleep(1);
    await Bun.sleep(20);
    expect(pool.stats.total).toBe(2);
    expect(created).toHaveLength(2);
    expect(pool.stats.queued).toBe(1);
    release();
    await Promise.all(inflight);
    await pool.close();
  });

  test('never retires a busy slot, even with the warm floor at 0', async () => {
    const { factory, release } = blockingFactory();
    const pool = new ACPPool({
      concurrency: 1, idleTtlMs: 1, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    const inflight = pool.run('slow');
    while (pool.stats.total === 0) await Bun.sleep(1);
    await Bun.sleep(5);
    await pool.sweepIdle();
    // Floor 0 means nothing but the busy check is protecting this slot.
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.idleRecycles).toBe(0);
    release();
    await inflight;
    await pool.close();
  });

  test('retires an idle slot once it passes the TTL', async () => {
    const { created, factory } = recordingFactory();
    const pool = new ACPPool({
      concurrency: 2, idleTtlMs: 1, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    await pool.run('one');
    expect(pool.stats.total).toBe(1);
    await Bun.sleep(5);
    await pool.sweepIdle();
    expect(pool.stats.total).toBe(0);
    expect(pool.stats.idleRecycles).toBe(1);
    // Retirement must actually close the process, not just drop the bookkeeping.
    expect(created[0]!.closeCalls).toBe(1);
    // And it must NOT start a replacement — that is the whole difference from
    // `recycleSlot`.
    expect(created).toHaveLength(1);
    await pool.close();
  });

  test('stops retiring when the next removal would breach `minWarmRuntimes`', async () => {
    const { created, factory, release } = blockingFactory();
    const pool = new ACPPool({
      concurrency: 3, idleTtlMs: 1, minWarmRuntimes: 1, runtimeFactory: factory,
    });
    const inflight = [pool.run('a'), pool.run('b'), pool.run('c')];
    while (pool.stats.total < 3) await Bun.sleep(1);
    release();
    await Promise.all(inflight);
    expect(pool.stats.total).toBe(3);

    await Bun.sleep(5);
    await pool.sweepIdle();
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.idleRecycles).toBe(2);
    expect(created).toHaveLength(3);
    await pool.close();
  });

  test('keeps the last runtime warm under the default floor', async () => {
    const { factory } = recordingFactory();
    // minWarmRuntimes left at its default of 1.
    const pool = new ACPPool({ concurrency: 3, idleTtlMs: 1, runtimeFactory: factory });
    await pool.run('one');
    await Bun.sleep(5);
    await pool.sweepIdle();
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.idleRecycles).toBe(0);
    expect(pool.stats.config.minWarmRuntimes).toBe(1);
    await pool.close();
  });

  test('idle time starts at release, so a re-acquired slot survives the pass', async () => {
    const { created, factory, release } = blockingFactory();
    const pool = new ACPPool({
      concurrency: 2, idleTtlMs: 30, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    const inflight = [pool.run('a'), pool.run('b')];
    while (pool.stats.total < 2) await Bun.sleep(1);
    release();
    await Promise.all(inflight);

    // Both slots are now past the TTL.
    await Bun.sleep(40);
    // This re-acquires the first idle slot and re-stamps its lastUsedAt.
    await pool.run('c');
    await pool.sweepIdle();

    // The reused slot is no longer expired; only the untouched one goes.
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.idleRecycles).toBe(1);
    expect(created[0]!.closeCalls).toBe(0);
    expect(created[1]!.closeCalls).toBe(1);
    await pool.close();
  });

  test('a runtime that fails to close is still removed, and the pool keeps serving', async () => {
    const { created, factory } = recordingFactory((i) =>
      i === 0
        ? new LifecycleRuntime({ pid: 4242, closeError: new Error('close refused') })
        : new LifecycleRuntime(),
    );
    const pool = new ACPPool({
      concurrency: 1, idleTtlMs: 1, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    await pool.run('one');
    await Bun.sleep(5);
    await pool.sweepIdle();

    expect(pool.stats.total).toBe(0);
    expect(pool.stats.idleRecycles).toBe(1);

    const result = await Promise.race([
      pool.run('two'),
      Bun.sleep(250).then(() => { throw new Error('pool hung after a failed retire close'); }),
    ]);
    expect(result.text).toBe('ok');
    expect(created).toHaveLength(2);
    await pool.close();
  });

  test('the housekeeping timer retires an expired slot with no explicit sweep', async () => {
    const { factory } = recordingFactory();
    const pool = new ACPPool({
      concurrency: 2, idleTtlMs: 20, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    await pool.run('one');
    expect(pool.stats.lastHousekeepingAt).toBeNull();

    const deadline = Date.now() + 2000;
    while (pool.stats.total > 0 && Date.now() < deadline) await Bun.sleep(10);

    expect(pool.stats.total).toBe(0);
    expect(pool.stats.idleRecycles).toBe(1);
    // Answers "did housekeeping ever run?" — the first thing to check when idle
    // reclaim does not happen.
    expect(pool.stats.lastHousekeepingAt).not.toBeNull();
    await pool.close();
  });

  test('unrefs the housekeeping timer and clears it on close', async () => {
    await withTimerSpy(async (spy) => {
      const { factory } = recordingFactory();
      const pool = new ACPPool({
        concurrency: 1, idleTtlMs: 60_000, runtimeFactory: factory,
      });
      // Lazy: a pool that has never compressed anything holds no timer.
      expect(spy.intervals).toBe(0);
      await pool.run('one');
      expect(spy.intervals).toBe(1);
      // Without unref, a caller that forgets close() keeps the process alive.
      expect(spy.unrefs).toBe(1);
      await pool.close();
      expect(spy.clears).toBe(1);
    });
  });

  test('idleTtlMs 0 disables retirement and starts no timer at all', async () => {
    await withTimerSpy(async (spy) => {
      const { created, factory } = recordingFactory();
      const pool = new ACPPool({
        concurrency: 1, idleTtlMs: 0, minWarmRuntimes: 0, runtimeFactory: factory,
      });
      await pool.run('one');
      expect(spy.intervals).toBe(0);
      await Bun.sleep(5);
      // Even an explicit pass must not retire: 0 means "off", not "immediately".
      await pool.sweepIdle();
      expect(pool.stats.total).toBe(1);
      expect(pool.stats.idleRecycles).toBe(0);
      expect(pool.stats.config.idleTtlMs).toBe(0);
      expect(created).toHaveLength(1);
      await pool.close();
    });
  });

  test('a retiring runtime keeps its budget until close finishes, so ACP processes never exceed concurrency', async () => {
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { finishClose = resolve; });
    class SlowClosing extends LifecycleRuntime {
      override async close() {
        this.closeCalls++;
        // The `kiro-cli acp` process is still alive for the whole of this await.
        await closeGate;
        this.alive = false;
      }
    }
    const { created, factory } = recordingFactory(() => new SlowClosing());
    const pool = new ACPPool({
      concurrency: 1, idleTtlMs: 1, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    await pool.run('one');
    await Bun.sleep(5);

    // Retirement starts but the process has not exited yet.
    const sweep = pool.sweepIdle();
    await Bun.sleep(5);
    expect(created).toHaveLength(1);
    expect(pool.stats.retiring).toBe(1);
    // Still counted, because the process still exists.
    expect(pool.stats.total).toBe(1);

    // A task arriving inside the close window must wait rather than start a
    // second ACP process alongside the one shutting down. This is the boundary
    // the round is accepted on: the ceiling bounds processes, not bookkeeping.
    const pending = pool.run('two');
    await Bun.sleep(20);
    expect(created).toHaveLength(1);
    expect(pool.stats.queued).toBe(1);

    finishClose();
    await sweep;
    const result = await Promise.race([
      pending,
      Bun.sleep(500).then(() => { throw new Error('waiter never drained after retirement'); }),
    ]);
    expect(result.text).toBe('ok');
    // Only now does the replacement exist, so the two processes never overlapped.
    expect(created).toHaveLength(2);
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.retiring).toBe(0);
    expect(pool.stats.idleRecycles).toBe(1);
    await pool.close();
  });

  test('a dead slot is closed and its budget handed to the waiting task', async () => {
    const { created, factory } = recordingFactory();
    // idleTtlMs 0 on purpose: with no housekeeping timer, `acquire` is the only
    // thing standing between a dead slot and a permanent hang.
    const pool = new ACPPool({ concurrency: 1, idleTtlMs: 0, runtimeFactory: factory });
    await pool.run('one');
    // The process died on its own — no contamination, no prompt error the pool saw.
    created[0]!.alive = false;

    const result = await Promise.race([
      pool.run('two'),
      Bun.sleep(250).then(() => { throw new Error('pool hung behind a dead slot'); }),
    ]);
    expect(result.text).toBe('ok');
    expect(pool.stats.deadDrops).toBe(1);
    expect(pool.stats.total).toBe(1);
    expect(pool.stats.retiring).toBe(0);
    expect(created).toHaveLength(2);
    await pool.close();
  });

  test('housekeeping drops a dead slot even when that breaches the warm floor', async () => {
    const { created, factory } = recordingFactory();
    const pool = new ACPPool({
      concurrency: 1, idleTtlMs: 60_000, minWarmRuntimes: 1, runtimeFactory: factory,
    });
    await pool.run('one');
    created[0]!.alive = false;
    await pool.sweepIdle();

    // A dead runtime is not warm; keeping it would satisfy the floor on paper only.
    expect(pool.stats.total).toBe(0);
    expect(pool.stats.deadDrops).toBe(1);
    // Not an idle retirement, and not an in-place restart either.
    expect(pool.stats.idleRecycles).toBe(0);
    expect(pool.stats.restarts).toBe(0);
    await pool.close();
  });

  test('close clears the timer, rejects queued waiters and closes every runtime', async () => {
    const { created, factory, release } = blockingFactory();
    const pool = new ACPPool({
      concurrency: 1, idleTtlMs: 60_000, runtimeFactory: factory,
    });
    const inflight = pool.run('a');
    while (pool.stats.total === 0) await Bun.sleep(1);
    const queued = pool.run('b');
    while (pool.stats.queued === 0) await Bun.sleep(1);

    await pool.close();
    await expect(queued).rejects.toThrow('ACPPool is closed');
    expect(pool.stats.total).toBe(0);
    // The invariant is "never left open", not "closed exactly once". `close()`
    // may race a slot that is still starting, and in that case the pool closes
    // the runtime twice on purpose — leak safety outranks a tidy call count, and
    // `ACPClient.close()` is idempotent.
    expect(created[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(created[0]!.alive).toBe(false);
    // A pool that has been closed refuses new work rather than lazily reopening.
    await expect(pool.run('c')).rejects.toThrow('ACPPool is closed');

    release();
    await inflight.catch(() => {});
  });
});

/**
 * Recycle accounting (plan §7 / §9.1.14).
 *
 * `restarts` keeps its pre-existing meaning — in-place restarts only — so a
 * reader comparing the number across versions never sees idle governance as new
 * instability. The three causes are then split, because "the pool is churning"
 * and "the pool is releasing idle memory" demand opposite responses.
 */
describe('ACPPool recycle accounting', () => {
  test('a job-limit recycle counts as an in-place restart', async () => {
    const { created, factory } = recordingFactory();
    const pool = new ACPPool({
      concurrency: 1, maxJobsPerProcess: 1, runtimeFactory: factory,
    });
    await pool.run('one');
    await pool.run('two');

    const s = pool.stats;
    expect(s.restarts).toBe(1);
    expect(s.jobLimitRecycles).toBe(1);
    expect(s.errorRecycles).toBe(0);
    expect(s.idleRecycles).toBe(0);
    expect(s.deadDrops).toBe(0);
    // In place: the slot count never dipped, so the warm floor was never involved.
    expect(s.total).toBe(1);
    expect(created).toHaveLength(2);
    await pool.close();
  });

  test('an ACP error counts as an error recycle, not a job-limit one', async () => {
    const runtimes = [
      new FakeRuntime(undefined, new Error('prompt failed')),
      new FakeRuntime(),
    ];
    const pool = new ACPPool({
      concurrency: 1,
      runtimeFactory: () => runtimes.shift() as any,
    });
    await expect(pool.run('one')).rejects.toThrow('prompt failed');

    const s = pool.stats;
    expect(s.restarts).toBe(1);
    expect(s.errorRecycles).toBe(1);
    expect(s.jobLimitRecycles).toBe(0);
    expect(s.idleRecycles).toBe(0);
    // The prompt failed for an ordinary reason, so the contamination subset
    // must stay empty.
    expect(s.contaminations).toBe(0);
    await pool.close();
  });

  test('idle retirement never inflates `restarts`', async () => {
    const { factory } = recordingFactory();
    const pool = new ACPPool({
      concurrency: 2, idleTtlMs: 1, minWarmRuntimes: 0, runtimeFactory: factory,
    });
    await pool.run('one');
    await Bun.sleep(5);
    await pool.sweepIdle();

    const s = pool.stats;
    expect(s.idleRecycles).toBe(1);
    expect(s.restarts).toBe(0);
    expect(s.jobLimitRecycles).toBe(0);
    expect(s.errorRecycles).toBe(0);
    await pool.close();
  });

  test('reports the parameters in effect, not the ones asked for', () => {
    const { factory } = recordingFactory();
    const pool = new ACPPool({
      concurrency: 1,
      // Above the ceiling: a floor that outranks concurrency would pin slots
      // that can never exist.
      minWarmRuntimes: 5,
      // Unusable. Falling back to "no reclaim" would be the wrong default.
      idleTtlMs: Number.NaN,
      runtimeFactory: factory,
    });
    expect(pool.stats.config.minWarmRuntimes).toBe(1);
    expect(pool.stats.config.idleTtlMs).toBe(600000);

    const negative = new ACPPool({ idleTtlMs: -1, runtimeFactory: factory });
    expect(negative.stats.config.idleTtlMs).toBe(600000);
    const infinite = new ACPPool({ idleTtlMs: Number.POSITIVE_INFINITY, runtimeFactory: factory });
    expect(infinite.stats.config.idleTtlMs).toBe(600000);
  });
});
