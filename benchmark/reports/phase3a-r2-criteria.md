# Phase 3A-R2 判据：bigram 加票的校准

> 日期：2026-08-04
>
> 状态：**冻结于运行任何 arm 之前，也冻结于实现 `bigramVote` 之前。**
>
> 上游：
>
> - `benchmark/reports/phase3a-submission.md` 顶部 Codex Gate E 裁决（3A 不通过）
> - `benchmark/reports/phase3a-r2-dataset-rules.md` 数据集规则（sha256 `8621b6fd…`）
> - `benchmark/dataset/queries-fusion-meta.json` 数据集冻结记录与 checksum
>
> R2 是**新实验轮次**，不是 3A 的补救。3A 的结论仍是不通过。

---

## 1. Gate E 留下的问题

裁决认可了「独立第三条腿」这个架构，但明确它不是完整安全方案：

> 独立第三条腿虽然能限制纯 bigram 结果，却仍然会给已有 semantic candidate 增加一个 RRF
> 投票。q21 已经证明 `bigramOnlyLimit=1` 仍可产生 5 条 hybrid 误召回。因此「第三条腿 + cap」
> **不是完整安全方案**，下一轮必须单独校准 `bigramWeight`、共现条件或 **bigram 是否允许给
> 已有候选加分**。

3A 的两条根因都落在「加票」这件事上：

| 3A 根因 | 现象 | 与加票的关系 |
| --- | --- | --- |
| §5.2 | `bigramOnlyLimit=1` 下 q21 仍返回 5 条，多数标记 `hybrid` | bigram 给**已有语义候选**加票，把它从页外推进页内。cap 只管纯 bigram 结果 |
| §5.3 | q14 的正确答案从 rank 1 掉到 2；同 arm 上 q04 反而升 | bigram 给**已有 FTS 候选**加票，而「命中几个两字词」比 bm25 和 cosine 粗得多，等权时方向不可控 |

两条根因共用一个机制：**bigram 对一条别的腿已经找到的记录投了票。**

---

## 2. 唯一产品改动：`bigramVote`

新增一个策略字段，控制 bigram 腿的投票范围：

```ts
bigramVote: 'always' | 'discovery-only'
```

| 取值 | 语义 |
| --- | --- |
| `always` | 3A 的行为。bigram 命中的**每一条**候选都获得一个 RRF 项 |
| `discovery-only` | bigram 只对**另两条腿都没找到**的候选贡献 RRF 项。已被 FTS 或语义腿找到的记录，bigram 不投票 |

### 2.1 为什么 `discovery-only` 值得单独测

它让两条根因**同时消失**，而且是结构性地消失：

- 语义腿已找到的记录拿不到 bigram 票 → §5.2 的 hybrid 提升没有产生路径；
- FTS 已找到的记录拿不到 bigram 票 → §5.3 的等权污染不存在；
- 剩下的 bigram 贡献只有「发现」一种，而那一种**完全**落在 `bigramOnlyLimit` 的管辖范围内。

换句话说，`discovery-only` 把 Gate E 指出的缺口补成闭合：cap 从「只兜住一部分」变成
「兜住全部 bigram 引入的新增返回」。

代价明确：放弃 bigram 对头部排序的贡献。3A 实测那个贡献方向本来就不可控（同一个 arm 上
q14 掉名次、q04 升名次），所以放弃它未必是损失——但这是**待测的问题，不是已知的答案**。

### 2.2 为什么同时保留 `always` + 降权作为竞争方案

Gate E 列了三个选项，`bigramWeight` 是其中之一。`discovery-only` 是「不投票」，降权是
「投票但票轻」。两者的差别在能不能留住加票的好处：

- 若降权到某个值能同时守住误召回门槛与头部质量，它优于 `discovery-only`（保留了收益）；
- 若做不到，`discovery-only` 是更小心的形态。

这两条路必须在同一份数据集上、同一批门槛下比较，否则「哪个更好」没有答案。

### 2.3 明确不改的变量

- 不改 FTS tokenizer，不新增索引或表；
- 不改 `extractCjkBigrams` 的滑窗与预算逻辑；
- 不改 2C/2D 冻结的 `semanticDiscovery` / `semanticFloor` / `semanticOnlyLimit` / `rrfK` /
  `ftsWeight` / `semanticWeight` / `tieBreak`；
