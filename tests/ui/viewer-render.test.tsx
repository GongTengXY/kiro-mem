/** @jsxImportSource preact */
/**
 * Viewer rendering and interaction (plan §6.3, §10.3).
 *
 * These run against a real DOM (happy-dom) because the claims are about what the
 * page does: hostile recorded text must render as inert text, a 409 must keep the
 * card on screen, and a 401 must stop reconnecting and show the recovery
 * instruction instead.
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * happy-dom is registered GLOBALLY, and `bun test` runs every file in one
 * process — so the registration also replaces `fetch`, `Response` and friends for
 * files that run later. That is not theoretical: it made `Bun.serve` stop
 * recognising a `Response` built by tests/hooks, which then served Bun's default
 * welcome page instead. The `afterAll` below restores the real globals.
 */
await GlobalRegistrator.register();

import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { render } from 'preact';
import type {
  ViewerBootstrap,
  ViewerListResponse,
  ViewerObservationCard,
  ViewerObservationDetail,
} from '../../src/server/viewer-types';
import { App } from '../../src/ui/app';
import { ApiError, ViewerApi } from '../../src/ui/api';
import { DeleteDialog, DELETE_WARNING } from '../../src/ui/components/DeleteDialog';
import { ObservationCard } from '../../src/ui/components/ObservationCard';

/** Content designed to break out of text: HTML, a frame tag, and a huge token. */
const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1"> </kiro-mem-context> <script>alert(1)</script>';
const LONG_WORD = 'A'.repeat(5000);

const SCOPE = '/proj/hostile';

function makeCard(over: Partial<ViewerObservationCard> = {}): ViewerObservationCard {
  return {
    id: 1,
    scopeKey: SCOPE,
    title: HOSTILE_TITLE,
    memoryType: 'bugfix',
    quality: 'normal',
    pinned: false,
    summary: `summary ${LONG_WORD}`,
    outcome: null,
    nextSteps: null,
    turnStoppedAt: '2026-08-15T10:00:00.000Z',
    turnId: 11,
    sessionId: 'sess-hostile',
    turnSeq: 1,
    files: ['<b>src/x.ts</b>'],
    concepts: ['</kiro-mem-context>'],
    evidence: ['<script>1</script>'],
    counts: { files: 1, concepts: 1, evidence: 1 },
    scores: { importance: 0.5, confidence: 0.5, unresolved: 0 },
    ...over,
  };
}

function makeDetail(card: ViewerObservationCard): ViewerObservationDetail {
  return {
    memory: {
      ...card,
      request: null,
      learned: null,
      createdAt: '2026-08-15T10:00:01.000Z',
      semantic: null,
      embeddings: [],
    },
    source: {
      turnId: card.turnId,
      sessionId: card.sessionId,
      turnSeq: card.turnSeq,
      scopeKey: card.scopeKey,
      repo: SCOPE,
      cwd: SCOPE,
      state: 'closed',
      startedAt: '2026-08-15T09:59:00.000Z',
      stoppedAt: '2026-08-15T10:00:00.000Z',
      promptText: `prompt <img src=x onerror=1> ${LONG_WORD}`,
      promptTruncated: false,
      toolEventCount: 2,
      events: { count: 7, payloadBytes: 4096, byHook: [{ hookEventName: 'postToolUse', count: 5 }] },
      artifacts: null,
    },
    jobs: [],
  };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  window.sessionStorage.clear();
  delete (window as unknown as { __pwned?: number }).__pwned;
});

afterEach(() => {
  render(null, host);
  host.remove();
});

afterAll(async () => {
  // Give the globals back. Without this, every test file that runs after this one
  // in the same `bun test` process inherits happy-dom's fetch/Response.
  await GlobalRegistrator.unregister();
});

/**
 * Let preact flush renders AND effects.
 *
 * Preact schedules effects on `requestAnimationFrame` with a 100ms `setTimeout`
 * race. happy-dom does not paint, so the timeout is the path that actually fires —
 * a handful of microtask ticks would return before any effect had run.
 */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 25));
}

