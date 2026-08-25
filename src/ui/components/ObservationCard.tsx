/** @jsxImportSource preact */
/**
 * One Feed / search card (plan §3.2).
 *
 * Evidence, concepts and files are collapsed summaries here on purpose: the card
 * answers "is this the record I mean", and the judgement of whether the memory is
 * faithful happens on the detail page next to the turn it came from.
 */

import { Pin, PinOff, Trash2 } from 'lucide-preact';
import type { ViewerObservationCard } from '../../server/viewer-types';
import { formatTime, scopeLabel } from '../merge';
import { Chip, TagList, Text } from './Common';

const MATCH_LABEL: Record<string, string> = {
  fts: 'keyword',
  hybrid: 'keyword + semantic',
  semantic: 'semantic only — unverified',
  bigram: 'bigram — unverified',
};

export function ObservationCard({
  card,
  selected,
  showScope,
  onOpen,
  onPin,
  onDelete,
}: {
  card: ViewerObservationCard;
  selected: boolean;
  showScope: boolean;
  onOpen: (id: number) => void;
  onPin: (id: number, pinned: boolean) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <article className={`card ${selected ? 'card-selected' : ''}`}>
      <button
        type="button"
        className="card-main"
        aria-label={`Open observation ${card.id}`}
        onClick={() => onOpen(card.id)}
      >
        <div className="card-top">
          <span className="card-id">{`#O${card.id}`}</span>
          <Chip tone={card.memoryType}>{card.memoryType}</Chip>
          {card.quality === 'fallback' ? <Chip tone="warn">fallback</Chip> : null}
          {card.matchSource ? (
            <Chip tone={card.matchSource === 'semantic' || card.matchSource === 'bigram' ? 'warn' : 'muted'}>
              {MATCH_LABEL[card.matchSource] ?? card.matchSource}
            </Chip>
          ) : null}
          <span className="card-time">{formatTime(card.turnStoppedAt)}</span>
        </div>
        <h4 className="card-title">
          <Text value={card.title} />
        </h4>
        <p className="card-summary">
          <Text value={card.outcome || card.summary} />
        </p>
        <div className="card-meta">
          {showScope ? <span className="card-scope" title={card.scopeKey}>{scopeLabel(card.scopeKey)}</span> : null}
          <TagList items={card.concepts} total={card.counts.concepts} max={3} />
          {card.counts.files > 0 ? <span className="card-count">{`${card.counts.files} files`}</span> : null}
          {card.counts.evidence > 0 ? <span className="card-count">{`${card.counts.evidence} evidence`}</span> : null}
        </div>
      </button>
      <div className="card-side">
        <button
          type="button"
          className={`icon-btn ${card.pinned ? 'icon-btn-on' : ''}`}
          title={card.pinned ? 'Unpin' : 'Pin for later context'}
          aria-label={card.pinned ? `Unpin observation ${card.id}` : `Pin observation ${card.id}`}
          onClick={() => onPin(card.id, !card.pinned)}
        >
          {card.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn-danger"
          title="Permanently delete this memory and its source turn"
          aria-label={`Permanently delete observation ${card.id}`}
          onClick={() => onDelete(card.id)}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}
