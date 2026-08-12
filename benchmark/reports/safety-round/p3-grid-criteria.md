# 安全策略轮次 P3：floor × cap 网格判据

> 日期：2026-08-11
>
> 状态：**待冻结**。SHA-256 写入 `p3-grid-freeze.json` 之后即冻结，**第一个 arm 之前完成**。
>
> 上游：
>
> - `plan/V3/retrieval-safety-round-plan-2026-08-10.md` §8（P3 的变量、网格来源处理、选择规则）
> - `benchmark/reports/final-recall/codex-p6-ruling.md` §3 / §4 / §5（裁定对本轮矩阵的要求）
> - `benchmark/reports/safety-round/p2-calibration-criteria.md`（**r3**，四个门与 `cap ≤ 1` 排除项）
> - `benchmark/reports/safety-round/p2-calibration-freeze.json`（`frozen: true`，装置与数据的 SHA）
> - `benchmark/reports/safety-round/p2-review-clearance.md`（P2 复核放行）

---

## 1. 本文管什么

管四件事：

1. **网格**：哪 12 个 arm、每个 arm 只动哪两个值、其余全部冻结（§2）；
2. **装置**：播什么、年龄怎么定、limit 多少（§3）；
3. **读数与门**：每个 arm 必须输出什么，F1 / N1 / N2 / N3 怎么机械判定（§4、§5）；
4. **选择规则**：先写死的确定性算法（§7）。

**本文不重新定义门。** F1 / N1 / N2 / N3 与 `cap ≤ 1` 的排除项由 P2 判据 r3 §4.5 冻结，
本文只**引用**并落成可执行的计算口径。任何与 r3 冲突的读法以 r3 为准。

**本文不裁定本轮通过与否。** runner 与选择脚本机械输出，裁定由复核方作。

冻结之后不得修订。看过任何 arm 读数之后改本文，等于用结果反向选参数。

---

## 2. 网格：12 个 arm

```text
semanticFloor      ∈ {0.197, 0.223, 0.250, 0.275, 0.300, 0.325}
semanticOnlyLimit  ∈ {1, 2}
arm id = f<floor>-c<cap>，例：f0.197-c2
```

`f0.197-c2` **就是当前生产策略值**，因此它同时是基线 arm（§7 的分层不回退以它为参照）。

### 2.1 网格来源的书面登记（方案 §8 要求）

| 值 | 来源 |
| --- | --- |
| `0.197` / `0.223` / `0.275` | phase 1a 离线校准，来源干净 |
| `0.250` / `0.325` | 本文按规则铺开产生，未被任何数据单独指出 |
| `0.300` | **2026-08-10 曾在已消耗盲审集上事后横扫得出过这个启发值**（方案 D3 表格）。它出现在本网格里是"从 0.197 起以约 0.025 步长铺到 0.325"这条规则的结果，不是因为那次横扫把它挑了出来 |

方案 §8 给了两条路：等距铺开，或书面登记 `0.300` 的来源。**本文两条都做**——网格按规则等距，
同时如实登记 `0.300` 曾以启发值出现过。选择只在 P2 的新集上进行（§7）。

步长实测：`0.026 / 0.027 / 0.025 / 0.025 / 0.025`。不是精确等距，因为三个干净来源值
（0.197 / 0.223 / 0.275）必须原样保留在网格里，它们本身不等距。

### 2.2 `cap ≤ 1` 是诊断臂（r3 §4.5，本文不得放宽）

零 FTS 的 hard-negative 页面完全由 semantic-only 构成，因此 `cap=1` 让"平均返回 ≤1"
成为**算术恒真**。`cap=1` 的 6 个 arm **必须跑**（它们读出"压到底之后收益损失多少"），
但**不得进入成功候选集**。选择脚本在结构上排除 `cap ≤ 1`（§7 第 1 步），不靠人记得。

`cap=0` 未纳入网格：它的诊断价值（关掉 semantic-only 的收益损失）可由 `cap=1` 与 `cap=2`
的差读出，而方案 §8 的变量表只列了 `{1, 2}`。若复核要求补 `cap=0`，另跑并单独报告。

### 2.3 冻结不动的量

以下每一项在 12 个 arm 上完全相同，任一项变化即本轮作废：

```text
semanticDiscovery      = true
rrfK                   = 60
ftsWeight              = 1        semanticWeight = 1
tieBreak               = 'semantic-rank'
semanticCandidatePool  = Infinity
semanticTopK           = 1000
bigramAux              = false
时间窗                  = 无界（不传 days）
FTS tokenizer          = 生产 trigram，不改
limit                  = 10
```

