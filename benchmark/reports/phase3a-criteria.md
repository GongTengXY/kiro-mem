# 阶段 3A 判据：中文两字词 FTS 召回

> 日期：2026-08-03
>
> 上游：方案 `plan/V3/retrieval-recall-implementation-plan-2026-07-31.md` §10；Gate D 已通过。
>
> 量测依据：`benchmark/reports/phase3a-bigram-probe.md`（只读探针，未改产品代码）。
>
> **本文在运行任何 arm 之前写完并冻结**（方案 §14.3）。任何后续修订必须以附录形式追加、
> 保留原文、写明是谁在什么证据下要求的——2D 的三次修订就是这么留档的。

---

## 1. 缺口与机制（已实测，非推断）

FTS5 用 trigram tokenizer，`FTS_MIN_UNIT_LEN=3`、`FTS_CJK_WINDOW=3`。中文两字词只有在
**三字窗口恰好对齐**时才可达。

q32「搜索词里带引号或括号会不会崩」→ 三字窗口含 `带引号`、`引号或`；
t01 记录里「引号」出现在 `未闭合引号等`（summary）与 `双引号翻倍`（learned）→ 三字单元是
`合引号`、`引号等`、`双引号`、`引号翻`。两侧都有「引号」，窗口一个都对不上，`ftsCount=0`。

一条捷径已被实测否掉：FTS5 前缀查询（`"引号" *`）走不通，因为 trigram tokenizer 会把
**query 也切成三字**，两字 query 切不出 token，`*` 没有作用对象。索引 vocab 里 `引号等`、
`引号翻` 确实存在，但 MATCH 到不了。

---

## 2. 唯一产品改动

给检索增加一路**受控的 CJK bigram 辅助候选**：从 query 提取两字单位，用辅助 LIKE 在
scope 内找出含该子串的 Observation，作为候选参与 RRF。

### 2.1 机制选型依据

方案 §10 给了两条路。实测对比（当前语料 26 条 primary）：

| 机制 | 完备性 | 单 bigram 耗时 | 结论 |
| --- | --- | ---: | --- |
| 辅助 LIKE | 完备（`%XY%` 就是子串的定义） | 0.035 ms | **选用** |
| `fts5vocab` 前缀展开 | 漏 9 条（只覆盖 `XY?`；bigram 落在列末尾时索引里只有 `?XY`） | 0.496 ms | 不选 |

**这个延迟结论是尺度相关的，必须如实登记**：26 条语料上 LIKE 全表扫描本来就便宜，而
vocab 的范围扫描优势要到大语料才显现。交叉点未测，登记给 3B（§11 规模阶段），不在 3A 内
声称 LIKE 在任何规模上都更快。

### 2.2 明确不改的变量

- 不改 FTS tokenizer，不切换成 bigram 索引（方案 §10 第 4 条）——索引大小与写入成本不变；
- 不改 `extractFtsSearchUnits` 现有的三字窗口逻辑，bigram 是**新增的一路**，不是替换；
- 不改 2C/2D 冻结的 `semanticDiscovery` / `semanticFloor` / `semanticOnlyLimit` / `rrfK` /
  权重 / `tieBreak`；
- 不改语义候选池（仍最近 200 条）、不改默认 90 天窗口（那是 3B / 3C）；
- 不改 embedding 模型与 `semantic-en-v1` 协议；
- 不改 MCP 工具 schema——bigram 的所有 knob 都是服务端检索策略，与 2A 起的纪律一致。

---

## 3. 实现规格

### 3.1 核心决策：bigram 是**第三条腿**，不是混进 FTS 名次

方案 §10 第 3 条写「辅助候选进入 FTS 排名后再参与 RRF」。**照字面实现会破发布门**，理由是
护栏的作用面：

`semanticOnlyLimit=2` 只作用于 `match_source === 'semantic'`。辅助候选一旦混入 FTS 名次，
记录就变成 `fts`/`hybrid`，而 FTS 候选从不被丢弃，所以进候选池基本等于进结果页。实测
（54 条 empty query，门槛均值 ≤1 / 最坏 ≤3）：

| 配置 | phase2 目标可达 | empty 均值 | empty 最坏 | 破 ≤3 的条数 |
| --- | ---: | ---: | ---: | ---: |
| DF 不设上限 | 32 / 72 | 1.00 | **15** | 4 |
| DF≤3 | 27 / 72 | 0.81 | **9** | 3 |
| DF≤2 | 24 / 72 | 0.70 | **6** | 2 |
| DF≤1 | 18 / 72 | 0.33 | 2 | 0 |

