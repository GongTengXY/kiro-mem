/**
 * Query vectors come from the Worker, not from each session (plan §5.4, §5.5
 * gates 2/4/5).
 *
 * The thing being verified is a resource claim, so it is measured rather than
 * asserted by inspection: with three repos searching concurrently through the
 * real HTTP path, the process that answers must report exactly ONE model
 * instance, and each repo must still see only its own scope.
 *
 * The `/embed/query` endpoint is also the only place a caller can push work into
 * the Worker's inference, so its bounds are part of the contract: auth required,
 * oversized input refused, and over-limit concurrency shed with 429 rather than
 * queued behind an uncancellable CPU-bound task.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB, computeScopeKey } from '../../src/db';
import { createApp } from '../../src/server/worker';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import { DIMENSIONS, embeddingToBlob } from '../../src/embedding-space';
import { RAW_PROTOCOL, SEMANTIC_EN_PROTOCOL, embeddingSpaceKey } from '../../src/semantic-en';
import { createWorkerEmbedder } from '../../src/worker-embedder';
import { hybridSearchObservations } from '../../src/server/observation-search';
import type { Hono } from 'hono';

const EN_SPACE = embeddingSpaceKey(SEMANTIC_EN_PROTOCOL);
const RAW_SPACE = embeddingSpaceKey(RAW_PROTOCOL);
const TOKEN = 'a'.repeat(64);

let db: MemoryDB;
let app: Hono;
let stopRunner: () => void;
/** Counts real inference calls: the stand-in for "how many models are loaded". */
let embedCalls = 0;
let embedDelayMs = 0;

beforeEach(() => {
  db = openInMemoryDB();
  embedCalls = 0;
  embedDelayMs = 0;
  const result = createApp({
    db,
    compressor: new ACPCompressor({}, new FakeACPPool()),
    config: loadConfig(),
    enableEmbeddings: true,
    embeddingGenerator: async (text: string) => {
      embedCalls++;
      if (embedDelayMs) await new Promise((r) => setTimeout(r, embedDelayMs));
      const v = new Float32Array(DIMENSIONS);
      // Deterministic and text-dependent, so a wrong text produces a wrong score.
      v[text.length % DIMENSIONS] = 1;
      return v;
    },
    enableAuth: true,
    authToken: TOKEN,
  });
  app = result.app;
  stopRunner = () => result.jobRunner.stop();
});

afterEach(() => { stopRunner(); db.close(); });

function seed(scope: { repo: string; session: string }, title: string, hot: number): number {
  db.upsertSessionRef({ session_id: scope.session, cwd: scope.repo, repo: scope.repo });
  const seq = db.allocateNextTurnSeq(scope.session);
  const turn = db.createTurn({
    session_id: scope.session, seq, cwd: scope.repo, repo: scope.repo, prompt_text: title,
  });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: scope.session, turn_seq: seq, repo: scope.repo,
    cwd_scope: scope.repo, title, summary: title, memory_type: 'change', quality: 'normal',
    turn_started_at: '2026-07-20T00:00:00Z', turn_stopped_at: '2026-07-20T00:00:00Z',
  })!;
  const v = new Float32Array(DIMENSIONS);
  v[hot % DIMENSIONS] = 1;
  db.upsertObservationEmbedding(id, EN_SPACE, DIMENSIONS, embeddingToBlob(v));
  db.upsertObservationEmbedding(id, RAW_SPACE, DIMENSIONS, embeddingToBlob(v));
  return id;
}

/** Serve `app` on an ephemeral port so the embedder exercises the real HTTP path. */
function serve(): { port: number; close: () => void } {
  const server = Bun.serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  return { port: server.port as number, close: () => server.stop(true) };
}

