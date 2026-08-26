# Codex Top-K blind audit

Result: **PASS**

- Frozen input SHA-256: `9048d05c57c5aa09440f17216b1fd034cbe75b478cd78c225399948f5648157c`
- Fixture filler SHA-256/16: `10b572bd3ec7e4b9`
- Queries: 26 zero-FTS relevance + 26 hard-negative
- Arms: pool 200 / no K; pool Infinity / no K reference; pool Infinity / K=1000 final

## Relevance

- Baseline: reached 0/26, hit@5 0.0%
- Reference: reached 26/26, hit@5 84.6%
- Final: reached 26/26, hit@5 84.6%

## Hard negatives

- Baseline: mean returned 2.81, semantic-only mean/max 1.77/2
- Final: mean returned 2.88, semantic-only mean/max 1.85/2

## Gates

- G5': PASS (0 unexplained additions, 0 cap violations)
- G6': PASS (0 page differences vs full-scoring reference, 0 source differences)
- G7: PASS (22 improved vs 0 regressed)
- G8: PASS (2.88 <= relative 3.31 and absolute 4.06)
- G10: PASS (mean 1.85 <= 2.27, max 2 <= 2)
- Invariants: PASS (degrade 0/0/0)

Machine-readable detail: `/Users/lixinjie/LXJSpace/kiro-memory/benchmark/reports/topk/codex-blind-audit.json`
