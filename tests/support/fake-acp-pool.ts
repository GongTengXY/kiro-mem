/**
 * Deterministic, no-subprocess stand-in for `ACPPool`.
 *
 * Tests drive the **production** compressor (`ACPCompressor`) and replace only
 * the transport: `new ACPCompressor({}, new FakeACPPool())`. That keeps the
 * whole production path under test — prompt builder, JSON parse, schema
 * validation, output length bounds, repair retries — while paying nothing for
 * `kiro-cli acp` subprocesses.
 *
 * The predecessor of this file faked a `CompressorProvider` behind a separate
 * test-only `Compressor` class (S3). That class re-implemented the prompt
 * builder and skipped `validateSchema` entirely, so every integration test was
 * exercising a pipeline whose compressor enforced none of the invariants the
 * shipping one does.
 *
 * Structurally typed against `ACPPoolLike` — no cast needed at the call site.
 */

export interface ScriptedResponse {
  /** Exact-match substring on the prompt. First match wins. */
  match: string;
  /** Raw text that the real ACP session would emit. */
  respondWith: string;
}

/**
 * Default response: a schema-valid Observation. A fixture that returns a shape
 * production can never produce makes downstream assertions meaningless.
 */
const DEFAULT_RESPONSE = JSON.stringify({
  title: 'fake observation',
  summary: 'fake summary',
  request: 'fake request',
  outcome: 'fake outcome',
  learned: '',
  next_steps: '',
  memory_type: 'change',
  files_touched: [],
  concepts: [],
  evidence: [],
  importance_score: 0.5,
  confidence_score: 0.5,
  unresolved_score: 0,
});

export class FakeACPPool {
  private scripted: ScriptedResponse[] = [];
  private fallback: string;
  /** Every prompt the compressor sent, including the system preamble. */
  public calls: Array<{ prompt: string }> = [];

  constructor(opts?: { fallback?: string; scripted?: ScriptedResponse[] }) {
    this.fallback = opts?.fallback ?? DEFAULT_RESPONSE;
    if (opts?.scripted) this.scripted = [...opts.scripted];
  }

  script(entry: ScriptedResponse): this {
    this.scripted.push(entry);
    return this;
  }

  setFallback(response: string): this {
    this.fallback = response;
    return this;
  }

  reset() {
    this.calls = [];
    this.scripted = [];
  }

  get stats() {
    return { total: 1, busy: 0, queued: 0, restarts: 0, contaminations: 0 };
  }

  async run(
    prompt: string,
    _opts?: { timeoutMs?: number; maxOutputBytes?: number },
  ): Promise<{ text: string; stopReason?: string }> {
    this.calls.push({ prompt });
    for (const s of this.scripted) {
      if (prompt.includes(s.match)) return { text: s.respondWith, stopReason: 'end_turn' };
    }
    return { text: this.fallback, stopReason: 'end_turn' };
  }

  async close(): Promise<void> {}
}
