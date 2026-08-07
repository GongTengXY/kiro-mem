# raw-v1 降级路径调查结论（裁定第 2 步的前置调查）

> 状态：**调查完成，请求裁定补救方向**。本文件**不是**判据实验——判据要等补救方向定下来
> 才能写，否则等于我自己选产品语义。
>
> 裁定第 2 步的原话：「专门验证 `semantic_query_en` 缺失/被拒且 FTS 有命中的路径，重点覆盖
> 超过 200 条记录的 scope。确认它应当是 FTS-only，还是严格复现冻结的 Phase 1b raw policy；
> 不能直接套用 semantic-en 的 0.197 floor、全 scope 候选池和 Top-K。」
>
> 调查结果：**当前行为两者都不是**。它是第三种、未经校准的形态。

---

## 1. 结论先说

`discoveryEffective = false`（降级）**并不阻止 semantic-only 发现**。它只拦住
`ftsCount === 0` 那一种情况。只要有 **1 条** FTS 命中，`raw-v1` 的语义腿就会：

- 对**整个 scope** 打分（`semanticCandidatePool = Infinity`），且默认**不再有时间窗**（3C）；
- 用 `semanticFloor = 0.197` 判定，而那个值是 2B 在 **`semantic-en-v1`** 空间扫出来的；
- 用 `semanticTopK = 1000` 保留名次，那是 Top-K 轮次在 `semantic-en-v1` 上选的；
- 于是一条**词面毫无关系**的老记录可以带着 `match_source: "semantic"` 进入页面，受 cap=2 限制。

三个参数没有一个是在 `raw-v1` 空间里校准过的。而 `raw-v1` 恰恰是**没有可用 floor** 的那个
空间——方案 §1.1 与代码注释都记着：标注正例 cosine 0.080…0.607，与"本项目从未发生过的事"
的最坏噪声 0.431 **区间重叠**。

## 2. 实测证据

装置：302 条同 scope 记录。刻意的时间顺序用来**隔离候选池这一个变量**：

| 记录 | 时间 | 向量第一维（= cosine） | 词面 |
| --- | ---: | ---: | --- |
| ghost `#1` | **900 天前**（落在"最近 200 条"之外） | **0.30** | 与 query 无任何重叠 |
| filler ×300 | 300…1 天前 | 0.05 | 与 query 无关 |
| anchor `#302` | 1 天前 | 0.05 | **命中 query 的 `zzanchor`** |

`0.30` 的选取有依据：它落在 raw-v1 的重叠区间内（正例 0.080–0.607 / 噪声 ≤0.431），
同时高于为英文空间校准的 0.197 与 Phase 1b 的 0.2 —— 所以它能把"floor 的作用"和
"池的作用"分开。

| arm | protocol | discoveryEffective | ftsCount | `comparableVectors` | 返回 | ghost 进页 |
| --- | --- | :--: | ---: | ---: | --- | --- |
| A 正常 + FTS 命中 | `semantic-en-v1` | true | 1 | 302 | `#1(semantic) #302(fts)` | 是 |
| **B 降级 + FTS 命中（生产默认）** | **`raw-v1`** | **false** | 1 | **302** | `#1(semantic) #302(fts)` | **是** |
| C 降级 + Phase 1b raw profile（floor 0.2 / pool 200 / 不截断） | `raw-v1` | false | 1 | **200** | `#302(fts)` | **否** |
| D 降级 + 零 FTS | `raw-v1` | false | 0 | 0 | **空** | 否 |
| E 正常 + 零 FTS | `semantic-en-v1` | true | 0 | 302 | `#1(semantic)` | 是 |

**B 与 C 的对比是决定性的**：同一条记录、同一个 query、同一条降级路径，
只因为候选池从 200 变成全 scope，它从"永不被打分"变成"以 semantic-only 进页"。
`aboveFloorCount` 也从 0 变成 1。

D 证明词面锚点门本身是好的——零 FTS 时降级路径确实返回空。问题正在于门只管这一种情况。

## 3. 这个暴露面是怎么长出来的

不是一次改动引入的，是三轮各自合理的改动叠加的结果。`semanticCandidatePool` 与
`semanticTopK` 是**单一策略字段，两个协议共用**：

