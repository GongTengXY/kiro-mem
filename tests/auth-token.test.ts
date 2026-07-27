import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureLocalAuthToken, inspectLocalAuthToken, readLocalAuthToken } from '../src/auth-token';

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

describe('inspectLocalAuthToken', () => {
  function freshDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-token-'));
    dirs.push(dir);
    return dir;
  }

  test('reports every credential state and never returns the token value', () => {
    const missing = freshDir();
    expect(inspectLocalAuthToken(missing)).toEqual({ state: 'missing', ok: false });
    expect(readLocalAuthToken(missing)).toBe('');

    const ok = freshDir();
    const token = ensureLocalAuthToken(ok);
    const okResult = inspectLocalAuthToken(ok);
    expect(okResult).toEqual({ state: 'ok', ok: true, mode: 0o600 });
    expect(JSON.stringify(okResult)).not.toContain(token);
    expect(readLocalAuthToken(ok)).toBe(token);

    const empty = freshDir();
    writeFileSync(join(empty, '.token'), '   ', { mode: 0o600 });
    expect(inspectLocalAuthToken(empty).state).toBe('empty');

    const weak = freshDir();
    writeFileSync(join(weak, '.token'), 'hunter2', { mode: 0o600 });
    expect(inspectLocalAuthToken(weak).state).toBe('weak');

    const insecure = freshDir();
    ensureLocalAuthToken(insecure);
    chmodSync(join(insecure, '.token'), 0o644);
    const insecureResult = inspectLocalAuthToken(insecure);
    expect(insecureResult.state).toBe('insecure');
    expect(insecureResult.mode).toBe(0o644);
  });
});
