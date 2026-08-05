# Phase 3A-R2 提交：bigram 加票的校准 —— **未通过**

> ## Gate 裁决（2026-08-04）：**不通过，bigram 路线收口**
>
> 三条裁定，逐条落档。前两条回答本报告 §9.1 请求裁定的两件事，第三条是路线级决定。
>
> ### 裁定一：`semantic + bigram` **不算**足以逃出 cap 的双重证据
>
> 同意 §9.1 的判断，并把正式语义写死为三档：
>
> ```text
> semantic + trigram FTS  => hybrid，不受 semantic-only cap
> semantic + bigram only  => semantic，继续受 semantic-only cap
> bigram only             => bigram，受 bigram-only cap
> ```
>
> 理由不是"保守起见"，而是 `hybrid` 这个标签的含义必须稳定：它表示**语义证据 + 可靠词面
> 证据**。trigram FTS 可以承担"可靠词面证据"，两字滑窗不行。bigram 与语义同时命中，不代表
> 拿到了两个相互独立且足够强的信号——「配置 / 发布 / 处理 / 服务」这批词已经实测会**同时**
> 制造语义近邻和词面噪声，两条腿的错误是相关的，不是独立的。
>
> 当前实现符合该定义（`src/server/observation-search.ts:1013` 起的 `match_source` 判定，
> 用 `bigramVotes` 而非 `bigramRank !== null`）。
>
> **S3 那 19 条收益被 cap 吃掉不是待优化的小问题，而是"当前 bigram 机制无法同时满足收益和
> 安全"的证明。** 允许它逃出 cap，等于把已经确认的 K8s 噪声重新放回来。
>
> ### 裁定二：A2 门槛修订可接受，但证据等级降一级
>
> 接受把 empty-ext 从绝对门槛改成"不比 baseline 更差"。接受理由**不是**"改完结论没变化"，
> 而是四条：
>
> - empty-ext 本来就故意包含词面重叠，确实不适合套用"无词面重叠"前提下校准的绝对门槛；
> - 修订发生在任何候选 arm 运行之前；
> - N1、既有 5 条 expected-empty、Codex hard-negative 三处仍保留绝对门槛；
> - 新门槛仍有判别力——所有候选依然因误召回恶化而失败。
>
> 因此本轮的正式表述是**"基线后修订的预登记实验"**，不得再称"全程未修改的纯预登记实验"。
> 报告已如实披露该时点，处理正确。
>
> ### 裁定三：3A-R2 正式收口为不通过，**停止 bigram 第四轮**
>
> `bigramAux` 保持关闭，不进入任何生产 profile。三个方向都已拿到答案：
>
> | 方向 | 结论 |
> | --- | --- |
> | 调权重 | 不能减少候选数量，对误召回**无因果作用** |
> | 共现条件 | 能压噪，但同步砍掉收益 |
> | 禁止给已有候选加票 | 能消除 hybrid 放大，但纯发现仍让误召回高于基线 |
>
> **这是机制收敛，不是参数没扫够。**
>
> ### 下一步：Phase 3B，先建规模测试语料
>
> 3B **只建设和冻结装置，不改生产策略**：
>
> - `recall-scale`：约 2,000 条真实 `semantic-en-v1` 向量，标注目标放在最近 200 条之外；
> - `performance-scale`：10,000 / 50,000 条单位向量；
> - 对比最近 200 与全 scope 的 recall；
> - 测量 p50/p95/p99、RSS 和稳定性；
> - 先测全量 brute-force，**超出预算后**才考虑分页、SQLite 向量扩展或 ANN；
> - bigram 将来可以复用这份语料，但 **3B 不重新开启任何 bigram arm**。
>
> 3B 之后再做 3C 时间窗口径统一。届时才能对"默认搜索全历史"给出完整而非表面的语义——
> 把 bootstrap 也缩到 90 天是在隐藏历史，不是提升召回。
>
> 独立验证读数：495 pass / 0 fail，typecheck 通过。

---

