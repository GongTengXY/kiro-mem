/** @jsxImportSource preact */
/** Top bar (plan §3.1). The standing notice keeps the all-workspaces default explicit. */

import { Activity, Database, FileText, Globe, Search, SlidersHorizontal } from 'lucide-preact';
import type { ViewerBootstrap, ViewerQueueStatus } from '../../server/viewer-types';
import type { StreamState } from '../stream';
import { useT } from '../i18n';
import { ScopePicker } from './ScopePicker';

export function TopBar({
  bootstrap,
  queue,
  streamState,
  scopeKey,
  allScopes,
  query,
  activePanel,
  onScopeChange,
  onQueryChange,
  onSubmitQuery,
  onTogglePanel,
}: {
  bootstrap: ViewerBootstrap | null;
  queue: ViewerQueueStatus | null;
  streamState: StreamState;
  scopeKey: string | null;
  allScopes: boolean;
  query: string;
  activePanel: string | null;
  onScopeChange: (value: string) => void;
  onQueryChange: (value: string) => void;
  onSubmitQuery: () => void;
  onTogglePanel: (panel: string) => void;
}) {
  const scopes = bootstrap?.scopes ?? [];
  const t = useT();
  const streamLabel: Record<StreamState, string> = {
    connecting: t.streamConnecting,
    open: t.streamOpen,
    closed: t.streamClosed,
    unauthorized: t.streamUnauthorized,
  };
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <Database size={18} />
          <span>kiro-mem</span>
          {bootstrap ? <span className="brand-version">{`v${bootstrap.version}`}</span> : null}
        </div>

        <ScopePicker scopes={scopes} scopeKey={scopeKey} allScopes={allScopes} onChange={onScopeChange} />

        <form
          className="searchbox"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmitQuery();
          }}
        >
          <Search size={15} />
          <input
            type="search"
            value={query}
            placeholder={allScopes ? t.searchAll : t.searchThis}
            aria-label={t.searchAria}
            onInput={(e) => onQueryChange((e.target as HTMLInputElement).value)}
          />
        </form>

        <nav className="topbar-tools">
          <button
            type="button"
            className={`btn btn-ghost ${activePanel === 'context' ? 'btn-on' : ''}`}
            onClick={() => onTogglePanel('context')}
            title={t.panelContextTitle}
          >
            <FileText size={15} /> {t.panelContext}
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${activePanel === 'retrieval' ? 'btn-on' : ''}`}
            onClick={() => onTogglePanel('retrieval')}
            title={t.panelRetrievalTitle}
          >
            <SlidersHorizontal size={15} /> {t.panelRetrieval}
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${activePanel === 'logs' ? 'btn-on' : ''}`}
            onClick={() => onTogglePanel('logs')}
            title={t.panelLogsTitle}
          >
            <Activity size={15} /> {t.panelLogs}
          </button>
        </nav>

        <div className="status">
          <span className={`dot dot-${streamState}`} aria-hidden="true" />
          <span className="status-text">{streamLabel[streamState]}</span>
          {queue ? (
            <span className="status-queue" title={t.queueTitle}>
              {`${queue.pending} / ${queue.leased} / ${queue.dead}`}
            </span>
          ) : null}
        </div>
      </div>

      {allScopes ? (
        <div className="warnbar" role="status">
          <Globe size={14} /> {t.globalWarning}
        </div>
      ) : null}
    </header>
  );
}
