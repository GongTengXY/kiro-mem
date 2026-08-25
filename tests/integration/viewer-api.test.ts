/**
 * Viewer API and browser-security surface (plan §6, §7, test matrix §10.2).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createApp } from '../../src/server/worker';
import { openInMemoryDB } from '../support/tmp-db';
import { loadConfig } from '../../src/config';
import type { MemoryDB } from '../../src/db';

const TOKEN = 'viewer-test-token';
const PORT = loadConfig().worker.port;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const HOST = `127.0.0.1:${PORT}`;

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const compressor = { summarizeObservation: async () => { throw new Error('unused'); } };

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function startApp(opts?: { uiDirs?: string[]; logsDir?: string }) {
  const db = openInMemoryDB();
  const { app, jobRunner, viewerHub } = createApp({
    db,
    compressor,
    config: loadConfig(),
    enableEmbeddings: false,
    authToken: TOKEN,
    ...(opts?.uiDirs ? { viewerUiDirs: opts.uiDirs } : {}),
    ...(opts?.logsDir ? { viewerLogsDir: opts.logsDir } : {}),
  });
  cleanups.push(() => { viewerHub.closeAll(); jobRunner.stop(); db.close(); });
  return { app, db, viewerHub };
}

/** Minimal shape of the Hono app under test. */
type TestApp = { request: (path: string, init: RequestInit) => Response | Promise<Response> };

/** POST to a viewer endpoint with the bearer token and a loopback Host. */
function post(
  app: TestApp,
  path: string,
  body: unknown,
  opts?: { token?: string | null; host?: string; origin?: string; method?: string },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Host: opts?.host ?? HOST };
  const token = opts?.token === undefined ? TOKEN : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts?.origin) headers.Origin = opts.origin;
  return Promise.resolve(app.request(path, { method: opts?.method ?? 'POST', headers, body: JSON.stringify(body) }));
}

function get(
  app: TestApp,
  path: string,
  opts?: { token?: string | null; host?: string },
) {
  const headers: Record<string, string> = { Host: opts?.host ?? HOST };
  const token = opts?.token === undefined ? TOKEN : opts.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  return Promise.resolve(app.request(path, { method: 'GET', headers }));
}

/**
 * Typed JSON read. Bun's `Response.json()` is `Promise<unknown>` (the DOM lib is
 * deliberately not in this project's types), so the cast happens once here rather
 * than at every assertion.
 */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

/** Seed one full record and return its ids. */
function seed(db: MemoryDB, opts?: { sessionId?: string; cwd?: string; repo?: string | null; title?: string; summary?: string }) {
  const sessionId = opts?.sessionId ?? 's1';
  const cwd = opts?.cwd ?? '/proj/one';
  const repo = opts?.repo === undefined ? cwd : opts.repo;
  db.upsertSessionRef({ session_id: sessionId, cwd, repo });
  const seq = db.allocateNextTurnSeq(sessionId);
  const turn = db.createTurn({ session_id: sessionId, seq, cwd, repo, prompt_text: 'rotate the auth token' });
  db.appendTurnEvent({ turn_id: turn.id, session_id: sessionId, hook_event_name: 'userPromptSubmit', payload_json: '{"prompt":"rotate the auth token"}' });
  db.appendTurnEvent({ turn_id: turn.id, session_id: sessionId, hook_event_name: 'postToolUse', tool_name: 'shell', payload_json: '{"tool_response":"ok"}' });
  db.upsertTurnArtifacts(turn.id, { commands_json: JSON.stringify(['bun test']) });
  db.markTurnClosed(turn.id);
  const id = db.insertObservation({
    turn_id: turn.id, session_id: sessionId, turn_seq: turn.seq, repo, cwd_scope: cwd,
    title: opts?.title ?? 'Auth token rotation', summary: opts?.summary ?? 'Rotation regenerates the token',
    request: 'rotate the auth token', outcome: 'verified', learned: null, next_steps: null,
    memory_type: 'bugfix', files_touched: ['src/auth.ts'], concepts: ['auth'], evidence: ['bun test'],
    importance_score: 0.5, confidence_score: 0.5, unresolved_score: 0, quality: 'normal',
    turn_started_at: turn.started_at, turn_stopped_at: turn.stopped_at ?? turn.started_at,
  })!;
  return { id, turnId: turn.id, scopeKey: db.getObservation(id)!.scope_key };
}

