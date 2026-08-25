/** @jsxImportSource preact */
/**
 * Top bar (plan §3.1).
 *
 * The scope selector defaults to "All workspaces" and can narrow the feed to a
 * single workspace. The standing notice keeps the global visibility explicit.
 */

import { Activity, Database, FileText, Globe, Search, SlidersHorizontal } from 'lucide-preact';
import type { ViewerBootstrap, ViewerQueueStatus } from '../../server/viewer-types';
import type { StreamState } from '../stream';
import { scopeLabel } from '../merge';

export const ALL_SCOPES_VALUE = '__all__';

const STREAM_LABEL: Record<StreamState, string> = {
  connecting: 'connecting',
  open: 'live',
  closed: 'reconnecting',
  unauthorized: 'unauthorized',
};

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
  return (
    <header className="topbar">
      <div className="topbar-row">
        <div className="brand">
          <Database size={18} />
          <span>kiro-mem</span>
          {bootstrap ? <span className="brand-version">{`v${bootstrap.version}`}</span> : null}
        </div>

        <label className="scope-select">
          <span className="sr-only">Workspace scope</span>
          <select
            value={allScopes ? ALL_SCOPES_VALUE : (scopeKey ?? '')}
            onChange={(e) => onScopeChange((e.target as HTMLSelectElement).value)}
          >
            <option value={ALL_SCOPES_VALUE}>All workspaces</option>
            {scopeKey && !scopes.some((s) => s.scopeKey === scopeKey) ? (
              <option value={scopeKey}>{`${scopeLabel(scopeKey)} (this workspace)`}</option>
            ) : null}
            {scopes.map((s) => (
              <option key={s.scopeKey} value={s.scopeKey}>
                {`${scopeLabel(s.scopeKey)} · ${s.observations}`}
              </option>
            ))}
          </select>
        </label>

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
            placeholder={`Search ${allScopes ? 'all workspaces' : 'this workspace'} (keyword)`}
            aria-label="Search observations"
            onInput={(e) => onQueryChange((e.target as HTMLInputElement).value)}
          />
        </form>

        <nav className="topbar-tools">
          <button
            type="button"
            className={`btn btn-ghost ${activePanel === 'context' ? 'btn-on' : ''}`}
            onClick={() => onTogglePanel('context')}
            title="Preview the context the next session will receive"
          >
            <FileText size={15} /> Context
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${activePanel === 'retrieval' ? 'btn-on' : ''}`}
            onClick={() => onTogglePanel('retrieval')}
            title="Retrieval health (last 24h)"
          >
            <SlidersHorizontal size={15} /> Retrieval
          </button>
          <button
            type="button"
            className={`btn btn-ghost ${activePanel === 'logs' ? 'btn-on' : ''}`}
            onClick={() => onTogglePanel('logs')}
            title="Worker error log"
          >
            <Activity size={15} /> Logs
          </button>
        </nav>

        <div className="status">
          <span className={`dot dot-${streamState}`} aria-hidden="true" />
          <span className="status-text">{STREAM_LABEL[streamState]}</span>
          {queue ? (
            <span className="status-queue" title="pending / leased / dead jobs">
              {`${queue.pending} / ${queue.leased} / ${queue.dead}`}
            </span>
          ) : null}
        </div>
      </div>

      {allScopes ? (
        <div className="warnbar" role="status">
          <Globe size={14} /> Browsing every workspace on this machine. Memory from other projects is visible.
        </div>
      ) : null}
    </header>
  );
}
