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
import { DeleteDialog } from '../../src/ui/components/DeleteDialog';
import { LangContext, VIEWER_STRINGS } from '../../src/ui/i18n';
import { ObservationCard } from '../../src/ui/components/ObservationCard';
import { ScopePicker } from '../../src/ui/components/ScopePicker';

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
    language: 'en',
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
      <LangContext.Provider value={VIEWER_STRINGS.zh}>
        <DeleteDialog detail={detail} busy={false} error={null} onCancel={() => undefined} onConfirm={() => undefined} />
      </LangContext.Provider>,
      host,
    );
    await settle(2);

    const text = host.textContent ?? '';
    expect(text).toContain('#O42');
    expect(text).toContain(SCOPE);
    expect(text).toContain('#11');
    expect(text).toContain('7 个原始事件');
    expect(text).toContain('已捕获 4.0 KB');
    // The fixed wording from the plan, verbatim.
    expect(text).toContain(VIEWER_STRINGS.zh.deleteWarning);
    // The danger action says what it does; there is no vague "OK".
    const danger = host.querySelector('.btn-danger');
    expect(danger!.textContent).toContain('永久删除');
    expect(text).not.toContain('withTurn');
    // One language only: the English copy of the warning is not also on screen.
    expect(text).not.toContain(VIEWER_STRINGS.en.deleteWarning);
    // Hostile text inside the dialog is still inert.
    expect(host.querySelector('img')).toBeNull();
  });

  test('renders English when the configured language is en', async () => {
    render(
      <LangContext.Provider value={VIEWER_STRINGS.en}>
        <DeleteDialog
          detail={makeDetail(makeCard({ id: 42 }))}
          busy={false}
          error={null}
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />
      </LangContext.Provider>,
      host,
    );
    await settle(2);
    const text = host.textContent ?? '';
    expect(text).toContain('Permanent delete');
    expect(text).toContain('7 raw events');
    expect(text).toContain(VIEWER_STRINGS.en.deleteWarning);
    expect(text).not.toContain('永久删除');
  });

  test('a 409 keeps the dialog open with a retryable message', async () => {
    render(
      <LangContext.Provider value={VIEWER_STRINGS.zh}>
        <DeleteDialog
          detail={makeDetail(makeCard())}
          busy={false}
          error="deletion_in_progress"
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />
      </LangContext.Provider>,
      host,
    );
    await settle(2);
    const alert = host.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('leased');
    expect(host.querySelector('.btn-danger')).not.toBeNull();
  });
});