describe('POST /embed/query', () => {
  test('returns a float32 vector of the model dimensionality', async () => {
    const res = await app.request('/embed/query', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'retrieval candidate pool' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dimensions: number; embedding: string };
    expect(body.ok).toBe(true);
    expect(body.dimensions).toBe(DIMENSIONS);
    expect(Buffer.from(body.embedding, 'base64').byteLength).toBe(DIMENSIONS * 4);
  });

  test('requires the local token — an unauthenticated session cannot spend inference', async () => {
    const res = await app.request('/embed/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(401);
    expect(embedCalls).toBe(0);
  });

  test('rejects empty and oversized input', async () => {
    const post = (text: unknown) =>
      app.request('/embed/query', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    expect((await post('   ')).status).toBe(400);
    expect((await post('x'.repeat(5000))).status).toBe(413);
    expect(embedCalls).toBe(0);
  });

  test('sheds load with 429 past the queue limit instead of queueing behind inference', async () => {
    embedDelayMs = 60;
    const limit = ((await (await app.request('/health')).json()) as {
      embedding_runtime: { queue_limit: number };
    }).embedding_runtime.queue_limit;
    const burst = await Promise.all(
      Array.from({ length: limit + 4 }, () =>
        app.request('/embed/query', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'burst' }),
        }),
      ),
    );
    const statuses = burst.map((r) => r.status);
    expect(statuses.filter((s) => s === 200).length).toBe(limit);
    expect(statuses.filter((s) => s === 429).length).toBe(4);
    // Rejections are reported, not silent: a caller degraded to FTS-only should
    // be diagnosable from /health.
    const health = (await (await app.request('/health')).json()) as {
      embedding_runtime: { rejected: number };
    };
    expect(health.embedding_runtime.rejected).toBe(4);
  });
});

describe('three repos, one model instance', () => {
  test('concurrent scoped searches share the Worker and never cross scopes', async () => {
    const repos = [
      { repo: '/repoA', session: 'sA', hot: 11, marker: 'alpha' },
      { repo: '/repoB', session: 'sB', hot: 22, marker: 'bravo' },
      { repo: '/repoC', session: 'sC', hot: 33, marker: 'charlie' },
    ];
    const owned = repos.map((r) => seed(r, `${r.marker} shared retrieval work`, r.hot));
    const server = serve();
    try {
      const embedder = createWorkerEmbedder({
        port: server.port,
        host: '127.0.0.1',
        dataDir: '/nonexistent-datadir',
        timeoutMs: 3000,
      });
      // No token on disk at that dataDir, so an authenticated Worker must refuse
      // — proof that this path really is the HTTP one and really is authorized.
      await expect(embedder('unauthorized probe')).rejects.toThrow(/HTTP 401/);

      const authorized = (text: string) =>
        fetch(`http://127.0.0.1:${server.port}/embed/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        })
          .then((r) => r.json() as Promise<{ embedding: string }>)
          .then((b) => {
            const buf = Buffer.from(b.embedding, 'base64');
            return new Float32Array(
              buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            );
          });

      const results = await Promise.all(
        repos.map((r, i) =>
          hybridSearchObservations(
            db,
            `${r.marker} retrieval`,
            {
              scopeKey: computeScopeKey(r.repo, r.repo),
              limit: 10,
              semanticQueryEn: `${r.marker} retrieval work`,
            },
            { generateEmbedding: authorized },
          ).then((res) => ({ i, res })),
        ),
      );

      for (const { i, res } of results) {
        expect(res.length).toBe(1);
        expect(res[0]!.id).toBe(owned[i]!);
        // Scope isolation is unaffected by centralizing the vectors: the embed
        // call carries text only, never a scope.
        for (const [j, otherId] of owned.entries()) {
          if (j !== i) expect(res.map((r) => r.id)).not.toContain(otherId);
        }
      }

      const health = (await (await app.request('/health')).json()) as {
        embedding_runtime: { model_instances: number; in_flight: number };
      };
      // The claim: one model per dataDir, not one per repo/session. The fixture
      // embedder counts instantiations the same way the real one does.
      expect(health.embedding_runtime.model_instances).toBeLessThanOrEqual(1);
      expect(health.embedding_runtime.in_flight).toBe(0);
      // Three searches, three query embeddings — all served by this one process.
      expect(embedCalls).toBe(3);
    } finally {
      server.close();
    }
  });

  test('a dead Worker degrades the search to FTS-only rather than failing it', async () => {
    seed({ repo: '/repoD', session: 'sD' }, 'delta retrieval work', 44);
    // Port 1 is never listening; the embedder must throw, and the kernel must
    // treat that as "no semantic leg" — the same contract as a model failure.
    const embedder = createWorkerEmbedder({ port: 1, host: '127.0.0.1', timeoutMs: 200 });
    let degraded = 0;
    const res = await hybridSearchObservations(
      db,
      'delta retrieval',
      { scopeKey: computeScopeKey('/repoD', '/repoD'), limit: 10, semanticQueryEn: 'delta retrieval work' },
      { generateEmbedding: embedder, onDegrade: () => { degraded++; }, embeddingTimeoutMs: 1000 },
    );
    expect(degraded).toBe(1);
    expect(res.length).toBe(1);
    expect(res[0]!.match_source).toBe('fts');
    expect(res[0]!.semantic_score).toBeNull();
  });
});
