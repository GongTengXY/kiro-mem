# Phase 3C 阶段一：放宽默认时间窗的行为中立性 —— **通过**

> 判据：`benchmark/reports/phase3c-criteria.md`，A0 `366ce756b0d6ebd0`，
> 冻结于 `2026-08-06T12:10:40Z`，**先于任何实现改动与任何测量**。
>
> 这份报告只回答一个问题：在**记录全部落在 90 天窗内**的现有装置上，去掉时间窗是否
> 改变了任何返回。判据 §6.1 要求逐位一致，因为那些装置里根本没有窗外的记录，
> 数学上不该有任何差异——有差异就说明改动碰到了时间窗以外的东西。
>
> 它**不是**本轮的正面证据。正面证据在 `phase3c-boundary.md`。

---

## 1. 门槛判定

| # | 门槛 | 读数 | 判定 |
| --- | --- | --- | :--: |
| N1 | 30 条 gold 语料 239 条 query 有序 `resultIds` | 差异 **0/239** | ✅ |
| N2 | 全部 summary 指标 + 17 个 gate | `summaryMetrics` 差异 0；`retrievalMetrics` 仅 `latencyP50/P95` 变动；17 个 gate ok 状态逐条一致，`allGatesOk` 均为 true | ✅ |
| N3 | 2,000 条装置 276 条 query 有序 `resultIds` | 差异 **0/276** | ✅ |
| N4 | `semanticRank` / `semanticScore` / `comparableVectors` | 逐 query 相同（gold 侧 41 个字段零差异；2,000 条装置侧 16 个字段零差异，含 `comparableVectors`） | ✅ |
| N5 | 跨 scope 泄漏 / 协议混排 / `semanticOnlyMax` | **0 / 0 / 2** | ✅ |
| N6 | `bun test` + `bun run typecheck` | **530 pass / 0 fail**；干净 | ✅ |

机器可读产物：`phase3c-identity-diff.json`（gold）、`phase3c-recall-diff.json`（2,000 条装置）。

## 2. 比对口径，以及哪些字段被排除

gold 侧比对了 `queryRows` 的 **41 个字段**（`latencyMs` 除外），包括 `resultIds`、`ranks`、
`matchSources`、`semanticRank`、`ftsRank`、`ftsCount`、`semanticCount`、`returned`、
`hitAt5`/`hitAt10`、`rPrecision`、`reciprocalRank`、`semanticOnlyReturned`/`Dropped`、
`exactTiePairs`、`leaked`、`protocol`、`degraded`、`discoveryRequested`/`Effective`
以及 5 个 bigram 字段。**没有一个字段出现差异。**

排除项只有计时：`latencyMs`、`latencyP50`、`latencyP95`，以及两个 latency 类 gate 的
**value**（它们的 ok 状态仍然要求一致，实测一致）。这个排除沿用 phase 2A §6.3 的既有先例
「除 p50/p95 外所有既有指标一致」，不是本轮新开的口子。实际变动：

| 读数 | 基线 | 本轮 |
| --- | ---: | ---: |
| `latencyP50` | 1.827ms | 1.969ms |
| `latencyP95` | 3.903ms | 3.971ms |
| gate「search p95 < 300ms」 | 3.9ms ✅ | 4.0ms ✅ |
| gate「bootstrap 构建 < 100ms」 | 12.9ms / 3096B ✅ | 12.3ms / 3096B ✅ |

## 3. 基线是什么，以及为什么它是对的参照物

| 装置 | 基线文件 | 为什么它是"改动前" |
| --- | --- | --- |
| 30 条 gold（239 query） | `topk/phase2-final-gold.json` | Top-K 轮次阶段二的最终 gold 跑，策略与今天**逐字段相同**（discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false），唯一区别就是默认时间窗还是 90 天 |
| 2,000 条 recall-scale（276 query） | `topk/phase2-final-recall.json` 的 `pool-full` arm | 同上，同一策略、同一冻结装置（filler `10b572bd3ec7e4b9`） |

## 4. 为什么这些装置证明不了修好了

判据 §5.1 先写下来的事实，实测复核如下：

| 装置 | 播种口径 | 实测跨度 | 是否有窗外记录 |
| --- | --- | --- | :--: |
| 30 条 gold | 当天 UTC 零点 −30 天，+1 分钟/turn（`run.ts:571`） | 30 分钟 | 无 |
| 2,000 条 recall-scale | 同口径（`run-phase3b-scale.ts:138`） | — | 无 |
| 50,000 performance-scale（历史口径） | 同口径，**+1 分钟/条**（`run-pool-perf-recheck.ts`） | 约 34.7 天 | 无 |

**一处判据更正**：判据 §5.1 的表里把 performance-scale 的跨度写成"≤13.9 小时"，那是按
每条 +1 秒算的；实际是每条 **+1 分钟**，50,000 条跨约 34.7 天。结论不变（仍然全部落在
90 天窗内，仍然只能作为行为中立锁），但数字错了，如实更正。

因此这三份装置对本轮的作用只有一个：**证明去掉窗没有顺手改坏别的东西**。

## 5. 复现命令

```bash
# N1 / N2 / N4 / N5：gold 语料
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --fusion --empty-ext \
  --no-heldout --semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 --rrf-k=60 \
  --fts-weight=1 --semantic-weight=1 --tie-break=semantic-rank --semantic-candidate-pool=inf \
  --semantic-topk=1000 --bigram-aux=off --json=benchmark/reports/phase3c-identity.json

# N3：2,000 条装置
bun run benchmark/run-phase3b-scale.ts --pools=full --sizes=0 \
  --json=benchmark/reports/phase3c-recall.json

# N6
bun test && bun run typecheck
```

## 6. Provenance

| 项 | 值 |
| --- | --- |
| commit | `13ad15c`，dirty（工作区含 Phase 1b–本轮未提交产物） |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 判据 | A0 `366ce756b0d6ebd0`（先于实现） |
| 策略（本轮未动） | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / pool=Infinity / semanticTopK=1000 / bigramAux=false |
| 唯一自变量 | 默认时间窗 90 天 → 无界（`DEFAULT_SEARCH_DAYS`） |
| 产物 | `phase3c-identity.json`、`phase3c-identity-diff.json`、`phase3c-recall.json`、`phase3c-recall-diff.json` |
