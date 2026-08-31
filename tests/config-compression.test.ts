/**
 * `compression.minWarmRuntimes` / `compression.idleTtlMs` validation.
 *
 * These two fields govern how many `kiro-cli acp` processes a long-running
 * Worker keeps resident, so a silently-mangled value is expensive in both
 * directions: too low and every low-frequency compression pays ACP cold start,
 * too high and the pool holds ~38MB per idle runtime forever.
 *
 * The case that motivates a dedicated test is `idleTtlMs: 0`. It is a legal,
 * meaningful value meaning "never retire on idle" — so it must NOT be pushed up
 * to the floor by a generic `Math.min/Math.max` clamp, which is what the rest of
 * the compression block uses.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig } from '../src/config';

const dirs: string[] = [];
const originalDataDir = process.env.KIRO_MEMORY_DATA_DIR;

afterEach(() => {
  // Restored so the shared preload data dir stays authoritative for every other
  // test in this process.
  if (originalDataDir == null) delete process.env.KIRO_MEMORY_DATA_DIR;
  else process.env.KIRO_MEMORY_DATA_DIR = originalDataDir;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Point `loadConfig()` at a throwaway dir holding exactly this config.json. */
function withConfig(raw: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-config-'));
  dirs.push(dir);
  process.env.KIRO_MEMORY_DATA_DIR = dir;
  writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
  return loadConfig().compression;
}

describe('compression pool config', () => {
  test('a config written before this round gets the defaults, with no migration', () => {
    const c = withConfig({ language: 'zh', compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 } });
    expect(c.minWarmRuntimes).toBe(1);
    expect(c.idleTtlMs).toBe(600000);
    // Untouched fields must survive the new sanitizers.
    expect(c.concurrency).toBe(3);
    expect(c.timeoutMs).toBe(30000);
    expect(c.maxRetries).toBe(2);
  });

  test('a config with no compression block at all still loads', () => {
    const c = withConfig({ language: 'en' });
    expect(c.minWarmRuntimes).toBe(1);
    expect(c.idleTtlMs).toBe(600000);
  });

  test('an explicit idleTtlMs of 0 survives instead of being clamped up', () => {
    const c = withConfig({ compression: { idleTtlMs: 0 } });
    // 0 means "idle retirement off". Raising it to the floor would give the
    // operator continuous recycling when they asked for none.
    expect(c.idleTtlMs).toBe(0);
  });

  test('unusable idleTtlMs values fall back to the default, not to 0', () => {
    // "Reclaim nothing" is not a safe default for a typo.
    expect(withConfig({ compression: { idleTtlMs: -1 } }).idleTtlMs).toBe(600000);
    expect(withConfig({ compression: { idleTtlMs: null } }).idleTtlMs).toBe(600000);
    expect(withConfig({ compression: { idleTtlMs: '600000' } }).idleTtlMs).toBe(600000);
    // JSON cannot carry Infinity/NaN literally; both arrive as null.
    expect(withConfig({ compression: { idleTtlMs: Number.POSITIVE_INFINITY } }).idleTtlMs).toBe(600000);
    expect(withConfig({ compression: { idleTtlMs: Number.NaN } }).idleTtlMs).toBe(600000);
  });

  test('a positive idleTtlMs is held inside sane bounds', () => {
    // Below the floor the pool would spend more time restarting ACP than
    // compressing, so a human-entered value under it is treated as a mistake.
    expect(withConfig({ compression: { idleTtlMs: 250 } }).idleTtlMs).toBe(1000);
    // Beyond a day it is indistinguishable from "never", which already has an
    // explicit spelling.
    expect(withConfig({ compression: { idleTtlMs: 999_999_999 } }).idleTtlMs).toBe(86_400_000);
    expect(withConfig({ compression: { idleTtlMs: 120_000 } }).idleTtlMs).toBe(120_000);
  });

  test('minWarmRuntimes is clamped against the concurrency actually in effect', () => {
    // A floor above the ceiling would pin slots that can never exist.
    const c = withConfig({ compression: { concurrency: 1, minWarmRuntimes: 5 } });
    expect(c.minWarmRuntimes).toBe(1);
    expect(withConfig({ compression: { concurrency: 3, minWarmRuntimes: 2 } }).minWarmRuntimes).toBe(2);
  });

  test('minWarmRuntimes 0 is legal and means "retire down to an empty pool"', () => {
    expect(withConfig({ compression: { minWarmRuntimes: 0 } }).minWarmRuntimes).toBe(0);
  });

  test('unusable minWarmRuntimes values fall back to the default', () => {
    expect(withConfig({ compression: { minWarmRuntimes: -2 } }).minWarmRuntimes).toBe(1);
    expect(withConfig({ compression: { minWarmRuntimes: 'one' } }).minWarmRuntimes).toBe(1);
    // The fallback is still bounded by concurrency.
    expect(withConfig({ compression: { concurrency: 0, minWarmRuntimes: null } }).minWarmRuntimes).toBe(0);
  });
});
