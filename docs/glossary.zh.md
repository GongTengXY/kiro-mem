# 名词解释（检索与基准口径）

覆盖 README、`src/server/observation-search.ts` 与 `benchmark/reports/` 里出现的检索/评测术语。
每条给出：**是什么** → **本项目当前取值/读数** → **容易读错的地方**。

读之前先记住三件事，否则下面的数字会被互相串引：

1. **同名指标可能来自两条不同的管线。** `tuned MRR` 在离线探针（`probe-semantic-rank.ts`，纯 cosine 排序）和产品基准（`run.ts`，走完 FTS + RRF + limit）里都存在，数值不可互换引用。
2. **数据集是严格分桶的。** `tuned` / `heldout` / `validation` / phase 2 校准集 / `empty` / `leakage` 各有各的举证能力，一个集合的读数不能当另一个集合的证据。
3. **检索策略是服务端的，不是调用方参数。** floor、cap、tie-break、权重全部来自 `RetrievalPolicy`，MCP 工具 schema 里没有它们。

---

## 速查表

| 术语 | 一句话 | 当前值 / 读数 |
| --- | --- | --- |
| cosine | 两个向量的余弦相似度，语义腿的打分函数 | 值域 `[-1, 1]`，与 floor 用严格 `>` 比较 |
| `raw-v1` | 原文直接送编码器的向量空间 | 中文下正负例分布重叠，**不允许独立语义召回** |
| `semantic-en-v1` | 记录与 query 两侧都先转英文再嵌入 | 生产协议，AUC 0.998 |
| tuned MRR / Top-5 | 校准集（18 条）上的排序读数 | 探针 phase1a：0.972 / 18 中 18 |
| heldout MRR / Top-5 | 泛化集（18 条）上的同口径读数 | 探针 phase1a：0.833 / 18 中 18 |
| heldout hit@5 | heldout 里前 5 条命中标注的比例（产品口径） | 门槛 ≥40%，1b 实测 44.4% |
| AUC | 正例分数排在负例之上的概率 | `semantic-en-v1` tuned/empty = 0.998 |
| floor | `semanticFloor`，语义候选的 cosine 下限 | 0.197（回滚档 0.2） |
| cap | `semanticOnlyLimit`，每次搜索纯语义结果条数上限 | 2 |
| tie-break | 融合分数**完全相等**时的排序规则 | `semantic-rank` |
| `RetrievalPolicy` | 服务端检索策略结构体 | 两个冻结档：默认 / 回滚 |
| expected-empty | 标注为「理应返回空」的 query 的平均返回条数 | 门槛 ≤1，工作点实测 1.00（最坏 2） |
| validation hit@5 / MRR / 中文 hit@5 | 20 条验证集（10 中 10 英）的确认读数 | 100% / 0.917 / 100% |
| FTS-only | query 向量拿不到时**单次请求**降级成纯关键词 | 基准 0/145 |
| arm | 一组参数在完整管线上跑出来的一次留档 | 2B 12 个、3A 15 个 |
| RRF | 倒数排名融合，`Σ w/(K+rank)` | K=60，权重 1:1 |
| `bigramWeight` | CJK 双字腿的 RRF 权重 | 1（腿默认关闭） |
| `bigramMinMatches` | 成为候选所需的最少不同双字词数 | 1 |
| `bigramVote` / `discovery-only` | 双字腿能给哪些候选投票 | `always`（腿默认关闭） |

---

## 一、向量空间与协议

### cosine（余弦相似度）

语义腿唯一的打分函数：`cosineSimilarity(queryEmbedding, storedEmbedding)`，值域 `[-1, 1]`，越大越像。

- 与 floor 的比较是**严格大于**（`score > floor`），边界值不入候选。这一点在内核、单测和报告里是同一个写法，避免同一个数在基准里和单测里含义不同。
- `validateRetrievalPolicy` 拒绝 `[-1, 1]` 之外的 floor：越界值读起来像阈值，实际含义是「全留」或「全丢」；`NaN` 更糟——`score > NaN` 恒假，语义腿会静默变空，看起来像 floor 生效了。
- cosine 只在**同一个向量空间内**有意义。跨空间比出来的分数看着权威但没有含义，所以读取时按空间 key 过滤（见下）。

### `raw-v1`