describe('Viewer API auth and host binding', () => {
  test('data routes need the bearer token; the static shell does not and carries no memory', async () => {
    const uiDir = tmpDir('kiro-mem-ui-');
    writeFileSync(join(uiDir, 'viewer.html'), '<!doctype html><html><body><div id="app"></div><script src="/ui/viewer.js"></script></body></html>');
    writeFileSync(join(uiDir, 'viewer.js'), 'console.log(1)');
    writeFileSync(join(uiDir, 'styles.css'), 'body{}');
    const { app, db } = startApp({ uiDirs: [uiDir] });
    const { scopeKey } = seed(db, { title: 'SECRET-MEMORY-TITLE' });

    // Shell: public, hardened, and free of any memory content.
    const shell = await app.request('/ui', { headers: { Host: HOST } });
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).not.toContain('SECRET-MEMORY-TITLE');
    expect(shell.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(shell.headers.get('content-security-policy')).not.toContain('unsafe-inline');
    expect(shell.headers.get('x-frame-options')).toBe('DENY');
    expect(shell.headers.get('x-content-type-options')).toBe('nosniff');
    expect(shell.headers.get('referrer-policy')).toBe('no-referrer');
    expect(shell.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(shell.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect((await app.request('/ui/viewer.js', { headers: { Host: HOST } })).status).toBe(200);
    expect((await app.request('/ui/styles.css', { headers: { Host: HOST } })).status).toBe(200);

    // Anything outside the asset allowlist is not reachable, traversal included.
    expect((await app.request('/ui/../kiro-mem.db', { headers: { Host: HOST } })).status).not.toBe(200);
    expect((await app.request('/ui/secrets.txt', { headers: { Host: HOST } })).status).toBe(404);

    // Data: fails closed.
    for (const path of ['/api/viewer/bootstrap', '/api/viewer/retrieval-health', '/api/viewer/logs']) {
      expect((await get(app, path, { token: null })).status).toBe(401);
      expect((await get(app, path, { token: 'wrong' })).status).toBe(401);
      expect((await get(app, path)).status).toBe(200);
    }
    for (const path of ['/api/viewer/observations/list', '/api/viewer/observations/detail', '/api/viewer/search', '/api/viewer/context-preview', '/api/viewer/observations/pin', '/api/viewer/stream']) {
      expect((await post(app, path, { scopeKey }, { token: null })).status).toBe(401);
    }
  });

  test('a non-loopback Host is refused before any handler runs (DNS rebinding)', async () => {
    const { app, db } = startApp();
    const { scopeKey } = seed(db);
    for (const host of ['evil.com', 'evil.com:37778', '127.0.0.1.evil.com', 'localhost.evil.com', '10.0.0.5:37778']) {
      expect((await get(app, '/api/viewer/bootstrap', { host })).status).toBe(403);
      expect((await app.request('/ui', { headers: { Host: host } })).status).toBe(403);
      expect((await post(app, '/api/viewer/observations/list', { scopeKey }, { host })).status).toBe(403);
    }
    for (const host of [HOST, `localhost:${PORT}`, `[::1]:${PORT}`]) {
      expect((await get(app, '/api/viewer/bootstrap', { host })).status).toBe(200);
    }
    // A loopback name on somebody else's port is not this Viewer.
    expect((await get(app, '/api/viewer/bootstrap', { host: '127.0.0.1:1' })).status).toBe(403);
  });

  test('the Host check follows the port actually bound, not the configured one', async () => {
    // A Worker can legitimately listen on a port other than `config.worker.port`
    // (a port-0 bind in a test harness, or a config edit not yet restarted into).
    // Anchoring the check to config alone rejected every real request.
    const db = openInMemoryDB();
    const { app, jobRunner, viewerHub, setListeningPort } = createApp({
      db, compressor, config: loadConfig(), enableEmbeddings: false, authToken: TOKEN,
    });
    cleanups.push(() => { viewerHub.closeAll(); jobRunner.stop(); db.close(); });
    const boundPort = PORT + 1234;

    expect((await get(app, '/api/viewer/bootstrap', { host: `127.0.0.1:${boundPort}` })).status).toBe(403);
    setListeningPort(boundPort);
    expect((await get(app, '/api/viewer/bootstrap', { host: `127.0.0.1:${boundPort}` })).status).toBe(200);
    // The stale configured port is no longer accepted.
    expect((await get(app, '/api/viewer/bootstrap', { host: HOST })).status).toBe(403);
    // Non-loopback names stay refused at any port.
    expect((await get(app, '/api/viewer/bootstrap', { host: `evil.com:${boundPort}` })).status).toBe(403);
  });

  test('missing scope fails closed; only allScopes === true browses globally', async () => {
    const { app, db } = startApp();
    const mine = seed(db, { sessionId: 'a', cwd: '/proj/mine', title: 'Mine' });
    seed(db, { sessionId: 'b', cwd: '/proj/other', title: 'Other' });

    expect((await post(app, '/api/viewer/observations/list', {})).status).toBe(400);
    expect((await post(app, '/api/viewer/observations/list', { allScopes: 'true' })).status).toBe(400);
    expect((await post(app, '/api/viewer/observations/list', { allScopes: 1 })).status).toBe(400);

    const scoped = await json(await post(app, '/api/viewer/observations/list', { scopeKey: mine.scopeKey }));
    expect(scoped.items.map((i: { title: string }) => i.title)).toEqual(['Mine']);
    expect(scoped.items.every((i: { scopeKey: string }) => i.scopeKey === mine.scopeKey)).toBe(true);

    const global = await json(await post(app, '/api/viewer/observations/list', { allScopes: true }));
    expect(global.items.length).toBe(2);
    expect(global.allScopes).toBe(true);
  });

  test('detail, events and search are scope-isolated by SQL, not by the client', async () => {
    const { app, db } = startApp();
    const mine = seed(db, { sessionId: 'a', cwd: '/proj/mine', title: 'Mine rotation' });
    const other = seed(db, { sessionId: 'b', cwd: '/proj/other', title: 'Other rotation' });

    // Asking for another scope's id under my scope is a 404, not a filtered 200.
    expect((await post(app, '/api/viewer/observations/detail', { id: other.id, scopeKey: mine.scopeKey })).status).toBe(404);
    expect((await post(app, '/api/viewer/observations/events', { id: other.id, scopeKey: mine.scopeKey })).status).toBe(404);

    const detail = await json(await post(app, '/api/viewer/observations/detail', { id: mine.id, scopeKey: mine.scopeKey }));
    expect(detail.memory.id).toBe(mine.id);
    expect(detail.source.turnId).toBe(mine.turnId);
    expect(detail.source.promptText).toBe('rotate the auth token');
    expect(detail.source.events.count).toBe(2);
    expect(detail.source.events.payloadBytes).toBeGreaterThan(0);
    expect(detail.source.artifacts.commands).toEqual(['bun test']);

    const events = await json(await post(app, '/api/viewer/observations/events', { id: mine.id, scopeKey: mine.scopeKey }));
    expect(events.items.length).toBe(2);
    expect(events.items[0].payload).toContain('rotate the auth token');
    expect(events.truncated).toBe(false);

    const search = await json(await post(app, '/api/viewer/search', { q: 'rotation', scopeKey: mine.scopeKey }));
    expect(search.items.length).toBe(1);
    expect(search.items[0].title).toBe('Mine rotation');
    expect(search.items[0].matchSource).toBeDefined();
    // Viewer search never invents an English form, so it stays keyword-only and
    // the embedder is never reached (the injected embedder would throw).
    expect(search.items[0].semanticScore).toBeNull();
  });

  test('list pagination is bounded and keyset-stable', async () => {
    const { app, db } = startApp();
    let scopeKey = '';
    for (let i = 0; i < 7; i++) {
      scopeKey = seed(db, { sessionId: `s${i}`, cwd: '/proj/page', title: `Item ${i}` }).scopeKey;
    }
    const first = await json(await post(app, '/api/viewer/observations/list', { scopeKey, limit: 3 }));
    expect(first.items.length).toBe(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await json(await post(app, '/api/viewer/observations/list', { scopeKey, limit: 3, cursor: first.nextCursor }));
    const firstIds = first.items.map((i: { id: number }) => i.id);
    const secondIds = second.items.map((i: { id: number }) => i.id);
    expect(secondIds.some((id: number) => firstIds.includes(id))).toBe(false);

    // An over-limit request is clamped, never honoured.
    const big = await json(await post(app, '/api/viewer/observations/list', { scopeKey, limit: 5000 }));
    expect(big.items.length).toBeLessThanOrEqual(50);
  });

  test('context preview matches the real hook output byte for byte and stays in scope', async () => {
    const { app, db } = startApp();
    // repo: null so the stored scope_key is the cwd-derived form the agentSpawn
    // hook computes for the same directory — otherwise the two sides would be
    // comparing different scopes and the byte-identity claim would be vacuous.
    const { scopeKey } = seed(db, { cwd: '/proj/ctx', repo: null, title: 'Context check' });
    expect(scopeKey).toBe('cwd:/proj/ctx');

    const preview = await json(await post(app, '/api/viewer/context-preview', { scopeKey }));
    const hook = await (await app.request(`/context/bootstrap?cwd=${encodeURIComponent('/proj/ctx')}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Host: HOST },
    })).text();
    expect(preview.text).toBe(hook);
    expect(preview.usedBytes).toBe(Buffer.byteLength(hook, 'utf8'));
    // The per-section byte accounting must explain the whole text.
    const sum = preview.sections.reduce((acc: number, s: { bytes: number }) => acc + s.bytes, 0);
    expect(sum).toBe(preview.usedBytes);
    expect(preview.text).toContain('Context check');

    // Budget is clamped server-side and capped at 9500.
    const capped = await json(await post(app, '/api/viewer/context-preview', { scopeKey, maxOutputBytes: 999999 }));
    expect(capped.effectiveMaxBytes).toBeLessThanOrEqual(9500);
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(9500);

    // Unknown scopes are refused, so a Viewer request cannot make the Worker
    // probe an arbitrary path.
    expect((await post(app, '/api/viewer/context-preview', { scopeKey: '/etc/passwd' })).status).toBe(404);
    expect((await post(app, '/api/viewer/context-preview', { allScopes: true })).status).toBe(400);
  });

  test('pin round-trips through the API and reaches the bootstrap index', async () => {
    const { app, db } = startApp();
    const { id, scopeKey } = seed(db, { cwd: '/proj/pin' });

    expect((await post(app, '/api/viewer/observations/pin', { id, scopeKey, pinned: true })).status).toBe(200);
    expect(db.getObservation(id)!.is_pinned).toBe(1);
    expect((await post(app, '/api/viewer/observations/pin', { id, scopeKey, pinned: false })).status).toBe(200);
    expect(db.getObservation(id)!.is_pinned).toBe(0);
    // Another scope cannot pin my rows.
    expect((await post(app, '/api/viewer/observations/pin', { id, scopeKey: '/proj/elsewhere', pinned: true })).status).toBe(404);
  });

  test('logs are bounded, component-filterable and never echo a token', async () => {
    const logsDir = tmpDir('kiro-mem-logs-');
    const token = 'a'.repeat(64);
    writeFileSync(
      join(logsDir, 'worker-2026-08-15.log'),
      `[2026-08-15T10:00:00.000Z] [auth/unauthorized] {"reason":"token-mismatch","token":"${token}"}\n` +
        `[2026-08-15T10:01:00.000Z] [job-runner] job #1 failed\n`,
    );
    const { app } = startApp({ logsDir });

    const all = await json(await get(app, '/api/viewer/logs'));
    expect(all.items.length).toBe(2);
    expect(JSON.stringify(all)).not.toContain(token);
    expect(JSON.stringify(all)).toContain('[REDACTED]');

    const filtered = await json(await get(app, '/api/viewer/logs?component=job-runner'));
    expect(filtered.items.length).toBe(1);
    expect(filtered.items[0].component).toBe('job-runner');

    // The worker log has one level; asking for another must return nothing rather
    // than silently returning errors under a wrong label.
    expect((await json(await get(app, '/api/viewer/logs?level=info'))).items).toEqual([]);
  });

  test('missing bundle degrades to a diagnosable 503 instead of crashing the Worker', async () => {
    const { app } = startApp({ uiDirs: [join(tmpDir('kiro-mem-empty-'), 'nope')] });
    const res = await app.request('/ui', { headers: { Host: HOST } });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('kiro-mem install');
    // The Worker itself is unaffected.
    expect((await app.request('/health')).status).toBe(200);
  });
});

describe('Viewer permanent deletion over HTTP', () => {
  test('deletes only with a matching Origin, and emits the SSE event after commit', async () => {
    const { app, db, viewerHub } = startApp();
    const { id, turnId, scopeKey } = seed(db, { cwd: '/proj/del' });

    const events: string[] = [];
    const stream = await post(app, '/api/viewer/stream', { scopeKey });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (let i = 0; i < 6; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        events.push(text);
        if (text.includes('observation_deleted')) break;
      }
    })();
    // initial_state must reach this connection.
    await Bun.sleep(20);
    expect(events.join('')).toContain('initial_state');

    // Wrong / missing Origin: refused, nothing deleted, no SSE event.
    expect((await post(app, `/api/viewer/observations/${id}`, { scopeKey }, { method: 'DELETE' })).status).toBe(403);
    expect((await post(app, `/api/viewer/observations/${id}`, { scopeKey }, { method: 'DELETE', origin: 'http://evil.com' })).status).toBe(403);
    expect((await post(app, `/api/viewer/observations/${id}`, { scopeKey }, { method: 'DELETE', origin: `http://127.0.0.1:1` })).status).toBe(403);
    expect(db.getObservation(id)).not.toBeNull();
    expect(events.join('')).not.toContain('observation_deleted');

    const ok = await post(app, `/api/viewer/observations/${id}`, { scopeKey }, { method: 'DELETE', origin: ORIGIN });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, observationId: id, turnId, scopeKey });
    expect(db.getObservation(id)).toBeNull();
    expect(db.getTurn(turnId)).toBeNull();

    await pump;
    const payload = events.join('');
    expect(payload).toContain('observation_deleted');
    expect(payload).toContain(`"observationId":${id}`);
    reader.cancel();
    viewerHub.closeAll();

    // Repeated delete is a 404.
    expect((await post(app, `/api/viewer/observations/${id}`, { scopeKey }, { method: 'DELETE', origin: ORIGIN })).status).toBe(404);
  });

  test('a leased related job returns 409 with zero data change and no SSE event', async () => {
    const { app, db, viewerHub } = startApp();
    const { id, turnId, scopeKey } = seed(db, { cwd: '/proj/leased' });
    db.enqueueJob({
      job_type: 'embed_observation', dedupe_key: `embed:obs:${id}`,
      entity_type: 'observation', entity_id: String(id),
      payload_json: JSON.stringify({ observation_id: id }),
    });
    db.raw.run("UPDATE jobs SET state = 'leased', leased_at = ?, lease_owner = 'runner' WHERE entity_id = ?", [new Date().toISOString(), String(id)]);

    const seen: string[] = [];
    const stream = await post(app, '/api/viewer/stream', { scopeKey });
    const reader = stream.body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      for (let i = 0; i < 3; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        seen.push(decoder.decode(value));
      }
    })();

    const res = await post(app, `/api/viewer/observations/${id}`, { scopeKey }, { method: 'DELETE', origin: ORIGIN });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'deletion_in_progress' });
    expect(db.getObservation(id)).not.toBeNull();
    expect(db.getTurn(turnId)).not.toBeNull();
    await Bun.sleep(20);
    expect(seen.join('')).not.toContain('observation_deleted');
    reader.cancel();
    viewerHub.closeAll();
  });

  test('a single-scope stream never receives another workspace\'s events', async () => {
    const { app, db, viewerHub } = startApp();
    const mine = seed(db, { sessionId: 'a', cwd: '/proj/mine' });
    const other = seed(db, { sessionId: 'b', cwd: '/proj/other' });

    const frames: string[] = [];
    const stream = await post(app, '/api/viewer/stream', { scopeKey: mine.scopeKey });
    const reader = stream.body!.getReader();
    void (async () => {
      const decoder = new TextDecoder();
      for (let i = 0; i < 4; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        frames.push(decoder.decode(value));
      }
    })();
    await Bun.sleep(10);

    await post(app, `/api/viewer/observations/${other.id}`, { scopeKey: other.scopeKey }, { method: 'DELETE', origin: ORIGIN });
    await Bun.sleep(20);
    expect(frames.join('')).not.toContain(`"observationId":${other.id}`);

    await post(app, `/api/viewer/observations/${mine.id}`, { scopeKey: mine.scopeKey }, { method: 'DELETE', origin: ORIGIN });
    await Bun.sleep(20);
    expect(frames.join('')).toContain(`"observationId":${mine.id}`);
    reader.cancel();
    viewerHub.closeAll();
  });
});
