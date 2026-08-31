/** @jsxImportSource preact */
/**
 * Detail: generated memory beside the turn it was projected from (plan §3.3).
 * Both sides stay on screen together so faithfulness is checkable, and raw event
 * payloads load only when asked for — a 4MB turn must not be the cost of opening a card.
 */

import { useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-preact';
import type { ViewerObservationDetail, ViewerTurnEvent } from '../../server/viewer-types';
import { formatBytes, formatTime } from '../merge';
import { useT } from '../i18n';
import { Block, Chip, Empty, Field, Raw, Section, TagList, Text } from './Common';

export function DetailPanel({
  detail,
  events,
  eventsCursor,
  eventsTruncated,
  eventsLoading,
  onLoadEvents,
  onDelete,
  onClose,
}: {
  detail: ViewerObservationDetail | null;
  events: ViewerTurnEvent[];
  eventsCursor: string | null;
  eventsTruncated: boolean;
  eventsLoading: boolean;
  onLoadEvents: (cursor: string | null) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  if (!detail) {
    return (
      <div className="detail detail-empty">
        <Empty message={t.selectObservation} hint={t.selectObservationHint} />
      </div>
    );
  }

  const { memory, source, jobs } = detail;
  return (
    <div className="detail">
      <div className="detail-head">
        <div>
          <span className="card-id">{`#O${memory.id}`}</span>
          <Chip tone={memory.memoryType}>{memory.memoryType}</Chip>
          {memory.quality === 'fallback' ? <Chip tone="warn">fallback</Chip> : null}
          {memory.pinned ? <Chip tone="muted">{t.pinnedChip}</Chip> : null}
        </div>
        <div className="detail-head-actions">
          <button
            type="button"
            className="btn btn-danger-ghost"
            title={t.deleteTitle}
            onClick={() => onDelete(memory.id)}
          >
            <Trash2 size={15} /> {t.delete}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>

      <div className="detail-body">
        <h2 className="detail-title">
          <Text value={memory.title} />
        </h2>

        <div className="detail-grid">
          {/* --- Generated memory --- */}
          <Section title={t.generatedMemory}>
            <Field label={t.fSummary}><Block value={memory.summary} /></Field>
            {memory.request ? <Field label={t.fRequest}><Block value={memory.request} /></Field> : null}
            {memory.outcome ? <Field label={t.fOutcome}><Block value={memory.outcome} /></Field> : null}
            {memory.learned ? <Field label={t.fLearned}><Block value={memory.learned} /></Field> : null}
            {memory.nextSteps ? <Field label={t.fNextSteps}><Block value={memory.nextSteps} /></Field> : null}

            <Field label={t.fScores}>
              {t.scoresValue(
                memory.scores.importance.toFixed(2),
                memory.scores.confidence.toFixed(2),
                memory.scores.unresolved.toFixed(2),
              )}
            </Field>
            {memory.files.length ? (
              <Field label={t.fFiles(memory.counts.files)}><TagList items={memory.files} total={memory.counts.files} max={12} /></Field>
            ) : null}
            {memory.concepts.length ? (
              <Field label={t.fConcepts(memory.counts.concepts)}><TagList items={memory.concepts} total={memory.counts.concepts} max={12} /></Field>
            ) : null}
            {memory.evidence.length ? (
              <Field label={t.fEvidence(memory.counts.evidence)}>
                <ul className="evidence">
                  {memory.evidence.map((line, i) => (
                    <li key={`${i}-${line}`}>{line}</li>
                  ))}
                </ul>
              </Field>
            ) : null}

            <Field label={t.fSemantic}>
              {memory.semantic
                ? `${memory.semantic.protocol}: ${memory.semantic.status}${memory.semantic.failureReason ? ` (${memory.semantic.failureReason})` : ''}`
                : t.noDerivedValue}
            </Field>
            <Field label={t.fEmbeddings}>
              {memory.embeddings.length
                ? memory.embeddings.map((e) => e.model).join(', ')
                : t.noEmbeddings}
            </Field>
          </Section>

          {/* --- Source truth --- */}
          <Section title={t.sourceTurn}>
            <Field label={t.fWorkspace}><span className="mono break">{source.scopeKey}</span></Field>
            <Field label={t.fSession}><span className="mono break">{`${source.sessionId} · turn #${source.turnId} · seq ${source.turnSeq}`}</span></Field>
            <Field label={t.fCwd}><span className="mono break">{source.cwd}</span></Field>
            <Field label={t.fTime}>{`${formatTime(source.startedAt)} → ${formatTime(source.stoppedAt)} · ${source.state}`}</Field>
            <Field label={t.fPrompt}>
              {source.promptText === null ? (
                <span className="muted">{t.noPrompt}</span>
              ) : (
                <>
                  <Raw value={source.promptText} maxHeight={220} />
                  {source.promptTruncated ? <p className="muted">{t.promptTruncated}</p> : null}
                </>
              )}
            </Field>
            <Field label={t.fRawEvents}>
              {t.rawEventsValue(source.events.count, formatBytes(source.events.payloadBytes))}
              {source.events.byHook.length ? (
                <div className="byhook">
                  {source.events.byHook.map((h) => (
                    <span className="tag" key={h.hookEventName}>{`${h.hookEventName} ×${h.count}`}</span>
                  ))}
                </div>
              ) : null}
            </Field>

            {source.artifacts ? (
              <>
                {source.artifacts.files.length ? <Field label={t.fArtifactFiles}><TagList items={source.artifacts.files} max={12} /></Field> : null}
                {source.artifacts.commands.length ? (
                  <Field label={t.fCommands}>
                    <ul className="evidence">{source.artifacts.commands.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
                {source.artifacts.errorSignals.length ? (
                  <Field label={t.fErrors}>
                    <ul className="evidence">{source.artifacts.errorSignals.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
                {source.artifacts.decisionSignals.length ? (
                  <Field label={t.fDecisions}>
                    <ul className="evidence">{source.artifacts.decisionSignals.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
                {source.artifacts.facts.length ? (
                  <Field label={t.fFacts}>
                    <ul className="evidence">{source.artifacts.facts.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
              </>
            ) : (
              <Field label={t.fArtifacts}><span className="muted">{t.noArtifacts}</span></Field>
            )}

            {jobs.length ? (
              <Field label={t.fRelatedJobs}>
                <div className="taglist">
                  {jobs.map((j) => (
                    <span className="tag" key={j.id}>{`${j.jobType}: ${j.state}`}</span>
                  ))}
                </div>
              </Field>
            ) : null}
          </Section>
        </div>

        <EventsList
          events={events}
          cursor={eventsCursor}
          truncated={eventsTruncated}
          loading={eventsLoading}
          total={source.events.count}
          onLoad={onLoadEvents}
        />
      </div>
    </div>
  );
}

function EventsList({
  events,
  cursor,
  truncated,
  loading,
  total,
  onLoad,
}: {
  events: ViewerTurnEvent[];
  cursor: string | null;
  truncated: boolean;
  loading: boolean;
  total: number;
  onLoad: (cursor: string | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={t.rawPayloads(total)}
      actions={
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && events.length === 0) onLoad(null);
          }}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {open ? t.hide : t.load}
        </button>
      }
    >
      {!open ? (
        <p className="muted">{t.payloadsOnDemand}</p>
      ) : (
        <>
          {events.map((event) => (
            <details className="event" key={event.id}>
              <summary>
                <span className="mono">{`#${event.eventSeq}`}</span> {event.hookEventName}
                {event.toolName ? <span className="tag">{event.toolName}</span> : null}
                <span className="muted">{`${formatBytes(event.payloadSize)} · ${formatTime(event.createdAt)}`}</span>
              </summary>
              <Raw value={event.payload} maxHeight={320} />
              {event.payloadTruncated ? <p className="muted">{t.payloadTruncated}</p> : null}
            </details>
          ))}
          {events.length === 0 && !loading ? <Empty message={t.noRawEvents} /> : null}
          {truncated ? <p className="muted">{t.byteBudgetReached}</p> : null}
          {cursor ? (
            <button type="button" className="btn" disabled={loading} onClick={() => onLoad(cursor)}>
              {loading ? t.loading : t.loadMoreEvents}
            </button>
          ) : null}
        </>
      )}
    </Section>
  );
}