把原文（中文就是中文）直接喂给内置编码器 `all-MiniLM-L6-v2` 的空间。

它不是「未优化版本」，而是**一个不可用于独立语义召回的空间**，原因是测出来的分布：

| 池 | 中位数 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| 正例（38 对） | 0.289 | 0.487 | 0.607 | 0.607 |
| 标注真负例（130 对） | 0.179 | 0.286 | 0.392 | 0.431 |

正例区间 0.080…0.607 与「本项目从没做过的事」的噪声上限 0.431 重叠，**不存在能分开两者的阈值**。所以内核里有一条协议边界：不在 `semantic-en-v1` 空间就不允许 discovery（不允许召回 FTS 完全没命中的记录）。

根因是编码器而不是混合检索：MiniLM 的 30522 词表里只有 244 个纯 CJK token，中文落在空间的退化区——无关中文句对能打到 0.42…0.85。

### `semantic-en-v1`

**两侧都转英文**的归一化协议：记录侧写入时把 title/summary/outcome/learned/concepts 译成英文再嵌入，query 侧由调用 `search` 的 agent 传 `semantic_query_en`。

三条测出来的硬约束：

- **要么两侧都转，要么都不转。** 只译记录侧、让中文 query 去比英文向量，实测 MRR 0.437，比 `raw-v1` 基线 0.529 **更差**。
- **协议是向量空间身份的一部分。** `raw-v1` 与 `semantic-en-v1` 都是同一个模型的 384 维输出，混排看起来无害，实测两个方向读数是 0.972 和 0.613。所以空间 key 是 `模型:量化:维度:协议`（`embeddingSpaceKey()`），不是模型名。
- **护栏不是防御性习惯。** phase 1a 里翻译器给 q16 返回了字面量 `...`，JSON 合法、schema 通过、该 query 名次从 1 掉到 18。`checkSemanticEnQuery` 因此检查占位符、CJK 残留比例、标识符丢失、长度比等，拒绝原因是可计数的枚举（`missing` / `untranslated` / `placeholder` …，见 `/health` 的 `semanticQueryIssues`）。

query 侧**没有重试**：它在交互路径上，不许再花一次 LLM 往返。护栏拒绝就退回 FTS-only；
`raw-v1` 只作为协议/观测身份保留，不生成 query embedding、不读取向量、不参与重排。

### AUC

「随机取一个正例和一个负例，正例分数更高」的概率。0.5 = 瞎猜，1.0 = 完全分开。这里用它回答一个具体问题：**这个空间里存不存在一条能分开信号与噪声的 cosine 阈值？**

- `semantic-en-v1`：tuned 正例 / empty 真负例 = **0.998**，heldout / empty = 0.995 → 阈值路线可行，于是才有了 floor。
- `raw-v1`：分布重叠（见上），阈值路线不可行。

AUC 高只说明「可分」，不说明「该切在哪」。切点由 floor 扫描表 + 完整基准跑出来定。

---

## 二、检索策略（`RetrievalPolicy`）

### `RetrievalPolicy`

`src/server/observation-search.ts` 里的服务端策略结构体，字段包括 `semanticDiscovery` / `semanticFloor` / `semanticOnlyLimit` / `rrfK` / `ftsWeight` / `semanticWeight` / `tieBreak` / `semanticCandidatePool` / `semanticTopK` / `bigram*`。

**刻意不放进 MCP 工具 schema**：调用方若能自己抬 floor 或 cap，就能造出任意结果页，基准里那些门槛也就不再描述任何人实际用过的策略。注入口只有 `ObservationSearchDeps.policy`，供基准 arm 和测试使用。

生产只有两个冻结档，由 `resolveRetrievalPolicy(config.retrieval.semanticDiscovery)` 二选一：

| 档 | discovery | floor | cap | tieBreak | 候选池 | topK |
| --- | --- | --- | --- | --- | --- | --- |
| `DEFAULT_RETRIEVAL_POLICY` | on | 0.197 | 2 | `semantic-rank` | 全 scope | 1000 |
| `LEXICAL_ANCHOR_ROLLBACK_POLICY` | off | 0.2 | ∞ | `recency` | 200 | ∞ |

没有第三种状态，也不做字段级合并——只有这两个组合被端到端测过。改这里任何一个字段都是产品改动，需要重跑全矩阵和重新过门，而不是改一行。