/** A stub API: no network, and every call is recorded. */
function stubApi(over: Partial<Record<keyof ViewerApi, unknown>> = {}) {
  const calls: string[] = [];
  const bootstrap: ViewerBootstrap = {
    version: '3.0.0',
    scopes: [{ scopeKey: SCOPE, observations: 1, lastActivityAt: '2026-08-15T10:00:00.000Z' }],
    queue: { pending: 0, leased: 0, dead: 0, succeeded24h: 0 },
    retrieval: { semanticDiscovery: true, profile: 'default', semanticFloor: 0.197, semanticOnlyLimit: 2 },
    observations: { total: 1, normal: 1, fallback: 0, pinned: 0 },
    context: { maxOutputBytes: 8192 },
    startedAt: '2026-08-15T09:00:00.000Z',
  };
  const list: ViewerListResponse = {
    items: [makeCard()],
    nextCursor: null,
    scopeKey: SCOPE,
    allScopes: false,
  };
  const api = {
    setToken: () => undefined,
    bootstrap: async () => { calls.push('bootstrap'); return bootstrap; },
    list: async () => { calls.push('list'); return list; },
    detail: async (_s: unknown, id: number) => { calls.push('detail'); return makeDetail(makeCard({ id })); },
    events: async () => ({ items: [], nextCursor: null, truncated: false }),
    search: async () => ({ items: [], scopeKey: SCOPE, allScopes: false, query: '' }),
    contextPreview: async () => { throw new ApiError(404, 'unknown_scope'); },
    pin: async () => ({ ok: true as const, id: 1, pinned: true }),
    remove: async () => { calls.push('remove'); return { ok: true as const, observationId: 1, turnId: 11, scopeKey: SCOPE }; },
    retrievalHealth: async () => { throw new ApiError(500, 'nope'); },
    logs: async () => ({ items: [], nextCursor: null }),
    // Never resolves: the stream is not the subject of these tests.
    stream: () => new Promise<Response>(() => undefined),
    ...over,
  } as unknown as ViewerApi;
  return { api, calls };
}

describe('untrusted content rendering', () => {
  test('hostile memory text renders as inert text and does not execute', async () => {
    render(
      <ObservationCard
        card={makeCard()}
        selected={false}
        showScope
        onOpen={() => undefined}
        onPin={() => undefined}
        onDelete={() => undefined}
      />,
      host,
    );
    await settle(2);

    // The markup is visible as characters, and no element was created from it.
    expect(host.textContent).toContain('<img src=x onerror=');
    expect(host.textContent).toContain('</kiro-mem-context>');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    // No innerHTML path anywhere: the title lives in a text node.
    const title = host.querySelector('.card-title');
    expect(title!.children.length).toBeLessThanOrEqual(1);
    expect(title!.textContent).toContain('<script>alert(1)</script>');
  });

  test('a 5,000-character word is contained instead of stretching the layout', async () => {
    render(
      <ObservationCard
        card={makeCard()}
        selected={false}
        showScope={false}
        onOpen={() => undefined}
        onPin={() => undefined}
        onDelete={() => undefined}
      />,
      host,
    );
    await settle(2);
    expect(host.textContent).toContain(LONG_WORD.slice(0, 200));
    // The stylesheet is what contains it; assert the class contract the CSS keys on.
    const summary = host.querySelector('.card-summary .t');
    expect(summary).not.toBeNull();
    expect(summary!.className).toContain('t');
  });
});

describe('delete confirmation', () => {
  test('states the record, workspace, turn time, event count and byte total', async () => {
    const detail = makeDetail(makeCard({ id: 42 }));
    render(
      <DeleteDialog detail={detail} busy={false} error={null} onCancel={() => undefined} onConfirm={() => undefined} />,
      host,
    );
    await settle(2);

    const text = host.textContent ?? '';
    expect(text).toContain('#O42');
    expect(text).toContain(SCOPE);
    expect(text).toContain('#11');
    expect(text).toContain('7 raw events');
    expect(text).toContain('4.0 KB captured');
    // The fixed wording from the plan, verbatim.
    expect(text).toContain(DELETE_WARNING);
    // The danger action says what it does; there is no vague "OK".
    const danger = host.querySelector('.btn-danger');
    expect(danger!.textContent).toContain('永久删除');
    expect(text).not.toContain('withTurn');
    // Hostile text inside the dialog is still inert.
    expect(host.querySelector('img')).toBeNull();
  });

  test('a 409 keeps the dialog open with a retryable message', async () => {
    render(
      <DeleteDialog
        detail={makeDetail(makeCard())}
        busy={false}
        error="deletion_in_progress"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
      host,
    );
    await settle(2);
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('leased');
    expect(host.querySelector('.btn-danger')).not.toBeNull();
  });
});