- 不改 embedding 模型与 `semantic-en-v1` 协议；
- 不改 MCP 工具 schema；
- 不改语义候选池（最近 200 条）、不改默认 90 天窗口（3B / 3C 的范围）；
- **不引入分词器。** 3A 已登记：那会塞进第二个自变量（词典版本）。

### 2.4 生产默认保持关闭

`bigramAux: false` 在 R2 通过之前不动。本轮的所有 arm 都通过 `deps.policy` 注入，
默认 profile 一个字段都不改。

---

## 3. 实现规格

### 3.1 `discovery-only` 作用在哪一步

在**融合之前**决定这条候选拿不拿 bigram 项，不是在融合之后扣分：

```text
对每个候选 id：
  ftsRank    = trigram 腿的名次（可能为 null）
  semRank    = 语义腿的名次（可能为 null）
  bigramRank = bigram 腿的名次（可能为 null）

  若 bigramVote === 'discovery-only' 且（ftsRank ≠ null 或 semRank ≠ null）：
      bigram 项不计入 score，且 match_source 不受 bigram 影响
  否则：
      score += w_bigram / (K + bigramRank)
```

两点必须成立，否则这个开关就名不副实：

1. **`match_source` 跟着变。** `discovery-only` 下，一条被 FTS 和 bigram 同时命中、无语义
   支持的记录必须仍是 `fts`（而不是任何含 bigram 的标记）——因为 bigram 在这条上没起作用。
2. **`bigramRank` 仍要如实报出**（观测字段），即使它没有参与打分。否则「这条腿本来会投给
   谁」这个事实在报告里消失，无法验证开关真的生效。

### 3.2 观测要求

`onCandidates` / `onFusion` 增加：

- `bigramVoteMode`：本次搜索实际生效的取值；
- `bigramVotesSuppressed`：因 `discovery-only` 而未计入的 bigram 项个数。这是开关生效的
  直接读数——它为 0 而 `bigramCount` 大于 0，说明开关没起作用。

运行观测（`/health`）只加计数，不记录 query 正文与两字词本身（方案 §14.10）。

---

## 4. 数据使用

### 4.1 各集合角色

| 集合 | 规模 | 角色 |
| --- | ---: | --- |
| **fusion 校准集**（S1–S5，冻结） | 62 | **本轮选参主依据。** 它是唯一能测「加票」的集合 |
| **empty-ext**（N1–N4，冻结） | 32 | 误召回主门槛 |
| 既有 5 条 expected-empty | 5 | **连续性锁，Gate E 裁定不得替换。** 与 empty-ext 并列，两道都要过 |
| 既有 tuned | 18 + 5 | 历史连续性锁，不选参 |
| Phase 2 校准集 | 121 | **3A 收益的守护读数**：R2 不得把 3A 的召回收益丢掉。不选参 |
| heldout | 18 | 策略冻结后确认 |
| 既有 validation | 20 | 第二确认集 |
| Codex Gate B 盲审集 | 40 | 冻结后确认 |

### 4.2 分层怎么用

fusion 集的五层各有明确职责，**混起来看会掩盖问题**：

| 层 | 条数 | 它在本轮回答什么 |
| --- | ---: | --- |
| S1 | 23 | 三票齐全时加票是改善还是破坏。**q14 那条根因的主测层** |
| S2 | 11 | bigram 够不着 gold → **必须逐条不变**（中立性锁） |
| S3 | 19 | bigram 提供词面锚点、语义腿佐证。加票在相关记录上的正面作用 |
| S4 | 7 | 只有 bigram 找到。`bigramOnlyLimit` 唯一完全管辖的一层 |
| S5 | 2 | S4 的对照：同样无语义佐证，词面支持来自强腿 |

S2 与 S5 的 `bigramHasGold` 都是 `false`，所以**任何 bigram 参数都不该改变它们的 gold 名次**。
这是本轮最强的中立性证据，比「不含 CJK 的 query 不变」更严——那些 query 连腿都不触发，
而 S2/S5 的 bigram 腿是**跑了但没碰到 gold**。

### 4.3 纪律

- 选参只用 fusion 集 + empty-ext + 既有 tuned/Phase2 的**不回退**判定；
- heldout、既有 validation、Codex 盲审集在策略冻结**之后**才跑，且不得反向调参；
- S4 只有 7 条（低于数据集规则 §3.2 的 8 条目标，已在冻结报告里如实登记）。
  **本轮不得把 S4 的读数单独当作结论依据**，它只能与 S3 合看或作为结构不变量的检查面；