### floor

即 `semanticFloor`：语义候选必须 `cosine > floor` 才进入融合。

默认 **0.197** 来自 phase 2B 的全管线扫描（floor ∈ {0.197, 0.223, 0.275} × cap ∈ {1, 2, 3, 5}，121 条冻结的 `ftsCount=0` 校准 query，规则在任何 arm 开跑之前就写下来了）。

抬高它不是「更安全」而不付代价：

| floor | 校准集正例保留 | 真负例通过 | 同 cap=2 下的 hit@5 |
| --- | --- | --- | --- |
| 0.197 | 100.0% | 5.4% | 50.0% |
| 0.223 | 95.0% | 3.1% | 40.3% |
| 0.275 | 90.0% | 0.0% | 约 −24 个百分点 |

它是**一个 `semantic-en-v1` 的数**，在 `raw-v1` 空间里没有意义——这正是协议边界存在的原因。低于 0.197 从未校准过。

### cap

即 `semanticOnlyLimit`：一次搜索里**只有语义腿找到**的结果最多返回几条，**在融合排序完成之后**施加。默认 **2**。

- 为什么在融合之后：先截语义列表会改变存活 hybrid 候选的语义 rank，cap 就会和融合权重纠缠，arm 无法归因。
- 被 cap 掉的候选**不占 limit**：循环继续往下用 hybrid/fts 结果补页，所以小 cap 是拿噪声换深度，不是换更短的页。
- 它是 semantic-only 来源的数量上限，**不是整页误召回护栏**。FTS/hybrid 从来不经过它；
  最终独立盲审在 cap=2 下仍测得 hard-negative 平均返回 1.9，因此当前工作点未通过 P6。
- 合法 `semantic_query_en` + `semanticDiscovery: false` 时，语义腿仍可重排已有 FTS 锚点；
  缺失/被拒的英文形式则严格 FTS-only，不运行语义腿。
- 同形状的还有 `bigramOnlyLimit`（双字腿专用），两者是**独立的两个额度**而不是共享预算。

### tie-break

融合分数**完全相等**（float64 `===`）时的排序规则。三档：

- `recency` — 更新的 `turn_stopped_at`，再比 id。phase 1b 行为，回滚档用它。
- `source-confidence` — 先按来源桶 `hybrid > semantic > fts > bigram`，再 recency，再 id。
- `semantic-rank` — **生产默认（phase 2D 选定）**：先桶序，再比语义 rank（小者优先），再 recency，再 id。

要点：

- 排序器里有 `if (b.score !== a.score) return b.score - a.score` 的守卫，所以换 tie-break **不可能**重排融合已经分开的候选。这是 2D 需要的性质，而调语义权重没有这个性质（`w_sem > 1` 会动非平局候选）。
- 真正让目标掉名次的平局是**同桶**平局：(ftsRank 2, semRank 1) 与 (ftsRank 1, semRank 2) 的分数完全相等且都是 `hybrid`，桶序分不开。`semantic-rank` 把 q03/q14 从第 2 名救回第 1 名；`source-confidence` 在 145 行里只动 2 行、不改任何指标。
- 桶序保持在语义 rank **之前**，因为跨腿平局真实可达：K=60 时 `1/93 + 1/186 === 1/62`，扫描 `ftsRank ≤ 50 × semRank ≤ 250` 能找到 17 个这样的解。

### RRF（Reciprocal Rank Fusion，倒数排名融合）

把多条腿各自的**排名**（不是分数）融合成一个分数：

```
score(doc) = Σ_leg  w_leg / (K + rank_leg(doc))
```

生产取 `rrfK = 60`、`ftsWeight = semanticWeight = 1`。用排名而不是原始分数，是因为 bm25 与 cosine 不同量纲、不可直接相加。

`validateRetrievalPolicy` 的约束也来自这个公式：K 必须是正整数（0 让 rank 1 贡献 `w/1`；负数可能让 `K+rank` 为 0 而除零，或反转方向让差排名得高分）；权重必须有限且为正（0 会静默关掉一整条腿，而报告仍声称双腿融合）。

### FTS-only

**单次请求**的降级：query 向量拿不到（Worker 挂了、超时），语义腿整条缺席，只剩关键词结果。内核 `catch` 后调 `deps.onDegrade()`。