12 个 arm 之间**只差 `semanticFloor` 与 `semanticOnlyLimit` 两个值**。

---

## 3. 装置（组成由 P2 判据 §4.6 冻结）

| 成分 | 内容 | 条数 |
| --- | --- | ---: |
| 新 gold | `benchmark/dataset/turns-safety-round.json` | 40 |
| 旧 primary | `benchmark/dataset/turns.json` 的 `scope: primary` | 26 |
| filler | `benchmark/dataset/pool-policy-filler-10k.json`，10,000 原文 × 5 副本 | 50,000 |
| **合计物理行** | | **50,066** |

旧 26 条必须播种（r3 §4.6）：`acceptable_gold` 引用了其中 **7 条**，不播种就算不出 acceptable
读数，也验证不了"只召回旧记录、没找到新记录"这个本轮要排除的失败模式。

### 3.1 时间位置

| 成分 | 时间位置 | 依据 |
| --- | --- | --- |
| 新 40 条 | 各自的 `age_days`（14…1068 天，40 个互不相同的值） | P2 冻结的一次性随机化，种子 `ageSeed.hex = dd61359b` |
| 旧 26 条 | 全部 400 天前（同一天内逐分钟递增） | 与已消耗盲审装置**逐位相同**的位置 |
| filler | 均匀铺在 1,095 天内 | 同上 |

旧 26 条沿用 400 天这个位置，是为了让本装置与已消耗审计装置**只差"新增 40 条新 gold"这一项**。
它们不是本轮主指标（`primary_gold` 只含新记录），时间位置只影响 tie-break 与 acceptable 读数。

### 3.2 插入顺序与 id

新 40 条按 `insertion_index` 升序插入（0…39，连续），因此 **observation id 的顺序与年龄无关**。
这是判据 §8 第 8 条"年龄、文本长度、插入顺序独立随机"的落地形式：`id ASC` 在本装置上
不再编码 oldest-first（裁定 §5 点出的那个混淆）。

### 3.3 向量与协议

- 空间：`semantic-en-v1`（`embeddingSpaceKey(SEMANTIC_EN_PROTOCOL)`），与生产同一空间；
- 新 40 条的英文派生值取 `mirror-en-acp-records-safety-round.json`（40/40，生产 ACP 译者）；
- 旧 26 条取 `mirror-en-acp-records.json`（26/26，与审计同一份）；
- query 英文形式取 query 集内联的 `semantic_query_en`，实测与
  `mirror-en-acp-queries-safety-round.json` **131/131 逐字相同**；
- filler 只做 **10,000 次**真实编码，5 份副本复用向量（与审计、候选池轮次同口径）。
  副本标题加 `[copy N]`，否则 FTS 命中形状退化成"同一条重复 5 次"。

### 3.4 允许的实现优化（不得改变任何返回页）

- **query 向量按文本缓存**：同一段英文在 12 个 arm 上编码结果逐位相同，且策略参数不进编码器，
  因此缓存等价于重复编码。缓存命中数写进报告 provenance。
- 语料**播种一次**，12 个 arm 复用同一个数据库文件。arm 之间只换策略对象，不动数据。

任何其他优化都不允许——特别是不得跳过某些 query、不得抽样、不得复用上一个 arm 的页面。

---

## 4. 每个 arm 必须输出的读数

缺任何一套的报告视为不完整（r3 §3.3 / §4.5 / §7.2）。

### 4.1 三套 relevance 读数（61 条）

| 读数 | 定义 |
| --- | --- |
| **primary hit@5 / MRR** | 只认 `primary_gold`（全部为新记录）。**本轮主指标** |
| **acceptable hit@5 / MRR** | 认 `acceptable_gold` 全集（40 新 + 7 旧） |
| **非 acceptable 返回数** | 页面上不在 `acceptable_gold` 里的条数：均值与最坏值 |

`acceptable_gold` 在 P2 冻结前穷举。**不得**以"这条其实也算相关"为由把某条返回项移出
非 acceptable 计数（r3 §3.3）。

### 4.2 低分正例四档（r3 §7.2）

按 query→自己 `primary_gold` 的最高余弦分四档，每档给出**条数**与**primary hit@5**：

```text
[<0.200)  [0.200,0.310)  [0.310,0.400)  [>=0.400)
```

P2 冻结的条数是 **6 / 9 / 18 / 28**（合计 61）。runner 必须复现这四个数（§6 的 S5 自证）。
`[<0.200)` 那 6 条在任何候选 floor 下都会被砍掉——**必须单独列出，不得因为难看而合并或省略**。

