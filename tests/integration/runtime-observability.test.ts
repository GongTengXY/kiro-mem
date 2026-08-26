/**
 * `/health` runtime observability groups (memory / storage / ingest / mcpClientsSeen).
 *
 * These fields exist for one purpose: answering "which process is growing?" from
 * a tester's machine, over a week, without asking them to correlate `ps` and `du`
 * by hand. So the contract under test is mostly about honesty of absence —
 * `null` vs `0`, `-1` vs `0`, `measured: false` vs a small number. A field that
 * reports 0 for "not measured" is worse than no field at all, because it reads as
 * evidence.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { openInMemoryDB, openTmpFileDB, type TmpDbHandle } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import type { Hono } from 'hono';

function buildApp(db: MemoryDB, opts?: { embeddings?: boolean }): Hono {
  const compressor = new ACPCompressor({}, new FakeACPPool());
  const config = { ...loadConfig(), retrieval: { semanticDiscovery: true } };
  return createApp({
    db,
    compressor,
    config,
    enableEmbeddings: opts?.embeddings ?? false,
    // Deterministic: this test must never load the real inference runtime.
    embeddingGenerator: async () => new Float32Array(384).fill(0.1),
    enableAuth: false,
  }).app;
}

async function health(app: Hono): Promise<any> {
  const res = await app.request('/health');
  expect(res.status).toBe(200);
  return res.json();
}

describe('/health memory group', () => {
  let db: MemoryDB;
  let app: Hono;

  beforeEach(() => {
    db = openInMemoryDB();
    app = buildApp(db);
  });
  afterEach(() => db.close());

  test('reports the Worker own RSS', async () => {
    const h = await health(app);
    expect(typeof h.runtime.startedAt).toBe('string');
    expect(h.runtime.uptimeMs).toBeGreaterThanOrEqual(0);
    // Its job is to RULE OUT the Worker: measured at 10.7MB after 18 days of
    // uptime, so a large value here means the diagnosis has to be redone.
    expect(h.memory.workerSelfRssBytes).toBeGreaterThan(1_000_000);
  });

  test('reports per-slot detail from the pool, with null pid for a pool-less double', async () => {
    const h = await health(app);
    expect(Array.isArray(h.memory.acpSlots)).toBe(true);
    const slot = h.memory.acpSlots[0];
    // The fake pool has no subprocess. `null` — not `undefined`, not `0` — is
    // what tells the reader "no process to measure" rather than "free".
    expect(slot.pid).toBeNull();
    expect(slot.rssBytes).toBeNull();
    expect(slot.jobCount).toBe(0);
    expect(slot.busy).toBe(false);
    expect(typeof slot.idleMs).toBe('number');
  });

  test('acpAttributedSubtreeRssBytes never counts an unmeasured slot as a number', async () => {
    const h = await health(app);
    // All slots are null here, so the total is 0 — but rssMeasured must still be
    // true, because nothing failed. These two flags are read together.
    expect(h.memory.acpAttributedSubtreeRssBytes).toBe(0);
    expect(h.memory.rssMeasured).toBe(true);
  });

  test('mcpClientsSeen is empty until a client identifies itself', async () => {
    const h = await health(app);
    expect(h.memory.mcpClientsSeen).toEqual([]);
  });

  test('an /embed/query carrying X-Kiro-Mem-Pid registers that client', async () => {
    const embedApp = buildApp(db, { embeddings: true });
    const res = await embedApp.request('/embed/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kiro-Mem-Pid': String(process.pid) },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);

    await health(embedApp); // starts the asynchronous RSS refresh
    await Bun.sleep(25);
    const h = await health(embedApp);
    expect(h.memory.mcpClientsSeen).toHaveLength(1);
    const client = h.memory.mcpClientsSeen[0];
    expect(client.pid).toBe(process.pid);
    // This PID is real, so it must actually resolve to a subtree size.
    expect(client.rssBytes).toBeGreaterThan(1_000_000);
    expect(client.lastSeenMsAgo).toBeGreaterThanOrEqual(0);
    expect(h.memory.rssSampleAt).not.toBeNull();
    expect(h.memory.rssSampleAgeMs).toBeGreaterThanOrEqual(0);
    expect(h.embedding_runtime.requests).toBe(1);
    expect(h.embedding_runtime.samples).toBe(1);
    expect(h.embedding_runtime.latencyMsP95).toBeGreaterThanOrEqual(0);
  });

  test('a request without the header is not counted, so old MCP builds stay silent', async () => {
    const embedApp = buildApp(db, { embeddings: true });
    const res = await embedApp.request('/embed/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(200);
    const h = await health(embedApp);
    expect(h.memory.mcpClientsSeen).toEqual([]);
  });
});

describe('/health ingest latency', () => {
  let db: MemoryDB;
  let app: Hono;

  beforeEach(() => {
    db = openInMemoryDB();
    app = buildApp(db);
  });
  afterEach(() => db.close());

  test('starts empty rather than reporting a fabricated 0ms p95', async () => {
    const h = await health(app);
    expect(h.ingest_runtime.requests).toBe(0);
    expect(h.ingest_runtime.samples).toBe(0);
  });

  test('counts every /events/* request, including quarantined ones', async () => {
    // A quarantined event still consumed Worker time, and the hook still waited
    // for it — excluding it would understate exactly the latency that causes
    // capture misses.
    await app.request('/events/observation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_name: 'read' }),
    });
    await app.request('/events/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'S1', cwd: '/tmp', prompt: 'hi' }),
    });

    const h = await health(app);
    expect(h.ingest_runtime.requests).toBe(2);
    expect(h.ingest_runtime.samples).toBe(2);
    expect(h.ingest_runtime.latencyMsP95).toBeGreaterThanOrEqual(0);
    expect(h.ingest_runtime.latencyMsMax).toBeGreaterThanOrEqual(h.ingest_runtime.latencyMsP50);
  });
});

describe('/health storage group', () => {
  test('reports real file sizes for a file-backed database', async () => {
    const handle: TmpDbHandle = openTmpFileDB('kiro-mem-storage-');
    try {
      const app = buildApp(handle.db);
      const h = await health(app);
      expect(h.storage.dbBytes).toBeGreaterThan(0);
      // WAL mode is enabled in the constructor, so the sidecar exists.
      expect(h.storage.walBytes).toBeGreaterThanOrEqual(0);
    } finally {
      handle.close();
    }
  });

  test('reports -1, not 0, when a file cannot be stat-ed', async () => {
    // `:memory:` has no file on disk. 0 would read as "an empty database";
    // -1 says "there is nothing to measure here".
    const db = openInMemoryDB();
    try {
      const h = await health(buildApp(db));
      expect(h.storage.dbBytes).toBe(-1);
      expect(h.storage.walBytes).toBe(-1);
    } finally {
      db.close();
    }
  });

  test('counts the two tables nothing ever prunes', async () => {
    const handle = openTmpFileDB('kiro-mem-storage-grow-');
    try {
      const app = buildApp(handle.db);
      const before = await health(app);
      expect(before.storage.turnEventsApprox).toBe(0);
      expect(before.storage.jobsSucceeded).toBe(0);

      await app.request('/events/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'S1', cwd: '/tmp', prompt: 'fix bug' }),
      });
      await app.request('/events/observation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'S1', tool_name: 'read', tool_response: 'x' }),
      });

      const after = await health(app);
      // The truth layer only ever grows; this is the number that makes the rate
      // visible across daily samples.
      expect(after.storage.turnEventsApprox).toBe(2);
    } finally {
      handle.close();
    }
  });
});