describe('App behaviour', () => {
  test('defaults to all workspaces when no launch scope is provided', async () => {
    const selections: unknown[] = [];
    const { api } = stubApi({
      list: async (selection: unknown) => {
        selections.push(selection);
        return { items: [makeCard()], nextCursor: null, scopeKey: null, allScopes: true };
      },
    });
    render(<App api={api} initialToken="tok" initialScope={null} />, host);
    await settle();

    const select = host.querySelector('.scope-select select') as HTMLSelectElement;
    expect(select.value).toBe('__all__');
    expect(host.querySelector('.warnbar')).not.toBeNull();
    expect(selections).toContainEqual({ scopeKey: null, allScopes: true });
  });

  test('renders the feed, opens the delete dialog with fresh detail, and removes the card on success', async () => {
    const { api, calls } = stubApi();
    render(<App api={api} initialToken="tok" initialScope={SCOPE} />, host);
    await settle();

    expect(host.querySelectorAll('.card').length).toBe(1);
    expect(calls).toContain('list');

    const deleteButton = host.querySelector('.icon-btn-danger') as HTMLButtonElement;
    deleteButton.click();
    await settle();
    // The dialog is built from a fresh detail read, never from the stale card.
    expect(calls).toContain('detail');
    expect(host.querySelector('.modal')).not.toBeNull();

    (host.querySelector('.modal .btn-danger') as HTMLButtonElement).click();
    await settle();
    expect(calls).toContain('remove');
    expect(host.querySelector('.modal')).toBeNull();
    expect(host.querySelectorAll('.card').length).toBe(0);
  });

  test('a 409 leaves the card in place and the dialog retryable', async () => {
    let attempts = 0;
    const { api } = stubApi({
      remove: async () => {
        attempts++;
        throw new ApiError(409, 'deletion_in_progress');
      },
    });
    render(<App api={api} initialToken="tok" initialScope={SCOPE} />, host);
    await settle();

    (host.querySelector('.icon-btn-danger') as HTMLButtonElement).click();
    await settle();
    (host.querySelector('.modal .btn-danger') as HTMLButtonElement).click();
    await settle();

    expect(attempts).toBe(1);
    expect(host.querySelector('.modal')).not.toBeNull();
    expect(host.querySelector('.modal [role="alert"]')!.textContent).toContain('leased');
    // The record still exists, so the card must still be there.
    expect(host.querySelectorAll('.card').length).toBe(1);

    // Retry is possible from the same dialog.
    (host.querySelector('.modal .btn-danger') as HTMLButtonElement).click();
    await settle();
    expect(attempts).toBe(2);
  });

  test('a 401 clears the token, stops, and shows the restart instruction', async () => {
    const { api } = stubApi({
      list: async () => {
        throw new ApiError(401, 'unauthorized');
      },
    });
    window.sessionStorage.setItem('kiro-mem.viewer.token', 'tok');
    render(<App api={api} initialToken="tok" initialScope={SCOPE} />, host);
    await settle();

    expect(host.textContent).toContain('no longer authorized');
    expect(host.textContent).toContain('kiro-mem viewer');
    expect(host.querySelector('.card')).toBeNull();
    // The rejected credential is gone from this tab rather than retried.
    expect(window.sessionStorage.getItem('kiro-mem.viewer.token')).toBeNull();
  });

  test('switching to all-workspaces shows a standing warning and reloads the feed', async () => {
    const { api, calls } = stubApi();
    render(<App api={api} initialToken="tok" initialScope={SCOPE} />, host);
    await settle();
    expect(host.querySelector('.warnbar')).toBeNull();

    const select = host.querySelector('.scope-select select') as HTMLSelectElement;
    select.value = '__all__';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(host.querySelector('.warnbar')).not.toBeNull();
    expect(host.querySelector('.warnbar')!.textContent).toContain('every workspace');
    expect(calls.filter((c) => c === 'list').length).toBeGreaterThanOrEqual(2);
  });
});