### 4.3 两套误召回口径（P1 已实现）

| 口径 | 定义 |
| --- | --- |
| `physicalRows` | 页面物理行数（= C1 的口径） |
| `distinctContent` | 按原文折叠：`filler:N` → `filler#(N mod 10000)`；gold 各自独立 |

两套都必须报。**判定用 `distinctContent`**（r3 §4.5）：它是真实的不同假线索数量。

### 4.4 逐 query 明细

每个 arm 保留逐 query 的：有序 `resultIds`、`resultSources`、`semanticScores`、
`ftsRank` / `semanticRank`、`ageDays`、`comparableVectors`、`aboveFloorCount`、
`scopeVectors`、`protocol`、`degraded`、`primaryRank`、`acceptableRank`。

`aboveFloorCount` 是 Top-K 截断**之前**的精确过线数（方案 D1 的那个纠正：`semanticIds`
的长度是 Top-K 保留集，**不是**过线数量）。每个 arm 都要报它的分布，因为这正是 floor
在这个规模上到底筛掉了多少的唯一直接读数。

---

## 5. 四个门的机械判定口径

门的定义由 P2 判据 r3 §4.5 冻结。本节只写"怎么算"。

### 5.1 层的定义与样本数

分层键是 query 的 `negative_type`（P2 冻结时完成标注，禁止事后补标）：

| 层 | empty 零 FTS | 词面锚点 | 合计 |
| --- | ---: | ---: | ---: |
| `foreign-domain` | 17 | 8 | **25** |
| `near-domain` | 23 | 22 | **45** |

### 5.2 判定

| 门 | 计算 | 通过条件 |
| --- | --- | --- |
| **F1** | 25 条 foreign-domain 的逐条 `physicalRows` 与逐条 `distinctContent` | **两套都必须逐条为 0** |
| **N1** | 45 条 near-domain 页面上所有返回项的 `match_source` | 全部为 `semantic`；出现 `fts` / `hybrid` 即失败 |
| **N2** | 45 条 near-domain 的 `distinctContent` 平均 | **≤ 1** |
| **N3** | 61 条 relevance：非 acceptable 结果排在**任一** `primary_gold` 之前的次数 | **必须为 0** |

N3 的精确算法（避免歧义）：对每条 relevance query，令 `p` = 页面上第一个 `primary_gold`
的位置（不存在则该 query 不产生计数——没有真命中就谈不上"压过真命中"）；
统计位置 `< p` 且不在 `acceptable_gold` 里的条数。全体求和必须为 0。

### 5.3 两个必须在跑之前写下的预测

写在这里的目的只有一个：**跑完之后没人能声称这两件事是事后解释。**
它们**不改变**任何门的判定，也不构成放宽的理由。

**预测一：N2 大概率不通过。** 方案 D3 在已消耗集上实测，near-domain 去重后的平均返回在
floor `0.197 → 0.320` 之间只从 **1.50** 降到 **1.15**，始终 >1。若本轮复现这个形状，
结论就是"floor × cap 不足以约束 near-domain，需要另开轮次"（r3 §4.5 已预写这条分支）。

**预测二：N1 在词面锚点那 22 条 near-domain 上结构性不可通过。** 那 30 条锚点 query 的定义
就是"实测会命中 FTS"（P2 §4.1 的机制发现：`ftsCount` 实测 1…50），所以它们的页面必然含
`fts` / `hybrid` 来源，而 N1 要求 near-domain 返回项 100% 为 `semantic`。

处理方式（**不动 N1 的定义**）：

- 判定**按 r3 原文执行**，覆盖全部 45 条 near-domain；
- 同时**必须**按 cohort 拆开报告：`empty-zero-fts` 的 23 条与 `lexical-anchor` 的 22 条各自一行，
  让失败位置可见；
- 若失败只出现在词面锚点那一侧，那正是裁定 §5 预登记的分支：**说明 floor / cap 无法约束
  FTS / hybrid 暴露面，需要另开 FTS 安全策略轮次**，不得继续调语义参数掩盖。

---

## 6. 结构自证（S 系列，机械计算）

这些不是策略门，是"这台仪器有没有量对东西"的自检。任一项失败则该次运行的全部读数作废。

