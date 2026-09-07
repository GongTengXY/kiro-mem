/**
 * ACP runtime process pool.
 * Manages concurrent access to ACP runtimes with lazy start and recycling.
 *
 * Two lifecycle paths, deliberately not merged (plan §4.2.9):
 *  - `recycleSlot()` — job-limit, ACP error, contamination. Closes the runtime
 *    and starts a replacement IN PLACE, so the slot count never changes and the
 *    `minWarmRuntimes` floor never gates it.
 *  - `retireSlot()` — idle TTL and dead-process pruning. Closes the runtime and
 *    REMOVES the slot, the only path that shrinks the pool and therefore the
 *    only one the warm floor protects.
 */

import { ACPRuntime, type PromptResult } from './runtime';
import type { ACPPoolOptions } from './types';
import { logError } from '../logger';

interface PoolSlot {
  runtime: ACPRuntime;
  jobCount: number;
  busy: boolean;
  /**
   * Epoch ms of the last release. Set at creation so a slot that was never used
   * still reports honest idle time rather than 0.
   */
  lastUsedAt: number;
  /** Chosen for removal. Never assignable again, and never closed twice. */
  retiring: boolean;
}

type RecycleReason = 'job-limit' | 'error';
type RetireReason = 'idle' | 'dead';

/** Housekeeping period bounds: a long TTL must not become an equally long blind
 * spot, a tiny one must not become a busy loop. */