> 结论：**按预登记判据 §7 第 9 条，R2 未通过。13 个 arm 里可行 arm 数 = 0。**
>
> 生产默认保持 `bigramAux: false` / `bigramVote: 'always'`，未进入任何 profile。
>
> 但本轮拿到了三个 3A 拿不到的结论，其中一个**否掉了 Gate E 三个选项之一**。

---

## 1. 三个主要结论

### 1.1 `discovery-only` 的机制成立，收益也真实，但不足以回到基线

| 指标 | baseline | `always`（3A 形态） | `discovery-only` |
| --- | ---: | ---: | ---: |
| S4 hit@5（只有 bigram 能找到，n=7） | 14.3% | 100% | **100%** |
| S3 hit@5（bigram + 语义，n=19） | 84.2% | 100% | 84.2% |
| fusion 全集 MRR（n=62） | 0.822 | 0.903 | 0.865 |
| empty-ext 均值 / 最坏（n=32） | 1.88 / 10 | 3.59 / 10 | **2.84 / 10** |
| N3 两字词噪声 均 / 坏（n=10） | 1.80 / 3 | 5.90 / **10** | **3.80 / 5** |
| 既有 5 条 均 / 坏 | 1.00 / 2 | 1.80 / 5 | **1.40 / 3** |
| 被抑制的 bigram 票 | 0 | 0 | **268** |

抑制票 268 说明开关在猛烈生效。它把 `always` 造成的误召回压掉近一半——**Gate E 指出的机制被证实，
封堵也确实起作用**。但每一项仍高于基线，所以按预登记门槛不可行。

### 1.2 决定性的负面发现：**`bigramWeight` 与误召回之间没有因果通路**

```text
always-w025   empty-ext 3.59/10   N3 5.90/10   fusion MRR 0.892
always-w05    empty-ext 3.59/10   N3 5.90/10   fusion MRR 0.891
always-w075   empty-ext 3.59/10   N3 5.90/10   fusion MRR 0.891
```

**三档权重的误召回读数逐字相同，一个数字都没动。**

原因是结构性的：在一条无关 query 上，一条记录**返回不返回**取决于它有没有进候选集，而不是它的
分数——`limit=10` 而这类 query 的候选常常不足 10 条。降权只改变已进页候选之间的次序，改不了
「进不进页」。

这**否掉了 Gate E 三个选项里的第一个**。不是「档位不够细」，是这个旋钮与要控制的量之间没有
因果通路。3A §5.3 曾把等权融合登记为「绑定约束」，本轮证明它**只对头部排序是约束，对误召回
不是**——那条根因的两半必须分开对待。

### 1.3 判据 A1 的预测被实测证实：护栏闭合与 S3 收益不可兼得

A1 在实现 `bigramVote` 时预先写下：`discovery-only` 下 S3 层（FTS ✗ + 语义 ✓ + bigram ✓）会变成
semantic-only，因此受 `semanticOnlyLimit=2` 约束；**若限额吃掉 S3 收益，网格会表现为 S3 hit@5
不上升。**

实测：`discovery-only` 的 S3 hit@5 **恒为 84.2%**（= 基线），`always` 是 **100%**。预测完全命中。

这是一条结构性权衡，不是参数问题：

- 要让 cap 完全管住 bigram 引入的一切，bigram 就不能给已有候选任何形式的支持；
- 一旦不给支持，S3 那 19 条记录就退回「只有语义」，于是撞上语义腿自己的限额。

**下一轮若还要走这条路，必须先回答「semantic + bigram 双词面证据的记录该不该受 semantic cap
约束」——那是 2C 冻结的护栏，动它需要独立的 Gate。**

---

## 2. 阶段与改动范围

### 2.1 阶段

Phase 3A-R2（新实验轮次，非 3A 补救）。上游 Codex Gate E 裁决：3A 不通过、架构偏离认可、
「第三条腿 + cap」不是完整安全方案，下一轮须单独校准 `bigramWeight` / 共现条件 /
**bigram 是否允许给已有候选加分**。

### 2.2 产品代码