- 这是**能力失败**，不是策略选择。与运维把 `semanticDiscovery` 关掉（回滚档）是两件不同的事，观测上也分开：`/health` 里 `ftsOnly` / `degradeRate` 记降级，`retrieval` 段落记生效的档。
- 基准里的读数是「FTS-only 降级次数 0 / 145」。
- 历史上还有一次 `FTS-only` 的含义（缺陷 D1）：FTS 对自然语言召回恒为 0 时，「降级成 FTS-only」实际等于「召回归零」。那个缺陷已修（`extractFtsSearchUnits`）。

---

## 三、双字腿（phase 3A / 3A-R2，默认关闭）

前置事实：`bigramAux` 默认 `false`，并且**保持 false**。Codex Gate E（2026-08-04）裁定 phase 3A 未通过——15 个 arm 里可行 arm 数为 0；后续 3A-R2 的裁定把这条路线判为「机制收敛，不是参数空间扫得不够」，路线关闭。代码保留是因为增益是真的（把 phase 2 校准集 hit@5 从 50.0% 抬到 68.1%，让 68 条零关键词 query 有了候选），代价也是真的（误召回越界）。

`FTS_CJK_WINDOW=3` 的 trigram 索引够不到中文两字词：query 切出 `带引号`/`引号或`，记录切出 `合引号`/`引号等`，两边窗口对不齐就永远不命中。双字腿补的是这个洞。

### `bigramWeight`

双字腿在 RRF 里的权重，固定为 1。

3A-R2 的结论是它**没有通向误召回的因果路径**：权重改变不了候选数量。0.25 / 0.5 / 0.75 三档跑出来的误召回读数**逐位相同**。

### `bigramMinMatches`

一条记录要匹配到几个**不同的**存活双字词才能成为候选。默认 1。

测出来「有效但很钝」：设为 2 时最坏误召回降到 0–2 条，但可达目标从 32/72 掉到 9/72——比只用 DF 上限更差，因为它是靠压制真候选来压制噪声的，并且拖低了 tuned R-precision。

（配套的 `bigramDfRatioCeiling` 是 `df / scopeSize` 的上限，用比例而不是绝对数，因为绝对值 1 换个语料规模就静默失效——「引号」在 10,000 条记录里不会是 df 1。登记的局限：26 条主语料每步分辨力 3.85 个百分点，所以选出来的值是「不越界的设置」，不是「校准过的最优」。）

### `bigramVote` 与 `discovery-only`

双字腿**允许给哪些候选投 RRF 票**：

- `always` — 3A 行为，也是当前默认值：匹配到的每个候选都拿到第三个 RRF 项。
- `discovery-only` — 只给**其它两条腿都没找到**的候选投票；已经被 trigram 或语义腿找到的记录，双字腿对它毫无影响。

`discovery-only` 存在的理由：3A 的两个根因共用同一个机制——双字腿给别的腿已经找到的记录投票。

- `bigramOnlyLimit=1` 时，「Kubernetes Ingress 灰度发布配置」（本项目从没做过的事）仍返回 5 条，大多标 `hybrid`——腿把已在场的语义候选从页外顶进页内，而 cap 只看 `bigram`，看不到它们。
- q14 的正确答案从第 1 掉到第 2，只因为另一条记录匹配了更多两字词。「匹配了几个双字词」比 bm25 和 cosine 粗得多，等权重下方向不可控（同一个 arm 上 q04 反而升了一名）。

`discovery-only` 把两者一起结构性关掉，代价是放弃双字腿对头部排序的贡献。随之被 3A-R2 裁定正式确认的三层 `match_source` 定义：

| 证据组合 | 标签 | 受哪个 cap 约束 |
| --- | --- | --- |
| 语义 + trigram FTS | `hybrid` | 不受 |
| 语义 + 仅双字 | `semantic` | `semanticOnlyLimit` |
| 仅双字 | `bigram` | `bigramOnlyLimit` |

理由是 `hybrid` 的含义：语义证据 + **可靠的**词面证据。trigram 命中算，两字滑窗不算——「配置 / 发布 / 处理 / 服务」被实测为同时产生语义近邻和词面噪声，两条腿的错误是相关的，「互相同意」并不等于两个独立信号。

