/**
 * Viewer SSE hub (plan §8).
 * A POST route producing `text/event-stream`: native `EventSource` cannot set an
 * Authorization header, so the Viewer streams via `fetch` with the scope in the
 * body and the token in a header — neither in a URL that would land in an access
 * log.
 * Every event carries its `scopeKey`; the filter here decides what leaves the
 * process, the client's own filter is only a re-check.
 */

import type { ViewerQueueStatus, ViewerStreamEvent } from './viewer-types';

/** Heartbeat cadence. Below the 30s a proxy or browser may silently reap at. */
const HEARTBEAT_MS = 20_000;
/** Queue polling for `processing_status`; the plan caps the event at 1/s. */
const QUEUE_POLL_MS = 1000;
/** Per-client pending-frame bound: a backgrounded or suspended tab must not become
 * unbounded Worker memory. Past this the connection drops and reconnects fresh. */
const MAX_QUEUED_FRAMES = 256;

interface Client {
  id: number;
  scopeKey: string | null;
  allScopes: boolean;
  send: (event: ViewerStreamEvent) => void;
  close: () => void;
}

export interface ViewerStreamHubOptions {
  /** Reads the live queue snapshot. Called only while clients are connected. */
  queueStatus: () => ViewerQueueStatus;
  heartbeatMs?: number;
  queuePollMs?: number;
}

export class ViewerStreamHub {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastQueueJson = '';
  private readonly opts: Required<ViewerStreamHubOptions>;

  constructor(opts: ViewerStreamHubOptions) {
    this.opts = {
      queueStatus: opts.queueStatus,
      heartbeatMs: opts.heartbeatMs ?? HEARTBEAT_MS,
      queuePollMs: opts.queuePollMs ?? QUEUE_POLL_MS,
    };
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** SSE response for one client. `initial_state` goes to this connection only —
   * broadcasting it would reset every already-open tab because a new one appeared. */
  connect(input: { scopeKey: string | null; allScopes: boolean; signal?: AbortSignal }): Response {
    const encoder = new TextEncoder();
    const id = this.nextId++;
    let queued = 0;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let closed = false;
        const write = (chunk: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
            queued = 0;
          } catch {
            // Controller already closed by the runtime (client vanished).
            cleanup();
          }
        };
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          this.clients.delete(id);
          this.stopTimersIfIdle();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };

        const client: Client = {
          id,
          scopeKey: input.scopeKey,
          allScopes: input.allScopes,
          send: (event) => {
            if (closed) return;
            queued++;
            if (queued > MAX_QUEUED_FRAMES) {
              cleanup();
              return;
            }
            write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          },
          close: cleanup,
        };
        this.clients.set(id, client);

        // Comment frame: opens the stream for the browser without delivering an event.
        write(': kiro-mem viewer stream\n\n');
        client.send({
          type: 'initial_state',
          scopeKey: input.scopeKey,
          allScopes: input.allScopes,
          queue: this.opts.queueStatus(),
          serverTime: new Date().toISOString(),
        });

        input.signal?.addEventListener('abort', cleanup, { once: true });
        this.startTimers();
      },
      cancel: () => {
        this.clients.delete(id);
        this.stopTimersIfIdle();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }

  /** Fan out one event; a no-op with no clients, so callers pay nothing when idle. */
  broadcast(event: ViewerStreamEvent): void {
    if (this.clients.size === 0) return;
    const scoped = 'scopeKey' in event ? (event.scopeKey as string | null) : null;
    for (const client of [...this.clients.values()]) {
      if (scoped && !client.allScopes && client.scopeKey !== scoped) continue;
      client.send(event);
    }
  }

  /** Drop every connection (Worker shutdown, tests). */
  closeAll(): void {
    for (const client of [...this.clients.values()]) client.close();
    this.clients.clear();
    this.stopTimersIfIdle();
  }

  private startTimers(): void {
    if (this.timer === null) {
      this.lastQueueJson = JSON.stringify(this.opts.queueStatus());
      this.timer = setInterval(() => {
        if (this.clients.size === 0) return;
        const status = this.opts.queueStatus();
        const json = JSON.stringify(status);
        // On change only, at most once per poll: a backlog must not become an SSE storm.
        if (json === this.lastQueueJson) return;
        this.lastQueueJson = json;
        this.broadcast({ type: 'processing_status', queue: status });
      }, this.opts.queuePollMs);
      this.timer.unref?.();
    }
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => {
        if (this.clients.size === 0) return;
        this.broadcast({ type: 'heartbeat', serverTime: new Date().toISOString() });
      }, this.opts.heartbeatMs);
      this.heartbeatTimer.unref?.();
    }
  }

  /** Timers run only while somebody is watching: left running they keep a `bun test`
   * process alive past its assertions and poll the job table forever. */
  private stopTimersIfIdle(): void {
    if (this.clients.size > 0) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