- 不得按 arm 运行后的分层重算集合成员。分层在 `queries-fusion.json` 里已冻结，
  R2 的所有前后对比按**冻结成员**配对——这与 3A 判据 §4.1 同一条纪律，理由也相同。

---

## 5. 候选网格（预登记）

Gate E 要求「**单独**校准」，所以网格按单变量分组，不是一次全撒开。

### 5.1 实验一：只改投票范围（主实验）

```text
bigramVote = discovery-only
其余全部保持 3A 的值：dfRatioCeiling=1.0  minMatches=1  bigramOnlyLimit=2  bigramWeight=1
```

1 个 arm。它直接检验 Gate E 指出的那条根因是否被消除，唯一自变量是投票范围。

### 5.2 实验二：`discovery-only` 下重新校准两个护栏

`discovery-only` 改变了护栏的分工——噪声由 cap 结构性封顶，DF 上限不再独自承担发布门。
所以 3A 选出的值在新形态下未必是对的，必须重扫：

```text
bigramVote            = discovery-only
bigramDfRatioCeiling ∈ {0.12, 1.0}
bigramOnlyLimit      ∈ {1, 2, 3}
```

6 个 arm（含实验一那个组合，作为一致性自检：同参必须逐位相同）。

DF 比例只取两档而不是 3A 的四档：3A 实测 0.04 与 0.08 都伴随 tuned 质量退化，
而 0.12 与 1.0 在 tuned 上反而是升的（0.972/91.7%）。**这个缩减是看过 3A 结果之后做的，
如实登记；它缩的是搜索范围，不是判据。**

### 5.3 实验三：`always` + 降权（竞争方案）

```text
bigramVote     = always
bigramWeight  ∈ {0.25, 0.5, 0.75}
其余保持 3A 的值：dfRatioCeiling=1.0  minMatches=1  bigramOnlyLimit=2
```

3 个 arm。检验「投票但票轻」能不能同时守住误召回与头部质量。

权重候选的来源与目的（方案 §7.2 要求在看到结果前写明）：3A 用 1.0 时 q14 掉名次，说明
bigram 的票太重；三个值覆盖「四分之一票 / 半票 / 四分之三票」，是等距的粗扫。**不扫 >1.0**：
3A 已证明等权都过重，加重没有假设支撑。

### 5.4 基线与诊断

| arm | 配置 | 用途 |
| --- | --- | --- |
| `baseline` | `bigramAux=off` | 当前发布行为。fusion 集与 empty-ext 的基线读数 |
| `diag-3a-best` | `always` + 3A 主网格里 Phase2 收益最高的组合（DF≤1.0 cap2 w1） | 3A 的形态在新数据集上的读数。**不参与选择**，用于说明 R2 相对 3A 动了什么 |
| `diag-min2` | `always` + `minMatches=2` | 共现轴。3A 已测它压噪有效但砍收益，**不参与选择**，只作对照 |

合计 **1 + 1 + 6 + 3 + 2 = 13 次运行**（实验一与实验二有一个重合组合，仍单独跑一次做一致性自检）。

---

## 6. 门槛（预登记）

基线值一律取 `baseline` arm 的**精确值**，不取四舍五入值——3A 判定时用 0.889 让 baseline
自己「不可行」，那个教训写在这里。

### 6.1 本轮主证据：fusion 集（62 条，冻结成员）

| 指标 | 门槛 | 角色 |
| --- | --- | --- |
| S1 MRR | **≥ baseline** | q14 那条根因的主测面。加票不得破坏三票齐全时的排序 |
| S1 R-precision | ≥ baseline | 头部不回退 |
| S2 逐条返回页 | **与 baseline 完全一致** | 中立性硬锁。bigram 腿跑了但没碰到 gold，任何参数都不该改变它 |
| S5 逐条返回页 | **与 baseline 完全一致** | 同上 |
| S3 hit@5 | ≥ baseline，且**至少一个 arm 严格高于** | bigram 词面锚点的正面作用 |
| S3 + S4 合计 hit@5 | ≥ baseline | S4 只有 7 条，不单独作结论 |
| 全集 MRR | ≥ baseline | 综合不回退 |

