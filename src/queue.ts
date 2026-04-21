import { Compressor } from "./compressor";
import { MemoryDB } from "./db";
import { loadConfig } from "./config";

export interface CompressionJob {
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  toolResponse: unknown;
  cwd: string;
}

type JobEntry = CompressionJob & { retries: number };

export class CompressionQueue {
  private queue: JobEntry[] = [];
  private running = 0;
  private runningSessionIds: Map<string, number> = new Map();
  private concurrency: number;
  private compressor: Compressor;
  private db: MemoryDB;
  private waiters: Map<string, Array<() => void>> = new Map();

  constructor(db: MemoryDB, compressor?: Compressor) {
    const config = loadConfig();
    this.concurrency = Math.min(10, Math.max(5, config.compression.concurrency));
    this.db = db;
    this.compressor = compressor || new Compressor();
  }

  get size() { return this.queue.length; }
  get active() { return this.running; }

  enqueue(job: CompressionJob) {
    this.queue.push({ ...job, retries: 0 });
    this.drain();
  }

  async waitForSession(sessionId: string, timeoutMs = 30000): Promise<void> {
    // 如果队列中没有该 session 的 job 且没有正在运行的，直接返回
    if (!this.hasSessionJobs(sessionId)) return;

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(sessionId, resolve);
        resolve();
      }, timeoutMs);

      const wrapped = () => {
        clearTimeout(timer);
        resolve();
      };

      const list = this.waiters.get(sessionId) || [];
      list.push(wrapped);
      this.waiters.set(sessionId, list);
    });
  }

  private hasSessionJobs(sessionId: string): boolean {
    return this.queue.some(j => j.sessionId === sessionId) || (this.runningSessionIds.get(sessionId) || 0) > 0;
  }

  private removeWaiter(sessionId: string, fn: () => void) {
    const list = this.waiters.get(sessionId);
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
    if (!list.length) this.waiters.delete(sessionId);
  }

  private notifyWaiters(sessionId: string) {
    if (this.hasSessionJobs(sessionId)) return;
    const list = this.waiters.get(sessionId);
    if (!list) return;
    this.waiters.delete(sessionId);
    for (const fn of list) fn();
  }

  private drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running++;
      this.runningSessionIds.set(job.sessionId, (this.runningSessionIds.get(job.sessionId) || 0) + 1);
      this.processJob(job).finally(() => {
        this.running--;
        const count = (this.runningSessionIds.get(job.sessionId) || 1) - 1;
        if (count <= 0) this.runningSessionIds.delete(job.sessionId);
        else this.runningSessionIds.set(job.sessionId, count);
        this.notifyWaiters(job.sessionId);
        this.drain();
      });
    }
  }

  private async processJob(job: JobEntry) {
    try {
      const result = await this.compressor.compressObservation({
        tool_name: job.toolName,
        tool_input: job.toolInput,
        tool_response: job.toolResponse,
        cwd: job.cwd,
      });

      const inputStr = JSON.stringify(job.toolInput) + JSON.stringify(job.toolResponse);
      this.db.insertObservation({
        session_id: job.sessionId,
        tool_name: job.toolName,
        event_type: "tool_use",
        title: result.title,
        narrative: result.narrative,
        facts: result.facts,
        concepts: result.concepts,
        obs_type: result.type,
        files: result.files,
        raw_tokens: Math.ceil(inputStr.length / 4),
        compressed_tokens: Math.ceil((result.title + result.narrative).length / 4),
      });
    } catch (err) {
      if (job.retries < 2) {
        job.retries++;
        this.queue.push(job);
      } else {
        console.error(`[queue] Failed after 3 attempts: ${job.toolName}`, err);
      }
    }
  }
}
