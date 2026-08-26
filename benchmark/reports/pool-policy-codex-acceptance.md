# Candidate-pool round: Codex acceptance

Date: 2026-08-05

## Verdict

**PASS.** Branch B-2 is accepted with `semanticCandidatePool=20000`.

The previously blocking §12.7 confirmation is now complete. Codex independently
constructed and froze 24 zero-FTS relevance queries plus 24 hard negatives on
the frozen 2,000-record Phase 3B fixture before running either semantic arm.
G7, G8, G10, and G5' all pass.

## Accepted decisions

- `Infinity` does not ship. Its 50,000-record real-cosine replay passes latency
  but fails P3 memory: p95 277.35ms, p99 434.00ms, loop RSS +720MB > 512MB.
- Production ships pool 20,000. The final, non-chunked implementation passed
  three consecutive 50,000-record runs:

| run | p95 | p99 | loop RSS delta | process peak | degrade |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 183.39ms | 342.72ms | +461MB | 547MB | 0 |
| 2 | 121.86ms | 302.03ms | +466MB | 593MB | 0 |
| 3 | 169.56ms | 282.64ms | +465MB | 592MB | 0 |

- The 8,192-row chunked production fetch was correctly rolled back under §9.1.
  Only the 65,535/65,536 SQLite parameter-boundary test remains.
- `LEXICAL_ANCHOR_ROLLBACK_POLICY.semanticCandidatePool` remains 200.
- A 20,000 pool is not recall-equivalent to full scope. At 50,000 records it
  leaves 60% outside the recency-selected semantic pool; that loss is unmeasured.

## Independent blind audit

Frozen input SHA-256:
`34a4dd06e632019b1287553a4a989e877c5433bad3f93ca52a33bb8d9e235a25`.

| metric | pool 200 | pool 20,000 |
| --- | ---: | ---: |
| relevance reached | 0 / 24 | 24 / 24 |
| relevance hit@5 | 0.0% | 91.7% |
| relevance MRR | 0.000 | 0.875 |
| hard-negative mean returned | 2.46 | 2.46 |
| hard-negative semantic-only mean / max | 2.00 / 2 | 2.00 / 2 |
| degrade | 0 | 0 |

- G7: PASS, 22 hit@5 improvements and 0 regressions.
- G8: PASS, 2.46 <= relative ceiling 2.96 and absolute ceiling 4.06.
- G10: PASS, semantic-only mean 2.00 <= 2.50 and max 2 <= 2.
- G5': PASS, 0 attribution violations.
- Fixture invariants: PASS, all relevance queries have zero FTS hits and every
  gold target is outside the most recent 200 records.

The input, freeze record, per-query candidate/result evidence, and mechanical
runner are in `benchmark/reports/pool-policy/codex-blind-audit-*` and
`benchmark/run-codex-pool-audit.ts`.

## Verification

- `bun test`: 517 pass, 0 fail.
- `bun run typecheck`: pass.
- `git diff --check`: pass.
- Static review confirms the production default is 20,000, the rollback profile
  is 200, embedding fetch is a single SQL statement, and chunk-only tests/code
  were removed while the SQLite ceiling guard remains.

## Non-blocking cleanup

These do not change the acceptance verdict, but should be corrected in Kiro's
next documentation-only edit:

1. `src/server/observation-search.ts` and the submission headline still cite the
   rolled-back chunked implementation's pool-20,000 reading (p95 183.15ms,
   p99 300.24ms, +384MB). The shipped non-chunked evidence is the three-run table
   above.
2. `benchmark/run-phase2d-grid.ts`, `benchmark/run-phase3a-grid.ts`, and
   `benchmark/run-phase3a-r2-grid.ts` still say the shipped default changed to
   `Infinity`; it changed to 20,000. Their guard behavior is correct, only the
   comments and error text are stale.
3. `tests/integration/retrieval-policy.test.ts` names the product-change group
   "full scope scoring" although the shipped behavior is a finite 20,000 pool.
4. `pool-policy-submission.md` still says the Codex §12.7 audit is missing. This
   acceptance report and its frozen audit artifacts supersede that status.

## Follow-up boundary

Phase 3C should not widen the default time window before a separate bounded
streaming scorer (chunked read, immediate scoring, bounded Top-K) raises the
current memory/scale ceiling. That work is outside this accepted round.
