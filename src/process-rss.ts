/**
 * Resident-memory sampling for processes the Worker spawned or serves. The number
 * that matters is a process subtree, not a process: measured on this machine, one
 * `kiro-cli acp` runtime is 9.8MB in the process the pool holds a PID for, plus a
 * 28.1MB child of its own — sampling the PID alone under-reports the pool by ~74%.
 * `process.memoryUsage()` covers only the calling process, and every expensive
 * process in this system is a child.
 */

import { spawn, spawnSync } from 'child_process';

interface ProcRow {
  pid: number;
  ppid: number;
  rssBytes: number;
}

export interface RssSample {
  /**
   * Subtree RSS per requested PID, in bytes. Absent from the map when the PID was
   * not found — a slot whose process already exited must not read as 0 bytes.
   */
  byPid: Map<number, number>;
  /**
   * False when `ps` could not run or produced nothing parseable. Surface it rather
   * than publishing zeros: "not measured" and "measured as small" are opposites.
   */
  measured: boolean;
}

/**
 * Parse `ps -Ao pid,ppid,rss` output. This and `sumSubtrees` are exported so
 * fixtures can test them: the parser silently rots when a platform changes its
 * column padding, and the traversal needs a synthetic table for its cycle guard.
 */
export function parsePsOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    // `ps` reports RSS in kilobytes on both macOS and Linux.
    const rssKb = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(rssKb)) {
      continue; // header row ("PID PPID RSS") and any malformed line
    }
    rows.push({ pid, ppid, rssBytes: rssKb * 1024 });
  }
  return rows;
}

/** Sum the subtree RSS of each requested PID from a parsed process table. */
export function sumSubtrees(rows: ProcRow[], pids: number[]): Map<number, number> {
  const byPid = new Map<number, ProcRow>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }

  const out = new Map<number, number>();
  for (const root of pids) {
    if (!byPid.has(root)) continue; // exited between stats read and sampling
    let total = 0;
    // Seen-set: a malformed table or PID reuse must not become an infinite loop in /health.
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += byPid.get(pid)?.rssBytes ?? 0;
      for (const child of children.get(pid) ?? []) {
        if (!seen.has(child)) stack.push(child);
      }
    }
    out.set(root, total);
  }
  return out;
}

/**
 * One `ps` invocation regardless of PID count, and none at all for an empty list,
 * so a polled `/health` pays nothing on an idle Worker.
 */
export function sampleRssTree(pids: number[]): RssSample {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (unique.length === 0) return { byPid: new Map(), measured: true };
  try {
    const result = spawnSync('ps', ['-Ao', 'pid,ppid,rss'], {
      encoding: 'utf-8',
      // A health endpoint must not hang on a wedged `ps`.
      timeout: 2000,
    });
    if (result.status !== 0 || !result.stdout) return { byPid: new Map(), measured: false };
    const rows = parsePsOutput(result.stdout);
    if (rows.length === 0) return { byPid: new Map(), measured: false };
    return { byPid: sumSubtrees(rows, unique), measured: true };
  } catch {
    return { byPid: new Map(), measured: false };
  }
}

/**
 * Non-blocking equivalent used by the production health endpoint: a synchronous
 * `ps` on the event loop would pause hook ingestion for the full timeout.
 */
export function sampleRssTreeAsync(pids: number[], timeoutMs = 2000): Promise<RssSample> {
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (unique.length === 0) return Promise.resolve({ byPid: new Map(), measured: true });

  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (sample: RssSample): void => {
      if (settled) return;
      settled = true;
      resolve(sample);
    };
    let child;
    try {
      child = spawn('ps', ['-Ao', 'pid,ppid,rss'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish({ byPid: new Map(), measured: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ byPid: new Map(), measured: false });
    }, timeoutMs);
    child.stdout?.setEncoding('utf-8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.on('error', () => {
      clearTimeout(timer);
      finish({ byPid: new Map(), measured: false });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (status !== 0 || !stdout) {
        finish({ byPid: new Map(), measured: false });
        return;
      }
      const rows = parsePsOutput(stdout);
      finish(rows.length === 0
        ? { byPid: new Map(), measured: false }
        : { byPid: sumSubtrees(rows, unique), measured: true });
    });
  });
}
