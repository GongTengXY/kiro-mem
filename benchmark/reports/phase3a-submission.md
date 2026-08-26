# Phase 3A 提交：中文两字词 FTS 召回 —— **未通过**

> ## Codex Gate E 裁决（2026-08-04）：**不通过**
>
> > 代码、测试、实验留档和基线保护通过；第三条腿偏离方案的理由成立；但没有任何 arm 同时
> > 满足质量和误召回门槛，`bigramAux` 继续保持关闭。
>
> ### 裁定一：架构偏离认可，**生产策略不认可**
>
> 独立 `bigramRank` 再参与 RRF 这个偏离被认可，理由与本报告 §5.2 一致：按方案字面合并进
> FTS 排名会让结果标记成 `fts`/`hybrid`，`bigramOnlyLimit` 从此无法识别、也无法限制
> bigram-only。判据 §3.1 的解释与 `src/server/observation-search.ts` 的实现互相一致，
> `match_source` 四档定义正确（trigram+bigram 无语义仍是 `fts`，只有语义同时支持才是
> `hybrid`，纯 bigram 才是 `bigram`）。
>
> **但只认可到「后续实验架构」这一层，不认可为生产策略。** 裁决明确：
>
> > 独立第三条腿虽然能限制纯 bigram 结果，却仍然会给已有 semantic candidate 增加一个 RRF
> > 投票。q21 已经证明 `bigramOnlyLimit=1` 仍可产生 5 条 hybrid 误召回。因此「第三条腿 + cap」
> > **不是完整安全方案**。
>
> 这比本报告 §5.2 的自我纠正更进一步：我承认了 cap 兜不住 hybrid 那一类，裁决进一步指出
> 「第三条腿 + cap」这个**组合**本身就不构成安全方案，所以下一轮必须单独校准三者之一或
> 其组合：`bigramWeight`、共现条件、**或者 bigram 是否允许给已有候选加分**。
>
> 最后那一项是裁决提出、我此前未考虑的设计选项：把 bigram 腿限制成**只做发现**（只对
> 另两条腿都没找到的记录贡献候选），不给已有候选投票。它会让 §5.2 与 §5.3 两条根因同时
> 消失，代价是放弃 bigram 对头部排序的贡献。下一轮应把它作为一个独立 arm。
>
> ### 裁定二：5 条 expected-empty 门槛**不豁免**
>
> 我在 §8.2 与 §9.1 请求独立判断这条门槛的判别力，裁决维持不豁免，理由不是认为 5 条样本
> 统计上够大，而是：
>
> - 它是 arm 运行**之前**预登记的连续性锁；
> - 2D 基线已经是 1.00 / 2，没有安全余量；
> - `df004-*` 把平均误召回从 1.00 推到 1.20，**确实发生了可观察的新增误召回**；
> - 事后因为样本少而放宽门槛，会破坏本轮全部 arm 的可比性。
>
> 并且豁免不改变结论：其余 arm 仍分别挂在 tuned MRR/R-precision、Phase 2 empty 最坏值或
> q21 的头部噪声上，没有哪个 arm 会自然变成可发布配置。**豁免只会削弱实验纪律。**
>
> 样本量偏小的正确处理方式是：**下一轮开始前扩充并冻结更大的 empty / hard-negative 集，
> 再预登记新门槛。不能用结果出来后的 54 条集合替换既有连续性锁。**
>
> ### 下一轮的前置条件（裁决约束）
>
> 1. 必须作为**新的实验轮次**，不是本轮的补救；
> 2. 先建立「两腿都命中」的校准集，再研究 `bigramWeight` 或更严格的候选进入条件；
> 3. 不能运行确认集之后再回调参数。

---

