/**
 * Viewer SSE hub (plan §8).
 *
 * The isolation claim is specific: `initial_state` belongs to the connection that
 * just opened, and must NOT be broadcast — otherwise opening a second tab would
 * reset the first one's state.
 */

import { describe, test, expect } from 'bun:test';
import { ViewerStreamHub } from '../../src/server/viewer-stream';
import type { ViewerQueueStatus } from '../../src/server/viewer-types';

const QUEUE: ViewerQueueStatus = { pending: 1, leased: 0, dead: 0, succeeded24h: 4 };

/** Collect whatever a client has received so far. */
async function drain(res: Response, ms = 30): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise<null>((r) => setTimeout(() => r(null), 10)),
    ]);
    if (!race || race.done) break;
    text += decoder.decode(race.value);
  }
  void reader.cancel();
  return text;
}

describe('ViewerStreamHub', () => {
  test('initial_state reaches only the new connection', async () => {
    const hub = new ViewerStreamHub({ queueStatus: () => QUEUE, heartbeatMs: 10_000, queuePollMs: 10_000 });
    const first = hub.connect({ scopeKey: '/proj/a', allScopes: false });
    // Give the first client something to distinguish, then open a second one.
    hub.broadcast({ type: 'observation_created', scopeKey: '/proj/a', observationId: 7 });
    const second = hub.connect({ scopeKey: '/proj/a', allScopes: false });

    const firstText = await drain(first);
    const secondText = await drain(second);

    // Count the `event:` line, not the substring: the type name also appears
    // inside the JSON payload of the same frame.
    expect(firstText.match(/event: initial_state/g)?.length).toBe(1);
    expect(secondText.match(/event: initial_state/g)?.length).toBe(1);
    expect(firstText).toContain('"observationId":7');
    // The second client connected after that event and must not be replayed it.
    expect(secondText).not.toContain('"observationId":7');
    hub.closeAll();
  });

  test('a single-scope client is not sent another workspace\'s events', async () => {
    const hub = new ViewerStreamHub({ queueStatus: () => QUEUE, heartbeatMs: 10_000, queuePollMs: 10_000 });
    const scoped = hub.connect({ scopeKey: '/proj/a', allScopes: false });
    const global = hub.connect({ scopeKey: null, allScopes: true });

    hub.broadcast({ type: 'observation_deleted', scopeKey: '/proj/b', observationId: 99, turnId: 5 });
    hub.broadcast({ type: 'observation_deleted', scopeKey: '/proj/a', observationId: 11, turnId: 6 });

    const scopedText = await drain(scoped);
    const globalText = await drain(global);

    expect(scopedText).not.toContain('"observationId":99');
    expect(scopedText).toContain('"observationId":11');
    expect(globalText).toContain('"observationId":99');
    expect(globalText).toContain('"observationId":11');
    hub.closeAll();
  });

  test('scope-less events (queue status) reach every client', async () => {
    const hub = new ViewerStreamHub({ queueStatus: () => QUEUE, heartbeatMs: 10_000, queuePollMs: 10_000 });
    const a = hub.connect({ scopeKey: '/proj/a', allScopes: false });
    const b = hub.connect({ scopeKey: '/proj/b', allScopes: false });
    hub.broadcast({ type: 'processing_status', queue: { pending: 3, leased: 1, dead: 0, succeeded24h: 9 } });

    expect(await drain(a)).toContain('"pending":3');
    expect(await drain(b)).toContain('"pending":3');
    hub.closeAll();
  });

  test('broadcasting with no clients is a no-op and never reads the queue', () => {
    let reads = 0;
    const hub = new ViewerStreamHub({
      queueStatus: () => { reads++; return QUEUE; },
      heartbeatMs: 10_000,
      queuePollMs: 10_000,
    });
    hub.broadcast({ type: 'observation_created', scopeKey: '/proj/a', observationId: 1 });
    expect(hub.clientCount).toBe(0);
    // An idle Worker must not be polling the job table for a Viewer nobody opened.
    expect(reads).toBe(0);
  });

  test('closeAll releases every client so timers can stop', async () => {
    const hub = new ViewerStreamHub({ queueStatus: () => QUEUE, heartbeatMs: 10_000, queuePollMs: 10_000 });
    const res = hub.connect({ scopeKey: '/proj/a', allScopes: false });
    expect(hub.clientCount).toBe(1);
    hub.closeAll();
    expect(hub.clientCount).toBe(0);
    // The stream is finished rather than left hanging.
    const reader = res.body!.getReader();
    let done = false;
    for (let i = 0; i < 5 && !done; i++) {
      const chunk = await reader.read();
      done = chunk.done;
    }
    expect(done).toBe(true);
  });
});