所以内核必须能区分「这条候选的名次是 trigram 给的还是 bigram 给的」，否则无法只限制后者。
落地形态：

1. bigram 候选生成**独立的名次表** `bigramRank`，与 `ftsRank`、`semanticRank` 并列；
2. RRF 融合时 bigram 名次以自己的权重项参与，公式扩展为

   ```text
   score = w_fts/(K+ftsRank) + w_sem/(K+semRank) + w_bigram/(K+bigramRank)
   ```

3. `match_source` 扩展一个取值 `bigram`：**只有** bigram 腿找到（trigram FTS 与语义腿都没
   找到）。三腿任意两腿以上命中仍为 `hybrid`；
4. `bigramOnlyLimit` 在**完整融合排序之后**施加，与 `semanticOnlyLimit` 完全同构：被 cap
   丢弃的候选不占 `request.limit`，继续向后补位。

### 3.2 为什么必须有 `bigramOnlyLimit` 这个轴

DF 上限单独承担不了发布门，实测已证：

- DF≤1 是唯一不越界的纯 DF 配置，但它把可达从 32/72 压到 18/72，**而且 DF=1 是绝对阈值**。
  26 条语料上它等于「占语料 3.8%」；1 万条语料上等于「占 0.01%」——「引号」在 1 万条记录里
  DF 不会是 1，功能会静默失效。
- 共现下限（记录须命中 ≥2 个不同 bigram）压噪很干净（最坏 0–2、越界清零），但可达掉到
  **9/72**，比 DF≤1 还差：它是靠把真候选一起压掉来压噪的。

`bigramOnlyLimit` 是**结构护栏**：最坏值由构造保证，与语料规模和 DF 分布都无关。这与 2C 对
语义腿的解法同构——2C 也不是靠调 cosine 阈值压噪声，而是靠融合后的数量 cap。DF 上限于是
退回它真正擅长的角色：延迟与粗噪声过滤。

### 3.3 DF 上限用**比例**而非绝对值

`bigramDfRatioCeiling` = 允许的 `DF / scope 内记录数` 上限。比例是尺度不变的：「测试」在任何
规模的语料上都占三到五成，「引号」都占百分之几。绝对阈值不是。

**登记限制**：当前语料 primary 只有 26 条，一档分辨力是 3.85 个百分点，所以本阶段选出的比例
值只能算「不破门的可行值」，不能算「已校准的最优值」。真正的校准要等 3B 的 recall-scale
fixture（约 2000 条）。

### 3.4 观测与归因

方案 §10 验收要求「不把该收益错误归到 semantic-en」。为此逐 query 报出：

- `bigramUnits`：切出的两字单位，以及被 DF 上限滤掉的个数；
- `bigramCount`：通过全部过滤后的 bigram 候选数；
- `bigramRank`：候选 id → 名次；
- `bigramOnlyReturned` / `bigramOnlyDropped`：与语义腿的两个同名字段对称；
- `matchSource` 分布必须能看出 `bigram` 这一档。

运行观测（`/health`）只加计数与延迟，**不记录 query 正文、不记录 bigram 本身**——一个两字词
就足以泄漏用户问了什么（方案 §14.10）。

---

## 4. 数据使用纪律

### 4.1 关键口径：Phase 2 校准集按**冻结成员**前后配对

Phase 2 那 121 条校准集是**按 `ftsCount = 0` 筛出来冻结的**，而 3A 改的恰好就是这个谓词。

因此：

- **主口径 = 冻结成员的前后配对。** 121 条的成员名单在 Gate A 时已冻结，3A 报告对这 121 条
  逐条给出 before（2D 策略）/ after（本 arm）的名次与返回，集合成员**不因 3A 而增减**。
- **禁止重算 zero-FTS 子集。** 若按 arm 运行后的 `ftsCount = 0` 重新筛子集，被 3A 修好的
  query 会因为「不再是 zero-FTS」而被踢出分母——指标会显示持平甚至变差，而产品实际改善了。
  这是本阶段最容易出的假读数，写死禁止。
- `zeroFtsAfter` 作为**附加**观测字段报出（有多少条从 0 变正），但不作为任何门槛的分母。

### 4.2 各集合角色（沿用方案 §7.3，不放宽）

