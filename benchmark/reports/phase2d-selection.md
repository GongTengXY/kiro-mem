# 阶段 2D arm 选择（确定性计算）

> 生成时间：2026-08-03T12:52:29.451Z
> 输入：`/Users/lixinjie/LXJSpace/kiro-memory/benchmark/reports/phase2d/grid.json`
> 判据：`benchmark/reports/phase2d-criteria.md` D1–D4（Gate D 反馈后的修订版，附录 A4）

## 精确平局集（实测，非推断）

基线运行里结果页内存在精确平局的 query 共 **9** 条：
`q02`、`q03`、`q06`、`q07`、`q10`、`q14`、`q15`、`q16`、`q20`

来源是内核 `onFusion` 报出的**实际融合分**按 float64 `===` 分组——与比较器里
那一行是同一个比较。页外深处的平局不计入：它不影响任何指标。

辅助诊断 `diag-wsem-epsilon`（w_sem=1+ε）改动 5 条：`q02`、`q03`、`q10`、`q14`、`q20`；全部落在平局集内（本轮它与实测一致，但这是读数，不是它可靠的证明）。

## 全部候选 arm

| arm | 自变量 | 改动 | D1a 不越界 | D1b 有解决 | D2 锁 | D3 保守扩展 | 可行 | 失败原因 |
| --- | --- | ---: | :--: | :--: | :--: | :--: | :--: | --- |
| `tb-source-confidence` | tieBreak | 3 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `tb-semantic-rank` | tieBreak | 5 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `k30-wsem1` | rrfK=30 w_sem=1 | 0 | ✅ | ❌ | ✅ | ❌ | ❌ | 一条平局都没解决；与方案登记的 source-confidence 结论冲突 |
| `k30-wsem1.1` | rrfK=30 w_sem=1.1 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k30-wsem1.25` | rrfK=30 w_sem=1.25 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k30-wsem1.5` | rrfK=30 w_sem=1.5 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k60-wsem1` | rrfK=60 w_sem=1 | 0 | ✅ | ❌ | ✅ | ❌ | ❌ | 一条平局都没解决；与方案登记的 source-confidence 结论冲突 |
| `k60-wsem1.1` | rrfK=60 w_sem=1.1 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k60-wsem1.25` | rrfK=60 w_sem=1.25 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k60-wsem1.5` | rrfK=60 w_sem=1.5 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k90-wsem1` | rrfK=90 w_sem=1 | 0 | ✅ | ❌ | ✅ | ❌ | ❌ | 一条平局都没解决；与方案登记的 source-confidence 结论冲突 |
| `k90-wsem1.1` | rrfK=90 w_sem=1.1 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k90-wsem1.25` | rrfK=90 w_sem=1.25 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |
| `k90-wsem1.5` | rrfK=90 w_sem=1.5 | 9 | ❌ | ✅ | ✅ | ✅ | ❌ | 越界改动非平局 query：q04,q11,q13 |

## D4 顺位（解决更多平局者优先）

| # | arm | 解决的平局 query | tuned MRR | tuned R-prec |
| ---: | --- | ---: | ---: | ---: |
| 1 | `tb-semantic-rank` | 5 / 9（q02,q03,q10,q14,q20） | 0.944 | 88.9% |
| 2 | `tb-source-confidence` | 3 / 9（q02,q10,q20） | 0.889 | 83.3% |

## 选中：`tb-semantic-rank`

| 项 | 值 |
| --- | --- |
| semanticDiscovery | `true` |
| semanticFloor | `0.197` |
| semanticOnlyLimit | `2` |
| rrfK | `60` |
| ftsWeight | `1` |
| semanticWeight | `1` |
| tieBreak | `"semantic-rank"` |
| 行为改动 | 5 / 145，全部落在平局集内 |
| 解决的平局 query | 5 / 9 |

**"解决"是可见口径，会低估**：一条平局 query 上，规则按证据判出的次序也可能
恰好与 recency 相同，那样它不进改动集，但平局确实不再由时间戳决定。低估对结论
是安全的——胜出者的改动集是次优者的超集（D3 已断言），所以真实覆盖只会更大。

