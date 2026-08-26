/** @jsxImportSource preact */
/**
 * Permanent-delete confirmation (plan §4.2).
 *
 * The dialog must state what is destroyed in concrete terms — which record, which
 * workspace, when the turn ran, and how many raw events and captured bytes go
 * with it — because the operation has no undo and no export. There is no
 * `withTurn` checkbox: the truth layer is not an option the user can leave
 * behind, since a kept turn would be re-summarized by `kiro-mem repair`.
 */

import { AlertTriangle } from 'lucide-preact';
import type { ViewerObservationDetail } from '../../server/viewer-types';
import { formatBytes, formatTime } from '../merge';
import { useT } from '../i18n';
import { Field, Text } from './Common';

export function DeleteDialog({
  detail,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  detail: ViewerObservationDetail;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const { memory, source } = detail;
  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="delete-title" className="modal-title">
          <AlertTriangle size={18} /> {t.deleteHeading}
        </h3>

        <Field label={t.dObservation}>
          <span className="mono">{`#O${memory.id}`}</span> <Text value={memory.title} />
        </Field>
        <Field label={t.dWorkspace}>
          <span className="mono break">{memory.scopeKey}</span>
        </Field>
        <Field label={t.dTurn}>
          <span className="mono">{`#${source.turnId} · seq ${source.turnSeq}`}</span>{' '}
          {`${formatTime(source.startedAt)} → ${formatTime(source.stoppedAt)}`}
        </Field>
        <Field label={t.dTruthLayer}>
          {t.truthLayerValue(source.events.count, formatBytes(source.events.payloadBytes))}
        </Field>

        <p className="modal-warning">{t.deleteWarning}</p>

        {error ? (
          <p className="modal-error" role="alert">
            {error === 'deletion_in_progress'
              ? t.errLeased
              : error === 'not_found'
                ? t.errNotFound
                : t.errDelete(error)}
          </p>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {t.cancel}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? t.deleting : t.confirmDelete}
          </button>
        </div>
      </div>
    </div>
  );
}