S2/S5 那两条是**硬锁**：不一致即该 arm 不可行，不看其他指标。理由是它们证明开关只在
该起作用的地方起作用；一旦它们变了，其余读数无法归因。

### 6.2 误召回（两道并列门槛，都要过）

| 指标 | 门槛 |
| --- | --- |
| empty-ext（32）平均返回 | ≤ 1 |
| empty-ext（32）最坏返回 | ≤ 3 |
| empty-ext 中 N3 层（10）最坏返回 | ≤ 3 |
| 既有 expected-empty（5）平均 | ≤ 1.00（**不得高于 2D**） |
| 既有 expected-empty（5）最坏 | ≤ 2（**不得高于 2D**） |
| Codex 盲审 hard-negative（20）平均 / 最坏 | ≤ 0.30 / ≤ 2（冻结后确认） |

N3 层单列一行，因为它是专门瞄准 3A §5.1 失败机制建的：那 10 条刻意含高文档频率两字词。
它过不了，说明通用词噪声没被解决，而这正是本轮要解决的东西之一。

### 6.3 历史连续性锁

| 指标 | 门槛 | 2D / 3A baseline 读数 |
| --- | --- | ---: |
| tuned hit@5 | ≥ 100.0% | 100.0% |
| tuned MRR | ≥ 0.944 | 0.944 |
| tuned R-precision | ≥ 0.8889（精确值 8/9） | 88.9% |
| **Phase 2 校准集 hit@5** | **严格高于 50.0%** | 50.0%（bigram 关闭时） |

最后一行是 R2 特有的：3A 那个「关键词零命中被救回」的收益必须**留住**。若某个 arm 守住了
误召回却把 Phase 2 收益还给了 50.0%，它等于把 bigram 腿关掉了，不算通过。

### 6.4 结构不变量（硬门）

| 项 | 要求 |
| --- | --- |
| `bigramOnly` 每条数量 | ≤ min(`bigramOnlyLimit`, `request.limit`) |
| `discovery-only` 下 `bigramVotesSuppressed` | > 0（否则开关没生效） |
| `discovery-only` 下被 FTS 或语义找到的候选 | `match_source` 不含 bigram 影响 |
| 不含 CJK bigram 的 query | 逐条与 baseline 一致 |
| validation 英文 MRR | 精确保持 1.0000 |
| 跨 scope 泄漏 | 0 |
| protocol 混排 | 0 |
| search p95 | < 300 ms |
| 索引大小 | 不变（未改 tokenizer，结构上不可能变） |

---

## 7. 选参规则（确定性，跑之前写死）

先按 §6 全部门槛筛出可行 arm。可行 arm 之间按以下顺序选择，第一个能区分的准则即定胜负：

1. 最大化 fusion 集 **S3 hit@5**（bigram 词面锚点的正面收益）；
2. 若差值小于一条 query 的分辨力（1/19 ≈ 5.3pp），最大化 fusion 集**全集 MRR**；
3. 再相同，最大化 **S1 MRR**（加票没有破坏已有排序的证据）；
4. 再相同，选择 empty-ext **最坏返回**更低者；
5. 再相同，选择 empty-ext **平均返回**更低者；
6. 再相同，**优先 `discovery-only`**（护栏闭合，最坏值由构造保证，与语料规模无关）；
7. 再相同，选择 `bigramOnlyLimit` 更小者；
8. 再相同，选择 `bigramDfRatioCeiling` 更小者；
9. **若没有 arm 可行，R2 结论为未通过**，`bigramAux` 继续保持关闭，不得用「恢复原状」
   充当阶段成功。

第 6 条把「护栏是否闭合」写成平局判据而不是硬门，理由是：Gate E 指出「第三条腿 + cap」
不完整，但没有裁定 `discovery-only` 是唯一出路。若降权方案在所有质量与安全门槛上都不劣，
它保留了加票收益，应当允许胜出；只有在**读数无法区分**时才让结构性更强的那个赢。

不得用 heldout、既有 validation 或 Codex 盲审集打破平局。
选择必须由脚本从 JSON 机械算出，不得手工抄表。

---

## 8. 确认门槛（策略冻结之后才运行）

