/**
 * fetch-based SSE client (plan §8).
 *
 * Two responsibilities kept apart: `parseSseChunk` is a pure incremental parser
 * (testable with no browser), and `ViewerStream` owns the reader loop, the
 * AbortController and the reconnect policy.
 *
 * A 401 must NOT be retried. The token lives in this tab's `sessionStorage`, so
 * once it is rejected no amount of reconnecting will fix it — the user has to run
 * `kiro-mem viewer` again. Looping would just hammer the Worker and hide the
 * actual instruction.
 */

import type { ViewerStreamEvent } from '../server/viewer-types';
import { ApiError, type ScopeSelection, type ViewerApi } from './api';

export type StreamState = 'connecting' | 'open' | 'closed' | 'unauthorized';

/**
 * Feed raw text into a buffer and pull out whole SSE frames.
 * Returns the events found plus the unconsumed tail.
 */
export function parseSseChunk(buffer: string): { events: ViewerStreamEvent[]; rest: string } {
  const events: ViewerStreamEvent[] = [];
  let rest = buffer;

  for (;;) {
    const boundary = rest.indexOf('\n\n');
    if (boundary === -1) break;
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);

    const dataLines = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue; // comment/heartbeat frame
    try {
      events.push(JSON.parse(dataLines.join('\n')) as ViewerStreamEvent);
    } catch {
      /* a partial or malformed frame is dropped, never thrown at the UI */
    }
  }
  return { events, rest };
}

/** 1s, 2s, 4s … capped at 15s. */
export function backoffDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export class ViewerStream {
  private controller: AbortController | null = null;
  private attempt = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private api: ViewerApi,
    private handlers: {
      onEvent: (event: ViewerStreamEvent) => void;
      onState: (state: StreamState) => void;
    },
  ) {}

  start(scope: ScopeSelection): void {
    this.stop();
    this.stopped = false;
    this.attempt = 0;
    void this.run(scope);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.controller?.abort();
    this.controller = null;
  }

  private async run(scope: ScopeSelection): Promise<void> {
    while (!this.stopped) {
      this.attempt++;
      this.handlers.onState('connecting');
      const controller = new AbortController();
      this.controller = controller;
      try {
        const res = await this.api.stream(scope, controller.signal);
        if (res.status === 401) {
          this.stopped = true;
          this.handlers.onState('unauthorized');
          return;
        }
        if (!res.ok || !res.body) throw new ApiError(res.status, 'stream_failed');

        this.attempt = 0;
        this.handlers.onState('open');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = parseSseChunk(buffer);
            buffer = rest;
            for (const event of events) this.handlers.onEvent(event);
          }
        } finally {
          // Always release the lock, or a reconnect leaks the previous body.
          try {
            reader.releaseLock();
          } catch {
            /* already released */
          }
        }
      } catch {
        if (this.stopped) return;
      }
      if (this.stopped) return;
      this.handlers.onState('closed');
      await this.wait(backoffDelay(this.attempt));
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.retryTimer = setTimeout(resolve, ms);
    });
  }
}
