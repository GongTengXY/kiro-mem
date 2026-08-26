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
import { useT } from '../i18n';
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
  const t = useT();
  if (error) {
    return (
      <Section title={t.retrievalHealth}>
        <Empty message={t.failedToLoad(error)} />
      </Section>
    );
  }
  if (!health) {
    return (
      <Section title={t.retrievalHealth}>
        <Empty message={loading ? t.loading : t.noData} />
      </Section>
    );
  }

  const s = health.search24h;
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  return (
    <Section title={t.retrievalHealth24h}>
      <Field label={t.rProfile}>
        {t.profileValue(
          health.retrieval.profile,
          health.retrieval.semanticFloor,
          health.retrieval.semanticOnlyLimit,
          health.retrieval.tieBreak,
        )}
      </Field>
      <Field label={t.rSearches}>{t.searchesValue(s.requests, s.latencyMsP50, s.latencyMsP95)}</Field>
      <Field label={t.rEnglishReach}>
        {t.englishReachValue(s.protocolSemanticEn, s.requests, pct(s.semanticEnRate))}
      </Field>
      {Object.keys(s.semanticQueryIssues).length ? (
        <Field label={t.rSemanticIssues}>
          <div className="taglist">
            {Object.entries(s.semanticQueryIssues).map(([reason, count]) => (
              <span className="tag" key={reason}>{`${reason}: ${count}`}</span>
            ))}
          </div>
        </Field>
      ) : null}
      <Field label={t.rDegraded}>{t.degradedValue(s.ftsOnly, pct(s.degradeRate))}</Field>
      <Field label={t.rZeroKeyword}>{t.zeroKeywordValue(s.zeroFts, s.zeroFtsRecalled)}</Field>
      <Field label={t.rSemanticOnly}>
        {t.semanticOnlyValue(s.semanticOnlyTotal, s.semanticOnlyPerRequest.toFixed(2), s.semanticOnlyMax)}
      </Field>
      <Field label={t.rVectors}>
        {t.vectorsValue(s.scopeVectorsAvg.toFixed(1), s.scopeVectorsMin, s.scopeVectorsMeasured, s.emptyScopeRequests)}
      </Field>
      <Field label={t.rCoverage}>
        {t.coverageValue(
          health.embeddings.ready,
          pct(health.embeddings.coverage),
          health.embeddings.semanticEn.ready,
          health.embeddings.semanticEn.pending,
          health.embeddings.semanticEn.failed,
        )}
      </Field>
      <p className="muted">{t.countersNote}</p>
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
  const t = useT();
  return (
    <Section
      title={t.workerErrorLog}
      actions={
        <input
          type="search"
          value={component}
          placeholder={t.filterComponent}
          aria-label={t.filterComponent}
          onInput={(e) => onComponentChange((e.target as HTMLInputElement).value)}
        />
      }
    >
      {error ? <Empty message={t.failedToLoad(error)} /> : null}
      {!error && lines.length === 0 ? (
        <Empty message={loading ? t.loading : t.noErrors} hint={t.noErrorsHint} />
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
          {loading ? t.loading : t.loadOlder}
        </button>
      ) : null}
    </Section>
  );
}
