# Codex Gate B audit

Input: `/Users/lixinjie/LXJSpace/kiro-memory/benchmark/reports/phase2b-codex-audit-input.json`
Policy: discovery=on floor=0.197 cap=2 rrfK=60 weights=1:1 tie=recency

- relevance: 20
- relevance hit@5: 90.0%
- relevance MRR: 0.825
- empty: 20, mean/worst returned: 0.45 / 2
- all FTS counts zero: yes
- max semantic-only returned: 2

## Per-query results

| id | kind | fts | semantic | returned | rank | results (id/source/score) |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| ca-r01 | relevance | 0 | 1 | 1 | 1 | [{"id":1,"match_source":"semantic","semantic_score":0.5292210677237186}] |
| ca-r02 | relevance | 0 | 6 | 2 | 1 | [{"id":2,"match_source":"semantic","semantic_score":0.3375465259034033},{"id":21,"match_source":"semantic","semantic_score":0.33038906378853317}] |
| ca-r03 | relevance | 0 | 4 | 2 | 1 | [{"id":3,"match_source":"semantic","semantic_score":0.49253241424787886},{"id":19,"match_source":"semantic","semantic_score":0.33233579294250637}] |
| ca-r04 | relevance | 0 | 7 | 2 | 1 | [{"id":4,"match_source":"semantic","semantic_score":0.32048669439699107},{"id":8,"match_source":"semantic","semantic_score":0.28672122534556316}] |
| ca-r05 | relevance | 0 | 3 | 2 | 1 | [{"id":5,"match_source":"semantic","semantic_score":0.37102335318491075},{"id":15,"match_source":"semantic","semantic_score":0.32396562387711253}] |
| ca-r06 | relevance | 0 | 7 | 2 | 1 | [{"id":6,"match_source":"semantic","semantic_score":0.28302029487925967},{"id":22,"match_source":"semantic","semantic_score":0.26321637436602074}] |
| ca-r07 | relevance | 0 | 6 | 2 | 1 | [{"id":7,"match_source":"semantic","semantic_score":0.4565505751611127},{"id":3,"match_source":"semantic","semantic_score":0.24317286871664257}] |
| ca-r08 | relevance | 0 | 10 | 2 | 1 | [{"id":8,"match_source":"semantic","semantic_score":0.3359346104958792},{"id":17,"match_source":"semantic","semantic_score":0.3271354086454155}] |
| ca-r09 | relevance | 0 | 14 | 2 | 1 | [{"id":9,"match_source":"semantic","semantic_score":0.4980568417898912},{"id":15,"match_source":"semantic","semantic_score":0.43342447178803545}] |
| ca-r10 | relevance | 0 | 2 | 2 | 1 | [{"id":10,"match_source":"semantic","semantic_score":0.46713298739283793},{"id":22,"match_source":"semantic","semantic_score":0.20265161286566638}] |
| ca-r11 | relevance | 0 | 4 | 2 | 1 | [{"id":11,"match_source":"semantic","semantic_score":0.5368084815334406},{"id":19,"match_source":"semantic","semantic_score":0.2529759818856308}] |
| ca-r12 | relevance | 0 | 13 | 2 | 1 | [{"id":12,"match_source":"semantic","semantic_score":0.4326178115409167},{"id":4,"match_source":"semantic","semantic_score":0.33468353723309535}] |
| ca-r13 | relevance | 0 | 8 | 2 | 0 | [{"id":19,"match_source":"semantic","semantic_score":0.36050051902674546},{"id":3,"match_source":"semantic","semantic_score":0.3262937659909653}] |
| ca-r14 | relevance | 0 | 11 | 2 | 1 | [{"id":14,"match_source":"semantic","semantic_score":0.4066482243250543},{"id":15,"match_source":"semantic","semantic_score":0.3438501880309852}] |
| ca-r15 | relevance | 0 | 10 | 2 | 1 | [{"id":15,"match_source":"semantic","semantic_score":0.3144929377890058},{"id":5,"match_source":"semantic","semantic_score":0.28332803690128516}] |
| ca-r16 | relevance | 0 | 15 | 2 | 2 | [{"id":19,"match_source":"semantic","semantic_score":0.41664830586412976},{"id":16,"match_source":"semantic","semantic_score":0.4145752973397704}] |
| ca-r17 | relevance | 0 | 6 | 2 | 2 | [{"id":2,"match_source":"semantic","semantic_score":0.3084802611437471},{"id":17,"match_source":"semantic","semantic_score":0.2526177826352951}] |
| ca-r18 | relevance | 0 | 1 | 1 | 0 | [{"id":20,"match_source":"semantic","semantic_score":0.20115871228420804}] |
| ca-r19 | relevance | 0 | 12 | 2 | 2 | [{"id":4,"match_source":"semantic","semantic_score":0.471558323024618},{"id":19,"match_source":"semantic","semantic_score":0.4690280430642494}] |
| ca-r20 | relevance | 0 | 6 | 2 | 1 | [{"id":20,"match_source":"semantic","semantic_score":0.3372200420904522},{"id":7,"match_source":"semantic","semantic_score":0.3029117332488799}] |
| ca-e01 | empty | 0 | 2 | 2 | 0 | [{"id":7,"match_source":"semantic","semantic_score":0.24267968342472077},{"id":8,"match_source":"semantic","semantic_score":0.22851865293739232}] |
| ca-e02 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e03 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e04 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e05 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e06 | empty | 0 | 1 | 1 | 0 | [{"id":2,"match_source":"semantic","semantic_score":0.25829583536901857}] |
| ca-e07 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e08 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e09 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e10 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e11 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e12 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e13 | empty | 0 | 1 | 1 | 0 | [{"id":2,"match_source":"semantic","semantic_score":0.26449640715122175}] |
| ca-e14 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e15 | empty | 0 | 1 | 1 | 0 | [{"id":21,"match_source":"semantic","semantic_score":0.21179874436596258}] |
| ca-e16 | empty | 0 | 2 | 2 | 0 | [{"id":26,"match_source":"semantic","semantic_score":0.23291807987995494},{"id":2,"match_source":"semantic","semantic_score":0.2066440683319277}] |
| ca-e17 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e18 | empty | 0 | 4 | 2 | 0 | [{"id":4,"match_source":"semantic","semantic_score":0.3495860931712972},{"id":11,"match_source":"semantic","semantic_score":0.22806455313643517}] |
| ca-e19 | empty | 0 | 0 | 0 | 0 | [] |
| ca-e20 | empty | 0 | 0 | 0 | 0 | [] |
