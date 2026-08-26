/**
 * Feed state merging (plan §3.2).
 *
 * The Feed has two writers — paginated fetches and the SSE stream — so "the same
 * Observation twice" and "an Observation from the workspace I just switched away
 * from" are the two defects this module exists to prevent. Kept pure and
 * DOM-free so it can be tested without a browser.
 */

import type { ViewerObservationCard } from '../server/viewer-types';

/** Feed order, matching the server's `turn_stopped_at DESC, id DESC`. */
export function compareCards(a: ViewerObservationCard, b: ViewerObservationCard): number {
  if (a.turnStoppedAt !== b.turnStoppedAt) return a.turnStoppedAt < b.turnStoppedAt ? 1 : -1;
  return b.id - a.id;
}

/**
 * Merge incoming cards into the current list.
 *
 * Dedupe is by Observation id, and the INCOMING copy wins: it is either the same
 * row or a fresher read of it (a pin toggle, an embedding that just landed).
 * `scopeKey` is the second line of defence the plan asks for — the server already
 * filtered, and a stale in-flight response from the previous workspace must not
 * be able to slip a card in after a scope switch.
 */
export function mergeCards(
  current: ViewerObservationCard[],
  incoming: ViewerObservationCard[],
  opts?: { scopeKey?: string | null; allScopes?: boolean },
): ViewerObservationCard[] {
  const byId = new Map<number, ViewerObservationCard>();
  for (const card of current) byId.set(card.id, card);
  for (const card of incoming) byId.set(card.id, card);

  const scopeKey = opts?.scopeKey ?? null;
  const allScopes = opts?.allScopes === true;
  const kept = [...byId.values()].filter((card) => allScopes || !scopeKey || card.scopeKey === scopeKey);
  return kept.sort(compareCards);
}

/** Remove one card (an `observation_deleted` event, or a local delete). */
export function removeCard(current: ViewerObservationCard[], id: number): ViewerObservationCard[] {
  return current.filter((card) => card.id !== id);
}

/** Apply a pin toggle without refetching the page. */
export function applyPin(
  current: ViewerObservationCard[],
  id: number,
  pinned: boolean,
): ViewerObservationCard[] {
  return current.map((card) => (card.id === id ? { ...card, pinned } : card));
}

/** Human-readable byte size for the delete dialog and context breakdown. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `2026-08-15T10:11:12.000Z` -> `2026-08-15 10:11`, in local time. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** Last path segment of a scope key, for a compact selector label. */
export function scopeLabel(scopeKey: string): string {
  const withoutPrefix = scopeKey.startsWith('cwd:') ? scopeKey.slice(4) : scopeKey;
  const parts = withoutPrefix.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : withoutPrefix;
}