| 集合 | 指标 | 要求 |
| --- | --- | --- |
| heldout（18） | hit@5 / MRR / R-prec | ≥ 83.3% / 0.7639 / 72.2% |
| validation（20） | hit@5 / MRR / R-prec | ≥ 100.0% / 0.9417 / 90.0% |
| | 中文 MRR | ≥ 0.8833 |
| | **英文 MRR** | **精确 = 1.0000**（英文 query 切不出 CJK 两字词，结构上必须完全不变） |
| Codex 盲审（40） | 全部字段 | 不回退 |
| 三集合合计 | 跨 scope 泄漏 | 0 |

确认集回退即 R2 未通过，不得回头调参数再跑一次确认。

---

## 9. 必须新增的测试

### 9.1 `bigramVote` 语义

- `discovery-only` 下，被 FTS 找到的候选**不得**获得 bigram 项：构造一条 FTS 与 bigram 都
  命中的记录，断言它的融合分等于 `w_fts/(K+1)` 而不是加上 bigram 项；
- `discovery-only` 下，被语义腿找到的候选同样不得获得 bigram 项；
- `discovery-only` 下，两条腿都没找到的候选**仍然**获得 bigram 项（否则等于关掉这条腿）；
- `always` 与 `discovery-only` 在「只有 bigram 命中」的候选上行为**完全相同**——
  这条锁住开关只影响加票、不影响发现；
- `bigramVotesSuppressed` 计数准确：等于「bigram 命中且另有腿命中」的候选数；
- `match_source` 在 `discovery-only` 下正确：FTS+bigram 无语义 → `fts`（不是 hybrid，
  也不是 bigram）。

### 9.2 权重

- `bigramWeight` 线性生效：同一 fixture 下 `w=0.5` 的 bigram 项恰好是 `w=1` 的一半；
- `bigramWeight` 在 `discovery-only` 下仍然作用于纯发现候选（它决定这些候选排在哪）。

### 9.3 回归

- 两个冻结 profile 的回归锁加上 `bigramVote` 字段，默认值必须是 `always`
  （`always` 是 3A 的行为；把默认写成 `discovery-only` 等于在没有 Gate 的情况下改了产品）；
- 3A 的 33 条 fixture 全部保持通过——R2 不改 bigram 腿的候选生成，只改投票范围。

---

## 10. 交付物

| 文件 | 内容 |
| --- | --- |
| `benchmark/reports/phase3a-r2-dataset-rules.md` | 数据集规则（已冻结） |
| `benchmark/dataset/queries-fusion.json` 等 4 份 | 数据集（已冻结，checksum 见 meta） |
| `benchmark/reports/phase3a-r2-dataset.md` | 数据集冻结报告（已完成） |
| `benchmark/reports/phase3a-r2-criteria.md` | 本文 |
| `benchmark/run-phase3a-r2-grid.ts` | 13 arm 驱动 |
| `benchmark/reports/phase3a-r2/{baseline,*}.{md,json}` | 逐 arm 留档，含失败 arm |
| `benchmark/reports/phase3a-r2/grid.json` + `grid-table.md` | 汇总 |
| `benchmark/select-phase3a-r2-arm.ts` + `phase3a-r2-selection.{md,json}` | 确定性选参 |
| `benchmark/reports/phase3a-r2/confirm-*.{md,json}` | 冻结后确认集 |
| `benchmark/reports/phase3a-r2-submission.md` | 提交报告 |

沿用 2D / 3A 的三道装置纪律，逐条反向测试后写进提交报告：

1. 每个 arm 生成**全部**策略字段的 CLI 参数，跑完与内核上报的 policy 逐字段断言；
2. 报告先写 `.staging`，断言通过后 MD 与 JSON 一起替换，`finally` 无条件清理；
3. `BASE_POLICY` 与生产策略对象逐字段比对，并断言 `bigramAux === false`、
   `bigramVote === 'always'`——否则「baseline = 当前发布行为」不成立。

---

## 11. Gate 复核清单

### 11.1 代码语义

1. `discovery-only` 是否在**融合之前**决定投票，而不是融合之后扣分；
2. `bigramRank` 是否仍如实上报（即使未参与打分），否则无法验证开关生效；
3. `match_source` 在 `discovery-only` 下是否正确（FTS+bigram 无语义 → `fts`）；
4. `bigramVotesSuppressed` 是否等于「bigram 命中且另有腿命中」的候选数；
5. `always` 与 `discovery-only` 在纯发现候选上是否完全一致；
6. 两个冻结 profile 的默认值是否仍是 `bigramAux: false` / `bigramVote: 'always'`；
7. 是否有任何 bigram knob 泄漏到 MCP 工具 schema。

