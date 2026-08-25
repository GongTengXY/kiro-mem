/** @jsxImportSource preact */
/**
 * Context injection preview (plan §3.4).
 *
 * The text shown here is the same string the agentSpawn hook injects — the server
 * returns one structured report and the hook takes its `text`, so this cannot
 * drift into a plausible-looking approximation. The per-section bytes come from
 * that same report rather than from parsing the rendered string.
 */

import { useState } from 'preact/hooks';
import type { ViewerContextPreview } from '../../server/viewer-types';
import { formatBytes } from '../merge';
import { Empty, Raw, Section } from './Common';

const SECTION_LABEL: Record<string, string> = {
  'frame-open': 'frame',
  'trust-boundary': 'trust boundary',
  usage: 'usage note',
  pinned: 'pinned',
  'recent-detail': 'recent (detail)',
  'recent-index': 'recent (index)',
  'frame-close': 'frame close',
};

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
  const [budget, setBudget] = useState<number | null>(null);

  if (error) {
    return (
      <Section title="Context preview">
        <Empty
          message={error === 'unknown_scope'
            ? 'This workspace is not known to the database yet.'
            : error === 'scope_required'
              ? 'Select a workspace to preview its injected context.'
              : `Preview failed: ${error}`}
          hint="Context injection is per-workspace; pick a workspace that has memory or session history."
        />
      </Section>
    );
  }
  if (!preview) {
    return (
      <Section title="Context preview">
        <Empty message={loading ? 'Loading…' : 'No preview yet.'} />
      </Section>
    );
  }

  const used = preview.usedBytes;
  const max = preview.effectiveMaxBytes;
  return (
    <Section
      title="Context preview"
      actions={
        <span className="muted">{`${used} / ${max} bytes (${((used / max) * 100).toFixed(0)}%)`}</span>
      }
    >
      <div className="budget-bar" aria-hidden="true">
        <div className="budget-fill" style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
      </div>

      <div className="budget-row">
        <label>
          <span className="sr-only">Context budget in bytes</span>
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
          {loading ? 'Rebuilding…' : 'Rebuild preview'}
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
          {`Use config (${preview.configuredMaxBytes})`}
        </button>
      </div>
      {preview.requestedMaxBytes > preview.effectiveMaxBytes ? (
        <p className="muted">{`Requested ${preview.requestedMaxBytes} bytes; the server caps injection at ${preview.effectiveMaxBytes}.`}</p>
      ) : null}
      {preview.degraded ? (
        <p className="warn-text">Budget too small for any content — only the frame would be injected.</p>
      ) : null}

      <table className="sections">
        <thead>
          <tr><th>section</th><th>items</th><th>bytes</th></tr>
        </thead>
        <tbody>
          {preview.sections.map((s) => (
            <tr key={s.kind} className={s.dropped ? 'dropped' : ''}>
              <td>{SECTION_LABEL[s.kind] ?? s.kind}{s.dropped ? ' (dropped)' : ''}</td>
              <td>{s.itemCount || '—'}</td>
              <td>{formatBytes(s.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted">
        {`Injected observations — pinned: ${preview.observationIds.pinned.length}, detail: ${preview.observationIds.detail.length}, index: ${preview.observationIds.index.length}`}
      </p>
      <Raw value={preview.text} maxHeight={420} />
    </Section>
  );
}
