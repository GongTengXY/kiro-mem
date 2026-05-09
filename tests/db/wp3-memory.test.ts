import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { MemoryDB } from '../../src/db';
import { Compressor } from '../../src/compressor';
import { JobRunner, extractArtifacts } from '../../src/jobs';
import { FakeCompressorProvider } from '../support/fake-compressor';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;
let fakeProvider: FakeCompressorProvider;

beforeEach(() => {
  db = openInMemoryDB();
  fakeProvider = new FakeCompressorProvider({
    fallback: JSON.stringify({
      title: 'Fix auth token refresh',
      summary: 'Fixed the token refresh logic to use short-lived access tokens',
      request: 'Fix the auth bug',
      investigated: 'Looked at token expiry handling',
      learned: 'Refresh tokens need rotation',
      completed: 'Implemented token rotation',
      next_steps: 'Add tests for edge cases',
      memory_type: 'bugfix',
      files_touched: ['/src/auth.ts'],
      concepts: ['auth', '认证', 'token'],
      topic_candidate: 'auth token refresh',
      importance_score: 0.8,
      confidence_score: 0.9,
      unresolved_score: 0.3,
    }),
  });
});
afterEach(() => { db.close(); });

function setupTurn() {
  db.upsertSessionRef({ session_id: 's1', cwd: '/proj', repo: '/proj' });
  const seq = db.allocateNextTurnSeq('s1');
  const turn = db.createTurn({ session_id: 's1', seq, cwd: '/proj', repo: '/proj', prompt_text: 'fix the auth bug' });
  db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'userPromptSubmit', payload_json: '{"prompt":"fix the auth bug"}' });
  db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'postToolUse', tool_name: 'read', payload_json: JSON.stringify({ tool_input: { path: '/src/auth.ts' }, tool_response: 'code' }) });
  db.appendTurnEvent({ turn_id: turn.id, session_id: 's1', hook_event_name: 'stop', payload_json: '{}' });
  db.markTurnClosed(turn.id);
  return turn;
}

describe('WP3 / summarizeTurn via Compressor', () => {
  test('summarizeTurn returns structured result', async () => {
    const compressor = new Compressor(fakeProvider);
    const result = await compressor.summarizeTurn({
      prompt_text: 'fix the auth bug',
      artifacts: { tool_names: ['read'], files_touched: ['/src/auth.ts'], commands: [], error_signals: [] },
    });
    expect(result.title).toBe('Fix auth token refresh');
    expect(result.memory_type).toBe('bugfix');
    expect(result.importance_score).toBe(0.8);
    expect(fakeProvider.calls.length).toBe(1);
  });

  test('invalid JSON fallback is marked with zero confidence', async () => {
    fakeProvider.setFallback('not valid json');
    const compressor = new Compressor(fakeProvider);

    const result = await compressor.summarizeTurn({
      prompt_text: 'fix the auth bug',
      artifacts: { tool_names: ['read'], files_touched: ['/src/auth.ts'], commands: [], error_signals: [] },
    });

    expect(result.title).toBe('');
    expect(result.confidence_score).toBe(0);
  });
});