| 集合 | 规模 | 角色 |
| --- | ---: | --- |
| Phase 2 校准集（冻结 121 条） | 72 zero-FTS relevance + 49 empty | **选参主依据** |
| 既有 tuned | 18 relevance + 5 expected-empty | 连续性锁，不选参 |
| heldout | 18 | 冻结后只跑一次确认 |
| 既有 validation | 20 | 第二确认集 |
| Codex Gate B 盲审集 | 20 relevance + 20 hard-negative | 冻结后确认 |
| **3A 新增两字词 fixture** | 见 §7 | 机制断言，不参与选参 |

方案 §10 第 5 条要求「对 q32 以及新增两字词 query 建独立 fixture」。注意 q32 是 **heldout**，
所以它只能进单元/集成 fixture 做机制断言，**不得**用它的端到端读数选参数。

---

## 5. 候选网格（预登记，跑之前写死）

### 5.1 主网格：12 个 arm

```text
bigramDfRatioCeiling ∈ {0.04, 0.08, 0.12, 1.00}
bigramOnlyLimit      ∈ {1, 2, 3}
bigramMinMatches     = 1（主网格固定）
bigramWeight         = 1（与两条既有腿等权，沿用 2B/2D 不动融合权重的纪律）
```

当前语料 primary=26，四个比例值分别等价于 DF≤1 / ≤2 / ≤3 / 不设上限。**这个映射必须写在
报告里**，否则读者无法判断分辨力。

`bigramOnlyLimit` 的三个值来源：`2` 是与 `semanticOnlyLimit` 对齐的同构值；`1` 是更保守的
下邻；`3` 是上邻，同时也是 §7.4 硬上界 `≤3` 的边界值——取它是为了让「cap 等于硬上界时是否
仍然安全」成为一个被实测的问题，而不是被假设的答案。

### 5.2 基线与诊断 arm

| arm | 配置 | 用途 |
| --- | --- | --- |
| `baseline` | `bigramAux=off` | 2D 冻结策略，行为必须与已提交 2D 读数逐条一致 |
| `diag-no-cap` | DF 不设上限，`bigramOnlyLimit=∞` | 方案 §10 字面实现的读数。**不参与选择**，用于在报告里证明「照字面写会越界」不是我的推断 |
| `diag-min2` | DF 不设上限，`minMatches=2`，`bigramOnlyLimit=2` | 共现轴的端到端读数。不参与选择——探针已测出它的候选池可达上限只有 9/72，是被支配的 |

共 15 次运行。两个 `diag-` arm 的排除理由在此写明，符合方案 §7.2「新增候选必须在看到结果前
写明来源和目的」的反向要求：这两个是**先写明为什么不参与选择**。

---

## 6. 可行性门槛（预登记）

一个 arm 必须**全部**满足才进入候选集合。基线值取 Gate D 通过时的已提交读数
（`benchmark/reports/phase2d-submission.md` §4）。

### 6.1 连续性锁（既有 tuned，18 条）

| 指标 | 门槛 | 2D 读数 |
| --- | --- | ---: |
| tuned hit@5 | ≥ 100.0% | 100.0% |
| tuned MRR | ≥ 0.944 | 0.944 |
| tuned R-precision | ≥ 88.9% | 88.9% |

tuned 是校准集，不能用它证明泛化；它只负责「没有明显破坏既有质量」。

### 6.2 3A 的主正面证据（Phase 2 冻结 121 条）

| 指标 | 门槛 |
| --- | --- |
| Phase 2 relevance hit@5 | **严格高于** `baseline` 的 50.0% |
| Phase 2 relevance MRR | 不低于 `baseline` 的 0.458 |
| 从 `ftsCount=0` 变为正的 relevance 条数 | > 0，且逐条列出是哪个两字词命中了哪条记录 |

第三项是归因要求：收益必须能指到具体的两字词，否则无法排除「其实是别的东西在动」。

### 6.3 误召回硬门（这是 3A 的主要风险面）

| 指标 | 门槛 | 2D 读数 |
| --- | --- | ---: |
| Phase 2 empty 平均返回 | ≤ 1 | — |
| Phase 2 empty 最坏返回 | ≤ 3 | — |
| 既有 expected-empty 平均 | ≤ 1.00（**不得高于 2D**） | 1.00 |
| 既有 expected-empty 最坏 | ≤ 2（**不得高于 2D**） | 2 |
| Codex 盲审 hard-negative 平均 / 最坏 | ≤ 0.30 / ≤ 2（不得高于 2D） | 0.30 / 2 |

