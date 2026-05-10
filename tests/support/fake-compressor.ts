/**
 * Deterministic, no-network CompressorProvider replacement for tests.
 *
 * The real `Compressor` in `src/compressor.ts` hides behind an
 * `CompressorProvider` interface that returns raw JSON strings. Tests can plug
 * this `FakeCompressorProvider` in via `new Compressor(fakeProvider)` and
 * assert on compression pipeline behavior without paying for or flaking on
 * LLM calls.
 *
 * WP3+ will extend `Compressor` with `summarizeTurn()` / `mergeTurnMemories()`
 * / `normalizeTopic()`. Each of those will look up a scripted response on this
 * provider by a stable key; see `script()` below.
 */

import type { CompressorProvider } from '../../src/compressor';

export interface ScriptedResponse {
  /** Exact-match substring on the USER prompt. First match wins. */
  match: string;
  /** Raw JSON string that the real LLM would return. */
  respondWith: string;
}

export class FakeCompressorProvider implements CompressorProvider {
  private scripted: ScriptedResponse[] = [];
  private fallback: string;
  public calls: Array<{ system: string; prompt: string }> = [];

  constructor(opts?: { fallback?: string; scripted?: ScriptedResponse[] }) {
    this.fallback =
      opts?.fallback ??
      JSON.stringify({
        title: 'fake',
        narrative: 'fake narrative',
        facts: [],
        concepts: [],
        type: 'change',
        files: [],
      });
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

  async compress(system: string, prompt: string): Promise<string> {
    this.calls.push({ system, prompt });
    for (const s of this.scripted) {
      if (prompt.includes(s.match)) return s.respondWith;
    }
    return this.fallback;
  }
}