describe('WP3 / turn → memory pipeline', () => {
  test('closed turn produces a memory with correct fields', async () => {
    const turn = setupTurn();
    const compressor = new Compressor(fakeProvider);

    // Simulate what the job handler does
    db.setTurnSummarizationState(turn.id, 'running');
    const artifacts = extractArtifacts(db, turn.id);

    const result = await compressor.summarizeTurn({
      prompt_text: turn.prompt_text || '',
      artifacts: {
        tool_names: artifacts.tool_names,
        files_touched: artifacts.files_touched,
        commands: artifacts.commands,
        error_signals: artifacts.error_signals,
      },
    });

    const memoryId = db.insertMemory({
      memory_kind: 'turn',
      repo: turn.repo,
      cwd_scope: turn.cwd,
      title: result.title,
      summary: result.summary,
      request: result.request,
      investigated: result.investigated,
      learned: result.learned,
      completed: result.completed,
      next_steps: result.next_steps,
      memory_type: result.memory_type as any,
      importance_score: result.importance_score,
      confidence_score: result.confidence_score,
      unresolved_score: result.unresolved_score,
      files_touched: result.files_touched,
      concepts: result.concepts,
      source_turn_count: 1,
      first_turn_at: turn.started_at,
      last_turn_at: turn.stopped_at || turn.last_event_at,
    });

    db.linkMemoryToTurn({ memory_id: memoryId, turn_id: turn.id, ordinal: 1 });
    db.setTurnSummarizationState(turn.id, 'ready');

    // Verify memory
    const memory = db.getMemory(memoryId)!;
    expect(memory.title).toBe('Fix auth token refresh');
    expect(memory.memory_kind).toBe('turn');
    expect(memory.memory_type).toBe('bugfix');
    expect(memory.repo).toBe('/proj');
    expect(memory.importance_score).toBe(0.8);

    // Verify link
    const links = db.listMemoryTurnLinks(memoryId);
    expect(links.length).toBe(1);
    expect(links[0]!.turn_id).toBe(turn.id);

    // Verify turn state
    expect(db.getTurn(turn.id)!.summarization_state).toBe('ready');
  });

  test('compression failure does not affect turn preservation', async () => {
    const turn = setupTurn();
    const failProvider = new FakeCompressorProvider({ fallback: 'INVALID JSON {{{{' });
    const compressor = new Compressor(failProvider);

    const artifacts = extractArtifacts(db, turn.id);
    const result = await compressor.summarizeTurn({
      prompt_text: 'fix it',
      artifacts: { tool_names: artifacts.tool_names, files_touched: artifacts.files_touched, commands: [], error_signals: [] },
    });

    // parseJSON returns fallback on invalid JSON
    expect(result.title).toBe('');
    expect(result.memory_type).toBe('change');

    // Turn is still intact
    const t = db.getTurn(turn.id)!;
    expect(t.state).toBe('closed');
    expect(db.listTurnEvents(turn.id).length).toBe(3);
  });

  test('memory is searchable via FTS after insert', () => {
    const turn = setupTurn();

    const memoryId = db.insertMemory({
      memory_kind: 'turn',
      title: 'Fix auth token refresh',
      summary: 'Fixed token rotation',
      memory_type: 'bugfix',
      concepts: ['auth', 'token'],
      first_turn_at: turn.started_at,
      last_turn_at: turn.stopped_at || turn.last_event_at,
    });

    // FTS search
    const rows = db.raw.query("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'token'").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).rowid).toBe(memoryId);
  });
});

describe('WP3 / full job runner integration with fake compressor', () => {
  test('end-to-end: turn close → job → memory created', async () => {
    const turn = setupTurn();
    const compressor = new Compressor(fakeProvider);

    // Enqueue job
    db.enqueueJob({
      job_type: 'summarize_turn',
      dedupe_key: `turn:${turn.id}`,
      payload_json: JSON.stringify({ turn_id: turn.id }),
    });

    // Run with real handler logic
    const runner = new JobRunner(db, { concurrency: 1, pollMs: 50 });
    runner.register('summarize_turn', async (job) => {
      const { turn_id } = JSON.parse(job.payload_json);
      const t = db.getTurn(turn_id);
      if (!t || t.state !== 'closed') return;

      db.setTurnSummarizationState(turn_id, 'running');
      const arts = extractArtifacts(db, turn_id);

      const res = await compressor.summarizeTurn({
        prompt_text: t.prompt_text || '',
        artifacts: { tool_names: arts.tool_names, files_touched: arts.files_touched, commands: arts.commands, error_signals: arts.error_signals },
      });

      const validTypes = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change'];
      const memType = validTypes.includes(res.memory_type) ? res.memory_type : 'change';

      const mid = db.insertMemory({
        memory_kind: 'turn', repo: t.repo, cwd_scope: t.cwd,
        title: res.title || 'Untitled', summary: res.summary || '',
        request: res.request, investigated: res.investigated,
        learned: res.learned, completed: res.completed, next_steps: res.next_steps,
        memory_type: memType as any,
        importance_score: res.importance_score, confidence_score: res.confidence_score,
        unresolved_score: res.unresolved_score,
        files_touched: res.files_touched, concepts: res.concepts,
        first_turn_at: t.started_at, last_turn_at: t.stopped_at || t.last_event_at,
      });
      db.linkMemoryToTurn({ memory_id: mid, turn_id, ordinal: 1 });
      db.setTurnSummarizationState(turn_id, 'ready');
    });

    runner.start();
    await Bun.sleep(250);
    runner.stop();

    // Verify
    expect(db.getTurn(turn.id)!.summarization_state).toBe('ready');
    const memories = db.raw.query("SELECT * FROM memories WHERE memory_kind = 'turn'").all() as any[];
    expect(memories.length).toBe(1);
    expect(memories[0].title).toBe('Fix auth token refresh');

    const links = db.raw.query('SELECT * FROM memory_turn_links').all() as any[];
    expect(links.length).toBe(1);
    expect(links[0].turn_id).toBe(turn.id);
  });
});
