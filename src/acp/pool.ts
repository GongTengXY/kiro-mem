/**
 * ACP runtime process pool.
 * Manages concurrent access to ACP runtimes with lazy start and recycling.
 */

import { ACPRuntime, type PromptResult } from './runtime';
import type { ACPPoolOptions } from './types';

interface PoolSlot {
  runtime: ACPRuntime;
  jobCount: number;
  busy: boolean;
  /**
   * Epoch ms of the last release. Set at creation so a slot that was never used
   * still reports honest idle time rather than 0.
   */
  lastUsedAt: number;
}

/** Per-slot detail reported on `/health`, for internal-test data collection. */
export interface ACPSlotStat {
  /** PID of the `kiro-cli acp` process; null if it never started or already exited. */
  pid: number | null;
  /**
   * Jobs this runtime has served since it was created. Recycling resets it, so
   * this reading answers whether `maxJobsPerProcess` is ever actually reached —
   * if it stays in single digits in real use, session accumulation inside one
   * runtime is not a real problem and needs no fix.
   */
  jobCount: number;
  /** Milliseconds since last release. 0 while busy. */
  idleMs: number;
  busy: boolean;
}

export class ACPPool {
  private slots: PoolSlot[] = [];
  private queue: Array<{
    resolve: (slot: PoolSlot) => void;
    reject: (error: Error) => void;
  }> = [];
  private opts: Required<ACPPoolOptions>;
  private runtimeFactory: () => ACPRuntime;
  private closed = false;
  private _restartCount = 0;
  private _contaminationCount = 0;

  constructor(opts: ACPPoolOptions & { runtimeFactory?: () => ACPRuntime } = {}) {
    this.opts = {
      kiroCliPath: opts.kiroCliPath ?? 'kiro-cli',
      kiroHome: opts.kiroHome ?? '',
      timeoutMs: opts.timeoutMs ?? 30000,
      maxOutputBytes: opts.maxOutputBytes ?? 16384,
      agentName: opts.agentName ?? '',
      concurrency: opts.concurrency ?? 3,
      maxJobsPerProcess: opts.maxJobsPerProcess ?? 50,
      onMetric: opts.onMetric ?? (() => {}),
    };
    this.runtimeFactory = opts.runtimeFactory ?? (() => new ACPRuntime({
      kiroCliPath: this.opts.kiroCliPath,
      kiroHome: this.opts.kiroHome,
      timeoutMs: this.opts.timeoutMs,
      maxOutputBytes: this.opts.maxOutputBytes,
      agentName: this.opts.agentName,
    }));
  }

  get stats() {
    const now = Date.now();
    return {
      total: this.slots.length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
      restarts: this._restartCount,
      contaminations: this._contaminationCount,
      // Per-slot detail. The aggregate counts above cannot distinguish "3 slots
      // saturated" from "3 slots idle holding memory", and those two readings
      // call for opposite decisions on idle recycling.
      slots: this.slots.map(
        (s): ACPSlotStat => ({
          // `?? null` rather than a bare read: a runtime implementation without
          // the getter (test doubles) must report "unknown", not `undefined`,
          // which would serialize as a missing key and read as a shape change.
          pid: s.runtime.pid ?? null,
          jobCount: s.jobCount,
          idleMs: s.busy ? 0 : Math.max(0, now - s.lastUsedAt),
          busy: s.busy,
        }),
      ),
    };
  }

  /**
   * Execute a prompt through the pool.
   * Acquires a slot, sends the prompt, releases the slot.
   */
  async run(prompt: string, opts?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<PromptResult> {
    if (this.closed) throw new Error('ACPPool is closed');

    const slot = await this.acquire();
    try {
      // Create a fresh session for each compression job
      await slot.runtime.createSession();
      const result = await slot.runtime.prompt(prompt, opts);
      slot.jobCount++;
      return result;
    } catch (err) {
      // On error, recycle the slot
      await this.recycleSlot(slot);
      throw err;
    } finally {
      this.release(slot);
    }
  }

  /** Shut down all runtimes. */
  async close(): Promise<void> {
    this.closed = true;
    const closedError = new Error('ACPPool is closed');
    for (const waiter of this.queue) waiter.reject(closedError);
    this.queue = [];
    await Promise.allSettled(this.slots.map((s) => s.runtime.close()));
    this.slots = [];
  }

  // --- Internal ---

  private async acquire(): Promise<PoolSlot> {
    const idle = this.slots.find((s) => !s.busy && s.runtime.alive);
    if (idle) {
      idle.busy = true;
      if (idle.jobCount >= this.opts.maxJobsPerProcess) {
        await this.recycleSlot(idle);
      }
      return idle;
    }

    if (this.slots.length < this.opts.concurrency) {
      const slot = await this.createSlot();
      slot.busy = true;
      return slot;
    }

    return new Promise<PoolSlot>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private release(slot: PoolSlot): void {
    // A failed recycle removes its slot. Never hand that dead object to a waiter.
    if (!this.slots.includes(slot)) return;
    slot.busy = false;
    // Stamped even when a waiter takes the slot immediately below: the field
    // means "last time this runtime finished work", not "start of idleness".
    slot.lastUsedAt = Date.now();

    const waiter = this.queue.shift();
    if (waiter) {
      slot.busy = true;
      waiter.resolve(slot);
    }
  }

  private async createSlot(): Promise<PoolSlot> {
    const runtime = this.runtimeFactory();
    try {
      await runtime.start();
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
    const slot: PoolSlot = { runtime, jobCount: 0, busy: false, lastUsedAt: Date.now() };
    this.slots.push(slot);
    return slot;
  }

  private async recycleSlot(slot: PoolSlot): Promise<void> {
    this._restartCount++;
    if (slot.runtime.isContaminated) {
      this._contaminationCount++;
      this.opts.onMetric('contamination');
    }

    let replacement: ACPRuntime | null = null;
    try {
      await slot.runtime.close();
      replacement = this.runtimeFactory();
      await replacement.start();
      slot.runtime = replacement;
      slot.jobCount = 0;
    } catch (error) {
      if (replacement) await replacement.close().catch(() => {});
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      const failure = error instanceof Error ? error : new Error(String(error));
      // Existing waiters were queued only because the dead slot occupied the
      // concurrency budget. Fail them explicitly; a subsequent call can create
      // a fresh slot instead of hanging behind an object that no longer exists.
      for (const waiter of this.queue.splice(0)) waiter.reject(failure);
      throw error;
    }
  }
}
