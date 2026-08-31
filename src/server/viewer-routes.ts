/**
 * Web Viewer HTTP surface (plan §6, §7). Two kinds of route:
 *   - `/ui` and its two static assets are a public shell with no memory content,
 *     exempt from the bearer token: a browser cannot set an Authorization header
 *     on a top-level navigation, and a token in the URL would leak into history,
 *     Referer and access logs.
 *   - every `/api/viewer/*` route is data and fails closed — the Worker's token
 *     middleware covers them because they are not on its exempt list.
 * Both also require a loopback `Host`, which is what stops DNS rebinding: a page
 * on evil.com resolving to 127.0.0.1 still sends `Host: evil.com`.
 */

import type { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { MemoryDB, type Observation } from '../db';
import { buildBootstrapContextReport } from '../bootstrap-context';
import { getDataDir, type Config } from '../config';
import { hybridSearchObservations, type RetrievalPolicy } from './observation-search';
import type { ViewerStreamHub } from './viewer-stream';
import {
  VIEWER_CONTEXT_MAX_BYTES,
  VIEWER_CONTEXT_MIN_BYTES,
  VIEWER_EVENTS_PAGE_LIMIT,
  VIEWER_EVENTS_RESPONSE_MAX_BYTES,
  VIEWER_EVENT_PAYLOAD_MAX_BYTES,
  VIEWER_LIST_CLIP,
  VIEWER_LOGS_PAGE_LIMIT,
  VIEWER_PAGE_LIMIT,
  VIEWER_QUERY_MAX_CHARS,
  VIEWER_TEXT_CLIP,
  type ViewerObservationCard,
  type ViewerQueueStatus,
  type ViewerScope,
} from './viewer-types';

/** Longest text field returned on the detail page (cards use VIEWER_TEXT_CLIP). */
const DETAIL_TEXT_CLIP = 4000;
/** Prompt text is Truth Layer input and can be large; bound what crosses the wire. */
const PROMPT_MAX_CHARS = 20_000;
/** Longest scope key the Viewer may send. Real ones are filesystem paths. */
const SCOPE_KEY_MAX_CHARS = 1024;
const LOG_FILES_SCANNED = 3;
/** Tail bytes read per log file, so a huge log cannot be pulled into memory. */
const LOG_FILE_TAIL_BYTES = 512 * 1024;

export interface ViewerRouteDeps {
  db: MemoryDB;
  config: Config;
  hub: ViewerStreamHub;
  queueStatus: () => ViewerQueueStatus;
  /** Live retrieval profile as `/health` reports it (read from disk per call). */
  retrievalProfile: () => {
    semanticDiscovery: boolean;
    profile: string;
    semanticFloor: number;
    semanticOnlyLimit: number | 'none';
    tieBreak: string;
  };
  retrievalPolicy: RetrievalPolicy;
  version: string;
  startedAt: string;
  /** The port the Worker is actually listening on — a function, not a number, because
   * `createApp` runs before `Bun.serve` binds. The Host check must anchor to the real
   * listener; `config.worker.port` would silently reject every request whenever the
   * two differ (a port-0 bind, or an unrestarted config edit). */
  listeningPort?: () => number;
  /** Override for tests. Production resolves <dataDir>/ui then repo dist/ui. */
  uiDirs?: string[];
  /** Override for tests; production reads <dataDir>/logs. */
  logsDir?: string;
}

// --- Security primitives ---

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Split a `Host` header into hostname and port. IPv6 literals keep their brackets
 * so `[::1]:37778` does not split on the colons inside the address. */
function splitHost(host: string): { hostname: string; port: string } {
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close === -1) return { hostname: host, port: '' };
    const hostname = host.slice(0, close + 1);
    const rest = host.slice(close + 1);
    return { hostname, port: rest.startsWith(':') ? rest.slice(1) : '' };
  }
  const idx = host.lastIndexOf(':');
  if (idx === -1) return { hostname: host, port: '' };
  return { hostname: host.slice(0, idx), port: host.slice(idx + 1) };
}