> 结论：**按预登记判据 §8 第 7 条，3A 未通过。15 个 arm 里可行 arm 数 = 0。**
>
> 生产默认保持 `bigramAux: false`，未进入任何 profile。方案 §2.2 明确「floor/cap 组合不通过时，
> 把恢复关键词门写成阶段成功」判为未完成——这里同理：本报告不把「默认关闭」当成阶段成果。
>
> 召回收益是真实且量级不小的（Phase 2 校准集 hit@5 **50.0% → 68.1%**，68 条零命中 query 变为
> 有命中），但每个配置都在误召回或头部质量上越界。本报告的价值在三条有具体证据的根因，
> 而不在一个可发布的工作点。

---

## 1. 阶段

Phase 3A（方案 §10）。上游：Gate D 通过。

判据预登记于 `benchmark/reports/phase3a-criteria.md`（A0 版，冻结于运行任何 arm 之前）。
量测依据 `benchmark/reports/phase3a-bigram-probe.md`（只读探针，先于判据）。

冻结不动：`semanticDiscovery=true` `semanticFloor=0.197` `semanticOnlyLimit=2` `rrfK=60`
权重 `1:1` `tieBreak='semantic-rank'`。

---

## 2. 改动范围

### 2.1 产品代码

| 文件 | 改动 |
| --- | --- |
| `src/db/index.ts` | 新增 `extractCjkBigrams()`（全滑窗 + 预算内均匀取样）、`MemoryDB.searchObservationsByCjkBigrams()`（单次扫描 + 每两字词一列位掩码 + DF 比例过滤 + 共现过滤）、常量 `BIGRAM_MAX_UNITS=16`、`CJK_RUN_BIGRAM_RE`、`FTS_INDEXED_COLUMNS` |
| `src/server/observation-search.ts` | `RetrievalPolicy` 新增 5 字段（默认全部关闭/中性）、第三条腿融合、`match_source: 'bigram'`、`bigramOnlyLimit`、`onCandidates`/`onFusion` 归因字段 |

**连带修改**（因 `RetrievalPolicy` 加字段而必须同步的既有断言）：
`tests/integration/retrieval-policy.test.ts` 两处冻结 profile 回归锁、
`benchmark/run-codex-phase2b-audit.ts` 的 policy 字面量。

### 2.2 顺带消除的一个双份手抄

`FTS_INDEXED_COLUMNS` 是新抽出的单一事实来源。既有 LIKE 兜底分支手抄了同一份 9 列清单，
而那里的注释本身就记着这个坑踩过一次（「当它只覆盖 9 列中的 5 列时，2 字 query 无法命中
只出现在 `request` 或 `evidence_json` 里的词」）。3A 会再手抄第三份，所以就地收口。

### 2.3 明确未改的变量

- **未改 FTS tokenizer**，未切换 bigram 索引，未新增任何索引或表；
- 未改 `extractFtsSearchUnits` 的三字窗口逻辑——bigram 是新增的一路，不是替换；
- 未改语义候选池（仍最近 200 条）、未改默认 90 天窗口（3B / 3C 的范围）；
- 未改 embedding 模型与 `semantic-en-v1` 协议；
- 未改 MCP 工具 schema——5 个 knob 全是服务端检索策略。

### 2.4 索引大小：证明不变，而不是声称不变

判据 §6.5 要求报出改动前后字节数。这里给的是更强的证据——**结构上不可能变**：

```text
observations_fts tokenize 声明:  tokenize='trigram'      （未改）
bigram 方法体内写操作条数:        0
bigram 方法体内数据库调用:        1 处，this.db.query(...).all(...)
bigram 策略字段在 src/ 的出现:    仅 observation-search.ts（写路径一处都没有）
```

索引内容由写路径决定，而 5 个策略字段没有任何一个到得了写路径。所以索引与 3A 之前逐字节
相同，不需要测量。

---

## 3. Provenance