| 轮次 | 改了什么 | 校准空间 | 对降级路径的副作用 |
| --- | --- | --- | --- |
| Phase 1b（冻结基线） | pool 200 / floor 0.2 / 不截断 | raw + en | — （这是 raw 唯一被测过的形态） |
| 2B / 2C | floor → 0.197、引入 cap 2 | **只有 `semantic-en-v1`** | 降级路径的 floor 也跟着变了 |
| 候选池轮次 | pool 200 → 20000 | **只有 `semantic-en-v1`** | 降级路径的池放大 100 倍 |
| Top-K 轮次 | pool → Infinity、topK 1000 | **只有 `semantic-en-v1`** | 降级路径变成全 scope |
| Phase 3C | 默认时间窗 → 无界 | 两个协议同时 | 降级路径连时间边界也没了 |

每一轮的门槛都只在英文空间上测过，因为校准集的 121 条 query 全部带合法英文派生值。
**没有任何一轮测过降级路径**，所以这个暴露面一直没有出现在任何门槛读数里。

## 4. 两个候选补救方向（请求裁定，我不自行选定）

裁定第 2 步已经把选项定为两个，调查结果支持把它们说得更具体：

### 选项 1：降级路径 = FTS-only

`protocol !== semantic-en-v1` 时**完全不跑语义腿**。

- 优点：暴露面归零，语义不变量最简单——`raw-v1` 不再产生任何 cosine 判断；
- 代价：丢掉 raw-v1 的**重排**能力。Phase 1b 的 raw 端到端 MRR 0.769 里有一部分来自它；
  降级请求的排序会退回纯 bm25。
- 需要测什么：降级路径的排序退化幅度（gold 语料 raw arm 对照 Phase 1b 读数）。

### 选项 2：降级路径 = 严格复现冻结的 Phase 1b raw policy

`protocol !== semantic-en-v1` 时，语义腿改用一组**独立的、属于 raw 空间的**参数：
floor 0.2、pool 200、不截断、无 cap、recency 平局——即 `LEXICAL_ANCHOR_ROLLBACK_POLICY`
里那套值，但只作用于语义腿，不改 FTS 腿与融合。

- 优点：保留重排能力，且回到**唯一被测过的** raw 形态；
- 代价：策略对象里出现"按协议分叉的参数"，复杂度上升；而且 Phase 1b 的 raw 读数是在
  90 天窗与 200 条池下测的，3C 之后时间窗是否也要为 raw 分叉需要一并裁定；
- 需要测什么：降级路径逐 query 复现 Phase 1b raw arm；>200 条 scope 上 ghost 不得进页。

### 我的观察（供参考，不构成选择）

C 臂显示 Phase 1b 的 pool=200 就足以挡住这个 ghost，但那**不是因为 floor 起了作用**
（0.30 > 0.2 仍然过 floor），而是因为记录压根没进池。也就是说选项 2 的安全性主要来自
**池的收窄**，不是来自 raw floor —— raw floor 从来没有分离能力，这一点方案 §1.1 已经写死。
如果裁定选 2，这条应该写进判据，否则会被误读成"raw floor 0.2 是安全阈值"。

## 5. Provenance

| 项 | 值 |
| --- | --- |
| 探针 | `benchmark/probe-raw-degrade.ts`（只读内存库，不碰真实用户库，不改任何生产值） |
| commit | `13ad15c`，dirty |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 当时的生产策略 | discovery=on / floor=0.197 / cap=2 / rrfK=60 / 1:1 / tieBreak=semantic-rank / **pool=Infinity** / **topK=1000** / bigramAux=false / **默认时间窗无界** |
| 对照 profile | `LEXICAL_ANCHOR_ROLLBACK_POLICY`：floor 0.2 / pool 200 / topK Infinity |
| 复现 | `bun run benchmark/probe-raw-degrade.ts` |

## 6. 纪律声明

- 本轮**尚未改动任何生产代码**；上表全部来自现状实测。
- 本轮**没有**借用 P6 的数据，也没有调整 floor / cap / Top-K / 时间窗（裁定第 2 步的约束）。
- 判据将在补救方向裁定之后冻结，然后才实现与测量。