| 项 | 检查 |
| --- | --- |
| **S1** | `p2-calibration-freeze.json` 的 14 个可校验 SHA-256 逐项一致；`frozen === true` |
| **S2** | scope 向量数 = 50,066；跨 scope 泄漏 = 0；`degraded` = 0；协议全部为 `semantic-en-v1` |
| **S3** | 本装置上实测：40 条 empty 的 `ftsCount` 全为 0；30 条锚点全部 ≥1（r3 §4.6 要求在实际装置上确认） |
| **S4** | 每个 arm 的逐 query `semanticOnly` ≤ 该 arm 的 cap（护栏自身没坏） |
| **S5** | 低分正例四档条数复现 P2 冻结值 **6 / 9 / 18 / 28** |
| **S6** | `f0.197-c2` arm 的策略对象与 `DEFAULT_RETRIEVAL_POLICY` 逐字段相等 |

S3 是判据 §4.6 明确要求的动作：零 FTS 是相对语料成立的事实，P2 阶段只播了 1 份 filler
确认（诚实边界 §5.4），本轮必须在真正的 5 份装置上重新确认。

---

## 7. 确定性选择规则（先写后跑）

选择**必须由 `benchmark/select-safety-round-arm.ts` 计算**，不得手工抄表。算法：

```text
输入：12 个 arm 的读数
基线：baseline = arm f0.197-c2（当前生产值）

1  结构排除：candidates = { arm : arm.cap >= 2 }              # r3 §4.5，排除 cap<=1
2  安全过滤：feasible = { arm ∈ candidates : F1 ∧ N1 ∧ N2 ∧ N3 全部通过 }
3  分层不回退：eligible = { arm ∈ feasible :
                            ∀档 b ∈ {<0.200, 0.200-0.310, 0.310-0.400, >=0.400}:
                              arm.primaryHitAt5[b] >= baseline.primaryHitAt5[b] }
4  若 eligible 为空 → 输出「本轮没有安全 arm」，结束。不得放宽任何门。
5  否则按字典序取最大：
     ① primary hit@5 最大
     ② primary MRR 最大
     ③ floor 最大        # 并列时取候选池更小的那个：留给误召回侧更多余量
     ④ arm id 字典序最小 # 纯为消除并列，保证可复算
```

第 3 步为什么是过滤器而不是排序键：D4 的坑是"选出一个看起来免费、实际砍掉难查询的门槛"。
把它写成过滤器意味着**任何一档回退都直接淘汰该 arm**，而写成排序键会允许"用容易档的收益
换掉难档的损失"。

第 5 步 ③ 取 floor 最大的理由：走到这一步说明两个 arm 的安全门与召回读数完全相同，
此时更高的 floor 让过线候选更少，在**历史上失败过的那一侧**留更多余量。

**没有安全 arm 就报本轮不通过**（方案 §4 禁止清单第 9 条）。不得为了产出一个候选而下调
F1 / N2、不得删掉低分正例那一层、不得把 `cap=1` 提升为候选。

---

## 8. 禁止清单

1. 不得修改 P2 的任何冻结物（14 项 SHA 全部在启动时校验）。
2. 不得修改判据 r3 的四个门或 `cap ≤ 1` 排除项。
3. 不得修改生产策略值（`DEFAULT_RETRIEVAL_POLICY`）——P5 才做这件事。
4. 不得在看过任何 arm 读数后修改本文。
5. 不得同时动第三个变量（本轮只有 floor 与 cap）。
6. 不得重判 C1（正式读数永远 1.900）、P6 或 Phase 3C（永远不通过）。
7. 不得使用最终盲审集的任何 query 选参。
8. 不得手工挑 arm；选择由脚本计算并留下逐步中间结果。
9. 不得用临时口径替换 `distinctContent` 判定（例如只报 `physicalRows` 就宣称通过）。
10. benchmark 一律用临时 dataDir / SQLite，不得碰真实用户库。

---

## 9. 产出物

| 文件 | 内容 |
| --- | --- |
| `p3-grid-criteria.md` | 本文（冻结） |
| `p3-grid-freeze.json` | 冻结记录：本文 SHA、P2 冻结引用、网格、装置契约、门、选择规则 |
| `benchmark/run-safety-round-grid.ts` | arm runner（机械仪表） |
| `p3-arms/arm-f<floor>-c<cap>.json` | 每 arm 独立报告（逐 query 明细 + 该 arm 的门读数） |
| `p3-grid-results.json` / `.md` | 12 个 arm 的汇总表 + S 系列自证 |
| `benchmark/select-safety-round-arm.ts` | 确定性选择脚本 |
| `p3-arm-selection.json` / `p3-completion.md` | 选择过程逐步中间结果 + 结论报告 |