### 11.2 实验完整性

8. 13 个 arm 是否全部实际跑过，两个 `diag-` 是否按预登记未参与选择；
9. 选参脚本是否按 §7 的九条顺序机械工作，能否从 JSON 复算；
10. S2 / S5 的逐条一致性硬锁是否真的成立（这是本轮最强的中立性证据）；
11. fusion 集是否按**冻结成员**配对，有没有按 arm 后的分层重算；
12. Phase 2 收益是否留住（§6.3 最后一行）；
13. 确认集是否在策略冻结之后才跑；
14. §5.2 那处「DF 比例从四档缩到两档」的披露是否充分——它是看过 3A 结果之后做的。

### 11.3 反例测试

15. `discovery-only` 下高文档频率两字词（「测试」DF=14）命中一条已有语义候选 → 不得加票；
16. `bigramOnlyLimit` 超限、`limit < cap`；
17. 跨 scope 的完美 bigram 命中必须不可见；
18. 三腿平局在 `discovery-only` 下的行为（bigram 项被抑制后平局集会变，需确认 2D 校准的
    前三档次序仍未被污染）；
19. `bigramWeight = 0.25` 时 bigram 项是否仍能把纯发现候选排进页（否则等于变相关掉）。

---

## 12. 已知限制（先写，不等复核指出）

1. **S4 只有 7 条，低于数据集规则 §3.2 的 8 条目标。** 原因结构性：语义腿在本语料上触达
   gold 53/62 = 85%，「bigram 找到了、语义腿没找到」本来就是少数形状。本轮不得把 S4 的读数
   单独当结论依据（§4.3）。
2. **S5 只有 2 条。** 它是实测掉出来的层，不是设计出来的，样本量只够做结构不变量检查。
3. **既有 expected-empty 仍是 5 条、零余量。** 2D 起登记未解决。R2 新增了 32 条 empty-ext
   作为并列门槛，但 Gate E 明确裁定不得替换那 5 条，所以零余量的问题仍在。
4. **fusion 集是校准集，不是泛化证据。** 62 条全部由我出题、依据本项目 26 条 Observation。
   它举证的是「加票在这些形状上是否安全」，不是「R2 在任意语料上有效」。
5. **DF 比例仍未真正校准。** 26 条 primary 语料一档分辨力 3.85 个百分点（3A 已知限制 1）。
   R2 缩到两档是缩搜索范围，不是解决了分辨力问题。真校准要等 3B 的 recall-scale fixture。
6. **`discovery-only` 放弃的收益无法在本轮量化上界。** 它不投票，所以「如果投票能带来多少
   头部改善」在这个形态下测不出来。实验三的降权 arm 是唯一能给出那个上界的读数，但它只有
   三个粗档。
7. **ACP 翻译首轮失败率不低。** 78 条派生值里首轮 61/68 成功，w53/w55/n03/n04/n05/n09/n17
   等需要 1–6 次重试。这不影响冻结后的固定输入（已合并且 checksum 锁定），但说明若将来要
   扩样，翻译环节需要预留重试预算。

---

## 附录 A：修订记录

- **A0（2026-08-04，冻结）** 初版，写于实现 `bigramVote` 之前、运行任何 arm 之前。
  与 Gate E 的三个选项对应：实验一/二测「是否允许给已有候选加分」，实验三测 `bigramWeight`，
  `diag-min2` 覆盖「共现条件」（3A 已测，本轮只作对照）。
  §5.2 的 DF 比例四档缩两档是看过 3A 结果之后的决定，已在正文披露。

