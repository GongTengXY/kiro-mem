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
