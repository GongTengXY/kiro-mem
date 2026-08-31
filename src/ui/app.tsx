/** @jsxImportSource preact */
/**
 * Viewer application shell: owns scope selection, Feed state, the SSE wiring and
 * the delete flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
  ViewerBootstrap,
  ViewerContextPreview,
  ViewerLogLine,
  ViewerObservationCard,
  ViewerObservationDetail,
  ViewerQueueStatus,
  ViewerRetrievalHealth,
  ViewerTurnEvent,
} from '../server/viewer-types';
import { ApiError, ViewerApi, type ScopeSelection } from './api';
import { applyPin, mergeCards, removeCard } from './merge';
import { ViewerStream, type StreamState } from './stream';
import { clearSession, rememberScope } from './token';
import { ALL_SCOPES_VALUE } from './components/ScopePicker';
import { TopBar } from './components/TopBar';
import { ObservationCard } from './components/ObservationCard';
import { DetailPanel } from './components/DetailPanel';
import { DeleteDialog } from './components/DeleteDialog';
import { ContextPreview } from './components/ContextPreview';
import { LogsDrawer, RetrievalHealth } from './components/Panels';
import { Toasts, useToasts } from './components/Toasts';
import { Empty } from './components/Common';
import { LangContext, VIEWER_STRINGS, type ViewerLang } from './i18n';

type Panel = 'context' | 'retrieval' | 'logs';

export function App({ api, initialToken, initialScope }: { api: ViewerApi; initialToken: string; initialScope: string | null }) {
  const [token, setToken] = useState(initialToken);
  const [scopeKey, setScopeKey] = useState<string | null>(initialScope);
  const [allScopes, setAllScopes] = useState(initialScope === null);
  const scope: ScopeSelection = useMemo(() => ({ scopeKey, allScopes }), [scopeKey, allScopes]);

  const [bootstrap, setBootstrap] = useState<ViewerBootstrap | null>(null);
  const [queue, setQueue] = useState<ViewerQueueStatus | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('connecting');

  const [cards, setCards] = useState<ViewerObservationCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ViewerObservationCard[] | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ViewerObservationDetail | null>(null);
  const [events, setEvents] = useState<ViewerTurnEvent[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [eventsTruncated, setEventsTruncated] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);

  const [panel, setPanel] = useState<Panel | null>(null);
  const [context, setContext] = useState<ViewerContextPreview | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [health, setHealth] = useState<ViewerRetrievalHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ViewerLogLine[]>([]);
  const [logsCursor, setLogsCursor] = useState<string | null>(null);
  const [logsComponent, setLogsComponent] = useState('');
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<ViewerObservationDetail | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();

  /** From `config.language` via bootstrap; English until that lands, rather than blocking first paint. */
  const lang: ViewerLang = bootstrap?.language === 'zh' ? 'zh' : 'en';
  const t = VIEWER_STRINGS[lang];

  /** Bumped by every scope switch: a response already in flight for the old workspace is dropped. */
  const requestId = useRef(0);

  const handleError = useCallback((err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        setToken('');
        clearSession(window.sessionStorage);
        setFatal('unauthorized');
      }
      return err.code;
    }
    return 'network';
  }, []);

  // --- Feed loading ---

  const loadPage = useCallback(
    async (nextCursor: string | null, reset: boolean) => {
      const mine = requestId.current;
      setLoading(true);
      try {
        const res = await api.list(scope, nextCursor);
        if (mine !== requestId.current) return; // stale scope
        setCards((prev) =>
          mergeCards(reset ? [] : prev, res.items, { scopeKey: res.scopeKey, allScopes: res.allScopes }),
        );
        setCursor(res.nextCursor);
      } catch (err) {
        handleError(err);
      } finally {
        if (mine === requestId.current) setLoading(false);
      }
    },
    [api, scope, handleError],
  );

  useEffect(() => {
    void api
      .bootstrap()
      .then((res) => {
        setBootstrap(res);
        setQueue(res.queue);
      })
      .catch(handleError);
  }, [api, handleError]);

  useEffect(() => {
    if (!token) return;
    if (!allScopes && !scopeKey) return;
    requestId.current++;
    setCards([]);
    setCursor(null);
    setSearchResults(null);
    setSelectedId(null);
    setDetail(null);
    void loadPage(null, true);
  }, [token, scopeKey, allScopes]);

  // --- SSE ---

  useEffect(() => {
    if (!token) return;
    if (!allScopes && !scopeKey) return;
    const stream = new ViewerStream(api, {
      onState: (state) => {
        setStreamState(state);
        if (state === 'unauthorized') {
          setToken('');
          clearSession(window.sessionStorage);
          setFatal('unauthorized');
        }
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'initial_state':
          case 'processing_status':
            setQueue(event.queue);
            break;
          case 'observation_created':
          case 'observation_updated':
            // The event is a notification, not the row: the API is the source of truth.
            void api
              .list({ scopeKey: event.scopeKey, allScopes: false }, null, 5)
              .then((res) => {
                setCards((prev) => mergeCards(prev, res.items, { scopeKey, allScopes }));
              })
              .catch(() => undefined);
            break;
          case 'observation_deleted':
            setCards((prev) => removeCard(prev, event.observationId));
            setSearchResults((prev) => (prev ? removeCard(prev, event.observationId) : prev));
            setSelectedId((prev) => (prev === event.observationId ? null : prev));
            setDetail((prev) => (prev && prev.memory.id === event.observationId ? null : prev));
            break;
          default:
            break;
        }
      },
    });
    stream.start({ scopeKey, allScopes });
    return () => stream.stop();
  }, [api, token, scopeKey, allScopes]);

  // --- Scope switching ---

  const onScopeChange = useCallback((value: string) => {
    if (value === ALL_SCOPES_VALUE) {
      setAllScopes(true);
      setScopeKey(null);
      rememberScope(window.sessionStorage, null);
      return;
    }
    setAllScopes(false);
    setScopeKey(value);
    rememberScope(window.sessionStorage, value);
  }, []);

  // --- Search ---

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    const mine = requestId.current;
    try {
      const res = await api.search(scope, q);
      if (mine !== requestId.current) return;
      setSearchResults(mergeCards([], res.items, { scopeKey: res.scopeKey, allScopes: res.allScopes }));
    } catch (err) {
      handleError(err);
    }
  }, [api, query, scope, handleError]);

  // --- Detail ---

  const openDetail = useCallback(
    async (id: number) => {
      setSelectedId(id);
      setEvents([]);
      setEventsCursor(null);
      setEventsTruncated(false);
      try {
        setDetail(await api.detail(scope, id));
      } catch (err) {
        handleError(err);
        setDetail(null);
      }
    },
    [api, scope, handleError],
  );

  const loadEvents = useCallback(
    async (cur: string | null) => {
      if (selectedId === null) return;
      setEventsLoading(true);
      try {
        const res = await api.events(scope, selectedId, cur);
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          for (const e of res.items) byId.set(e.id, e);
          return [...byId.values()].sort((a, b) => a.eventSeq - b.eventSeq);
        });
        setEventsCursor(res.nextCursor);
        setEventsTruncated(res.truncated);
      } catch (err) {
        handleError(err);
      } finally {
        setEventsLoading(false);
      }
    },
    [api, scope, selectedId, handleError],
  );

  // --- Pin ---

  const onPin = useCallback(
    async (id: number, pinned: boolean) => {
      setCards((prev) => applyPin(prev, id, pinned));
      setSearchResults((prev) => (prev ? applyPin(prev, id, pinned) : prev));
      try {
        await api.pin(scope, id, pinned);
        pushToast(pinned ? t.toastPinned(id) : t.toastUnpinned(id));
      } catch (err) {
        const code = handleError(err);
        // Revert an optimistic toggle the server refused.
        setCards((prev) => applyPin(prev, id, !pinned));
        setSearchResults((prev) => (prev ? applyPin(prev, id, !pinned) : prev));
        pushToast(t.toastPinFailed(id, code), 'danger');
      }
    },
    [api, scope, handleError, pushToast, t],
  );

  // --- Delete ---

  const askDelete = useCallback(
    async (id: number) => {
      setDeleteError(null);
      try {
        // Always re-read: the dialog quotes the exact event count and bytes destroyed,
        // which a stale card cannot supply.
        setPendingDelete(await api.detail(scope, id));
      } catch (err) {
        handleError(err);
      }
    },
    [api, scope, handleError],
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.memory.id;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await api.remove({ scopeKey: pendingDelete.memory.scopeKey, allScopes: false }, id);
      setCards((prev) => removeCard(prev, id));
      setSearchResults((prev) => (prev ? removeCard(prev, id) : prev));
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      setPendingDelete(null);
    } catch (err) {
      // 409 (a leased job) and 404 both keep the dialog open so the user sees why nothing happened.
      setDeleteError(handleError(err));
    } finally {
      setDeleteBusy(false);
    }
  }, [api, pendingDelete, selectedId, handleError]);

  // --- Panels ---

  const loadContext = useCallback(
    async (maxOutputBytes?: number) => {
      if (!scopeKey) {
        setContextError('scope_required');
        return;
      }
      setContextLoading(true);
      setContextError(null);
      try {
        setContext(await api.contextPreview(scopeKey, maxOutputBytes));
      } catch (err) {
        setContext(null);
        setContextError(handleError(err));
      } finally {
        setContextLoading(false);
      }
    },
    [api, scopeKey, handleError],
  );

  const loadLogs = useCallback(
    async (cur: string | null, componentFilter: string) => {
      setLogsLoading(true);
      setLogsError(null);
      try {
        const res = await api.logs(cur, componentFilter || undefined);
        setLogs((prev) => (cur ? [...prev, ...res.items] : res.items));
        setLogsCursor(res.nextCursor);
      } catch (err) {
        setLogsError(handleError(err));
      } finally {
        setLogsLoading(false);
      }
    },
    [api, handleError],
  );

  const togglePanel = useCallback(
    (next: string) => {
      const value = next as Panel;
      setPanel((prev) => (prev === value ? null : value));
      if (panel === value) return;
      if (value === 'context') void loadContext(undefined);
      if (value === 'retrieval') {
        api.retrievalHealth().then(setHealth).catch((err) => setHealthError(handleError(err)));
      }
      if (value === 'logs') void loadLogs(null, logsComponent);
    },
    [panel, loadContext, loadLogs, api, handleError, logsComponent],
  );

  // --- Render ---

  if (fatal === 'unauthorized' || !token) {
    return (
      <LangContext.Provider value={t}>
        <div className="fatal">
          <Empty message={t.unauthorized} hint={t.unauthorizedHint} />
        </div>
      </LangContext.Provider>
    );
  }

  const visible = searchResults ?? cards;
  return (
    <LangContext.Provider value={t}>
    <div className="app">
      <TopBar
        bootstrap={bootstrap}
        queue={queue}
        streamState={streamState}
        scopeKey={scopeKey}
        allScopes={allScopes}
        query={query}
        activePanel={panel}
        onScopeChange={onScopeChange}
        onQueryChange={(value) => {
          setQuery(value);
          if (!value.trim()) setSearchResults(null);
        }}
        onSubmitQuery={() => void runSearch()}
        onTogglePanel={togglePanel}
      />

      {panel ? (
        <div className="drawer">
          {panel === 'context' ? (
            <ContextPreview preview={context} loading={contextLoading} error={contextError} onReload={(b) => void loadContext(b)} />
          ) : null}
          {panel === 'retrieval' ? <RetrievalHealth health={health} loading={!health} error={healthError} /> : null}
          {panel === 'logs' ? (
            <LogsDrawer
              lines={logs}
              cursor={logsCursor}
              loading={logsLoading}
              error={logsError}
              component={logsComponent}
              onComponentChange={(value) => {
                setLogsComponent(value);
                void loadLogs(null, value);
              }}
              onLoadMore={() => void loadLogs(logsCursor, logsComponent)}
            />
          ) : null}
        </div>
      ) : null}

      <main className="layout">
        <section className="feed" aria-label={t.observationsAria}>
          {searchResults ? (
            <div className="feed-note">
              {t.searchNote(searchResults.length)}
              <button type="button" className="btn btn-ghost" onClick={() => { setSearchResults(null); setQuery(''); }}>
                {t.clear}
              </button>
            </div>
          ) : null}

          {visible.length === 0 && !loading ? (
            <Empty
              message={searchResults ? t.emptySearch(allScopes) : t.emptyFeed(allScopes)}
              hint={searchResults ? t.emptySearchHint : t.emptyFeedHint}
            />
          ) : null}

          {visible.map((card) => (
            <ObservationCard
              key={card.id}
              card={card}
              selected={card.id === selectedId}
              showScope={allScopes}
              onOpen={(id) => void openDetail(id)}
              onPin={(id, pinned) => void onPin(id, pinned)}
              onDelete={(id) => void askDelete(id)}
            />
          ))}

          {!searchResults && cursor ? (
            <button type="button" className="btn load-more" disabled={loading} onClick={() => void loadPage(cursor, false)}>
              {loading ? t.loading : t.loadMore}
            </button>
          ) : null}
        </section>

        <aside className="detail-pane" aria-label={t.detailAria}>
          <DetailPanel
            detail={detail}
            events={events}
            eventsCursor={eventsCursor}
            eventsTruncated={eventsTruncated}
            eventsLoading={eventsLoading}
            onLoadEvents={(cur) => void loadEvents(cur)}
            onDelete={(id) => void askDelete(id)}
            onClose={() => {
              setSelectedId(null);
              setDetail(null);
            }}
          />
        </aside>
      </main>

      {pendingDelete ? (
        <DeleteDialog
          detail={pendingDelete}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            setPendingDelete(null);
            setDeleteError(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}

      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
    </LangContext.Provider>
  );
}