---

## 四、评测口径

### arm

**一组参数在完整管线上跑出来的一次留档**（`.md` + `.json`），不是一次 A/B 实验，也不是代码分支。

- phase 2B：12 个 arm = floor 3 档 × cap 4 档；phase 3A：15 个；每个 arm 单独成文件。
- 纪律：每个 arm 从冻结的上一阶段 policy 出发，**生成全部策略字段的 CLI 参数**，跑完后与内核上报的 policy 逐字段断言。只重述被测字段的话，无关字段的笔误就和自变量分不开了（`--semantic-floor=0.22.3` 静默变成 0.2，等于把一个 arm 的结果写进另一个 arm 名下）。
- 参数非法/策略非法时脚本在**播种之前**退出码 2：被静默纠正的值会产出一份完整报告，而那份报告的 provenance 写着一个从未运行过的策略，肉眼与真报告无法区分。

### 数据集分层

| 集合 | 规模 | 举证能力 |
| --- | --- | --- |
| `tuned` | 18 条 relevance | 检索实现当初就是在它上面调的 → **连续性锁**，不是泛化证据 |
| `heldout` | 18 条 relevance | 后补且没据此改任何检索参数 → **泛化读数** |
| `validation` | 20 条 relevance（10 中 / 10 英） | 选参完成后的确认集 |
| phase 2 校准集 | 121 条（72 relevance + 49 empty），全部 `ftsCount=0` | 2B 选参的**唯一**输入，与上面严格分桶 |
| `empty` | 5 条（q19、q21–q24） | 误召回侧，理想返回空 |
| `leakage` | 1 条（q20） | 只查跨 scope 隔离，**不计入** expected-empty |

`empty` 与 `leakage` 的 `expect` 都是空数组，但含义不同：前者是「什么都不该返回」，后者是「不该返回别的 scope 的记录」——q20 故意与本 scope 的 401/token 词汇重叠，返回本 scope 命中是正确行为。第一版按 `expect.length === 0` 推断取样，把 q20 算了进去，指标偏高到 8.5，还会把「压制正确结果」变成优化方向。

### hit@5 / Top-5 / MRR / R-precision

四个都在报告里出现，测的不是一件事：

- **hit@5 / Top-5** — 前 5 条里至少有一条命中标注的 query 比例。同一个东西的两种写法（phase 1a 的表里写成 `18/18` 这样的计数）。它是**阶跃函数**：目标从第 4 名升到第 1 名，它一动不动。
- **MRR** — 首个命中名次的倒数的平均值。仍然离散，但细得多；单条 query 对它的**最大**贡献是 1/n（未命中→第 1），不是固定 1/n。它存在的原因很具体：在词汇锚点门还在时，换编码器唯一能改变的就是排序，只看 hit@5 会把一个真正更好的编码器读成「没变化」，然后正确的改动被回退。
- **R-precision**（截断点 R = |expect|）而不是 precision@5：标注里 `expect` 通常只有 1 条，precision@5 上限就是 20%，测出来只是 hit@5 的另一种写法。

### tuned MRR / tuned Top-5

校准集（18 条）上的排序读数。**必须带管线出处引用**：

| 出处 | tuned MRR | tuned Top-5 |
| --- | --- | --- |
| 离线探针 phase0（`raw-v1`，纯 cosine） | 0.529 | 12/18 |
| 离线探针 phase1a（`semantic-en-v1`，纯 cosine） | **0.972** | 18/18 |
| 产品基准 phase0（走完 FTS + RRF + limit） | 0.769 | hit@5 94.4% |

离线探针**绕过**词汇锚点门（`if (ftsResults.length === 0) return []` 在语义步骤之前），直接测「语义腿单独能不能把对的记录排上来」。不绕过的话，零锚点 query 连查询向量都不会算，端到端读数结构上就是不动的。

tuned 的产品门槛是 hit@5 ≥90%，性质是**连续性锁**——它证明不了泛化。

### heldout MRR / heldout Top-5 / heldout hit@5

泛化集（18 条，后补、未据此调参）上的同口径读数。

| 出处 | 读数 |
| --- | --- |
| 离线探针 phase0 | MRR 0.365，Top-5 7/18 |
| 离线探针 phase1a | **MRR 0.833**，Top-5 18/18 |
| 产品基准 phase 1b（gold） | **hit@5 44.4%**（门槛 ≥40%） |