| 文件 | 改动 |
| --- | --- |
| `src/server/observation-search.ts` | `RetrievalPolicy` 新增 `bigramVote: 'always' \| 'discovery-only'`；融合前决定投票、不做事后扣分；`match_source` 跟随抑制；新增 `bigramVoteMode` / `bigramVotesSuppressed` 观测 |

两个冻结 profile 的默认值都是 `bigramVote: 'always'`（3A 行为），回归锁已更新。

### 2.3 测量装置

| 文件 | 改动 |
| --- | --- |
| `benchmark/dataset.ts` | 新增 `origin: 'fusion'`、`FUSION_QUERIES_FILE` / `EMPTY_EXT_QUERIES_FILE`、`withFusion` / `withEmptyExt` / `withR2` 开关 |
| `benchmark/run.ts` | `--bigram-vote` 参数；`--fusion` / `--empty-ext` 加载；fusion 五层与 empty-ext 四层的分层指标；**`leaked` 定义修正**（见 §2.4） |
| `benchmark/probe-acp-translate.ts` | 新增 `--query-set=r2` |
| `benchmark/build-phase3a-r2-dataset.ts` | 数据集生成 + 三腿预检 + 分层判定 + 冻结 |
| `benchmark/run-phase3a-r2-grid.ts` | 13 arm 驱动 |
| `benchmark/select-phase3a-r2-arm.ts` | 确定性选参 |

### 2.4 一处 harness 定义缺陷，由我的 fixture 暴露

`leaked` 原本判的是「返回了任何 **other scope** 的记录」，与 query 自己在哪个 scope 无关。
在此之前所有 query 都搜 primary，两种定义完全重合，所以那个简写一直没出问题。

R2 的 **w40**「620KB 是哪个项目的数字」（gold 是 x03，属 other scope）是数据集里第一条搜 other
scope 的 query：它**正确地**在 other scope 里找到 x03，却被旧口径记成一次泄漏，于是 13 个 arm
连基线一起全部显示 `leakTotal = 1`，撞上「泄漏必须为 0」的硬门。

已改为「返回了不属于本 query 所搜 scope 的记录」。对既有全部 query（都搜 primary）两种口径给出
**完全相同**的结果，所以这是纯定义修正，不改任何历史读数。修正后全部 arm 泄漏为 **0**。

### 2.5 明确未改的变量

- 未改 FTS tokenizer、未新增索引或表；
- 未改 `extractCjkBigrams` 与 `searchObservationsByCjkBigrams` 的候选生成逻辑；
- 未改 2C/2D 冻结的 `semanticDiscovery` / `semanticFloor` / `semanticOnlyLimit` / `rrfK` /
  `ftsWeight` / `semanticWeight` / `tieBreak`；
- 未改 embedding 模型与 `semantic-en-v1` 协议、未改 MCP 工具 schema；
- **未引入分词器。**

---

## 3. Provenance

| 项 | 值 |
| --- | --- |
| commit | `b2e972f`，dirty（工作区含 Phase 1b–3A 未提交产物；按裁定不清理，它们是验收证据） |
| turnsHash / queriesHash / runHash | `aa8f9beda2a4` / `95ee03d880a9` / `2720028b1f1f` |
| Bun | 1.2.20 / darwin-arm64 |
| 数据集规则 | `8621b6fdf71fcc21`，冻结于 2026-08-04T14:51:03Z，**先于任何 query** |
| 判据（含 A1/A2） | `9097d5dc1ee46d8a` |
| 网格驱动 | `b48f57694502af4d` |
| 选参脚本 | `2f4be8ee4ee628e1` |
| 数据集构建脚本 | `1d4679e4dce8c8b9` |

数据集冻结记录（`queries-fusion-meta.json`，`frozen: true`）：

```text
9ff56d6d2c8e5187  queries-fusion.json              62 条  S1=23 S2=11 S3=19 S4=7 S5=2
d36fb3602f14dee1  queries-empty-ext.json           32 条  N1=8 N2=8 N3=10 N4=6
51736a6c2b606616  queries-fusion-eliminated.json    0 条淘汰 + 两项检查结果
07ce80e608c7fd01  mirror-en-acp-queries-r2.json    78 条派生值（62 经 ACP + 16 恒等）
语义腿触达 gold：53 / 62
```

