import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../src/server/worker';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import { ensureLocalAuthToken } from '../../src/auth-token';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const compressor = { summarizeObservation: async () => { throw new Error('unused'); } };

/** Isolated data dir so the Worker reads a token file this test owns. */
function isolatedDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-mem-auth-'));
  const previous = process.env.KIRO_MEMORY_DATA_DIR;
  process.env.KIRO_MEMORY_DATA_DIR = dir;
  cleanups.push(() => {
    process.env.KIRO_MEMORY_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function startWorker() {
  const db = openInMemoryDB();
  const { app, jobRunner } = createApp({
    db, compressor, config: loadConfig(), enableEmbeddings: false,
  });
  cleanups.push(() => { jobRunner.stop(); db.close(); });
  return { app, db };
}

function promptRequest(token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return ['/events/prompt', {
    method: 'POST', headers,
    body: JSON.stringify({ session_id: 's1', cwd: '/tmp', prompt: 'hello' }),
  }] as const;
}

describe('Worker local token authentication', () => {
  test('health stays public while event routes require the configured bearer token', async () => {
    const db = openInMemoryDB();
    const { app, jobRunner } = createApp({
      db, compressor, config: loadConfig(), enableEmbeddings: false,
      authToken: 'test-local-token',
    });
    cleanups.push(() => { jobRunner.stop(); db.close(); });

    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request(...promptRequest())).status).toBe(401);
    expect((await app.request(...promptRequest('wrong'))).status).toBe(401);
    expect((await app.request(...promptRequest('test-local-token'))).status).toBe(200);
  });

  test('a token rotated under a running Worker is picked up without a restart', async () => {
    const dataDir = isolatedDataDir();
    const original = ensureLocalAuthToken(dataDir);
    const { app } = startWorker();

    expect((await app.request(...promptRequest(original))).status).toBe(200);

    // A repair install regenerates .token while the Worker keeps running.
    const rotated = 'b'.repeat(64);
    writeFileSync(join(dataDir, '.token'), rotated, { mode: 0o600 });

    expect((await app.request(...promptRequest(rotated))).status).toBe(200);
    expect((await app.request(...promptRequest(original))).status).toBe(401);
  });

  test('a missing token file is regenerated and never degrades to open access', async () => {
    const dataDir = isolatedDataDir();
    const { app } = startWorker();

    // No .token on disk: the request must be rejected, not waved through.
    expect((await app.request(...promptRequest())).status).toBe(401);
    expect((await app.request(...promptRequest(''))).status).toBe(401);

    const tokenPath = join(dataDir, '.token');
    const regenerated = readFileSync(tokenPath, 'utf-8').trim();
    expect(regenerated).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    // A Hook reading the freshly written file keeps working — no user action.
    expect((await app.request(...promptRequest(regenerated))).status).toBe(200);
  });

  test('rejected requests are counted in /health and logged without the token', async () => {
    const dataDir = isolatedDataDir();
    const token = ensureLocalAuthToken(dataDir);
    const { app } = startWorker();

    await app.request(...promptRequest('wrong-token'));
    await app.request(...promptRequest());

    const health = (await (await app.request('/health')).json()) as {
      auth_24h: { unauthorized: number };
    };
    expect(health.auth_24h.unauthorized).toBe(2);

    const date = new Date().toISOString().slice(0, 10);
    const log = readFileSync(join(dataDir, 'logs', `worker-${date}.log`), 'utf-8');
    expect(log).toContain('auth/unauthorized');
    expect(log).toContain('token-mismatch');
    expect(log).toContain('no-credential');
    expect(log).not.toContain(token);
    expect(log).not.toContain('wrong-token');
  });
});