/** Accept only an exact loopback authority on the port this Worker listens on. A
 * missing port is accepted because an in-process `app.fetch()` carries none; a
 * browser pointed at a rebound hostname cannot produce that form. */
export function isLoopbackHost(host: string | undefined | null, port: number): boolean {
  if (!host) return false;
  const { hostname, port: hostPort } = splitHost(host.trim().toLowerCase());
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return hostPort === '' || hostPort === String(port);
}

/** A destructive request must come from the Viewer page itself: exact equality with the
 * request's own authority, not "some loopback origin", so a page on a different local
 * port cannot delete this Worker's memory. Missing `Origin` is refused — the Viewer's
 * `fetch` always sends it. */
export function isSameViewerOrigin(origin: string | undefined | null, host: string | undefined | null): boolean {
  if (!origin || !host) return false;
  return origin.trim().toLowerCase() === `http://${host.trim().toLowerCase()}`;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** `'self'` everywhere, no `unsafe-inline` — which is why the stylesheet is a separate
 * file: one inline style would force `style-src 'unsafe-inline'` and re-open the
 * injection surface that rendering untrusted memory as text nodes closes. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// --- Static shell ---

const STATIC_ASSETS: Record<string, { file: string; type: string }> = {
  'viewer.html': { file: 'viewer.html', type: 'text/html; charset=utf-8' },
  'viewer.js': { file: 'viewer.js', type: 'text/javascript; charset=utf-8' },
  'styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
};

/** `<dataDir>/ui` first — what `kiro-mem install` lays down; a real installation has
 * no repo to fall back to. The repo path serves the local build during development
 * only, and the plan forbids treating it as installation acceptance. */
export function resolveViewerUiDirs(override?: string[]): string[] {
  if (override) return override;
  return [join(getDataDir(), 'ui'), resolve(import.meta.dir, '../../dist/ui')];
}

function findUiFile(dirs: string[], file: string): string | null {
  for (const dir of dirs) {
    const path = join(dir, file);
    if (existsSync(path)) return path;
  }
  return null;
}

const BUILD_MISSING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kiro-mem viewer</title></head>
<body><h1>Viewer bundle not found</h1>
<p>The Worker is running, but no built Viewer bundle was found in
<code>&lt;dataDir&gt;/ui</code> or <code>dist/ui</code>.</p>
<p>Run <code>kiro-mem install</code> to install it, or
<code>bun run build:ui</code> when working from a source checkout.</p>
</body></html>`;

// --- Shared request helpers ---

export interface ResolvedScope {
  scopeKey: string | undefined;
  allScopes: boolean;
}

/** Fail-closed scope resolution: `allScopes` must be strictly `true` — a truthy string
 * like `"false"` does not unlock cross-workspace browsing — and a request with neither
 * a scope nor that flag is rejected rather than silently served globally. */
export function resolveScopeInput(body: unknown): ResolvedScope | null {
  const raw = (body ?? {}) as { scopeKey?: unknown; allScopes?: unknown };
  if (raw.allScopes === true) return { scopeKey: undefined, allScopes: true };
  const scopeKey = typeof raw.scopeKey === 'string' ? raw.scopeKey.trim() : '';
  if (!scopeKey || scopeKey.length > SCOPE_KEY_MAX_CHARS) return null;
  return { scopeKey, allScopes: false };
}

function clip(value: string | null | undefined, max: number): string {
  if (!value) return '';
  return value.length > max ? value.slice(0, max) : value;
}

function parseStringArray(json: string, max: number): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string')
      .slice(0, max)
      .map((v) => clip(v, VIEWER_TEXT_CLIP));
  } catch {
    return [];
  }
}

function countArray(json: string): number {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/** Project one row into the bounded card the Viewer renders. */
export function toCard(o: Observation, textClip = VIEWER_TEXT_CLIP): ViewerObservationCard {
  return {
    id: o.id,
    scopeKey: o.scope_key,
    title: clip(o.title, 300),
    memoryType: o.memory_type,
    quality: o.quality,
    pinned: o.is_pinned === 1,
    summary: clip(o.summary, textClip),
    outcome: o.outcome ? clip(o.outcome, textClip) : null,
    nextSteps: o.next_steps ? clip(o.next_steps, textClip) : null,
    turnStoppedAt: o.turn_stopped_at,
    turnId: o.turn_id,
    sessionId: o.session_id,
    turnSeq: o.turn_seq,
    files: parseStringArray(o.files_touched_json, VIEWER_LIST_CLIP),
    concepts: parseStringArray(o.concepts_json, VIEWER_LIST_CLIP),
    evidence: parseStringArray(o.evidence_json, VIEWER_LIST_CLIP),
    counts: {
      files: countArray(o.files_touched_json),
      concepts: countArray(o.concepts_json),
      evidence: countArray(o.evidence_json),
    },
    scores: {
      importance: o.importance_score,
      confidence: o.confidence_score,
      unresolved: o.unresolved_score,
    },
  };
}

function encodeCursor(cursor: { turnStoppedAt: string; id: number } | null): string | null {
  return cursor ? `${cursor.turnStoppedAt}|${cursor.id}` : null;
}

function decodeCursor(raw: unknown): { turnStoppedAt: string; id: number } | null {
  if (typeof raw !== 'string' || !raw) return null;
  const idx = raw.lastIndexOf('|');
  if (idx <= 0) return null;
  const id = Number(raw.slice(idx + 1));
  if (!Number.isInteger(id) || id <= 0) return null;
  return { turnStoppedAt: raw.slice(0, idx), id };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Pretty-print JSON payloads; leave anything unparseable exactly as stored. */
function formatPayload(raw: string): { payload: string; truncated: boolean } {
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    /* not JSON — render the stored string */
  }
  if (Buffer.byteLength(text, 'utf8') <= VIEWER_EVENT_PAYLOAD_MAX_BYTES) {
    return { payload: text, truncated: false };
  }
  const buf = Buffer.from(text, 'utf8').subarray(0, VIEWER_EVENT_PAYLOAD_MAX_BYTES);
  return { payload: buf.toString('utf8'), truncated: true };
}

/** The log drawer is the one place that ships log text to a browser, so strip anything
 * shaped like the 64-hex local token before it leaves the process. */
function redactTokens(line: string): string {
  return line.replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]');
}

// --- Route registration ---

export function registerViewerRoutes(app: Hono, deps: ViewerRouteDeps): void {
  const { db, config, hub } = deps;
  const port = () => deps.listeningPort?.() ?? config.worker.port;
  const uiDirs = resolveViewerUiDirs(deps.uiDirs);
  const logsDir = deps.logsDir ?? join(getDataDir(), 'logs');

  // One middleware for shell and API alike: every browser-reachable path needs the
  // loopback Host check and the same hardening headers, HTML/JSON/SSE included.
  for (const pattern of ['/ui', '/ui/*', '/api/viewer/*']) {
    app.use(pattern, async (c, next) => {
      if (!isLoopbackHost(c.req.header('host'), port())) {
        return c.json({ ok: false, error: 'forbidden_host' }, 403);
      }
      await next();
      for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
        c.res.headers.set(key, value);
      }
      c.res.headers.set('Content-Security-Policy', CSP);
    });
  }

  // --- Public static shell (no memory content) ---

  const serveAsset = (name: string) => {
    const asset = STATIC_ASSETS[name];
    if (!asset) return null;
    const path = findUiFile(uiDirs, asset.file);
    if (!path) return null;
    return { body: readFileSync(path), type: asset.type };
  };

  app.get('/ui', (c) => {
    const asset = serveAsset('viewer.html');
    if (!asset) {
      // Not a crash and not a 404: memory works, only the optional UI payload is absent.
      return c.html(BUILD_MISSING_HTML, 503);
    }
    return c.body(asset.body, 200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
  });

  app.get('/ui/:file', (c) => {
    const asset = serveAsset(c.req.param('file'));
    if (!asset) return c.text('not found', 404);
    return c.body(asset.body, 200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' });
  });

  // --- Bootstrap: scopes + worker summary ---

  app.get('/api/viewer/bootstrap', (c) => {
    const stats = db.getObservabilityStats();
    const withObservations = db.listObservationScopes();
    const seen = new Set(withObservations.map((s) => s.scopeKey));
    const scopes: ViewerScope[] = [...withObservations];
    // Still selectable before its first compression, or the Viewer opens the wrong scope.
    for (const key of db.listKnownScopeKeys()) {
      if (!seen.has(key)) scopes.push({ scopeKey: key, observations: 0, lastActivityAt: null });
    }
    return c.json({
      version: deps.version,
      // Live config object, so a `kiro-mem config` edit lands on the next page load.
      language: config.language,
      scopes,
      queue: deps.queueStatus(),
      retrieval: deps.retrievalProfile(),
      observations: stats.observations,
      context: { maxOutputBytes: config.context.maxOutputBytes },
      startedAt: deps.startedAt,
    });
  });

  // --- SSE ---

  app.post('/api/viewer/stream', async (c) => {
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    return hub.connect({
      scopeKey: scope.scopeKey ?? null,
      allScopes: scope.allScopes,
      signal: c.req.raw.signal,
    });
  });

  // --- Feed ---

  app.post('/api/viewer/observations/list', async (c) => {
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    const limit = clampInt((body as { limit?: unknown }).limit, 1, VIEWER_PAGE_LIMIT, VIEWER_PAGE_LIMIT);
    const page = db.listObservationsPage({
      ...(scope.scopeKey ? { scopeKey: scope.scopeKey } : {}),
      limit,
      cursor: decodeCursor((body as { cursor?: unknown }).cursor),
    });
    return c.json({
      items: page.rows.map((row) => toCard(row)),
      nextCursor: encodeCursor(page.nextCursor),
      scopeKey: scope.scopeKey ?? null,
      allScopes: scope.allScopes,
    });
  });

  // --- Detail: generated memory beside the turn it came from ---

  app.post('/api/viewer/observations/detail', async (c) => {
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    const id = clampInt((body as { id?: unknown }).id, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!id) return c.json({ ok: false, error: 'id_required' }, 400);

    // Scope filters in the query, not after: a cross-scope row never enters this process.
    const [obs] = db.getObservationsByIds([id], scope.scopeKey ? { scopeKey: scope.scopeKey } : {});
    if (!obs) return c.json({ ok: false, error: 'not_found' }, 404);

    const turn = db.getTurn(obs.turn_id);
    const artifacts = db.getTurnArtifacts(obs.turn_id);
    const eventStats = db.turnEventStats(obs.turn_id);
    const semantic = db.getObservationSemanticText(obs.id, 'semantic-en-v1');
    const prompt = turn?.prompt_text ?? null;

    return c.json({
      memory: {
        ...toCard(obs, DETAIL_TEXT_CLIP),
        request: obs.request ? clip(obs.request, DETAIL_TEXT_CLIP) : null,
        learned: obs.learned ? clip(obs.learned, DETAIL_TEXT_CLIP) : null,
        createdAt: obs.created_at,
        semantic: semantic
          ? {
              protocol: semantic.protocol,
              status: semantic.status,
              attempts: semantic.attempts,
              failureReason: semantic.failure_reason,
              updatedAt: semantic.updated_at,
            }
          : null,
        embeddings: db.listObservationEmbeddingSpaces(obs.id),
      },
      source: {
        turnId: obs.turn_id,
        sessionId: obs.session_id,
        turnSeq: obs.turn_seq,
        scopeKey: obs.scope_key,
        repo: turn?.repo ?? obs.repo,
        cwd: turn?.cwd ?? obs.cwd_scope,
        state: turn?.state ?? 'missing',
        startedAt: turn?.started_at ?? obs.turn_started_at,
        stoppedAt: turn?.stopped_at ?? obs.turn_stopped_at,
        promptText: prompt === null ? null : clip(prompt, PROMPT_MAX_CHARS),
        promptTruncated: prompt !== null && prompt.length > PROMPT_MAX_CHARS,
        toolEventCount: turn?.tool_event_count ?? 0,
        events: {
          count: eventStats.events,
          payloadBytes: eventStats.payloadBytes,
          byHook: eventStats.byHook,
        },
        artifacts: artifacts
          ? {
              toolNames: parseStringArray(artifacts.tool_names_json, 60),
              files: parseStringArray(artifacts.files_touched_json, 60),
              commands: parseStringArray(artifacts.commands_json, 60),
              errorSignals: parseStringArray(artifacts.error_signals_json, 60),
              decisionSignals: parseStringArray(artifacts.decision_signals_json, 60),
              facts: parseStringArray(artifacts.facts_json, 60),
            }
          : null,
      },
      jobs: db.listRelatedJobs({ turnId: obs.turn_id, observationId: obs.id }).map((j) => ({
        id: j.id,
        jobType: j.job_type,
        state: j.state,
        attempts: j.attempts,
        updatedAt: j.updated_at,
      })),
    });
  });

  // --- Raw events, bounded and on demand ---

  app.post('/api/viewer/observations/events', async (c) => {
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    const id = clampInt((body as { id?: unknown }).id, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!id) return c.json({ ok: false, error: 'id_required' }, 400);
    const [obs] = db.getObservationsByIds([id], scope.scopeKey ? { scopeKey: scope.scopeKey } : {});
    if (!obs) return c.json({ ok: false, error: 'not_found' }, 404);

    const limit = clampInt(
      (body as { limit?: unknown }).limit,
      1,
      VIEWER_EVENTS_PAGE_LIMIT,
      VIEWER_EVENTS_PAGE_LIMIT,
    );
    const afterSeq = clampInt((body as { cursor?: unknown }).cursor, 0, Number.MAX_SAFE_INTEGER, 0);
    const page = db.listTurnEventsPage(obs.turn_id, { limit, afterSeq });

    // Two independent bounds, per event and per response: one 4MB tool payload must
    // not make a page unreadable even if the per-event cap lets it through.
    const items = [];
    let bytes = 0;
    let truncated = false;
    let lastSeq = afterSeq;
    for (const event of page.rows) {
      const { payload, truncated: payloadTruncated } = formatPayload(event.payload_json);
      const size = Buffer.byteLength(payload, 'utf8');
      if (items.length > 0 && bytes + size > VIEWER_EVENTS_RESPONSE_MAX_BYTES) {
        truncated = true;
        break;
      }
      bytes += size;
      lastSeq = event.event_seq;
      items.push({
        id: event.id,
        eventSeq: event.event_seq,
        hookEventName: event.hook_event_name,
        toolName: event.tool_name,
        payloadSize: event.payload_size,
        createdAt: event.created_at,
        payload,
        payloadTruncated,
      });
    }

    return c.json({
      items,
      nextCursor: truncated ? String(lastSeq) : page.nextAfterSeq === null ? null : String(page.nextAfterSeq),
      truncated,
    });
  });

  // --- Search (FTS only in V1) ---

  app.post('/api/viewer/search', async (c) => {
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    const raw = (body as { q?: unknown }).q;
    const q = typeof raw === 'string' ? raw.trim().slice(0, VIEWER_QUERY_MAX_CHARS) : '';
    if (!q) return c.json({ items: [], scopeKey: scope.scopeKey ?? null, allScopes: scope.allScopes, query: '' });

    const type = typeof (body as { type?: unknown }).type === 'string' ? (body as { type: string }).type : undefined;
    const days = (body as { days?: unknown }).days;
    const limit = clampInt((body as { limit?: unknown }).limit, 1, VIEWER_PAGE_LIMIT, 20);

    // No `semanticQueryEn`: the Viewer must not fabricate an English form, so this
    // search is keyword-only. The throwing stub fails loudly if the embedder is reached.
    const results = await hybridSearchObservations(
      db,
      q,
      {
        ...(scope.scopeKey ? { scopeKey: scope.scopeKey } : {}),
        ...(type ? { type } : {}),
        ...(Number.isFinite(Number(days)) && Number(days) > 0 ? { days: Number(days) } : {}),
        limit,
      },
      {
        policy: deps.retrievalPolicy,
        generateEmbedding: () => {
          throw new Error('viewer search must not embed');
        },
      },
    );

    return c.json({
      items: results.map((r) => ({
        ...toCard(r),
        matchSource: r.match_source,
        semanticScore: r.semantic_score,
      })),
      scopeKey: scope.scopeKey ?? null,
      allScopes: scope.allScopes,
      query: q,
    });
  });

  // --- Context injection preview ---

  app.post('/api/viewer/context-preview', async (c) => {
    const body = await readJson(c);
    const scopeKey = typeof (body as { scopeKey?: unknown }).scopeKey === 'string'
      ? (body as { scopeKey: string }).scopeKey.trim()
      : '';
    // Injection is per-workspace by definition, so `allScopes` is not legal here.
    if (!scopeKey || scopeKey.length > SCOPE_KEY_MAX_CHARS) {
      return c.json({ ok: false, error: 'scope_required' }, 400);
    }
    // Only a scope this database already knows: the report takes a scope key, not a
    // cwd, so a request can never make the Worker `git rev-parse` an attacker path.
    if (!db.listKnownScopeKeys().includes(scopeKey)) {
      return c.json({ ok: false, error: 'unknown_scope' }, 404);
    }

    const requested = (body as { maxOutputBytes?: unknown }).maxOutputBytes;
    const maxOutputBytes =
      requested === undefined || requested === null
        ? config.context.maxOutputBytes
        : clampInt(requested, VIEWER_CONTEXT_MIN_BYTES, VIEWER_CONTEXT_MAX_BYTES, config.context.maxOutputBytes);

    const report = buildBootstrapContextReport(db, scopeKey, { maxOutputBytes }, config.language);
    return c.json({ ...report, configuredMaxBytes: config.context.maxOutputBytes });
  });

  // --- Pin ---

  app.post('/api/viewer/observations/pin', async (c) => {
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    const id = clampInt((body as { id?: unknown }).id, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!id) return c.json({ ok: false, error: 'id_required' }, 400);
    const pinned = (body as { pinned?: unknown }).pinned === true;
    const [obs] = db.getObservationsByIds([id], scope.scopeKey ? { scopeKey: scope.scopeKey } : {});
    if (!obs) return c.json({ ok: false, error: 'not_found' }, 404);

    db.pinObservation(id, pinned);
    hub.broadcast({
      type: 'observation_updated',
      scopeKey: obs.scope_key,
      observationId: id,
      reason: 'pin',
    });
    return c.json({ ok: true, id, pinned });
  });

  // --- Permanent deletion (plan §4) ---

  app.delete('/api/viewer/observations/:id', async (c) => {
    // Destructive, so the Origin check sits on top of the loopback Host check.
    if (!isSameViewerOrigin(c.req.header('origin'), c.req.header('host'))) {
      return c.json({ ok: false, error: 'forbidden_origin' }, 403);
    }
    const body = await readJson(c);
    const scope = resolveScopeInput(body);
    if (!scope) return c.json({ ok: false, error: 'scope_required' }, 400);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'id_required' }, 400);

    const result = db.deleteObservationWithTruth(
      id,
      scope.scopeKey ? { scopeKey: scope.scopeKey } : {},
    );
    if (!result.ok) {
      return c.json({ ok: false, error: result.reason }, result.reason === 'not_found' ? 404 : 409);
    }

    // Only after the transaction committed: a rollback or a 409 must leave every
    // connected Viewer showing the card, because the record still exists.
    hub.broadcast({
      type: 'observation_deleted',
      scopeKey: result.scopeKey,
      observationId: result.observationId,
      turnId: result.turnId,
    });
    return c.json(result);
  });

  // --- Retrieval health (projection of the existing snapshot) ---

  app.get('/api/viewer/retrieval-health', (c) => {
    const stats = db.getObservabilityStats();
    const s = stats.search24h;
    return c.json({
      retrieval: deps.retrievalProfile(),
      search24h: {
        requests: s.requests,
        latencyMsP50: s.latencyMsP50,
        latencyMsP95: s.latencyMsP95,
        protocolSemanticEn: s.protocolSemanticEn,
        semanticEnRate: s.semanticEnRate,
        semanticQueryIssues: s.semanticQueryIssues,
        ftsOnly: s.ftsOnly,
        degradeRate: s.degradeRate,
        zeroFts: s.zeroFts,
        zeroFtsRecalled: s.zeroFtsRecalled,
        semanticOnlyTotal: s.semanticOnlyTotal,
        semanticOnlyPerRequest: s.semanticOnlyPerRequest,
        semanticOnlyMax: s.semanticOnlyMax,
        comparableVectorsAvg: s.comparableVectorsAvg,
        scopeVectorsAvg: s.scopeVectorsAvg,
        scopeVectorsMin: s.scopeVectorsMin,
        scopeVectorsMeasured: s.scopeVectorsMeasured,
        emptyScopeRequests: s.emptyScopeRequests,
      },
      embeddings: {
        ready: stats.embeddings.ready,
        coverage: stats.embeddings.coverage,
        semanticEn: stats.embeddings.semanticEn,
      },
    });
  });

  // --- Logs ---

  app.get('/api/viewer/logs', (c) => {
    const level = c.req.query('level') ?? '';
    // One level exists today (`logError`); any other filter returns nothing, not errors.
    if (level && level !== 'error') return c.json({ items: [], nextCursor: null });

    const component = (c.req.query('component') ?? '').trim().toLowerCase();
    const offset = clampInt(c.req.query('cursor'), 0, 100_000, 0);
    const lines = readRecentLogLines(logsDir);
    const filtered = component
      ? lines.filter((l) => l.component.toLowerCase().includes(component))
      : lines;
    const page = filtered.slice(offset, offset + VIEWER_LOGS_PAGE_LIMIT);
    const next = offset + page.length;
    return c.json({
      items: page,
      nextCursor: next < filtered.length ? String(next) : null,
    });
  });
}

/** Tolerant JSON body read: a malformed body must not become a 500. */
async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** Newest worker log lines, most recent first. Reads only the tail of each file so a
 * long-running Worker's log cannot be pulled into memory for one log-drawer request. */
export function readRecentLogLines(
  logsDir: string,
): { at: string | null; component: string; message: string }[] {
  if (!existsSync(logsDir)) return [];
  let files: string[];
  try {
    files = readdirSync(logsDir)
      .filter((f) => f.startsWith('worker-') && f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, LOG_FILES_SCANNED);
  } catch {
    return [];
  }

  const out: { at: string | null; component: string; message: string }[] = [];
  for (const file of files) {
    const path = join(logsDir, file);
    let text = '';
    try {
      const size = statSync(path).size;
      const buf = readFileSync(path);
      text = buf
        .subarray(Math.max(0, size - LOG_FILE_TAIL_BYTES))
        .toString('utf8');
    } catch {
      continue;
    }
    const parsed = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const match = /^\[([^\]]+)\] \[([^\]]+)\] ([\s\S]*)$/.exec(line);
        if (!match) return { at: null, component: 'unknown', message: redactTokens(clip(line, 2000)) };
        return {
          at: match[1] ?? null,
          component: clip(match[2] ?? '', 120),
          message: redactTokens(clip(match[3] ?? '', 2000)),
        };
      })
      .reverse();
    out.push(...parsed);
  }
  return out;
}
