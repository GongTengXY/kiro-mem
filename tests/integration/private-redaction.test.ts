/**
 * P0-1: `<private>` redaction must fail closed.
 *
 * The old regex only matched well-formed `<private>…</private>` pairs, so an
 * unterminated tag wrote the secret verbatim into the append-only Truth Layer.
 * These tests pin the scanner behaviour and assert every write path (prompt,
 * postToolUse, stop) plus the raw `turn_events` rows stay clean.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp, redactPrivate } from '../../src/server/worker';
import { MemoryDB } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';
import { ACPCompressor } from '../../src/acp/compressor';
import { FakeACPPool } from '../support/fake-acp-pool';
import { loadConfig } from '../../src/config';
import type { Hono } from 'hono';

const SECRET = 'PRIVATE_LEAK_MARKER_4c81';

describe('redactPrivate (fail-closed scanner)', () => {
  test('redacts a well-formed pair', () => {
    expect(redactPrivate(`a<private>${SECRET}</private>b`)).toBe('a[REDACTED]b');
  });

  test('an unterminated tag redacts to the end of the string', () => {
    expect(redactPrivate(`keep <private>${SECRET} and more`)).toBe('keep [REDACTED]');
  });

  test('nested tags do not let the inner close end the outer block', () => {
    const input = `<private>outer ${SECRET} <private>inner</private> tail ${SECRET}</private>after`;
    expect(redactPrivate(input)).toBe('[REDACTED]after');
  });

  test('an unterminated nested tag still redacts to the end', () => {
    expect(redactPrivate(`<private>a<private>${SECRET}</private>`)).toBe('[REDACTED]');
  });

  test('tag matching is case-insensitive', () => {
    expect(redactPrivate(`<PRIVATE>${SECRET}</Private>x`)).toBe('[REDACTED]x');
    expect(redactPrivate(`<Private>${SECRET}`)).toBe('[REDACTED]');
  });

  test('multiple blocks each collapse to one marker', () => {
    expect(redactPrivate(`<private>${SECRET}</private>mid<private>${SECRET}</private>`))
      .toBe('[REDACTED]mid[REDACTED]');
  });

  test('multi-line content inside a block is redacted', () => {
    expect(redactPrivate(`<private>line1\n${SECRET}\nline3</private>tail`)).toBe('[REDACTED]tail');
  });

  test('a stray closing tag is kept literally and carries no secret', () => {
    expect(redactPrivate('nothing </private> here')).toBe('nothing </private> here');
  });

  test('text without any tag is untouched', () => {
    expect(redactPrivate('plain text <notprivate>x</notprivate>')).toBe('plain text <notprivate>x</notprivate>');
  });
});

describe('unterminated <private> never reaches storage', () => {
  let db: MemoryDB;
  let app: Hono;

  beforeEach(() => {
    db = openInMemoryDB();
    const compressor = new ACPCompressor({}, new FakeACPPool());
    const config = loadConfig();
    ({ app } = createApp({ db, compressor, config, enableEmbeddings: false, enableAuth: false }));
  });

  afterEach(() => { db.close(); });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  test('prompt path: unterminated tag is redacted in prompt_text and raw events', async () => {
    await post('/events/prompt', {
      session_id: 'S1',
      cwd: '/tmp/p0-1',
      prompt: `deploy help <private>${SECRET}`,
    });

    const turn = db.getOpenTurnBySession('S1')!;
    expect(turn.prompt_text).toBe('deploy help [REDACTED]');

    const dump = JSON.stringify(db.listTurnEvents(turn.id));
    expect(dump).not.toContain(SECRET);
  });

  test('postToolUse path: unterminated tag in tool_response is redacted', async () => {
    await post('/events/prompt', { session_id: 'S2', cwd: '/tmp/p0-1', prompt: 'task' });
    await post('/events/observation', {
      session_id: 'S2',
      tool_name: 'shell',
      tool_input: { command: 'cat secrets' },
      tool_response: `stdout: <private>${SECRET}`,
    });

    const turn = db.getOpenTurnBySession('S2')!;
    const dump = JSON.stringify(db.listTurnEvents(turn.id));
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain('[REDACTED]');
  });

  test('stop path: unterminated tag in assistant_response is redacted', async () => {
    await post('/events/prompt', { session_id: 'S3', cwd: '/tmp/p0-1', prompt: 'task' });
    const turnId = db.getOpenTurnBySession('S3')!.id;
    await post('/events/stop', {
      session_id: 'S3',
      assistant_response: `done. <private>${SECRET}`,
    });

    const events = db.listTurnEvents(turnId);
    const stopEvent = events.find((e) => e.hook_event_name === 'stop')!;
    expect(stopEvent.payload_json).not.toContain(SECRET);
    expect(stopEvent.payload_json).toContain('[REDACTED]');
  });

  test('nested tags in a tool payload do not leak the outer tail', async () => {
    await post('/events/prompt', { session_id: 'S4', cwd: '/tmp/p0-1', prompt: 'task' });
    await post('/events/observation', {
      session_id: 'S4',
      tool_name: 'read',
      tool_input: {},
      tool_response: `<private>a<private>b</private>${SECRET}</private>visible`,
    });

    const turn = db.getOpenTurnBySession('S4')!;
    const dump = JSON.stringify(db.listTurnEvents(turn.id));
    expect(dump).not.toContain(SECRET);
    expect(dump).toContain('visible');
  });
});
