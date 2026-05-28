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
}

export class ACPPool {
  private slots: PoolSlot[] = [];
  private queue: Array<{ resolve: (slot: PoolSlot) => void }> = [];
  private opts: Required<ACPPoolOptions>;
  private closed = false;
  private _restartCount = 0;

  constructor(opts: ACPPoolOptions = {}) {
    this.opts = {
      kiroCliPath: opts.kiroCliPath ?? 'kiro-cli',
      kiroHome: opts.kiroHome ?? '',
      timeoutMs: opts.timeoutMs ?? 30000,
      maxOutputBytes: opts.maxOutputBytes ?? 16384,
      agentName: opts.agentName ?? '',
      concurrency: opts.concurrency ?? 3,
      maxJobsPerProcess: opts.maxJobsPerProcess ?? 50,
    };
  }

  get stats() {
    return {
      total: this.slots.length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.queue.length,
      restarts: this._restartCount,
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
    // Reject queued waiters
    for (const waiter of this.queue) {
      waiter.resolve(null as unknown as PoolSlot); // will be caught
    }
    this.queue = [];
    // Close all slots
    await Promise.all(this.slots.map((s) => s.runtime.close()));
    this.slots = [];
  }

  // --- Internal ---

  private async acquire(): Promise<PoolSlot> {
    // Find an idle slot
    const idle = this.slots.find((s) => !s.busy && s.runtime.alive);
    if (idle) {
      idle.busy = true;
      // Recycle if over job limit
      if (idle.jobCount >= this.opts.maxJobsPerProcess) {
        await this.recycleSlot(idle);
      }
      return idle;
    }

    // Create new slot if under concurrency limit
    if (this.slots.length < this.opts.concurrency) {
      const slot = await this.createSlot();
      slot.busy = true;
      return slot;
    }

    // Wait for a slot to become available
    return new Promise<PoolSlot>((resolve) => {
      this.queue.push({ resolve });
    });
  }

  private release(slot: PoolSlot): void {
    slot.busy = false;

    // If there are waiters, give them this slot
    if (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      slot.busy = true;
      waiter.resolve(slot);
    }
  }

  private async createSlot(): Promise<PoolSlot> {
    const runtime = new ACPRuntime({
      kiroCliPath: this.opts.kiroCliPath,
      kiroHome: this.opts.kiroHome,
      timeoutMs: this.opts.timeoutMs,
      maxOutputBytes: this.opts.maxOutputBytes,
      agentName: this.opts.agentName,
    });
    await runtime.start();
    const slot: PoolSlot = { runtime, jobCount: 0, busy: false };
    this.slots.push(slot);
    return slot;
  }

  private async recycleSlot(slot: PoolSlot): Promise<void> {
    this._restartCount++;
    await slot.runtime.close();
    const runtime = new ACPRuntime({
      kiroCliPath: this.opts.kiroCliPath,
      kiroHome: this.opts.kiroHome,
      timeoutMs: this.opts.timeoutMs,
      maxOutputBytes: this.opts.maxOutputBytes,
      agentName: this.opts.agentName,
    });
    await runtime.start();
    slot.runtime = runtime;
    slot.jobCount = 0;
  }
}
