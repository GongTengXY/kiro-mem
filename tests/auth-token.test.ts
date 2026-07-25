import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureLocalAuthToken } from '../src/auth-token';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ensureLocalAuthToken', () => {
  test('creates a high-entropy 0600 token and preserves it on repair install', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-token-'));
    dirs.push(dir);
    const first = ensureLocalAuthToken(dir);
    const tokenPath = join(dir, '.token');

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(tokenPath, 'utf-8')).toBe(first);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    const second = ensureLocalAuthToken(dir);
    expect(second).toBe(first);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });
});
