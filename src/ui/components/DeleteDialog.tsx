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
import { Field, Text } from './Common';

/** Fixed wording from the plan. Not a paraphrase. */
export const DELETE_WARNING =
  '将永久删除这条生成记忆、原始对话事件和相关索引。删除后无法恢复。';
export const DELETE_WARNING_EN =
  'This permanently deletes the generated memory, the raw conversation events and the related indexes. It cannot be undone.';

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
          <AlertTriangle size={18} /> 永久删除 / Permanent delete
        </h3>

        <Field label="Observation">
          <span className="mono">{`#O${memory.id}`}</span> <Text value={memory.title} />
        </Field>
        <Field label="Workspace">
          <span className="mono break">{memory.scopeKey}</span>
        </Field>
        <Field label="Turn">
          <span className="mono">{`#${source.turnId} · seq ${source.turnSeq}`}</span>{' '}
          {`${formatTime(source.startedAt)} → ${formatTime(source.stoppedAt)}`}
        </Field>
        <Field label="Truth layer to be destroyed">
          {`${source.events.count} raw events · ${formatBytes(source.events.payloadBytes)} captured`}
        </Field>

        <p className="modal-warning">{DELETE_WARNING}</p>
        <p className="modal-warning-en">{DELETE_WARNING_EN}</p>

        {error ? (
          <p className="modal-error" role="alert">
            {error === 'deletion_in_progress'
              ? '有关联任务正在执行（leased），未删除任何数据。等它结束后重试。 / A related job is running; nothing was deleted. Retry once it finishes.'
              : error === 'not_found'
                ? '这条记忆已经不存在了。 / This memory no longer exists.'
                : `删除失败 / Delete failed: ${error}`}
          </p>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消 / Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? '删除中…' : '永久删除 / Permanently delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
