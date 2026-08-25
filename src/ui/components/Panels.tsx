/** @jsxImportSource preact */
/**
 * Retrieval health and the log drawer (plan §3.5, §9 P3).
 *
 * Both are projections of numbers the Worker already computes — `search_24h`,
 * the retrieval profile, and the worker error log. Nothing here recalculates a
 * metric, because a second implementation of a counter is a second answer to the
 * same question.
 */

import type { ViewerLogLine, ViewerRetrievalHealth } from '../../server/viewer-types';
import { formatTime } from '../merge';
import { Empty, Field, Section } from './Common';

export function RetrievalHealth({
  health,
  loading,
  error,
}: {
  health: ViewerRetrievalHealth | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) return <Section title="Retrieval health"><Empty message={`Failed to load: ${error}`} /></Section>;
  if (!health) return <Section title="Retrieval health"><Empty message={loading ? 'Loading…' : 'No data.'} /></Section>;

  const s = health.search24h;
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return (
    <Section title="Retrieval health (last 24h)">
      <Field label="profile">
        {`${health.retrieval.profile} · floor ${health.retrieval.semanticFloor} · semantic-only cap ${health.retrieval.semanticOnlyLimit} · tie-break ${health.retrieval.tieBreak}`}
      </Field>
      <Field label="agent searches">
        {`${s.requests} requests · p50 ${s.latencyMsP50}ms · p95 ${s.latencyMsP95}ms`}
      </Field>
      <Field label="English space reach">
        {`${s.protocolSemanticEn} of ${s.requests} (${pct(s.semanticEnRate)}) — independent semantic recall only works there`}
      </Field>
      {Object.keys(s.semanticQueryIssues).length ? (
        <Field label="semantic_query_en issues">
          <div className="taglist">
            {Object.entries(s.semanticQueryIssues).map(([reason, count]) => (
              <span className="tag" key={reason}>{`${reason}: ${count}`}</span>
            ))}
          </div>
        </Field>
      ) : null}
      <Field label="degraded to keyword-only">{`${s.ftsOnly} (${pct(s.degradeRate)}) — embedding unavailable`}</Field>
      <Field label="zero-keyword queries">{`${s.zeroFts}, recalled semantically ${s.zeroFtsRecalled}`}</Field>
      <Field label="unverified semantic-only leads">
        {`${s.semanticOnlyTotal} total · ${s.semanticOnlyPerRequest.toFixed(2)}/request · worst page ${s.semanticOnlyMax}`}
      </Field>
      <Field label="vectors">
        {`scope avg ${s.scopeVectorsAvg.toFixed(1)} · min ${s.scopeVectorsMin} · measured on ${s.scopeVectorsMeasured} requests · empty-scope requests ${s.emptyScopeRequests}`}
      </Field>
      <Field label="embedding coverage">
        {`${health.embeddings.ready} ready (${pct(health.embeddings.coverage)}) · semantic-en ready ${health.embeddings.semanticEn.ready}, pending ${health.embeddings.semanticEn.pending}, failed ${health.embeddings.semanticEn.failed}`}
      </Field>
      <p className="muted">
        Counters cover agent searches through MCP. Viewer search is keyword-only and is deliberately not counted here.
      </p>
    </Section>
  );
}

export function LogsDrawer({
  lines,
  cursor,
  loading,
  error,
  component,
  onComponentChange,
  onLoadMore,
}: {
  lines: ViewerLogLine[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  component: string;
  onComponentChange: (value: string) => void;
  onLoadMore: () => void;
}) {
  return (
    <Section
      title="Worker error log"
      actions={
        <input
          type="search"
          value={component}
          placeholder="filter component"
          aria-label="Filter log component"
          onInput={(e) => onComponentChange((e.target as HTMLInputElement).value)}
        />
      }
    >
      {error ? <Empty message={`Failed to load: ${error}`} /> : null}
      {!error && lines.length === 0 ? (
        <Empty message={loading ? 'Loading…' : 'No errors logged.'} hint="This log only records failures; an empty drawer is the healthy state." />
      ) : null}
      {lines.length ? (
        <ul className="loglines">
          {lines.map((line, i) => (
            <li key={`${i}-${line.at ?? ''}`}>
              <span className="mono muted">{formatTime(line.at)}</span>
              <span className="tag">{line.component}</span>
              <span className="logmsg">{line.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {cursor ? (
        <button type="button" className="btn" disabled={loading} onClick={onLoadMore}>
          {loading ? 'Loading…' : 'Load older'}
        </button>
      ) : null}
    </Section>
  );
}
