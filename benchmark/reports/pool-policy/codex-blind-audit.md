# Codex pool-policy blind audit

Result: **PASS**

- frozen input SHA-256: `34a4dd06e632019b1287553a4a989e877c5433bad3f93ca52a33bb8d9e235a25`
- fixture filler SHA-16: `10b572bd3ec7e4b9`
- queries: 24 zero-FTS relevance + 24 hard-negative
- pool 200: reached 0/24, hit@5 0.0%, hard-negative mean 2.46, semantic-only mean/max 2.00/2
- pool 20000: reached 24/24, hit@5 91.7%, hard-negative mean 2.46, semantic-only mean/max 2.00/2

## Gates

- G7: PASS (22 improved vs 0 regressed)
- G8: PASS (2.46 <= relative 2.96 and absolute 4.06)
- G10: PASS (mean 2.00 <= 2.50, max 2 <= 2)
- G5': PASS (0 violations)
- invariants: PASS (degrade 0/0)

The JSON report contains every candidate set, result id, source, and gold rank for independent recomputation.