| 项 | 值 |
| --- | --- |
| commit | `b2e972f`，**dirty**（工作区含 Phase 1b–2D 未提交产物 76 项） |
| turnsHash | `aa8f9beda2a4` |
| queriesHash | `95ee03d880a9` |
| runHash | `1e313357d771` |
| datasetHash | `e02509605c3f` |
| Bun / 平台 | 1.2.20 / darwin-arm64 |
| 探针 checksum | `1c0a9b23196cec91…` `benchmark/probe-cjk-bigram.ts` |
| 网格驱动 checksum | `302125f9423b0937…` `benchmark/run-phase3a-grid.ts` |
| 判据 checksum | `f432b76a0ac27c65…` `benchmark/reports/phase3a-criteria.md` |

完整命令：

```bash
# 量测（先于判据）
bun run benchmark/probe-cjk-bigram.ts

# 15 arm 网格
bun run benchmark/run-phase3a-grid.ts
```

网格驱动沿用 2D 立下的三道纪律，全部在本轮生效：

1. 每个 arm 生成**全部 12 个策略字段**的 CLI 参数，跑完与内核上报的 policy 逐字段断言；
2. 报告先写 `.staging`，断言通过后 MD 与 JSON 一起替换，`finally` 无条件清理；
3. `BASE_POLICY` 与生产策略对象**逐字段**比对（3A 比 2D 更严：2D 允许 `tieBreak` 不同，
   3A 一个字段都不许差，因为 baseline 就是当前发布行为），并额外断言
   `DEFAULT_RETRIEVAL_POLICY.bigramAux === false`——否则「baseline = 改动之前」不成立。

**本轮对驱动做的一处改动，需要复核**：退出码 1（`allGatesOk=false`）不再终止驱动，而是记为
该 arm 的结果。理由是方案 §7.8 与判据 §10 都要求所有失败 arm 留档，而 harness 用退出码 1
表示「有门槛未达标」——第一版驱动在第一个 arm 就崩了。退出码 ≥2（参数非法、策略非法、播种
失败）仍然致命。同时给 `run.ts` 的 JSON 加了逐条门槛明细（此前只有 `allGatesOk` 布尔值，
上层想把「哪条没过」记下来只能重新实现一遍判定）。

### 3.1 三道保护的反向测试（实测输出，非声称）

```text
A  改坏 BASE_POLICY.semanticFloor（0.197 → 0.25）
   → BASE_POLICY.semanticFloor=0.25 与生产策略的 0.197 不一致——基线不再是当前发布行为，
     本驱动的报告会说谎

B  删掉 flagsFor 里 bigramOnlyLimit 的映射
   → policy 里有未映射到 CLI 参数的字段：bigramOnlyLimit

C  把 DEFAULT_RETRIEVAL_POLICY.bigramAux 改成 true
   → BASE_POLICY.bigramAux=false 与生产策略的 true 不一致——基线不再是当前发布行为，
     本驱动的报告会说谎
```

三次都在**任何 arm 运行之前**失败，所以既有证据未被污染（复原后 `grid.json` 仍是 15 arm、
`baseline.policy.bigramAux=false`、`semanticFloor=0.197`），且无 `.staging` 残留。
两个被改的文件均已 `diff -q` 确认逐字节复原。

注：C 触发的是 `BASE_POLICY` 逐字段比对，而不是我另写的那句
`bigramAux !== false` 专项断言——前者先到。专项断言因此是冗余的第二道，不是唯一一道。

---

## 4. 指标

### 4.1 基线中立性（前置条件）

不带任何 bigram 参数复跑，与已提交的 2D `default-policy.json` 对比：

```text
2D 的 145 行：逐 query 0 处字段差异（比较 21 个行为字段）
bigram 字段非零的行数：0
tunedMrr：0.9444（与 2D 逐位相同）
```

所以本轮所有读数的基线确实是「改动之前」。

### 4.2 15 个 arm 全表

primary scope 26 条记录，所以四个 DF 比例分别等价 **DF≤1 / ≤2 / ≤3 / 不设上限**——一档分辨力
3.85 个百分点，这是本阶段最重要的分辨力限制。

