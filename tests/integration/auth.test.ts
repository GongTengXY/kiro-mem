import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../../src/server/worker';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe('Worker local token authentication', () => {
  test('health stays public while event routes require the configured bearer token', async () => {
    const db = openInMemoryDB();
    const compressor = { summarizeObservation: async () => { throw new Error('unused'); } };
    const { app, jobRunner } = createApp({
      db, compressor, config: loadConfig(), enableEmbeddings: false,
      authToken: 'test-local-token',
    });
    cleanups.push(() => { jobRunner.stop(); db.close(); });

    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/events/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 's1', cwd: '/tmp', prompt: 'hello' }),
    })).status).toBe(401);
    expect((await app.request('/events/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ session_id: 's1', cwd: '/tmp', prompt: 'hello' }),
    })).status).toBe(401);
    expect((await app.request('/events/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-local-token' },
      body: JSON.stringify({ session_id: 's1', cwd: '/tmp', prompt: 'hello' }),
    })).status).toBe(200);
  });
});