完整命令：

```bash
bun run benchmark/build-phase3a-r2-dataset.ts --stage=full     # 数据集 + 预检 + 冻结
bun run benchmark/probe-acp-translate.ts --target=queries --query-set=r2
bun run benchmark/run-phase3a-r2-grid.ts                       # 13 arm
bun run benchmark/select-phase3a-r2-arm.ts                     # 确定性选参
```

---

## 4. 指标

### 4.1 通过的门槛

| 门槛 | 读数 | 判定 |
| --- | --- | :--: |
| **S2 / S5 逐条一致性硬锁** | **13 个 arm 合计 0 处破损** | ✅ |
| 一致性自检（`exp1-disc` vs `disc-df1-cap2` 同参） | 逐 query **0 差异** | ✅ |
| S1 MRR ≥ 基线 0.978 | 全部 arm 0.978 或 1.000，**无一回退** | ✅ |
| fusion 全集 MRR ≥ 基线 0.822 | 0.842 – 0.903 | ✅ |
| S3 hit@5 ≥ 基线，且至少一个 arm 严格更高 | `always` 系 100.0% | ✅ |
| Phase 2 hit@5 严格 > 基线 50.0% | 56.9% – 69.4% | ✅ |
| tuned hit@5 / MRR ≥ 基线 | 全部 arm 不回退 | ✅ |
| `bigramOnlyMax ≤ min(cap, limit)` | 逐 arm 成立 | ✅ |
| `discovery-only` 下抑制票 > 0 | 166 – 268 | ✅ |
| `always` 下抑制票 = 0 | 全部为 0（构造保证） | ✅ |
| 跨 scope 泄漏 | 全部 arm **0**（§2.4 修正后） | ✅ |
| search p95 < 300ms | 12.4 – 16.9ms | ✅ |

S2/S5 那一行是本轮最强的中立性证据。那 13 条 query 的 bigram 腿**跑了但没碰到 gold**，比 3A 的
「不含中文的 query 连腿都不触发」严得多——13 个 arm 里返回页一条都没变。

### 4.2 挡住全部 arm 的门槛