| arm | 自变量 | Phase2 hit@5 | Phase2 MRR | Phase2 empty 均/坏 | tuned hit@5/MRR/R-prec | 既有 empty 均/坏 | bigramOnly max | 救回 | 可行 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--: |
| `baseline` | bigram 关闭 | 50.0% | 0.458 | 0.59/2 | 100%/0.944/88.9% | 1.00/2 | 0 | 0 | — |
| `df004-cap1` | DF≤4% cap1 | 58.3% | 0.532 | 0.88/3 | 100%/0.917/77.8% | **1.20**/2 | 1 | 50 | ❌ |
| `df004-cap2` | DF≤4% cap2 | 61.1% | 0.546 | 0.92/3 | 100%/0.917/77.8% | **1.20**/2 | 2 | 50 | ❌ |
| `df004-cap3` | DF≤4% cap3 | 61.1% | 0.546 | 0.92/3 | 100%/0.917/77.8% | **1.20**/2 | 2 | 50 | ❌ |
| `df008-cap1` | DF≤8% cap1 | 59.7% | 0.530 | 0.98/**4** | 100%/0.880/72.2% | **1.80/5** | 1 | 60 | ❌ |
| `df008-cap2` | DF≤8% cap2 | 63.9% | 0.551 | **1.12/4** | 100%/0.880/72.2% | **1.80/5** | 2 | 60 | ❌ |
| `df008-cap3` | DF≤8% cap3 | 63.9% | 0.551 | **1.18/4** | 100%/0.880/72.2% | **1.80/5** | 3 | 60 | ❌ |
| `df012-cap1` | DF≤12% cap1 | 62.5% | 0.543 | 0.98/**4** | 100%/0.972/91.7% | **1.80/5** | 1 | 63 | ❌ |
| `df012-cap2` | DF≤12% cap2 | 68.1% | 0.567 | **1.14/4** | 100%/0.972/91.7% | **1.80/5** | 2 | 63 | ❌ |
| `df012-cap3` | DF≤12% cap3 | 68.1% | 0.567 | **1.22/4** | 100%/0.972/91.7% | **1.80/5** | 3 | 63 | ❌ |
| `df1-cap1` | 无上限 cap1 | 62.5% | 0.545 | 1.00/**4** | 100%/0.972/91.7% | **1.80/5** | 1 | 68 | ❌ |
| `df1-cap2` | 无上限 cap2 | 68.1% | 0.567 | **1.18/5** | 100%/0.972/91.7% | **1.80/5** | 2 | 68 | ❌ |
| `df1-cap3` | 无上限 cap3 | 68.1% | 0.567 | **1.29/6** | 100%/0.972/91.7% | **1.80/5** | 3 | 68 | ❌ |
| `diag-no-cap` | 诊断：方案字面实现 | 68.1% | 0.569 | **1.43/10** | 100%/0.972/91.7% | **1.80/5** | 9 | 68 | ❌ 诊断 |
| `diag-min2` | 诊断：共现下限 2 | 56.9% | 0.515 | 0.63/3 | 100%/0.944/**83.3%** | 1.00/2 | 2 | 14 | ❌ 诊断 |

粗体 = 破预登记门槛。判定用 baseline 的**精确值**而非四舍五入值（`tunedRPrecision` 基线是
8/9 = 0.8888…，写成 0.889 会让 baseline 自己「不可行」）。

### 4.3 通过的门槛（同样是结论的一部分）

| 门槛 | 读数 | 判定 |
| --- | --- | :--: |
| Phase 2 relevance hit@5 严格 > 50.0% | 56.9%–68.1%，全部 arm | ✅ |
| Phase 2 relevance MRR ≥ 0.458 | 0.515–0.569 | ✅ |
| `ftsCount` 由 0 变正 > 0 且可归因 | 14–68 条，其中 10–33 条能指到具体两字词 | ✅ |
| `bigramOnlyMax ≤ min(cap, limit)` | 逐 arm 成立（cap1→1、cap2→2、cap3→3、无 cap→9） | ✅ |
| **中立性锁**：不含 CJK bigram 的 query 逐条不变 | **15 个 arm 合计 0 处违规** | ✅ |
| 跨 scope 泄漏 | 全部 arm 0 | ✅ |
| search p95 < 300ms | 12.2–16.1ms | ✅ |
| 单次 search 的 LIKE 上界 | `BIGRAM_MAX_UNITS = 16`，单次扫描 | ✅ |
| 索引大小不变 | 结构上不可能变（§2.4） | ✅ |

护栏、隔离、性能、中立性都是好的。**挡住 3A 的只有噪声本身与头部质量。**

---

## 5. 三条根因（本轮的主要产出）

### 5.1 噪声是机制性的，不是阈值没调对

无分词滑窗必然产出通用两字词，它们制造真实的词面重叠但零相关性。逐条证据：

| query（应返回空） | 被召回 | 经由 | arm |
| --- | --- | --- | --- |
| q24「Excel 导出 中文乱码 编码」 | t05 | 「编码」/「导出」 | DF≤4% 起 |
| q21「Kubernetes Ingress 灰度发布配置」 | **5 条**（t05 t26 t09 t16 t03） | 「发布」「配置」 | DF≤12% 起 |
| y01「冰箱压缩机噪音大怎么处理」 | t01 | 「处理」——t01 是「FTS5 查询按字面量**处理**」 | DF≤4% |
| y17「GPU 批量推理吞吐怎么提上去」 | t02 | 两字词命中，与主题无关 | DF≤4% |
| y27「换一家云上的托管服务要改什么」 | t09 | 「服务」 | DF≤4% |
| y35「字段级别的多份表示怎么存」 | t04 | 「字段」 | DF≤4% |

DF 比例本该分开这两类词，但 26 条语料一档分辨力 3.85 个百分点：「处理」DF=3、「引号」DF≤2，
中间没有可用的切点。实测 DF 上限从 4% 放到 12%，误召回从 1.20 涨到 1.80、最坏从 2 涨到 5，
而收益只从 58.3% 涨到 62.5%——**噪声比收益涨得快**。

### 5.2 结构 cap 只兜住了一部分，判据 §3.2 的预判被实测纠正

判据 §3.2 写的是「`bigramOnlyLimit` 是结构护栏，最坏值由构造保证，与语料规模和 DF 分布都
无关」。**这句话对 `match_source='bigram'` 的结果成立，但它不是误召回的主体。**

看 `df012-cap1`：cap=1，`bigramOnlyMax=1`，护栏严格生效——可 q21 仍然返回了 5 条。因为那 5 条
里多数标记是 `hybrid`：bigram 腿给一条**本来就有语义候选**的记录加上了第三个 RRF 项，把它从
页外推进页内。cap 按定义只管纯 bigram 结果，管不到这一类。

这是本轮最重要的一处自我修正：我在判据里预判结构 cap 能兜住最坏值，实测它只兜住一部分。
「新增一条腿」和「给已有候选加一票」是两种不同的风险，前者可以用数量 cap 封顶，后者不能。

### 5.3 等权融合是另一个绑定约束

`diag-min2` 是唯一同时守住两个 empty 门槛的配置（0.63/3 与 1.00/2，均不劣于 baseline），
它只在 tuned R-precision 上退化一条 query。那一条是：

```text
q14「注入到会话里的上下文有多大 会不会超预算」  expect=[t18]
  baseline: rank=1  rPrec=1.00  page=[t18, t24, t03, t17, t02]
  min2    : rank=2  rPrec=0.00  page=[t24, t18, t03, t17, t02]
  t18 命中的两字词: 注入 / 上下 / 下文 / 预算
```

t24 命中的两字词更多，于是 bigram 名次更好，压过了 t18。而「命中了几个不同两字词」是比
bm25 和 cosine 都粗得多的排序信号，却在 `bigramWeight=1` 下拿到同等投票权。

同一个 arm 上 q04 反而从 rank 2 升到 rank 1，所以这不是「bigram 腿总是拖后腿」，而是
**一个未校准的粗信号在等权融合里既能帮忙也能捣乱**，方向不可控。

判据 §5.1 把 `bigramWeight` 固定为 1、未纳入扫参（理由是沿用 2B/2D 不动融合权重的纪律）。
**因此本轮不能事后去调它**——那正是 2D 被连续三轮复核指出的做法。这条登记为 3A 第二轮的
主假设。

---

## 6. 逐 query 变化

以 `df1-cap2`（收益最高的主网格 arm）为例，145 行里 85 行行为改变：

| 类别 | 条数 | 说明 |
| --- | ---: | --- |
| `ftsCount` 由 0 变正 | 68 | 冻结成员前后配对，分母是 baseline 名单 |
| └ 其中 hit@5 由假转真 | 13 | 真收益 |
| └ 其中能指到具体两字词 | 33 | 归因证据；其余是 bigram 让语义候选进页 |
| 不含 CJK bigram 的 query 改动 | **0** | 中立性锁 |
| 发出过辅助查询的 query | 117 / 183 | 66 条纯英文/无 CJK，一次扫描都没发 |
| 拿到 bigram 候选的 query | 85 | 其余 32 条切出的词全部 DF=0 |

**关键数据口径（判据 §4.1）**：以上全部按 Gate A 冻结的 121 条成员名单前后配对，
**没有**按 arm 跑完之后的 `ftsCount=0` 重算子集。后者会把被 3A 修好的 query 踢出分母，
让指标显示持平甚至变差，而产品其实改善了——这是本阶段最容易出的假读数，驱动里写死了口径。

---

## 7. 测试

```text
bun test          487 pass  0 fail   （新增 33 条，其中 bigram-recall.test.ts 32 条 + 回归锁 1 条更新）
bun run typecheck 干净
```

新建 `tests/integration/bigram-recall.test.ts`，六组，对应判据 §7：

1. `extractCjkBigrams` 纯函数：全滑窗不分词、无 CJK 不切、单字不成词、跨空白不拼接、去重、
   预算内尾部可达；
2. 机制 fixture：q32 最小复现（先断言两侧三字单元无交集，再断言 bigram 修好，`zeroDf=12` 归因）、
   「超时」「降级」「查询」三个技术两字词、反向 fixture（区分「语料里没有」与「被护栏拦下」）；
3. `bigramOnlyLimit` 0/1/2/3/∞ 精确条数、丢弃不占 limit、`limit < cap`、两个 cap 独立不共享预算；
4. `bigramDfRatioCeiling` 比例过滤、滤光时等同关闭但可观测状态不同；
5. 三腿平局：bigram-only 与 fts-only 精确平局时 fts 优先且压过更新时间戳；
6. 隔离（scope/type/days）、中立性（英文 query `probed=0`）、降级（语义腿挂掉仍工作、
   bigram 充当词面锚点、三腿全空、空库）。

### 7.1 写测试时抓到并修掉的一个实现缺陷

第一版把 `match_source` 定义为「命中腿数 > 1 → hybrid」。**这是错的**，而且错得不是边角：

含 query 中文三字窗口的记录**必然**含该窗口里的两字词，所以中文 trigram 命中必然也是 bigram
候选。按腿数计会把大部分中文 `fts` 结果改写成 `hybrid`，向调用方声称一份不存在的语义证据
（方案 §4.4 定义 `hybrid` = 词面与语义均支持），还会把它们从平局第 3 档挪到第 1 档。

已改为：`lexical = fts || bigram`；`hybrid = lexical && semantic`；`fts` = trigram 命中（不论
bigram）；`bigram` = 仅 bigram；`semantic` = 仅语义。两条测试正反钉住。

**顺带的结构性事实**：bigram 腿对 CJK 内容是 trigram 腿的真超集，所以「中文 trigram 命中但
bigram 不命中」结构上不可能。精确平局 fixture 因此必须用 Latin 单元制造纯 `fts` 腿——第一版
用中文，测试直接报出分数 2/61 而不是 1/61。

---

## 8. 已知限制

1. **26 条 primary 语料校准不出尺度不变的 DF 比例。** 一档分辨力 3.85 个百分点，而需要区分的
   「处理」(DF=3) 与「引号」(DF≤2) 之间没有可用切点。真校准要等 3B 的 recall-scale fixture
   （约 2000 条）。**这个限制可能是 3A 未通过的主因之一，但无法在 3A 内消除。**
2. **既有 expected-empty 仍是 5 条、零余量。** baseline 恰好 1.00 / 门槛 ≤1。`df004-*` 只因为
   q24 多回一条就破门（1.00 → 1.20）。这个门槛在这个样本量上判别力很弱，但它是 Gate B 起
   预登记的，本轮不放宽。**建议 Codex 判定它是否应扩样后再作为 3A 的否决依据。**
3. **`bigramWeight` 未扫参。** §5.3 指出它很可能是绑定约束，但判据固定了它，本轮不能事后调。
4. **LIKE 的延迟优势是尺度相关的。** 26 条上比 vocab 前缀展开快 14×（0.035ms vs 0.496ms），
   但全表扫描随语料线性增长，vocab 范围扫描不是。交叉点未测，登记给 3B。若 3B 测出交叉点在
   生产规模内，机制选型要重新评估，届时 vocab 展开那 `?XY` 的不完备性（实测漏 9 条）也要
   一起重新定价。
5. **Phase 2 校准集对融合层仍不可测**（2D 已知限制第 8 条）。它按 `ftsCount=0` 筛出，所以
   `bigramWeight` 在它上面无法校准——第二轮若要扫权重，必须先建两腿都命中的冻结校准集。
6. **q32 是 heldout。** 它是本阶段最直观的例子，进了 fixture 做机制断言，但**没有**参与选参，
   也没有跑确认集（策略未冻结，判据 §9 不允许跑）。
7. **确认集一次都没跑。** heldout / 既有 validation / Codex 盲审集全部未运行，因为没有可行 arm
   可冻结。这是纪律的结果，不是遗漏。
8. **两字词不等于中文分词。** 本轮用全滑窗，必然产出「号或」这类非词。引入分词器会给 3A 塞进
   第二个自变量（词典版本），本轮不做——但 §5.1 的证据说明这可能是绕不过去的一步。

---

## 9. 请求 Codex 验证（Gate E）

### 9.1 首先需要裁定的两件事

1. **判据 §3.1 与方案 §10 第 3 条的实质偏离**：方案写「辅助候选进入 FTS 排名后再参与 RRF」，
   我改成独立第三条腿。理由与实测在 §5.2、判据附录 A0。请明确认可或否决——若否决，3A 的
   结论不变（仍未通过），但第二轮的形状要改。
2. **既有 expected-empty（5 条、零余量）是否应作为 3A 的否决依据**（已知限制 2）。`df004-*` 仅
   因一条 query 多回一条记录而破门，同时它在 54 条的 Phase 2 empty 集上是过的（0.88/3）。
   我按预登记判据判它不可行，但这个门槛的判别力值得独立判断。

### 9.2 推荐复跑命令

```bash
# 量测探针（含播种自证：42 条 query 的 ftsCount 必须与 Phase 1b 报告逐条一致）
bun run benchmark/probe-cjk-bigram.ts

# 15 arm 网格。三道装置纪律的反向测试**已实测**，输出见 §3.1：
bun run benchmark/run-phase3a-grid.ts

# 基线中立性：不带 bigram 参数，与已提交 2D default-policy 逐 query 对比，应 0 差异
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --validation --phase2 \
  --report=/tmp/n.md --json=/tmp/n.json
bun -e 'const a=await Bun.file("benchmark/reports/phase2d/default-policy.json").json();
  const b=await Bun.file("/tmp/n.json").json(); const m=new Map(b.queryRows.map(r=>[r.id,r]));
  const K=["ranks","resultIds","ftsCount","semanticCount","semanticOnlyReturned","rPrecision","matchSources"];
  let d=0; for(const r of a.queryRows){const n=m.get(r.id);
    for(const k of K) if(JSON.stringify(r[k])!==JSON.stringify(n[k])) d++;}
  console.log("字段差异:", d, " bigram 非零行:", b.queryRows.filter(r=>r.bigramUnitsProbed).length)'

# 机制与护栏
bun test tests/integration/bigram-recall.test.ts
bun test && bun run typecheck
```

### 9.3 重点复核项

1. `match_source` 的四档定义是否正确——特别是「trigram+bigram 无语义 → `fts` 而非 `hybrid`」
   这条（§7.1）。若这条错了，2D 校准的平局分档会被污染；
2. `bigramOnlyLimit` 是否确实在完整融合之后施加、被丢弃的候选是否正常补位、与
   `semanticOnlyLimit` 是否各自独立计数；
3. DF 比例的分母是否是**本次扫描的行数**（即 scope/type/days 过滤后的记录数），而不是全库；
4. bigram 命中作为**词面锚点**开门这条判断是否成立（`!discoveryEffective && ftsCount===0 &&
   bigramRank.size===0` 才早返回）。我的理由是 bigram 命中是词面证据而非相似度判断，所以
   降级路径上无需 cosine floor 校准——这条是我加的，方案没写；
5. 冻结成员配对口径（判据 §4.1）是否真的没有出现「按 arm 后的 `ftsCount=0` 重算子集」；
6. 中立性锁的实现是否有判别力：驱动用 `bigramUnitsProbed === 0` 界定「不含 CJK bigram」，
   请确认这个界定与「结构上不可能被 3A 影响」等价；
7. 驱动接受退出码 1 的改动（§3）是否恰当，会不会掩盖真实错误；
8. 全部 15 个 arm 是否实际跑过、两个 `diag-` arm 是否按预登记未参与选择、
   选参结论「零可行 arm」是否可从 `phase3a/grid.json` 独立复算。

### 9.4 第二轮建议（若 Gate E 同意继续）

主假设来自 §5.3：**粗信号不应等权**。建议的新网格是 `bigramWeight` × 共现下限，
`bigramDfRatioCeiling` 退回粗过滤角色。但这需要：

- 一份**两腿都命中**的冻结校准集（已知限制 5），否则权重在 `ftsCount=0` 的集合上不可测；
- 判据以 A1 修订形式追加，并写明它是**看到第一轮结果之后**才设计的，证据强度弱一档。

我不建议把第二轮塞进本轮当补救。

---

## 10. 证据文件

- `benchmark/reports/phase3a-bigram-probe.{md,json}` — 量测探针（先于判据）
- `benchmark/reports/phase3a-criteria.md` — 预登记判据（A0，冻结于任何 arm 之前）
- `benchmark/reports/phase3a/grid.json` + `grid-table.md` — 15 arm 汇总
- `benchmark/reports/phase3a/{baseline,df*-cap*,diag-*}.{md,json}` — 逐 arm 留档，含失败 arm
- `benchmark/run-phase3a-grid.ts` — 网格驱动
- `benchmark/probe-cjk-bigram.ts` — 量测探针
- `tests/integration/bigram-recall.test.ts` — 机制与护栏 fixture
