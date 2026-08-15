/**
 * Subtree RSS sampling.
 *
 * The reason this module exists is a measurement: one `kiro-cli acp` runtime is
 * 9.8MB in the process the pool holds a PID for, plus a 28.1MB child. Sampling
 * only the PID under-reports the ACP pool by ~74% — and an under-report here does
 * not produce a missing number, it produces a confident wrong one that would send
 * the internal-test analysis away from the real cost. So the traversal is pinned.
 */

import { describe, expect, test } from 'bun:test';
import { parsePsOutput, sumSubtrees, sampleRssTree, sampleRssTreeAsync } from '../src/process-rss';

describe('parsePsOutput', () => {
  test('parses rows and converts ps kilobytes to bytes', () => {
    const rows = parsePsOutput('  PID  PPID   RSS\n  100     1  1024\n  200   100  2048\n');
    expect(rows).toEqual([
      { pid: 100, ppid: 1, rssBytes: 1024 * 1024 },
      { pid: 200, ppid: 100, rssBytes: 2048 * 1024 },
    ]);
  });

  test('skips the header and any malformed line instead of throwing', () => {
    const rows = parsePsOutput('PID PPID RSS\n\ngarbage\n1 2\n300 1 512\n');
    expect(rows).toEqual([{ pid: 300, ppid: 1, rssBytes: 512 * 1024 }]);
  });
});

describe('sumSubtrees', () => {
  const table = [
    { pid: 1, ppid: 0, rssBytes: 1 },
    // The shape actually measured: an acp runtime with one heavy child.
    { pid: 100, ppid: 1, rssBytes: 9_800_000 },
    { pid: 101, ppid: 100, rssBytes: 28_100_000 },
    // A grandchild, to prove the walk is not one level deep.
    { pid: 102, ppid: 101, rssBytes: 1_000_000 },
    // An unrelated process that must never be counted.
    { pid: 999, ppid: 1, rssBytes: 500_000_000 },
  ];

  test('sums the whole subtree, not just the requested pid', () => {
    const out = sumSubtrees(table, [100]);
    expect(out.get(100)).toBe(9_800_000 + 28_100_000 + 1_000_000);
  });

  test('omits a pid that is not in the table rather than reporting 0', () => {
    const out = sumSubtrees(table, [100, 4242]);
    // A slot whose process already exited must be distinguishable from a slot
    // that costs nothing.
    expect(out.has(4242)).toBe(false);
    expect(out.has(100)).toBe(true);
  });

  test('does not leak unrelated processes into a subtree', () => {
    const out = sumSubtrees(table, [999]);
    expect(out.get(999)).toBe(500_000_000);
  });

  test('terminates on a cyclic parent chain', () => {
    // PID reuse or a malformed table must not hang a health endpoint.
    const cyclic = [
      { pid: 10, ppid: 11, rssBytes: 100 },
      { pid: 11, ppid: 10, rssBytes: 200 },
    ];
    const out = sumSubtrees(cyclic, [10]);
    expect(out.get(10)).toBe(300);
  });
});

describe('sampleRssTree', () => {
  test('skips the ps call entirely for an empty pid list', () => {
    // An idle Worker has no ACP slots, and /health is meant to be polled, so the
    // common case must cost nothing. `measured: true` because nothing failed —
    // there was simply nothing to measure.
    const sample = sampleRssTree([]);
    expect(sample.measured).toBe(true);
    expect(sample.byPid.size).toBe(0);
  });

  test('ignores invalid pids', () => {
    const sample = sampleRssTree([0, -1, Number.NaN]);
    expect(sample.byPid.size).toBe(0);
  });

  test('measures this process, including its own subtree', () => {
    const sample = sampleRssTree([process.pid]);
    expect(sample.measured).toBe(true);
    const rss = sample.byPid.get(process.pid);
    expect(typeof rss).toBe('number');
    // Sanity bound only: any live Bun process is well above 1MB.
    expect(rss!).toBeGreaterThan(1_000_000);
  });
});

describe('sampleRssTreeAsync', () => {
  test('measures without blocking the caller', async () => {
    const sample = await sampleRssTreeAsync([process.pid]);
    expect(sample.measured).toBe(true);
    expect(sample.byPid.get(process.pid)).toBeGreaterThan(1_000_000);
  });
});