const HOUSEKEEPING_MAX_PERIOD_MS = 60_000;
const HOUSEKEEPING_MIN_PERIOD_MS = 50;

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
  private _jobLimitRecycles = 0;
  private _errorRecycles = 0;
  private _idleRecycles = 0;
  private _deadDrops = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private lastHousekeepingAt = 0;

  constructor(opts: ACPPoolOptions & { runtimeFactory?: () => ACPRuntime } = {}) {
    const concurrency = opts.concurrency ?? 3;
    this.opts = {
      kiroCliPath: opts.kiroCliPath ?? 'kiro-cli',
      kiroHome: opts.kiroHome ?? '',
      timeoutMs: opts.timeoutMs ?? 30000,
      startupTimeoutMs: opts.startupTimeoutMs ?? 30000,
      maxOutputBytes: opts.maxOutputBytes ?? 16384,
      agentName: opts.agentName ?? '',
      concurrency,
      maxJobsPerProcess: opts.maxJobsPerProcess ?? 50,
      // Any positive value, unlike the config loader: unit tests drive the pool
      // with millisecond TTLs. The human-facing floor belongs to config.ts.
      idleTtlMs: sanitizeIdleTtlMs(opts.idleTtlMs),
      minWarmRuntimes: sanitizeMinWarmRuntimes(opts.minWarmRuntimes, concurrency),
      onMetric: opts.onMetric ?? (() => {}),
    };
    this.runtimeFactory = opts.runtimeFactory ?? (() => new ACPRuntime({
      kiroCliPath: this.opts.kiroCliPath,
      kiroHome: this.opts.kiroHome,
      timeoutMs: this.opts.timeoutMs,
      startupTimeoutMs: this.opts.startupTimeoutMs,
      maxOutputBytes: this.opts.maxOutputBytes,
      agentName: this.opts.agentName,
    }));
  }

  get stats() {
    const now = Date.now();
    return {
      total: this.slots.length,
      busy: this.slots.filter((s) => s.busy).length,
      // Counted in `total` and against `concurrency` — the process exists until
      // its close resolves — but never assignable.
      retiring: this.slots.filter((s) => s.retiring).length,
      queued: this.queue.length,
      // In-place restarts only (job-limit + error). Idle retirement is
      // deliberately excluded: resource governance must not read as instability.
      restarts: this._restartCount,
      contaminations: this._contaminationCount,
      jobLimitRecycles: this._jobLimitRecycles,
      errorRecycles: this._errorRecycles,
      idleRecycles: this._idleRecycles,
      deadDrops: this._deadDrops,
      // null, not 0, before the first pass: "did housekeeping ever run?" is the
      // first thing to check when idle reclaim does not happen.
      lastHousekeepingAt:
        this.lastHousekeepingAt > 0 ? new Date(this.lastHousekeepingAt).toISOString() : null,
      // The parameters IN EFFECT, not what config.json says. A pool whose
      // sanitizer rejected a value must not let /health repeat the bad number.
      config: {
        concurrency: this.opts.concurrency,
        minWarmRuntimes: this.opts.minWarmRuntimes,
        idleTtlMs: this.opts.idleTtlMs,
        maxJobsPerProcess: this.opts.maxJobsPerProcess,
      },
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
      // `close()` rejects every in-flight prompt. Recycling on that rejection
      // would start a replacement the pool no longer tracks — an orphaned
      // `kiro-cli acp` process nothing will ever close.
      if (!this.closed) await this.recycleSlot(slot, 'error');
      throw err;
    } finally {
      this.release(slot);
    }
  }

  /** Shut down all runtimes. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopHousekeeping();
    const closedError = new Error('ACPPool is closed');
    for (const waiter of this.queue) waiter.reject(closedError);
    this.queue = [];
    const slots = this.slots;
    this.slots = [];
    await Promise.allSettled(slots.map((s) => s.runtime.close()));
    // A `createSlot` mid-`start()` pushes into the new list, and a retirement in
    // flight may still hold one. Sweep until empty rather than trusting a single
    // pass — the promise here is that no ACP process outlives the pool.
    while (this.slots.length > 0) {
      const stragglers = this.slots;
      this.slots = [];
      await Promise.allSettled(stragglers.map((s) => s.runtime.close()));
    }
  }

  /**
   * One housekeeping pass: drop dead slots, then retire idle ones past the TTL.
   * Public so tests can assert the rules without racing the timer.
   */
  async sweepIdle(): Promise<void> {
    if (this.closed || this.sweeping) return;
    this.sweeping = true;
    try {
      this.lastHousekeepingAt = Date.now();
      await this.pruneDeadSlots();

      // Pending demand cancels the whole TTL pass: retiring a slot a queued task
      // is about to take is pure cold-start cost.
      if (this.queue.length > 0) return;
      if (this.opts.idleTtlMs <= 0) return;

      const ttl = this.opts.idleTtlMs;
      const now = Date.now();
      const expired = this.slots
        .filter((s) => !s.busy && !s.retiring && now - s.lastUsedAt >= ttl)
        // Oldest first, so a pass stopped by the floor keeps the runtime most
        // likely to be reused.
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      for (const slot of expired) {
        if (this.closed) return;
        // The floor applies to the count AFTER this retirement.
        if (this.slots.length <= this.opts.minWarmRuntimes) break;
        // An acquire may have claimed this slot while the previous close awaited.
        if (slot.busy || slot.retiring || !this.slots.includes(slot)) continue;
        await this.retireSlot(slot, 'idle');
      }
    } finally {
      this.sweeping = false;
      if (this.slots.length === 0) this.stopHousekeeping();
    }
  }

  // --- Internal ---

  private async acquire(): Promise<PoolSlot> {
    // A slot whose process died is unassignable, and with `idleTtlMs = 0` there
    // is no timer to clear it — it would hold budget for the life of the Worker.
    // Not awaited: it keeps that budget until its close resolves, and the waiter
    // queued below is served by `drainQueue`.
    void this.pruneDeadSlots();

    const idle = this.slots.find((s) => !s.busy && !s.retiring && s.runtime.alive);
    if (idle) {
      idle.busy = true;
      if (idle.jobCount >= this.opts.maxJobsPerProcess) {
        await this.recycleSlot(idle, 'job-limit');
      }
      return idle;
    }

    // Retiring slots still count here: their `kiro-cli acp` process has not
    // exited, so freeing their budget early would let the machine hold more
    // runtimes than `concurrency` during the close window.
    if (this.slots.length < this.opts.concurrency) {
      // Returned already busy — `createSlot` reserves it synchronously.
      return await this.createSlot();
    }

    return new Promise<PoolSlot>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
  }

  private release(slot: PoolSlot): void {
    // A failed recycle or a retirement removes its slot. Never hand that dead
    // object to a waiter.
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
    // Reserved before `start()` is awaited, and reserved as busy.
    //
    // Pushing after the await let every acquire arriving during ACP
    // initialization pass the `concurrency` check against a still-empty list —
    // measured: 3 runtimes created under `concurrency: 2`. Parking it as idle
    // would be just as wrong: a runtime that has not started reports
    // `alive === false`, so dead-slot pruning would sweep it away.
    const slot: PoolSlot = {
      runtime,
      jobCount: 0,
      busy: true,
      lastUsedAt: Date.now(),
      retiring: false,
    };
    this.slots.push(slot);
    try {
      await runtime.start();
      // A pool that closed during `start()` can no longer reach this runtime,
      // so it must not be kept.
      this.throwIfClosed();
    } catch (error) {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
      // Unconditional, even when `close()` already took this slot:
      // `ACPClient.close()` is idempotent, and skipping here is what let a
      // process spawned during the shutdown race survive unowned.
      await runtime.close().catch(() => {});
      // Nothing is left that could ever release a slot, so waiters queued behind
      // this budget would hang. Fail them with the real start error.
      if (this.slots.length === 0 && this.queue.length > 0) {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const waiter of this.queue.splice(0)) waiter.reject(failure);
      }
      throw error;
    }
    // Started here rather than in the constructor so a Worker that never
    // compresses anything holds no timer (plan §4.3).
    this.ensureHousekeeping();
    return slot;
  }

  /** Close a runtime and start a replacement in the same slot. */
  private async recycleSlot(slot: PoolSlot, reason: RecycleReason): Promise<void> {
    this._restartCount++;
    if (reason === 'job-limit') this._jobLimitRecycles++;
    else this._errorRecycles++;
    if (slot.runtime.isContaminated) {
      this._contaminationCount++;
      this.opts.onMetric('contamination');
    }

    let replacement: ACPRuntime | null = null;
    try {
      await slot.runtime.close();
      // Re-checked after every await: a replacement started after `close()` ran
      // would be unreachable — not in `slots`, not closed, alive until reboot.
      this.throwIfClosed();
      replacement = this.runtimeFactory();
      await replacement.start();
      this.throwIfClosed();
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

  /** Bail out of a multi-await sequence the moment the pool starts shutting down. */
  private throwIfClosed(): void {
    if (this.closed) throw new Error('ACPPool is closed');
  }

  /** Close a runtime and remove its slot, with no replacement. */
  private async retireSlot(slot: PoolSlot, reason: RetireReason): Promise<void> {
    if (slot.retiring) return;
    // Marked unassignable but deliberately NOT detached yet: a retiring slot
    // keeps its place in the `concurrency` budget until its OS process is gone.
    // Detaching first would bound logical slots only, and the machine would
    // briefly hold `concurrency + 1` runtimes at ~38MB each — which is the cost
    // this path exists to avoid.
    slot.retiring = true;
    const idleMs = Math.max(0, Date.now() - slot.lastUsedAt);
    const before = this.slots.length;
    const pid = slot.runtime.pid;

    if (reason === 'idle') this._idleRecycles++;
    else this._deadDrops++;

    try {
      await slot.runtime.close();
    } catch (error) {
      // The slot is already unassignable and is still removed below, so one
      // stuck runtime cannot block the pass. Logged as an error because a leaked
      // ACP process is exactly what this path exists to prevent.
      logError('acp-pool/retire-close-failed', {
        reason,
        pid,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);

      // stdout, not logError: `kiro-mem diagnose` prints the worker log tail as
      // "recent errors" and flags the section as soon as that file is non-empty,
      // so a routine retirement would mark a healthy install as failing. No
      // paths, no prompt text, no Observation content.
      console.log(
        `[kiro-mem] acp-pool/retire reason=${reason} pid=${pid ?? '?'} ` +
          `jobs=${slot.jobCount} idleMs=${idleMs} slots=${before}->${this.slots.length}`,
      );

      // This slot's budget is free only now, and nothing else will release one
      // for a waiter that queued during the close window.
      this.drainQueue();
    }
  }

  /**
   * Hand freed budget to queued tasks. Called after a retirement, the one moment
   * capacity opens up without any slot being released.
   */
  private drainQueue(): void {
    while (!this.closed && this.queue.length > 0 && this.slots.length < this.opts.concurrency) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      void this.createSlot().then(
        (slot) => waiter.resolve(slot),
        (error) => waiter.reject(error instanceof Error ? error : new Error(String(error))),
      );
    }
  }

  /**
   * Remove slots whose process is gone. Unconditional: a dead runtime is not
   * warm, so neither the TTL nor `minWarmRuntimes` protects it (plan §4.2.10).
   */
  private pruneDeadSlots(): Promise<void> {
    const dead = this.slots.filter((s) => !s.busy && !s.retiring && !s.runtime.alive);
    if (dead.length === 0) return Promise.resolve();
    return Promise.all(dead.map((slot) => this.retireSlot(slot, 'dead'))).then(() => {});
  }

  private ensureHousekeeping(): void {
    if (this.closed || this.timer != null) return;
    // `idleTtlMs = 0` starts no timer at all; dead-slot pruning still runs on
    // the `acquire()` path (plan §4.3).
    if (this.opts.idleTtlMs <= 0) return;
    if (this.slots.length === 0) return;
    const period = Math.max(
      HOUSEKEEPING_MIN_PERIOD_MS,
      Math.min(Math.floor(this.opts.idleTtlMs / 2), HOUSEKEEPING_MAX_PERIOD_MS),
    );
    this.timer = setInterval(() => { void this.sweepIdle(); }, period);
    // Without unref, a caller that forgets `pool.close()` keeps a short-lived
    // process (the Bun test runner) alive on an idle timer.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  private stopHousekeeping(): void {
    if (this.timer == null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** `0` means "idle retirement off" and must survive. Anything unusable falls
 * back to the default, because "reclaim nothing" is not a safe default. */
function sanitizeIdleTtlMs(value: number | undefined): number {
  if (value === 0) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 600000;
  return value;
}

/** `0 <= minWarmRuntimes <= concurrency` (plan §4.1). */
function sanitizeMinWarmRuntimes(value: number | undefined, concurrency: number): number {
  const ceiling = Math.max(0, Number.isFinite(concurrency) ? Math.floor(concurrency) : 0);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return Math.min(1, ceiling);
  }
  return Math.min(Math.floor(value), ceiling);
}
