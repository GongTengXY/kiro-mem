/**
 * Viewer SSE hub (plan §8).
 *
 * Native `EventSource` cannot set an Authorization header, so the Viewer opens
 * the stream with `fetch` and reads the body itself. That is why this is a POST
 * route producing `text/event-stream`: the scope selection travels in the body
 * and the bearer token in a header, neither of them in a URL that would land in
 * an access log.
 *
 * Every event carries its `scopeKey`. A single-scope client filters again before
 * merging, but the filter here is the one that decides what leaves the process.
 */

import type { ViewerQueueStatus, ViewerStreamEvent } from './viewer-types';

/** Heartbeat cadence. Below the 30s a proxy or browser may silently reap at. */
const HEARTBEAT_MS = 20_000;
/** Queue polling for `processing_status`; the plan caps the event at 1/s. */
const QUEUE_POLL_MS = 1000;
/**
 * Per-client queue of pending frames. A tab that stops reading (backgrounded,
 * suspended laptop) must not become unbounded memory in the Worker; past this
 * the connection is dropped and the client reconnects with fresh state.
 */
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

  /**
   * Build the SSE response for one client.
   *
   * `initial_state` goes to this connection only — broadcasting it would make
   * every already-open tab reset its state because a new tab appeared.
   */
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

        // A comment frame first: it opens the stream for the browser without
        // being delivered as an application event.
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

  /**
   * Fan out one event. Skipped entirely when nobody is connected, so the write
   * paths that call this never pay for payload construction on an idle Worker.
   */
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
        // Only on change, and at most once per poll interval — a Worker chewing
        // through a backlog must not turn into a per-job SSE storm.
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

  /**
   * Timers exist only while somebody is watching. Started unconditionally they
   * would keep a `bun test` process alive after the assertions finished, and
   * would poll the job table forever on a Worker nobody has a Viewer open on.
   */
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
