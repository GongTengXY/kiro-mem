/** @jsxImportSource preact */
/**
 * Detail: generated memory beside the turn it was projected from (plan §3.3).
 *
 * The layout exists to answer one question — is this memory faithful to what
 * actually happened — so the two sides are always on screen together, and the raw
 * event payloads load only when asked for. A 4MB turn must not be the cost of
 * opening a card.
 */

import { useState } from 'preact/hooks';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-preact';
import type { ViewerObservationDetail, ViewerTurnEvent } from '../../server/viewer-types';
import { formatBytes, formatTime } from '../merge';
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
  if (!detail) {
    return (
      <div className="detail detail-empty">
        <Empty
          message="Select an observation"
          hint="Each card opens the generated memory next to the prompt, artifacts and raw events it came from."
        />
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
          {memory.pinned ? <Chip tone="muted">pinned</Chip> : null}
        </div>
        <div className="detail-head-actions">
          <button
            type="button"
            className="btn btn-danger-ghost"
            title="Permanently delete this memory and its source turn"
            onClick={() => onDelete(memory.id)}
          >
            <Trash2 size={15} /> Delete
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      <div className="detail-body">
        <h2 className="detail-title">
          <Text value={memory.title} />
        </h2>

        <div className="detail-grid">
          {/* --- Generated memory --- */}
          <Section title="Generated memory">
            <Field label="summary"><Block value={memory.summary} /></Field>
            {memory.request ? <Field label="request"><Block value={memory.request} /></Field> : null}
            {memory.outcome ? <Field label="outcome"><Block value={memory.outcome} /></Field> : null}
            {memory.learned ? <Field label="learned"><Block value={memory.learned} /></Field> : null}
            {memory.nextSteps ? <Field label="next steps"><Block value={memory.nextSteps} /></Field> : null}

            <Field label="scores">
              {`importance ${memory.scores.importance.toFixed(2)} · confidence ${memory.scores.confidence.toFixed(2)} · unresolved ${memory.scores.unresolved.toFixed(2)}`}
            </Field>
            {memory.files.length ? (
              <Field label={`files (${memory.counts.files})`}><TagList items={memory.files} total={memory.counts.files} max={12} /></Field>
            ) : null}
            {memory.concepts.length ? (
              <Field label={`concepts (${memory.counts.concepts})`}><TagList items={memory.concepts} total={memory.counts.concepts} max={12} /></Field>
            ) : null}
            {memory.evidence.length ? (
              <Field label={`evidence (${memory.counts.evidence})`}>
                <ul className="evidence">
                  {memory.evidence.map((line, i) => (
                    <li key={`${i}-${line}`}>{line}</li>
                  ))}
                </ul>
              </Field>
            ) : null}

            <Field label="semantic normalization">
              {memory.semantic
                ? `${memory.semantic.protocol}: ${memory.semantic.status}${memory.semantic.failureReason ? ` (${memory.semantic.failureReason})` : ''}`
                : 'no derived value'}
            </Field>
            <Field label="embeddings">
              {memory.embeddings.length
                ? memory.embeddings.map((e) => e.model).join(', ')
                : 'none — not semantically reachable yet'}
            </Field>
          </Section>

          {/* --- Source truth --- */}
          <Section title="Source turn (truth layer)">
            <Field label="workspace"><span className="mono break">{source.scopeKey}</span></Field>
            <Field label="session"><span className="mono break">{`${source.sessionId} · turn #${source.turnId} · seq ${source.turnSeq}`}</span></Field>
            <Field label="cwd"><span className="mono break">{source.cwd}</span></Field>
            <Field label="time">{`${formatTime(source.startedAt)} → ${formatTime(source.stoppedAt)} · ${source.state}`}</Field>
            <Field label="prompt">
              {source.promptText === null ? (
                <span className="muted">no prompt recorded</span>
              ) : (
                <>
                  <Raw value={source.promptText} maxHeight={220} />
                  {source.promptTruncated ? <p className="muted">prompt truncated for display</p> : null}
                </>
              )}
            </Field>
            <Field label="raw events">
              {`${source.events.count} events · ${formatBytes(source.events.payloadBytes)} original`}
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
                {source.artifacts.files.length ? <Field label="artifact files"><TagList items={source.artifacts.files} max={12} /></Field> : null}
                {source.artifacts.commands.length ? (
                  <Field label="commands">
                    <ul className="evidence">{source.artifacts.commands.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
                {source.artifacts.errorSignals.length ? (
                  <Field label="errors">
                    <ul className="evidence">{source.artifacts.errorSignals.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
                {source.artifacts.decisionSignals.length ? (
                  <Field label="decisions">
                    <ul className="evidence">{source.artifacts.decisionSignals.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
                {source.artifacts.facts.length ? (
                  <Field label="facts">
                    <ul className="evidence">{source.artifacts.facts.map((c, i) => <li key={`${i}-${c}`}>{c}</li>)}</ul>
                  </Field>
                ) : null}
              </>
            ) : (
              <Field label="artifacts"><span className="muted">no deterministic artifacts stored</span></Field>
            )}

            {jobs.length ? (
              <Field label="related jobs">
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
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={`Raw event payloads (${total})`}
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
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {open ? 'Hide' : 'Load'}
        </button>
      }
    >
      {!open ? (
        <p className="muted">Loaded on demand — a single turn can hold megabytes of tool output.</p>
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
              {event.payloadTruncated ? <p className="muted">payload truncated for display</p> : null}
            </details>
          ))}
          {events.length === 0 && !loading ? <Empty message="No raw events stored for this turn." /> : null}
          {truncated ? <p className="muted">Response byte budget reached; load more to continue.</p> : null}
          {cursor ? (
            <button type="button" className="btn" disabled={loading} onClick={() => onLoad(cursor)}>
              {loading ? 'Loading…' : 'Load more events'}
            </button>
          ) : null}
        </>
      )}
    </Section>
  );
}