既有 expected-empty 只有 5 条且 2D 已经停在 1.00 / 门槛 ≤1，**零余量**。所以这里写的是
「不得高于 2D」而不是「≤1」——在零余量的位置上，「不恶化」才是可执行的门槛。

### 6.4 结构不变量（硬门，任一不成立即整个阶段不通过）

| 项 | 要求 |
| --- | --- |
| `bigram` 结果每条数量 | ≤ min(`bigramOnlyLimit`, `request.limit`) |
| 只被 bigram 找到的结果的 `match_source` | 100% 为 `bigram` |
| 被 cap 丢弃的 bigram 候选 | 不占用 `request.limit`，正常补位 |
| 跨 scope 泄漏 | 0 |
| protocol 混排 | 0 |
| scope / type / days 过滤 | 对 bigram 腿与另两腿完全一致 |
| **不含 CJK bigram 的 query** | 返回页逐条与 `baseline` 一致（3A 特有的中立性锁） |

最后一项是 3A 独有的中立性证据：探针已经量出语料里有多少条 query 不含任何 CJK bigram，
这些 query 在结构上不可能被 3A 影响，所以它们**必须**逐条不变。任何一条变了，说明改动
泄漏到了它不该碰的地方。

### 6.5 性能与规模

| 指标 | 门槛 |
| --- | --- |
| search p95 | < 300 ms |
| FTS 腿延迟（trigram + bigram 合计） | 报出 p50 / p95，与 `baseline` 对比 |
| 索引大小 | 报出改动前后字节数——预期**完全不变**（未改 tokenizer），非零变化必须解释 |
| 单次 search 的 LIKE 次数 | 报出上界，并证明它被 `FTS_MAX_UNITS` 同级的常量约束 |

---

## 7. 必须新增的测试

### 7.1 机制 fixture（方案 §10 第 5 条）

- q32 的最小复现：记录含 `未闭合引号等`、query 含 `带引号或`，三字窗口不match、bigram 命中；
- 「超时」「降级」「查询」三个技术两字词各一条（探针实测 DF=3，是最典型的形状）；
- 反向 fixture：两字词**只在 query 里有**，记录里没有 → 不得凭空产出候选。

### 7.2 护栏与不变量

- `bigramOnlyLimit` = 0 / 1 / 2 / 3 / ∞ 均严格生效；
- bigram-only 被 cap 丢弃后继续补入后续 hybrid/fts/semantic 结果；
- `limit=1/5/20` 下不变量成立（含 `limit < cap`）；
- DF 比例上限生效：构造一个高 DF 的两字词，断言它被滤掉；
- 三腿精确平局：`tieBreak` 的分档必须给 `bigram` 一个明确位置，且不污染 2D 已冻结的
  `hybrid > semantic > fts` 顺序——**新增取值不得改变既有三档之间的相对次序**；
- scope / type / days 对 bigram 候选生效（含跨 scope 完美命中必须不可见）；
- 无 CJK 的纯英文 query 一个 LIKE 都不发（性能不变量）。

### 7.3 降级与边界

- bigram 腿抛错时其余两腿仍正常返回；
- 全部 bigram 都被 DF 上限滤掉 → 行为等同 `bigramAux=off`；
- query 只有一个两字词、且该词 DF=0 → 不产生候选、不产生额外 LIKE 之外的开销。

---

## 8. 选参规则（确定性，跑之前写死）

在全部可行 arm 中按顺序选择，第一个能区分的准则即定胜负：

1. 最大化 Phase 2 冻结集的 relevance hit@5；
2. 若差值小于一条 query 的分辨力（1/72 ≈ 1.39pp），最大化同一集合的 MRR；
3. 再相同，选择 Phase 2 empty **最坏**返回更低者；
4. 再相同，选择 Phase 2 empty **平均**返回更低者；
5. 再相同，选择 `bigramOnlyLimit` 更小者（护栏更紧）；
6. 再相同，选择 `bigramDfRatioCeiling` 更小者（噪声面更小）；
7. 若没有 arm 可行，**3A 结论为未通过**，不进入生产 profile，不得用「恢复原状」充当阶段成功。

不得用 heldout、既有 validation 或 Codex 盲审集打破平局（方案 §7.5）。
选择必须由脚本从 JSON 机械算出，不得手工抄表。