| arm | 挡在哪 |
| --- | --- |
| `disc-df012-cap1`（误召回最低的 discovery arm） | empty-ext 均值 2.38 > 1.88；N3 最坏 4 > 3；既有 5 条 1.40/3 > 1.00/2 |
| `exp1-disc` / `disc-df1-cap2` | empty-ext 2.84 > 1.88；N3 3.80/5；既有 1.40/3 |
| `disc-df1-cap3` | empty-ext 3.19；N3 4.60/6 |
| `always-w025/05/075` | empty-ext 3.59；N3 5.90/**10**；既有 1.80/**5** |
| `diag-3a-best`（诊断） | 同 `always-w*` |
| `diag-min2`（诊断） | empty-ext 2.25 > 1.88；N3 2.80/6；tuned R-prec 83.3% < 88.9% |

**没有任何 arm 把误召回压回基线。** 最接近的是 `disc-df012-cap1`（DF≤12% + cap1 + discovery-only），
它在 empty-ext 上是 2.38 对基线 1.88——仍高 0.5 条/query。

---

## 5. 剩余误召回的来源分析

`discovery-only` 关掉了「加票」这条路，可误召回仍然高于基线。剩下的只能是**发现**本身——
bigram 腿把新记录带进候选集，而它们在无关 query 上不该出现。N3 层（10 条，刻意含高文档频率
两字词）逐条实测：

| query（应返回空） | 基线 | `disc-df012-cap1` | `exp1-disc` | `always-w05` |
| --- | ---: | ---: | ---: | ---: |
| n17「配置项的默认值写在哪个配置文件里」 | 2 | 3 | 4 | 4 |
| n18「发布流程里的灰度发布怎么控制」 | 1 | 2 | 3 | 3 |
| n19「异常处理的统一入口放在哪一层」 | 2 | 3 | 4 | 5 |
| n20「服务端和客户端的服务发现怎么做」 | 0 | 1 | 2 | 2 |
| n21「数据迁移的数据校验怎么写」 | 2 | 3 | 4 | 4 |
| n22「测试环境的测试数据是从哪来的」 | 3 | 4 | 5 | **10** |
| n23「安装包的安装路径能不能改」 | 2 | **2** | 4 | 8 |
| n24「失败重试的失败原因怎么分类」 | 2 | 3 | 4 | **10** |
| n25「模型训练的模型版本怎么管理」 | 2 | 3 | 4 | 9 |
| n26「启动参数和启动顺序在哪里定义」 | 2 | 3 | 4 | 4 |
| **合计 / 均值** | 18 / 1.80 | 27 / 2.70 | 38 / 3.80 | 59 / 5.90 |

三件事从这张表直接读出来：

**一、`discovery-only` + `cap=1` 下每条**最多**只加 1。** 10 条里 9 条加 1、n23 加 0——
`bigramOnlyLimit` 在结构上封住了增量。对比 `always-w05` 那一列：n22 从 3 冲到 10、n24 从 2 冲到 10，
是限额管不到的 hybrid 提升。

**二、增量确实全部来自 bigram 发现。** 9 条新增里每一条的 `bigramOnlyReturned` 都恰好是 1，
`matchSources` 都含 `bigram`——归因干净，不是别的东西在动。

**三、但基线本来就不是 0**（1.80），所以「每条加 1」就是相对恶化。除非 `bigramOnlyLimit = 0`，
而那等于关掉这条腿。

**机制上的进步是真实的**：3A 时误召回主体是不可控的 hybrid 提升（`always` 那一列的 8、9、10），
R2 之后它变成完全受 cap 约束的发现增量（每条 +1）。从「漏水」变成了「按闸门放水」——
但闸门的最小非零开度仍然大于基线。

---

## 6. 逐 query 变化

以 `exp1-disc` 为例，239 行里 151 行行为改变：

| 类别 | 条数 |
| --- | ---: |
| S4 层由未命中变命中（bigram 独立发现的正面收益） | 6 / 7 |
| S2 / S5 层改动 | **0**（硬锁） |
| 被抑制的 bigram 票 | 268 |
| Phase 2 校准集 hit@5 | 50.0% → 66.7% |

fusion 集按**冻结成员**配对，分层取自 `queries-fusion.json` 的 `precheck.stratum`（数据集冻结时
由预检判定、checksum 已锁），**没有**按 arm 运行结果重算——否则「S2/S5 必须逐条不变」这条硬锁
会自我实现，因为那两层的定义本身会随 arm 漂移。

---

## 7. 测试

```text
bun test          495 pass  0 fail   （R2 新增 8 条）
bun run typecheck 干净
```

R2 新增测试（判据 §9）：

1. `discovery-only` 下被 trigram 找到的候选拿不到 bigram 票——断言分数**恰好**等于
   `w_fts/(K+1)`，不是加上第三项；
2. `discovery-only` 下被语义腿找到的候选同样拿不到票，且标记为 `semantic`（A1 定下的语义）；
3. `discovery-only` 下两条腿都没找到的候选**仍然**拿到票（否则等于关掉整条腿）；
4. 两种模式在「只有 bigram 命中」的候选上**逐条完全一致**；
5. `bigramVotesSuppressed` 精确等于「bigram 命中且另有腿命中」的候选数；
6. `bigramWeight` 线性生效（`w=0.5` 恰好是 `w=1` 的一半）；
7. `bigramWeight` 在 `discovery-only` 下仍作用于纯发现候选；
8. 高文档频率两字词命中已有语义候选时不加票——**断言方式不依赖 bm25 名次**：两种模式的分差
   恰好等于那一项被抑制的票。第一版把名次写死（以为是 FTS 第 1，实际第 4），测试报出
   0.032018 而非 0.032787，改成分差断言后既更稳也更贴近要证明的性质。

3A 的 33 条 fixture 全部保持通过——R2 未改候选生成，只改投票范围。

---

## 8. 已知限制

1. **S4 只有 7 条**（数据集规则 §3.2 目标 8）。原因结构性：语义腿在本语料上触达 gold 53/62 = 85%，
   「bigram 找到了、语义腿没找到」本来就是少数形状。判据 §4.3 因此禁止 S4 单独作结论依据。
   本轮 S4 从 14.3% 升到 100% 是最亮的读数，但它建立在 7 条样本上。
2. **S5 只有 2 条**，样本量只够做结构不变量检查。
3. **判据被修订两次，均在跑 arm 之前，均已披露。** A1 补上 §3.1 漏掉的 semantic+bigram 语义；
   A2 纠正 §6.2 的范畴错误（绝对门槛用在按设计有词面重叠的集合上）。A2 是在跑**基线**之后写的
   ——基线不是候选 arm，「不恶化」型门槛在定义上必须先有基线数字，但这确实削弱了纯预登记强度。
4. **N2 层更接近 `leakage` 而非 `empty`。** 它的题面与语料有真实词汇重叠（「跨机器同步记忆」含
   记忆/同步/协议），基线就是 3.00/10。它测的是语义近邻的误召回压力，**读数不能解释成
   「系统在编造」**。已写进数据集报告的已知限制。
5. **fusion 集是校准集，不是泛化证据。** 62 条全部由我出题、依据本项目 26 条 Observation。
6. **确认集一次都没跑**（heldout / 既有 validation / Codex 盲审集）——没有可行 arm 可冻结。
   这是纪律的结果，不是遗漏。
7. **`discovery-only` 与 semantic cap 的冲突未解。** §1.3 那条权衡需要动 2C 冻结的
   `semanticOnlyLimit` 语义，超出 R2 范围。
8. **DF 比例仍未真正校准**（3A 已知限制 1 未变）。26 条 primary 语料一档分辨力 3.85 个百分点。

---

## 9. 请求 Gate 复核

### 9.1 需要裁定的两件事

1. **A1 定下的语义是否正确**：`discovery-only` 下 semantic + bigram 的记录标记为 `semantic`
   （因而受 `semanticOnlyLimit` 约束）。备选是标记 `hybrid` 让它逃出 cap，我判定那会让 3A §5.2
   从另一道门回来。这条选择直接决定了 §1.3 的权衡，值得独立判断。
2. **A2 的门槛修订是否可接受**：绝对门槛改为「不得高于 baseline」，理由是我把「无词面重叠」
   前提下校准的门槛用在了「按设计有重叠」的集合上。修订发生在跑基线之后、跑任何候选 arm 之前。

### 9.2 推荐复跑命令

```bash
# 数据集：规则 checksum 必须先于一切；含中文却缺派生值时脚本应退出码 2
bun run benchmark/build-phase3a-r2-dataset.ts --stage=full

# 13 arm + 确定性选参。四道装置保护的反向测试**已实测**，输出见 §9.2.1
bun run benchmark/run-phase3a-r2-grid.ts
bun run benchmark/select-phase3a-r2-arm.ts

# 投票语义
bun test tests/integration/bigram-recall.test.ts
bun test && bun run typecheck

# 权重无效这条结论可独立复算：三档 empty-ext 读数应逐字相同
bun -e 'const g=await Bun.file("benchmark/reports/phase3a-r2/grid.json").json();
  console.log(g.filter(r=>r.arm.startsWith("always-w")).map(r=>
    `${r.arm} ${r.metrics.emptyExtReturned}/${r.metrics.emptyExtWorst} N3=${r.emptyLayers.N3.mean}/${r.emptyLayers.N3.worst}`).join("\n"))'
```

#### 9.2.1 四道装置保护的反向测试（实测输出，非声称）

```text
A  改坏 BASE_POLICY.semanticFloor（0.197 → 0.25）
   → BASE_POLICY.semanticFloor=0.25 与生产策略的 0.197 不一致——基线不再是当前发布行为，
     本驱动的报告会说谎

B  删掉 flagsFor 里 bigramVote 的映射
   → policy 里有未映射到 CLI 参数的字段：bigramVote

C  把 DEFAULT_RETRIEVAL_POLICY.bigramAux 改成 true
   → BASE_POLICY.bigramAux=false 与生产策略的 true 不一致——…报告会说谎

D  把 DEFAULT_RETRIEVAL_POLICY.bigramVote 改成 'discovery-only'
   → BASE_POLICY.bigramVote="always" 与生产策略的 "discovery-only" 不一致——…报告会说谎
```

四次都在**任何 arm 运行之前**失败，既有证据未被污染，无 `.staging` 残留，两个被改的文件均已
`diff -q` 确认逐字节复原。D 是 R2 新增的一道：没有它，把生产默认改成 `discovery-only` 之后
「baseline = 改动之前」这句话会静默失效。

### 9.3 重点复核项

1. `discovery-only` 是否在**融合之前**决定投票，`bigramRank` 是否仍如实上报；
2. `match_source` 在 `discovery-only` 下是否与 A1 一致；
3. `bigramVotesSuppressed` 是否精确等于「bigram 命中且另有腿命中」；
4. **S2/S5 硬锁的实现是否有判别力**——驱动比对的是 `resultIds`（有序返回页），分层取自冻结数据集；
5. `leaked` 定义修正（§2.4）是否正确、是否真的不改历史读数；
6. fusion 集是否按冻结成员配对，有没有按 arm 后的分层重算；
7. **「权重与误召回无因果通路」这个结论是否成立**——它否掉了 Gate E 的一个选项，值得独立复算；
8. 13 个 arm 是否全部跑过，两个 `diag-` 是否按预登记未参与选择；
9. 选参脚本是否按 §7 九条顺序机械工作，「可行 0 个」能否从 `grid.json` 独立复算；
10. A2 修订的时点（跑基线之后、跑候选之前）是否可接受。

### 9.4 下一轮的可能方向（不作为本轮结论）

按本轮证据，Gate E 的三个选项状态是：

| 选项 | 状态 |
| --- | --- |
| `bigramWeight` | **已否**。与误召回无因果通路（§1.2） |
| 共现条件 | 3A + R2 均测过。压噪有效但砍收益，且仍未回到基线（`diag-min2` 2.25 > 1.88） |
| bigram 是否给已有候选加分 | **机制成立**，误召回压掉近一半，但发现本身仍带来正增量（§5） |

若继续，真正未被触碰的旋钮是**候选进入条件**——即让 bigram 腿在生成候选时就更严，而不是在
融合或返回时限制。3A 的 DF 比例是这条路的一次尝试，但 26 条语料的分辨力撑不住。这需要
3B 的 recall-scale fixture 先落地。

另一条是 §1.3 指出的：重新审视「双词面证据的记录该不该受 semantic cap 约束」。那会动 2C
冻结的护栏，需要独立的 Gate。

**两条都不该作为 R2 的补救，也不该在没有新数据集支撑时开跑。**

---

## 10. 证据文件

- `benchmark/reports/phase3a-r2-dataset-rules.md` — 数据集规则（先于一切冻结）
- `benchmark/dataset/queries-fusion.json` / `queries-empty-ext.json` / `-eliminated.json` / `-meta.json`
- `benchmark/dataset/mirror-en-acp-queries-r2.json` — 78 条派生值（含恒等补齐披露）
- `benchmark/reports/phase3a-r2-dataset.md` — 数据集冻结报告（含三批披露、N2 限制）
- `benchmark/reports/phase3a-r2-criteria.md` — 判据（A0 + A1 + A2）
- `benchmark/reports/phase3a-r2/grid.json` + `grid-table.md` — 13 arm 汇总
- `benchmark/reports/phase3a-r2/{baseline,exp1-disc,disc-*,always-*,diag-*}.{md,json}` — 逐 arm 留档
- `benchmark/reports/phase3a-r2-selection.{md,json}` — 确定性选参（可行 0 个）
