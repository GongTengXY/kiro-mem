/** Persistent job runner backed by SQLite jobs table. Supports lease, retry, dedup, dead-letter. */

import { MemoryDB } from '../db';
import type { Job, JobState } from '../db/types';
import { logError } from '../logger';

export type JobHandler = (job: Job) => Promise<void>;

const LEASE_OWNER = `worker-${process.pid}`;
const DEFAULT_POLL_MS = 2000;
const BACKOFF_BASE_MS = 5000;

export class JobRunner {
  private db: MemoryDB;
  private handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private concurrency: number;
  private inflight = 0;
  private pollMs: number;

  constructor(db: MemoryDB, opts?: { concurrency?: number; pollMs?: number }) {
    this.db = db;
    this.concurrency = opts?.concurrency ?? 6;
    this.pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  }

  /** Register a handler for a job_type. Must be called before start(). */
  register(jobType: string, handler: JobHandler): this {
    this.handlers.set(jobType, handler);
    return this;
  }

  /** Start polling. Also reclaims stale leases from previous crashes. */
  start() {
    if (this.running) return;
    this.running = true;
    this.reclaimStaleLeases();
    this.poll(); // immediate first poll
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get stats() {
    return {
      inflight: this.inflight,
      pending: this.countByState('pending'),
      leased: this.countByState('leased'),
      dead: this.countByState('dead'),
    };
  }

  // ----------------------------------------------------------
  // Internal
  // ----------------------------------------------------------

  private countByState(state: JobState): number {
    const row = this.db.raw
      .query('SELECT COUNT(*) AS cnt FROM jobs WHERE state = ?')
      .get(state) as { cnt: number };
    return row.cnt;
  }

  /**
   * On startup, any jobs left in `leased` state from a previous process are
   * considered abandoned. Reset them to `pending` so they get retried.
   */
  private reclaimStaleLeases() {
    const now = new Date().toISOString();
    this.db.raw.run(
      `UPDATE jobs SET state = 'pending', leased_at = NULL, lease_owner = NULL, updated_at = ?
       WHERE state = 'leased'`,
      [now],
    );
  }

  private poll() {
    if (!this.running) return;
    while (this.inflight < this.concurrency) {
      const job = this.fetchNext();
      if (!job) break;
      this.inflight++;
      this.execute(job).finally(() => {
        this.inflight--;
      });
    }
  }

  /**
   * Atomically lease the next available job. Uses UPDATE ... RETURNING to
   * avoid TOCTOU races in single-writer SQLite.
   */
  private fetchNext(): Job | null {
    const now = new Date().toISOString();
    const row = this.db.raw
      .query(
        `UPDATE jobs
           SET state = 'leased', leased_at = ?, lease_owner = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state = 'pending' AND available_at <= ?
           ORDER BY priority ASC, available_at ASC, id ASC
           LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, LEASE_OWNER, now, now) as Job | null;
    return row;
  }

  private async execute(job: Job) {
    const handler = this.handlers.get(job.job_type);
    if (!handler) {
      logError('job-runner', `no handler for job_type=${job.job_type}, marking dead`);
      this.markDead(job, 'no handler registered');
      return;
    }
    try {
      await handler(job);
      this.markSucceeded(job);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('job-runner', `job #${job.id} (${job.job_type}) failed: ${msg}`);
      this.markFailed(job, msg);
    }
  }

  private markSucceeded(job: Job) {
    const now = new Date().toISOString();
    this.db.raw.run(
      `UPDATE jobs SET state = 'succeeded', attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      [now, job.id],
    );
  }

  private markFailed(job: Job, error: string) {
    const now = new Date().toISOString();
    const attempts = job.attempts + 1;
    if (attempts >= job.max_attempts) {
      this.markDead(job, error);
      return;
    }
    // Exponential backoff
    const delayMs = BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    this.db.raw.run(
      `UPDATE jobs
         SET state = 'pending', attempts = ?, last_error = ?,
             available_at = ?, leased_at = NULL, lease_owner = NULL, updated_at = ?
       WHERE id = ?`,
      [attempts, error, availableAt, now, job.id],
    );
  }

  private markDead(job: Job, error: string) {
    const now = new Date().toISOString();
    this.db.raw.run(
      `UPDATE jobs
         SET state = 'dead', attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [error, now, job.id],
    );
  }
}