tuned 94.4% 与 heldout 44.4% 之间那 50 个百分点是本项目整个检索改造的起点：检索对调优过的问法有效，对同一批工作的另一种问法只有一半有效。诊断是 heldout 里 9/18 条一个字面词都没命中，主因是 FTS trigram 对自然语言换说法无效，而不是锚点规则本身。

门槛 ≥40% 的性质写在 README 里：**这个水平不可接受**，门槛只是防止再退。阶段 2C 之后这两个数要在 `--protocol=semantic-en` 且 discovery 默认开启的前提下重读。

配套两个诊断读数：`heldoutNoAnchor`（FTS 候选数为 0 的 heldout 条数，纯输入侧，拆门前后可比）与 `heldoutReturnedEmpty`（最终返回 0 条的条数，旧口径）。`semanticDiscovery=false` 时两者必然相等（都是 9），拆门后会分叉——2A 实测 `heldoutNoAnchor` 仍是 9 而 `heldoutReturnedEmpty` 掉到 0，这正是改名的必要性。

### validation hit@5 / validation MRR / validation 中文 hit@5

`benchmark/dataset/queries-validation.json` 的 20 条 relevance query（`origin: "validation"`，10 条中文 + 10 条英文），用于选参**之后**的确认，不参与选参。

Gate B 后续重跑（修掉 v20 的固定输入缺陷后）的读数：

| 指标 | 读数 | 门槛 |
| --- | --- | --- |
| validation hit@5 | 100.0% | 严格 >75.0% |
| validation MRR | 0.917 | ≥0.667 |
| validation R-precision | 0.850 | — |
| 中文 / 英文 hit@5 | 100% / 100% | ≥50% / =100% |

**「中文 hit@5」是分层读数**：把集合按 query 语言拆开各算一次。中文门槛（≥50%）明显低于英文（=100%），因为中文路径依赖 `semantic_query_en` 的翻译质量，多一层可能失败的环节。同名的分层读数在 phase 2 校准集里也有一份（中文 56 条 / 英文 16 条），两者不是同一个集合。

v20 的缺陷值得单独记：它原文本来就是英文，而固定输入是用中→英 prompt 生成的，翻译器返回了字面 `'...'`，生产护栏以 `placeholder` 正确拒绝，于是该 query 静默落回 `raw-v1`。修好后它的名次 2 → 1，MRR 增量 1/20 × (1 − 1/2) = 0.025，与 0.892 → 0.917 吻合。

### expected-empty

标注为 `kind: "empty"` 的 query（本 scope 内既无相关记忆也无合法词汇重叠，理想返回空）的**平均返回条数**。门槛：均值 ≤1，最坏 ≤3。

- 取样按**显式 kind**，不能用 `expect.length === 0` 推断（见上面 `leakage` 一节）。
- 收口手段在 2C 换过：过去是检索层的词汇锚点规则（本 scope FTS 无命中即返回空），现在是 `semantic-en-v1` 空间里的 floor 0.197 + cap 2。
- **读它必须同时看 `discoveryEffective`。** 在 discovery 未生效的跑批里，「expected-empty 返回 0.00 条」对任何无词面重叠的 query 都是结构性必然，那是一条连续性读数，**不是** floor/cap 控住了误召回的证据。2B/2C 的误召回数字全部来自 discovery 生效的跑批。
- 门槛留的 1 条余量在 2C 之后是**紧的**：既有 5 条在选中工作点上平均返回 1.00，正好贴着门槛。真正的硬不变量（零锚点且语义候选全部低于 floor 必返回空）由单测钉住，不依赖这条门槛。

---

## 出处

- 策略字段与全部内联理由：`src/server/observation-search.ts`
- 协议与护栏：`src/semantic-en.ts`
- 指标定义、门槛与数据集分层：`benchmark/README.md`
- 空间对比与 floor 候选扫描：`benchmark/reports/phase1a-en-normalization-eval.md`
- 选参与确认：`benchmark/reports/phase2b-matrix-summary.md`、`phase2d-selection.md`
- 双字腿裁定：`benchmark/reports/phase3a-submission.md`、`phase3a-r2-submission.md`