- **A1（2026-08-04，实现时补充，仍在运行任何 arm 之前）**
  §3.1 的 `match_source` 规则**只写了 FTS+bigram 一种情况**，而那种情况下标记是 `fts` 与
  开关无关，所以它没有真正定义开关的语义边界。被漏掉的是 **semantic + bigram**，而这一种
  的选择影响很大：

  | 方案 | `discovery-only` 下 semantic+bigram 的标记 | 后果 |
  | --- | --- | --- |
  | 抑制到底（**采用**） | `semantic` | 受 `semanticOnlyLimit=2` 约束 |
  | 只抑制打分、保留证据 | `hybrid` | 逃出 semantic cap |

  **采用「抑制到底」。** 理由：第二种方案会让 §5.2 从另一道门回来——一个噪声两字词仍然能
  提升一条 hard negative，不是靠加分，而是靠把它抬出 cap 的管辖范围。堵住那道门正是 R2 的
  全部目的，所以抑制必须是彻底的：这条腿要么对这个候选起了作用，要么没起。

  **代价是预先说明的、可测的**：S3 层（FTS ✗ + 语义 ✓ + bigram ✓，19 条）在
  `discovery-only` 下会变成 semantic-only，于是每页受 cap=2 约束。如果这个 cap 吃掉了 S3 的
  收益，网格会表现为 **S3 hit@5 没有上升**——正是 §6.1 已登记的那个读数。所以这不是一个
  被隐藏的副作用，而是一个被登记的待测后果。

  本条在实现 `bigramVote` 的同一次改动里写下，早于任何 arm 运行。A0 正文未回改。

- **A2（2026-08-04，跑基线之后、跑任何 arm 之前）：§6.2 的 empty-ext 门槛写错了，改为相对门槛**

  跑基线（bigram 关闭）时发现：**基线自己过不了我登记的门槛。**

  ```text
  empty-ext 总体   均 1.88 / 坏 10     门槛写的是 ≤1 / ≤3
    N1 完全无关     均 0.50 / 坏 2
    N2 近邻未做     均 3.00 / 坏 10
    N3 两字词噪声   均 1.80 / 坏 3
    N4 中英混合     均 2.33 / 坏 5
  ```

  这是**我的范畴错误**，不是基线的问题。既有 5 条 expected-empty 的定义是「本 scope 内
  **既无相关记忆，也无合法词汇重叠**」，绝对门槛 ≤1/≤3 是在那个定义下校准的。而 R2 的
  N2、N3、N4 **按设计就有词汇重叠**：

  - N2「跨机器同步记忆用的是哪套协议」含「记忆」「同步」「协议」，本项目确实没做跨机器
    同步，但这些词大量出现在语料里；
  - N3 的存在意义就是含「配置」「发布」「处理」这类高文档频率两字词；
  - N4 的混合脚本层同样。

  拿「无重叠」的绝对门槛去卡「按设计有重叠」的集合，重复的正是 `run.ts` 注释里已经记着的
  那个错误：q20 当年因为词汇重叠被误算进误召回，于是「压制正确结果」变成了优化方向。

  **修订后的 §6.2**：

  | 指标 | 门槛 | 类型 |
  | --- | --- | --- |
  | empty-ext 总体 均值 / 最坏 | **不得高于 baseline**（1.88 / 10） | 相对 |
  | N1（完全无关，无词面重叠） 均值 / 最坏 | ≤ 1 / ≤ 3，且不得高于 baseline（0.50 / 2） | 绝对 + 相对 |
  | N2 / N3 / N4 均值 / 最坏 | 不得高于 baseline | 相对 |
  | **N3（两字词噪声）最坏** | **不得高于 baseline 的 3** | 相对（本轮重点） |
  | 既有 expected-empty（5）均值 / 最坏 | ≤ 1.00 / ≤ 2（**不变**） | 绝对 |
  | Codex 盲审 hard-negative | ≤ 0.30 / ≤ 2（不变） | 绝对 |

  只有 N1 保留绝对门槛，因为只有它满足「无词面重叠」这个前提。其余改成「不恶化」——
  empty-ext 要回答的问题本来就是「**bigram 腿有没有让误召回变差**」，而不是「误召回是否
  低于某个绝对值」；后者是既有 5 条与盲审集的职责，它们都保留绝对门槛。

  **为什么这次修订可以接受**：基线不是候选 arm，它是当前发布行为。「不恶化」型门槛在定义上
  必须先有基线读数才能写出数字。修订发生在跑**任何 arm 之前**，也没有任何候选结果被看到。
  但它确实削弱了「纯预登记」的强度，如实登记。

  **同时记下一条数据集层面的限制**：N2 层的题面严格说更接近既有数据集的 `leakage` 类别
  （词汇重叠、返回命中可辩护），而不是 `empty`。它仍然有用——它测的是语义近邻的误召回压力
  ——但它的读数不能被解释成「系统凭空编造」。这一条写进数据集冻结报告的已知限制。
