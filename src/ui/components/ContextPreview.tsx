/** @jsxImportSource preact */
/**
 * Context injection preview (plan §3.4). The text is the exact string the agentSpawn
 * hook injects — server and hook share one structured report — so it cannot drift into
 * an approximation. Per-section bytes come from that report, not the rendered string.
 */

import { useState } from 'preact/hooks';
import type { ViewerContextPreview } from '../../server/viewer-types';
import { formatBytes } from '../merge';
import { useT } from '../i18n';
import { Empty, Raw, Section } from './Common';

export function ContextPreview({
  preview,
  loading,
  error,
  onReload,
}: {
  preview: ViewerContextPreview | null;
  loading: boolean;
  error: string | null;
  onReload: (maxOutputBytes?: number) => void;
}) {
  const t = useT();
  const [budget, setBudget] = useState<number | null>(null);

  if (error) {
    return (
      <Section title={t.contextPreview}>
        <Empty
          message={
            error === 'unknown_scope'
              ? t.ctxUnknownScope
              : error === 'scope_required'
                ? t.ctxScopeRequired
                : t.ctxFailed(error)
          }
          hint={t.ctxErrorHint}
        />
      </Section>
    );
  }
  if (!preview) {
    return (
      <Section title={t.contextPreview}>
        <Empty message={loading ? t.loading : t.noPreview} />
      </Section>
    );
  }

  const used = preview.usedBytes;
  const max = preview.effectiveMaxBytes;
  return (
    <Section
      title={t.contextPreview}
      actions={<span className="muted">{t.bytesUsed(used, max, ((used / max) * 100).toFixed(0))}</span>}
    >
      <div className="budget-bar" aria-hidden="true">
        <div className="budget-fill" style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
      </div>

      <div className="budget-row">
        <label>
          <span className="sr-only">{t.contextBudgetAria}</span>
          <input
            type="number"
            min={512}
            max={9500}
            step={256}
            value={budget ?? preview.requestedMaxBytes}
            onInput={(e) => setBudget(Number((e.target as HTMLInputElement).value))}
          />
        </label>
        <button type="button" className="btn" disabled={loading} onClick={() => onReload(budget ?? undefined)}>
          {loading ? t.rebuilding : t.rebuild}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={loading}
          onClick={() => {
            setBudget(null);
            onReload(undefined);
          }}
        >
          {t.useConfig(preview.configuredMaxBytes)}
        </button>
      </div>
      {preview.requestedMaxBytes > preview.effectiveMaxBytes ? (
        <p className="muted">{t.cappedAt(preview.requestedMaxBytes, preview.effectiveMaxBytes)}</p>
      ) : null}
      {preview.degraded ? <p className="warn-text">{t.budgetTooSmall}</p> : null}

      <table className="sections">
        <thead>
          <tr>
            <th>{t.colSection}</th>
            <th>{t.colItems}</th>
            <th>{t.colBytes}</th>
          </tr>
        </thead>
        <tbody>
          {preview.sections.map((s) => (
            <tr key={s.kind} className={s.dropped ? 'dropped' : ''}>
              <td>
                {t.sectionLabel[s.kind] ?? s.kind}
                {s.dropped ? t.sectionDropped : ''}
              </td>
              <td>{s.itemCount || '—'}</td>
              <td>{formatBytes(s.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted">
        {t.injectedCounts(
          preview.observationIds.pinned.length,
          preview.observationIds.detail.length,
          preview.observationIds.index.length,
        )}
      </p>
      <Raw value={preview.text} maxHeight={420} />
    </Section>
  );
}