describe('scope picker', () => {
  const SCOPES = [
    { scopeKey: '/Users/me/work/<img src=x onerror=1>alpha', observations: 12, lastActivityAt: '2026-08-21T09:02:00.000Z' },
    { scopeKey: '/Users/me/work/beta', observations: 3, lastActivityAt: null },
  ];

  function mountPicker(over: { scopeKey?: string | null; allScopes?: boolean } = {}) {
    const picked: string[] = [];
    render(
      <ScopePicker
        scopes={SCOPES}
        scopeKey={over.scopeKey ?? null}
        allScopes={over.allScopes ?? over.scopeKey === undefined}
        onChange={(v) => picked.push(v)}
      />,
      host,
    );
    return picked;
  }

  test('lists every workspace with its path and count, and picks one by click', async () => {
    const picked = mountPicker();
    await settle(2);
    // Closed: no listbox in the DOM at all, so the popup cannot be read by AT.
    expect(host.querySelector('.scope-popup')).toBeNull();

    (host.querySelector('.scope-trigger') as HTMLButtonElement).click();
    await settle(2);

    const options = [...host.querySelectorAll('.scope-option')];
    expect(options.length).toBe(3); // all-workspaces + two recorded scopes
    expect(options[0]!.textContent).toContain('All workspaces');
    expect(options[0]!.textContent).toContain('15'); // 12 + 3
    expect(options[1]!.textContent).toContain('alpha');
    expect(options[1]!.textContent).toContain('/Users/me/work/');
    // A path is recorded data: it renders as text, never as markup.
    expect(host.querySelector('.scope-popup img')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    (options[2] as HTMLElement).click();
    await settle(2);
    expect(picked).toEqual(['/Users/me/work/beta']);
    expect(host.querySelector('.scope-popup')).toBeNull();
  });

  test('keyboard opens, moves, selects, and Escape closes without selecting', async () => {
    const picked = mountPicker();
    await settle(2);
    const trigger = host.querySelector('.scope-trigger') as HTMLButtonElement;
    const key = (k: string) => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

    key('ArrowDown');
    await settle(2);
    expect(host.querySelector('.scope-popup')).not.toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    key('Escape');
    await settle(2);
    expect(host.querySelector('.scope-popup')).toBeNull();
    expect(picked).toEqual([]);

    key('ArrowDown'); // reopen at the current row (all workspaces)
    await settle(2);
    key('End'); // last workspace
    await settle(2);
    key('Enter');
    await settle(2);
    expect(picked).toEqual(['/Users/me/work/beta']);
  });

  test('a launch scope the database has never recorded stays selectable', async () => {
    mountPicker({ scopeKey: '/tmp/unrecorded', allScopes: false });
    await settle(2);
    const trigger = host.querySelector('.scope-trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('unrecorded');

    trigger.click();
    await settle(2);
    const rows = [...host.querySelectorAll('.scope-option')];
    expect(rows.length).toBe(4);
    const own = rows.find((r) => r.textContent?.includes('/tmp/unrecorded'))!;
    expect(own.getAttribute('aria-selected')).toBe('true');
    expect(own.textContent).toContain('this workspace');
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

    const trigger = host.querySelector('.scope-trigger') as HTMLButtonElement;
    expect(trigger.textContent).toContain('All workspaces');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
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

  test('pinning confirms with a dismissible toast rather than a modal', async () => {
    const { api } = stubApi();
    render(<App api={api} initialToken="tok" initialScope={SCOPE} />, host);
    await settle();

    // Reversible action -> transient receipt, no modal.
    const pinButton = host.querySelector('.card-side .icon-btn:not(.icon-btn-danger)') as HTMLButtonElement;
    pinButton.click();
    await settle();
    const toast = host.querySelector('.toast');
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('Pinned #O1');
    expect(host.querySelector('.modal')).toBeNull();
    // The live region is a fixture, not something that appears with the message.
    expect(host.querySelector('.toasts')!.getAttribute('aria-live')).toBe('polite');
    // Clicking the pill dismisses it early.
    (toast as HTMLButtonElement).click();
    await settle(2);
    expect(host.querySelector('.toast')).toBeNull();
  });

  test('a refused pin reverts the optimistic toggle and reports it', async () => {
    const { api } = stubApi({
      pin: async () => {
        throw new ApiError(500, 'boom');
      },
    });
    render(<App api={api} initialToken="tok" initialScope={SCOPE} />, host);
    await settle();

    const pinButton = host.querySelector('.card-side .icon-btn:not(.icon-btn-danger)') as HTMLButtonElement;
    pinButton.click();
    await settle();

    const toast = host.querySelector('.toast.toast-danger');
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain('reverted');
    // Reverted: the button is back to its unpinned state.
    expect(host.querySelector('.card-side .icon-btn-on')).toBeNull();
  });

  test('the whole chrome follows config.language, in one language only', async () => {
    const { api } = stubApi({
      bootstrap: async () => ({
        version: '3.0.0',
        language: 'zh' as const,
        scopes: [{ scopeKey: SCOPE, observations: 1, lastActivityAt: '2026-08-15T10:00:00.000Z' }],
        queue: { pending: 0, leased: 0, dead: 0, succeeded24h: 0 },
        retrieval: { semanticDiscovery: true, profile: 'default', semanticFloor: 0.197, semanticOnlyLimit: 2 },
        observations: { total: 1, normal: 1, fallback: 0, pinned: 0 },
        context: { maxOutputBytes: 8192 },
        startedAt: '2026-08-15T09:00:00.000Z',
      }),
    });
    render(<App api={api} initialToken="tok" initialScope={null} />, host);
    await settle();

    const text = host.textContent ?? '';
    expect(host.querySelector('.scope-trigger')!.textContent).toContain('全部工作区');
    expect(host.querySelector('.warnbar')!.textContent).toContain('正在浏览本机所有工作区');
    // Not doubled: the English wording is nowhere on the page.
    expect(text).not.toContain('All workspaces');
    expect(text).not.toContain('Browsing every workspace');
    // The card action labels moved too.
    const pinButton = host.querySelector('.card-side .icon-btn:not(.icon-btn-danger)') as HTMLButtonElement;
    expect(pinButton.getAttribute('title')).toBe(VIEWER_STRINGS.zh.pin);

    pinButton.click();
    await settle();
    expect(host.querySelector('.toast')!.textContent).toContain('已置顶');
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

    const trigger = host.querySelector('.scope-trigger') as HTMLButtonElement;
    trigger.click();
    await settle();
    const allOption = [...host.querySelectorAll('.scope-option')].find((o) =>
      o.textContent?.includes('All workspaces'),
    ) as HTMLElement;
    allOption.click();
    await settle();

    expect(host.querySelector('.scope-popup')).toBeNull();
    expect(host.querySelector('.warnbar')).not.toBeNull();
    expect(host.querySelector('.warnbar')!.textContent).toContain('every workspace');
    expect(calls.filter((c) => c === 'list').length).toBeGreaterThanOrEqual(2);
  });
});
