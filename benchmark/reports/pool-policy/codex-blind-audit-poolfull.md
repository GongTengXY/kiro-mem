# Codex Gate B audit

Input: `/Users/lixinjie/LXJSpace/kiro-memory/benchmark/reports/phase2b-codex-blind-audit-input.json`
Input SHA-256: `dc9a0ba59f1e6d638d71aed775e075da52eb0beda566678a77a88e58832f44e5`
Policy: discovery=on floor=0.197 cap=2 rrfK=60 weights=1:1 tie=recency

- relevance: 20
- relevance hit@5: 100.0%
- relevance MRR: 1.000
- empty: 20, mean/worst returned: 0.30 / 2
- all FTS counts zero: yes
- max semantic-only returned: 2

## Per-query results

| id | kind | fts | semantic | returned | rank | results (id/source/score) |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| cb-r01 | relevance | 0 | 4 | 2 | 1 | [{"id":7,"match_source":"semantic","semantic_score":0.4985618305900009},{"id":2,"match_source":"semantic","semantic_score":0.33438642526565154}] |
| cb-r02 | relevance | 0 | 12 | 2 | 1 | [{"id":8,"match_source":"semantic","semantic_score":0.4441027833055066},{"id":4,"match_source":"semantic","semantic_score":0.4235342300994459}] |
| cb-r03 | relevance | 0 | 9 | 2 | 1 | [{"id":9,"match_source":"semantic","semantic_score":0.4149487675029967},{"id":12,"match_source":"semantic","semantic_score":0.3945405810822875}] |
| cb-r04 | relevance | 0 | 8 | 2 | 1 | [{"id":10,"match_source":"semantic","semantic_score":0.6136670251124482},{"id":5,"match_source":"semantic","semantic_score":0.36684614847512187}] |
| cb-r05 | relevance | 0 | 3 | 2 | 1 | [{"id":11,"match_source":"semantic","semantic_score":0.5425065532559015},{"id":19,"match_source":"semantic","semantic_score":0.2865881596524813}] |
| cb-r06 | relevance | 0 | 16 | 2 | 1 | [{"id":12,"match_source":"semantic","semantic_score":0.5395369988467966},{"id":15,"match_source":"semantic","semantic_score":0.33127119172173247}] |
| cb-r07 | relevance | 0 | 13 | 2 | 1 | [{"id":13,"match_source":"semantic","semantic_score":0.596318882849914},{"id":14,"match_source":"semantic","semantic_score":0.41794036102067295}] |
| cb-r08 | relevance | 0 | 14 | 2 | 1 | [{"id":14,"match_source":"semantic","semantic_score":0.5732729367449596},{"id":19,"match_source":"semantic","semantic_score":0.37990308871578277}] |
| cb-r09 | relevance | 0 | 17 | 2 | 1 | [{"id":15,"match_source":"semantic","semantic_score":0.5086551544306721},{"id":5,"match_source":"semantic","semantic_score":0.4016022126818383}] |
| cb-r10 | relevance | 0 | 11 | 2 | 1 | [{"id":16,"match_source":"semantic","semantic_score":0.5872027319503332},{"id":19,"match_source":"semantic","semantic_score":0.3873093185831338}] |
| cb-r11 | relevance | 0 | 16 | 2 | 1 | [{"id":17,"match_source":"semantic","semantic_score":0.6456078801988961},{"id":20,"match_source":"semantic","semantic_score":0.40911668552268143}] |
| cb-r12 | relevance | 0 | 7 | 2 | 1 | [{"id":18,"match_source":"semantic","semantic_score":0.6380963696074465},{"id":23,"match_source":"semantic","semantic_score":0.29727367028638896}] |
| cb-r13 | relevance | 0 | 13 | 2 | 1 | [{"id":19,"match_source":"semantic","semantic_score":0.5094869028618577},{"id":3,"match_source":"semantic","semantic_score":0.4335401545349343}] |
| cb-r14 | relevance | 0 | 2 | 2 | 1 | [{"id":20,"match_source":"semantic","semantic_score":0.6617254843287635},{"id":21,"match_source":"semantic","semantic_score":0.27988805561222696}] |
| cb-r15 | relevance | 0 | 3 | 2 | 1 | [{"id":21,"match_source":"semantic","semantic_score":0.5208504629860946},{"id":10,"match_source":"semantic","semantic_score":0.19939999341542997}] |
| cb-r16 | relevance | 0 | 16 | 2 | 1 | [{"id":22,"match_source":"semantic","semantic_score":0.5915097885514383},{"id":18,"match_source":"semantic","semantic_score":0.35855999187830845}] |
| cb-r17 | relevance | 0 | 4 | 2 | 1 | [{"id":23,"match_source":"semantic","semantic_score":0.5843435618591496},{"id":2,"match_source":"semantic","semantic_score":0.2983213945297067}] |
| cb-r18 | relevance | 0 | 8 | 2 | 1 | [{"id":24,"match_source":"semantic","semantic_score":0.6203079975028737},{"id":18,"match_source":"semantic","semantic_score":0.27884056238638705}] |
| cb-r19 | relevance | 0 | 6 | 2 | 1 | [{"id":25,"match_source":"semantic","semantic_score":0.47339124677272937},{"id":11,"match_source":"semantic","semantic_score":0.39936861786853795}] |
| cb-r20 | relevance | 0 | 6 | 2 | 1 | [{"id":26,"match_source":"semantic","semantic_score":0.6310450702640553},{"id":17,"match_source":"semantic","semantic_score":0.31964435218620135}] |
| cb-e01 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e02 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e03 | empty | 0 | 3 | 2 | 0 | [{"id":2,"match_source":"semantic","semantic_score":0.2122106177444808},{"id":3,"match_source":"semantic","semantic_score":0.20851196284492876}] |
| cb-e04 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e05 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e06 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e07 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e08 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e09 | empty | 0 | 3 | 2 | 0 | [{"id":2,"match_source":"semantic","semantic_score":0.2693260924928812},{"id":18,"match_source":"semantic","semantic_score":0.2272940494635904}] |
| cb-e10 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e11 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e12 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e13 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e14 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e15 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e16 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e17 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e18 | empty | 0 | 0 | 0 | 0 | [] |
| cb-e19 | empty | 0 | 5 | 2 | 0 | [{"id":15,"match_source":"semantic","semantic_score":0.28845488079894843},{"id":19,"match_source":"semantic","semantic_score":0.2747424953461261}] |
| cb-e20 | empty | 0 | 0 | 0 | 0 | [] |