---

## 9. 确认门槛（策略冻结之后才运行）

| 集合 | 指标 | 要求 |
| --- | --- | --- |
| heldout（18） | hit@5 | ≥ 83.3%（2D 读数） |
| | MRR / R-precision | ≥ 0.7639 / 72.2% |
| | q32 | 逐条报出它是否被 bigram 腿找回，以及名次变化 |
| validation（20） | hit@5 | ≥ 100.0% |
| | MRR / R-precision | ≥ 0.9417 / 90.0% |
| | 中文 MRR | ≥ 0.8833（**3A 是中文改动，这一项是它该动的地方**） |
| | 英文 MRR | ≥ 1.0000（英文 query 无 CJK bigram，结构上必须完全不变） |
| Codex 盲审（40） | 全部字段 | 不回退 |
| 三集合合计 | 跨 scope 泄漏 | 0 |

英文 MRR 那一行是 3A 的强中立性断言：英文 query 切不出 CJK bigram，所以它**必须**逐条不变，
不是「最好不变」。

确认集不得反向用于选参。若确认集回退，结论是 3A 未通过，不得回头调参数再跑一次确认。

---

## 10. 交付物

- `benchmark/reports/phase3a-bigram-probe.{md,json}` — 量测探针（**已完成**，本判据的依据）
- `benchmark/reports/phase3a-criteria.md` — 本文
- `benchmark/reports/phase3a/{baseline,df*-cap*,diag-*}.{md,json}` — 15 个 arm 逐个留档
- `benchmark/reports/phase3a/grid.json` + `grid-table.md` — 网格汇总
- `benchmark/reports/phase3a-selection.{md,json}` — 确定性选参（脚本产出）
- `benchmark/reports/phase3a/confirm-{heldout,validation,audit}-{baseline,candidate}.{md,json}`
- `benchmark/reports/phase3a-submission.md` — 按方案 §15 模板
- 逐 query 前后对比：改善 / 退化 / 不变 / 最大退化
- FTS 延迟与索引大小对比
- 全部失败 arm 及失败原因（不得只留最佳）

沿用 2D 立下的两条装置纪律：报告先写 `.staging`，断言通过后 MD 与 JSON **一起**替换；
每个 arm 从冻结的 2D policy 出发生成**全部**字段的 CLI 参数，运行后逐字段断言实际 policy
与预期一致。

---

## 11. Gate E 复核清单（给 Codex）

### 11.1 代码语义

1. bigram 腿是否**独立于** trigram FTS 名次，`match_source: 'bigram'` 是否真的只在
   「另两腿都没找到」时出现；
2. `bigramOnlyLimit` 是否在**完整融合排序之后**施加，被丢弃的候选是否正常补位、不占 limit；
3. 2D 冻结的 `hybrid > semantic > fts` 三档相对次序是否未被新取值改动；
4. scope / type / days 是否同时约束三条腿；
5. DF 比例上限是否作用在正确的分母（scope 内记录数，而非全库）；
6. LIKE 次数是否有硬上界，无 CJK 的 query 是否一个 LIKE 都不发；
7. bigram 腿抛错是否只降级自己、不影响另两腿；
8. 是否有任何 bigram knob 泄漏到 MCP 工具 schema。

### 11.2 实验完整性

9. 15 个 arm 是否全部实际跑过，两个 `diag-` arm 是否按预登记**未参与**选择；
10. 选参脚本是否按 §8 的顺序机械工作，能否从 JSON 复算；
11. Phase 2 校准集是否按**冻结成员**前后配对，有没有出现「按 arm 后的 ftsCount=0 重算子集」
    这个假读数（§4.1）；
12. heldout / validation / 盲审集是否在策略冻结**之后**才运行；
13. 「不含 CJK bigram 的 query 逐条不变」与「英文 MRR 完全不变」两条中立性锁是否成立；
14. 收益是否能逐条指到具体两字词，而不是笼统归给「FTS 改好了」；
15. 索引大小是否确实未变（未改 tokenizer 的直接推论，非零变化说明有别的东西被改了）。

### 11.3 反例测试

16. 高 DF 两字词（如「测试」DF=14）是否被滤掉；
17. `bigramOnlyLimit` 超限、`limit < cap`；
18. 跨 scope 的完美 bigram 命中必须不可见；
19. 三腿两两精确平局与三腿同时平局；
20. bigram 腿命中但语义腿也命中 → 必须是 `hybrid` 而非 `bigram`；
21. 两字词只在 query 里、记录里没有 → 不得凭空产出候选。

---

## 12. 已知限制（先写，不等复核指出）

1. **26 条 primary 语料校准不出尺度不变的 DF 比例。** 一档分辨力 3.85 个百分点。本阶段选出的
   比例值只是「不破门的可行值」，不是「已校准的最优值」。真校准要等 3B 的 recall-scale
   fixture（约 2000 条）。
2. **LIKE 的延迟优势是尺度相关的。** 26 条上 LIKE 比 vocab 前缀展开快 14×，但全表扫描随语料
   线性增长，vocab 范围扫描不是。交叉点未测，登记给 3B。若 3B 测出交叉点在生产规模之内，
   3A 的机制选型需要重新评估——届时 vocab 展开那 `?XY` 的不完备性也要一起重新定价。
3. **Phase 2 校准集对融合层仍然不可测**（2D 已知限制第 8 条）。它按 `ftsCount=0` 筛出，
   所以 3A 的 `bigramWeight` 无法在它上面校准——这也是本阶段把权重固定为 1、不作为自变量的
   原因。要动融合权重必须先建混合腿校准集。
4. **既有 expected-empty 仍是 5 条、仍零余量。** 2D 起登记未解决。3A 的门槛写成「不得高于 2D」
   是权宜之计；这 5 条撑不起任何泛化结论。
5. **q32 是 heldout。** 它是本阶段最直观的例子，但它的端到端读数**不能**用于选参，只能进
   fixture 做机制断言、进确认集做一次性确认。报告里引用它时必须带这句限定。
6. **两字词不等于中文分词。** 本阶段用全滑窗，必然产出「号或」这类非词。噪声控制靠 DF 上限
   与结构 cap，不靠切得准。引入分词器会给 3A 塞进第二个自变量（词典版本），本阶段不做。
7. **三字以上的中文词不在本阶段范围。** 三字词现有窗口已可达；四字及以上的窗口错位问题
   与 bigram 是同一族缺陷，但未量测，不在 3A 内顺手改。

---

## 附录 A：修订记录

（本文冻结于运行任何 arm 之前。后续修订在此追加，保留原文，写明要求方与证据。）

- **A0（2026-08-03，冻结）** 初版。依据 `phase3a-bigram-probe.md`。与方案 §10 的唯一实质
  偏离是 §3.1：方案第 3 条写「辅助候选进入 FTS 排名后再参与 RRF」，本文改为独立第三条腿，
  理由是实测证明混入 FTS 名次会让辅助候选绕过 `semanticOnlyLimit`，empty 最坏返回达 15 条
  （硬上界 3）。这条偏离需要 Codex 在 Gate E 明确认可或否决。

- **Gate E 裁定（2026-08-04）** A0 的偏离**被认可，但只到「后续实验架构」这一层，不认可为
  生产策略**。裁定原文与完整理由见 `phase3a-submission.md` 顶部。三条对本文的直接影响：

  1. **§3.2 的判断被裁定为不完整。** 本文写「`bigramOnlyLimit` 是结构护栏，最坏值由构造
     保证」——裁定指出「第三条腿 + cap」这个组合本身不构成安全方案，因为第三条腿仍会给
     已有 semantic candidate 增加一票，而 cap 只管纯 bigram 结果。q21 在 `cap=1` 下仍返回
     5 条 hybrid 误召回是实证。**下一轮不得再以「有 cap 所以最坏值受控」为前提。**
  2. **§6.3 的既有 expected-empty 门槛不豁免。** 我在提交报告里请求独立判断它的判别力，
     裁定维持原门槛，并指出正确做法是**下一轮开始前扩充并冻结更大的 empty / hard-negative
     集、再预登记新门槛**，而不是用结果出来后的 54 条集合替换既有连续性锁。
  3. **新增一个此前未考虑的设计选项**：bigram 腿是否**允许给已有候选加分**。限制成「只做
     发现」（只对另两条腿都没找到的记录贡献候选）会让 §5.2 与 §5.3 两条根因同时消失，代价
     是放弃 bigram 对头部排序的贡献。下一轮应作为独立 arm。

  本文其余部分不修改：A0 是在任何 arm 之前冻结的，裁定不回改它，只在此追加。
