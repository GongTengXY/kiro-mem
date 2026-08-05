# Phase 2D 提交（Gate D 第三轮）：RRF 精确平局收口

> **Codex Gate D：通过**（2026-08-03）。关键证据均独立复现。两条判定一并记录：
> (1) 播种时间「跨天整体平移」的方案可接受，无需改产品时钟路径；
> (2) 三次判据修订削弱了纯预登记实验的强度，但修订均有披露、选参未用确认集、最终证据按序
> 重跑，因此结论表述为**机制验证 + 无回退确认**，不作为强泛化证据。
>
> 遗留（非阻塞）：首次全量测试出现过一次 MCP 聚合时序用例瞬时失败，该文件单独复跑 12/12、
> 第二次全量 454/454。记为既有测试抖动，未在本轮修。

## 阶段

Phase 2D（方案 §9）。上游：Gate C 通过。冻结不动：`semanticDiscovery=true`
`semanticFloor=0.197` `semanticOnlyLimit=2` `rrfK=60` 权重 `1:1`。

**前两轮均未通过。** 第二轮改掉了策略的比较顺序与平局集口径；第三轮改掉的是**实验装置的
确定性**——基线本身在变，以及行为 diff 会漏报。三轮反馈都改到了实质结论，不只是措辞。

---

# 第三轮整改（本轮新增）

## P1-1 recency 基线未冻结时间 —— 已整改

**问题**：播种调 `markTurnClosed(turn.id)` 不传时间，落回运行时 `new Date()`。同一毫秒内
关闭的 turn 按 id 排、跨毫秒按时间戳排，于是 **`recency` 的第一顺位取值随机器快慢变化**。
Codex 的实证（正式报告 v16 是 `hybrid+semantic+fts`，两次独立复跑都是 `hybrid+fts+semantic`）
成立——这不是噪声，是正在被比较的基线在变。

**整改**：播种给每个 turn 显式、唯一、确定性的 `stopped_at`：**当天 UTC 零点往前 30 天**为
基准，按数据集顺序每 turn 加 1 分钟。任何两个 turn 时间都不同，`recency` 永远在第一顺位决出
结果，不会退到 id——两个顺位混用才是不确定性的来源。

**中途踩到的坑，如实留档**：第一版按建议用了写死的 `2026-01-01`，当天就跑不通——`search`
的默认时间窗是 90 天且相对墙上时钟计算，所有记录被窗口过滤，`allGatesOk: false`、全部 hit@5
归零。所以正确口径是「同一天内逐位可复现，跨天整体平移」：平移均匀，相对次序、间隔、落在
窗口内三件事都不变，平局行为完全一致。写死绝对日期会让基准集在某一天静默失效，比不确定更糟。

**验证**（不是推断）：同一命令连跑 3 次

```text
allGatesOk: true true true
1v2 逐 query 差异: 0 / 62
1v3 逐 query 差异: 0 / 62
平局进页: 18 18 18
v16 matchSources: ["hybrid","fts","semantic"]   ← 与 Codex 两次复跑一致
```

## P1-2 diffRows 不是完整页面 diff —— 已整改

**问题**：`QueryRow` 只存期望名次、**去重后的** `matchSources`、返回条数，没有有序结果 id。
两条无关 hybrid 互换时这些字段可能全不变，diff 漏报，于是「改动 N 条」「候选是
`source-confidence` 改动集的超集」「D4 覆盖数量」都无法机械证明。

**整改**：`QueryRow` 新增 `resultIds`（返回页的**有序**数据集 id），纳入 fingerprint。用数据集
id 而非数据库自增 id：与播种顺序解耦，报告里也读得懂。

**漏报量不小，所有「改动 N 条」的读数都已更新**：

| arm / 集合 | 旧（漏报） | 新（完整页面） |
| --- | ---: | ---: |
| `tb-source-confidence` | 2 | **3** |
| `tb-semantic-rank` | 4 | **5** |
| 全部 `w_sem ≥ 1.1` | 7 | **9** |
| `diag-wsem-epsilon` | 4 | **5** |
| heldout 确认集 | 4 | **5** |
| validation 确认集 | 5 | **8**（新增 v16、v20） |

指标读数一个没变——漏报的都是不影响 hit@5 / MRR / R-precision 的次序变化。但两个论断现在
可以机械证明了：改动集全部落在平局集内（越界 = 无），且
`{q02,q10,q20} ⊂ {q02,q03,q10,q14,q20}`。

## P2 staging 只保护 JSON —— 已整改

Markdown 也先写 `.staging`，断言通过后两份一起替换。断言失败不会再留下「新 MD + 旧 JSON」
这种自相矛盾的证据。运行后确认无 `.staging` 残留。

## P1-4 证据按顺序重新落盘 —— 已完成

```text
20:52:29  phase2d/grid.json
20:52:29  phase2d-selection.md
20:53:14  phase2d/confirm-heldout-candidate.json
20:53:18  phase2d/confirm-validation-candidate.json
20:53:20  phase2d/confirm-audit-candidate.json
20:53:23  phase2d/default-policy.json
```

grid → selection → confirmation → default，顺序与时间戳一致；正式 validation 现在包含 v16
的次序变化。（Gate D 通过后为清理 P2 的 `finally` 又整体重跑过一次，产出逐位一致，时间戳
是这一次的。）

---

# 第二轮整改（保留，供追溯）

## P1-1 网格不可复现 —— 已整改

**问题**：`run-phase2d-grid.ts` 的 baseline 不传 `--tie-break`，weighted / epsilon arm 也继承
内核默认值。2D 落地默认值之后，按提交文档重跑会让 baseline 变成候选，静默覆盖证据。

**整改**：每个 arm 从冻结的 2C policy 出发，**生成全部 7 个字段的 CLI 参数**，运行后与预期
policy 逐字段断言；报告先写 `.staging`，断言通过才落正式路径——所以断言发生在覆盖既有证据
**之前**。

关键的实现细节：参数不是「基线 flag + 覆盖 flag」拼接。`run.ts` 取第一个匹配的 `--name=`，
所以 `--tie-break=recency --tie-break=source-confidence` 会静默保留基线值。**这条整改当场抓到
了这个 bug**：

```text
[2D] baseline … 差异 0/145 行，平局进页 9 条
[2D] tb-source-confidence … error: arm tb-source-confidence 的实际 policy 与预期不符：
     tieBreak="recency"，预期 "source-confidence"
```

断言直接报错退出，没有产出一份看起来正常的报告。改成从合并后的完整 policy 生成参数后，
16 个 arm 的断言全部通过。

**补一道断言**：上面那个 per-arm 断言的 expected 与 CLI 参数**同源**，所以它抓不到「基线值
本身写错」——写错 `BASE_POLICY` 会让两边一起错，跑出一份 provenance 自洽但基线不是 2C 的
报告。这是我在自测反向用例时发现的（第一版反向测试改了 `BASE_POLICY.semanticFloor`，驱动
照跑通并覆盖了 baseline.json）。现在驱动会拿**生产策略对象本身**当参照物：除 `tieBreak` 外
逐字段相同，且 `tieBreak` 必须是 `recency`。

两个反向测试的实测输出：

```text
A（BASE_POLICY 写错）  → BASE_POLICY.semanticFloor=0.25 与生产策略的 0.197 不一致
                          ——基线不再是 2C 冻结值，本驱动的报告会说谎
B（漏掉 tie-break 映射）→ policy 里有未映射到 CLI 参数的字段：tieBreak
```

---

## P1-2 `semantic-rank` 不是保守扩展 —— 已整改（策略本身改了）

**问题**：源码与判据文档都声称 K=60 下 hybrid 与单腿候选不可能精确平局。**这是错的。**

```text
1/93 + 1/186 === 1/62        // hybrid(ftsRank=33, semRank=126) 撞单腿 rank=2
```

我复算确认 float64 下精确相等，并穷举了候选范围（`ftsRank ≤ 50` 是 FTS 内部 limit，
`semRank ≤ 250` 是候选池上界）：**共 17 组解**，不是孤例。原设计「语义名次优先」会把这些
平局判给 semantic-only，与方案登记的 `source-confidence` 相反——一条未经校准的新边界。

**整改**：比较器改为 Codex 推荐的顺序

```text
source-confidence 分档 → 语义名次 → recency → id
```

它在 `source-confidence` 能决定的每个平局上给出同一答案，只在**同档内**（名次互换的 hybrid
对）多给一个答案，因此是真正的保守扩展。q03 / q14 仍被解决——它们本来就是同档 hybrid。

**新增 fixture（Gate D 要求的跨腿数用例）**：

| 用例 | 内容 |
| --- | --- |
| `K=60 下跨腿数精确平局确实可达` | 断言 `1/93 + 1/186 === 1/62`，并穷举出 ≥17 组解 |
| `跨腿数精确平局：semantic-rank 与 source-confidence 同解（hybrid 优先）` | `rrfK=1` 下 hybrid(fts=3,sem=3)、fts-only(1)、semantic-only(1) 三条**分数精确相等**（用 `onFusion.ranked` 断言前提），两种策略返回**逐条相同**的次序，首位是 hybrid；反向锁住"去掉分档只按语义名次"这种改法 |

用 `rrfK=1` 建 fixture 的理由写在注释里：同一套算术在 K=1 下的最小解是 `1/4 + 1/4 === 1/2`，
只需 3 条词面 + 3 条语义候选，而 K=60 的实例需要 126 条语义候选；被检验的性质（平局上的分档
顺序）与 K 无关，K=60 的可达性由上面那行算术单独断言。

---

## P2 ε arm 不能当证明 —— 已整改（平局集改为实测）

**问题**：`1.000001` 是有限扰动，一般情况下可能翻转分数只是足够接近的严格有序对；生产
比较器判的是 float64 `===`。

**整改**：内核 `onFusion` 新增 `ranked`，报出它**自己算出的**融合分与完整排序（cap 与 limit
之前）。benchmark 按 `===` 分组枚举平局，只计入「至少一名成员进了结果页」的组——页外深处的
平局不影响任何指标。逐 query 落 `exactTiePairs` / `exactTieInPage`，聚合落
`exactTieQueries` / `exactTieInPageQueries` / `exactTiePairsTotal`。

**这不是形式整改，实测与 ε 差得很远**：

| 运行 | ε 推断 | 实测平局进页 |
| --- | ---: | ---: |
| `--phase2 --no-heldout`（145 行） | 4 | **9** |
| heldout 确认集（42 行） | 4 | **11** |
| validation 确认集（62 行） | 5 | **18** |

**连带修正一处第一轮的错误陈述**：第一轮报告写「heldout 一条精确平局都没有」。实测是
**2 条**（q26、q38），只是候选没有改变它们的次序——规则按证据判出的结果恰好与 recency 相同。
「无平局」和「有平局但同解」是两件事，第一轮把后者说成了前者。

平局进页按子集（validation 运行，62 行）：tuned 8 / heldout 2 / validation 7 / leakage 1。

ε arm 保留为辅助诊断，本轮它的 4 条改动确实落在 9 条平局集内，但报告明确写这是读数、不是
它可靠的证明。

**源码注释里把 q04 说成 transposed tie 的错误也已改正**——现有证据（P2 的实测平局集）证明
q04 不在平局集内，它是非平局重加权收益。

---

## 1. 结构性发现（保留，未受整改影响）

**§9.3 的主判据在合法选参集上不可达。** 16 个 arm 在 Phase 2 校准集 121 行上**全部逐位零
差异**（72 relevance + 49 empty）。原因是结构性的：2A 按 `ftsCount === 0` 筛出这批 query，
每条只有语义腿在工作，而 semantic-only 的融合分 `w_sem/(rrfK + semRank)` 对任何正权重、正 K
都随 `semRank` 单调递减，次序恒等于 `semRank`；不同 `semRank` 不同分，tie-break 永不触发。

**`rrfK` 在本语料上是空操作**：`k30-wsem1` / `k60-wsem1` / `k90-wsem1` 与基线逐位零差异。

**§9.1 登记的 tie-break 触及不到主导平局形状**：`source-confidence` 只解决 9 条平局里的 2 条
（q10、q20），两条都只是页面第 2、3 位互换，零指标变化。真正让期望目标丢掉第 1 位的是同档
hybrid 名次互换（q03、q14）：

```text
目标      ftsRank=2, semRank=1 → 1/62 + 1/61 = 0.0325223…
压住它的  ftsRank=1, semRank=2 → 1/61 + 1/62 = 0.0325223…   ← 精确相等，且同为 hybrid
```

---

## 2. 改动范围

| 文件 | 行为变化 |
| --- | --- |
| `src/server/observation-search.ts` | `tieBreak` 新增 `'semantic-rank'`：**分档 → 语义名次 → recency → id**（P1-2）；`onFusion` 新增 `ranked`（id / 实际融合分 / matchSource / semRank，cap 与 limit 之前）（P2）；`DEFAULT_RETRIEVAL_POLICY.tieBreak = 'semantic-rank'`，其余 6 字段未动；注释改正跨腿平局可达性与 q04 归属 |
| `src/server/worker.ts` | `/health` 的 `retrieval` 块新增 `tie_break`：`profile: 'default'` 在 2C 与 2D 构建上同名，没有这个字段无法从 `/health` 分辨实际服务哪套融合次序 |
| `benchmark/run.ts` | `--tie-break` 放开到三值；捕获 `onFusion.ranked`，按 float64 `===` 枚举平局；`QueryRow` 新增 `exactTiePairs` / `exactTieInPage`；`retrievalMetrics` 新增三个平局聚合。**第三轮**：播种传显式确定性 `stopped_at`（P1-1）；`QueryRow` 新增有序 `resultIds`（P1-2） |
| `benchmark/run-codex-phase2b-audit.ts` | 新增 `--tie-break`（floor/cap/K/权重仍写死为 Gate B 选中值）；报告 policy 行改为按实际策略输出 |
| `benchmark/run-phase2d-grid.ts`（新） | 16 arm 驱动，全部显式钉死完整 policy + 运行后断言 + 对生产策略的独立校验；行为差异刻意剥离平局诊断字段，否则加权 arm 会因元数据变化虚报。**第三轮**：Markdown 与 JSON 一起 staging（P2） |
| `benchmark/select-phase2d-arm.ts`（新） | 平局集读实测 `exactTieInPage`；D1a 改为「改动集 ⊆ 平局集」；新增 D3 保守扩展检查；含确认集污染自检 |
| `tests/integration/retrieval-policy.test.ts` | 见「测试」 |
| `tests/integration/ingest.test.ts` | `/health` 断言新增 `tie_break`：默认 `semantic-rank`、回滚 `recency` |
| `README.md` / `docs/i18n/README.zh.md` | 回滚描述补上平局策略 |

### 明确未改的变量

`rrfK=60`、`ftsWeight=1`、`semanticWeight=1`、floor `0.197`、cap `2`、discovery 开关、模型与
`semantic-en-v1` 协议、FTS tokenizer、200 条候选池、90 天窗口、`limit` 默认值、MCP 工具
schema、`metric_events` schema、Observation 写入路径、向量空间键。回滚 profile 仍是整份 1b
（`tieBreak: 'recency'`）。

---

## 3. Provenance

- commit `b2e972f`，工作区有未提交改动（1b/2A/2B/2C/2D 全部未提交）
- Bun 1.2.20 / darwin arm64；`kiro-cli 2.15.1`
- 生产默认（无任何 flag）：`discovery=on floor=0.197 cap=2 rrfK=60 w=1:1 tieBreak=semantic-rank`
- checksum：`turns.json aa8f9beda2a4`、`queries.json 95ee03d880a9`、`queries-phase2.json 908efa997041`、
  `run.ts 9781779426b5`、`run-phase2d-grid.ts 83a1ab6d7417`、`select-phase2d-arm.ts 416b6de859c6`、
  `observation-search.ts 384b9ff7ed30`
- 播种时间口径：`stopped_at` = 当天 UTC 零点 − 30 天 + 数据集序号 × 1 分钟（同一天内逐位可复现）
- 判据：`benchmark/reports/phase2d-criteria.md`，含**三次**修订披露（A1–A3 第一轮、A4–A6 第二轮、A7–A10 第三轮）
- 命令：

  ```bash
  bun run benchmark/run-phase2d-grid.ts        # 16 arm，全部 --no-heldout + policy 断言
  bun run benchmark/select-phase2d-arm.ts      # 确定性选参
  # 冻结后才跑的三份确认集，全部显式钉死完整策略
  BASE="--semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 --rrf-k=60 --fts-weight=1 --semantic-weight=1"
  bun run benchmark/run.ts --compressor=gold --protocol=semantic-en $BASE --tie-break={recency,semantic-rank}
  bun run benchmark/run.ts --compressor=gold --protocol=semantic-en $BASE --validation --tie-break={recency,semantic-rank}
  bun run benchmark/run-codex-phase2b-audit.ts --input=benchmark/reports/phase2b-codex-blind-audit-input.json \
    --expected-input-sha256=dc9a0ba59f1e6d638d71aed775e075da52eb0beda566678a77a88e58832f44e5 --tie-break={recency,semantic-rank}
  ```

---

## 4. 指标

### 4.1 选参（Phase 2 校准集 + tuned 连续性锁，`--no-heldout`，145 行）

实测平局进页：**9** 条（`q02,q03,q06,q07,q10,q14,q15,q16,q20`）。

| arm | 行为改动 | D1a 不越界 | D3 保守扩展 | Phase2 hit@5/MRR | tuned hit@5/MRR/R-prec | 可行 |
| --- | ---: | :--: | :--: | ---: | ---: | :--: |
| `baseline`（2C） | 0 | — | — | 50.0% / 0.458 | 100.0% / 0.889 / 83.3% | — |
| `tb-source-confidence` | 3 | ✅ | ✅ | 50.0% / 0.458 | 100.0% / 0.889 / 83.3% | ✅ |
| **`tb-semantic-rank`** | **5** | ✅ | ✅ | 50.0% / 0.458 | 100.0% / **0.944** / **88.9%** | ✅ |
| `k{30,60,90}-wsem1` | 0 | ✅ | ❌ | 50.0% / 0.458 | 100.0% / 0.889 / 83.3% | ❌ 一条平局未解决 |
| `k{30,60,90}-wsem{1.1,1.25,1.5}` | 9 | ❌ | ✅ | 50.0% / 0.458 | 100.0% / 0.972 / 88.9% | ❌ **越界改动 q04、q11、q13**（不在平局集内） |
| `diag-wsem-epsilon` | 5 | 辅助诊断，不参与选择 | | | 100.0% / 0.944 / 88.9% | — |

D2 在所有 arm 上成立（Phase 2 三项不回退、两个 empty 口径不恶化、tuned 不回退、
`semanticOnlyMax=2`、泄漏 0、p95 < 300ms）。D4 在两个可行 arm 间按「解决更多平局」选中
`tb-semantic-rank`（**5/9 vs 3/9**），且它的改动集是 `source-confidence` 的严格超集：
`{q02,q10,q20} ⊂ {q02,q03,q10,q14,q20}`——这一点现在由有序 `resultIds` 机械证明。

### 4.2 确认集（策略冻结之后才运行）

| 集合 | 指标 | 基线 | 候选 |
| --- | --- | ---: | ---: |
| heldout（18） | hit@5 / MRR / R-prec | 83.3% / 0.7639 / 72.2% | 83.3% / 0.7639 / 72.2% |
| | 该集合行为改动 | — | **0**（42 行里改动 5 条，全在 tuned/leakage） |
| validation（20） | hit@5 | 100.0% | 100.0% |
| | MRR | 0.9167 | **0.9417** |
| | R-precision | 85.0% | **90.0%** |
| | 英文 MRR | 0.9500 | **1.0000** |
| | 中文 MRR | 0.8833 | 0.8833 |
| Codex 盲审（40） | 全部 summary 字段 | — | **逐字段完全一致**（hit@5 100% / MRR 1.000 / empty 0.30-2 / semOnly max 2） |
| 两个 empty 口径 | expected-empty 均/坏 | 1.00 / 2 | 1.00 / 2 |
| 全部集合 | 跨 scope 泄漏 | 0 | 0 |
| 全部集合 | **越界（改动 ∉ 平局集）** | — | **无** |

行为改动明细（完整页面 diff）：heldout 运行 5/42 = `q02,q03,q10,q14,q20`；validation 运行
8/62 = `q02,q03,q10,q14,q20,v13,v16,v20`。平局进页分别为 11 / 18 条，改动全部落在其中。

`v13` 是 Phase 1b 唯一那条退化（协议切换把它从 rank 1 压到 2）。实测证明它是精确平局，
2D 把它修回 rank 1，英文半 MRR 回到 1.000。

**判据分歧仍在，仍由 Codex 判定**：§9.3 写「三者的 hit@5 均不得回退，MRR / R-precision 至少
一项上升」。逐集合严格读，heldout 与审计集两项都不变；跨三集合读，validation 两项都升。
机制说明：heldout 只有 2 条平局且规则与 recency 同解，审计集 40 条全部 `ftsCount=0`（单腿
页面，结构上无平局）——是不可测，不是未达标。

### 4.3 生产默认 == 选中 arm

不传任何 flag 重跑：逐 query **0 / 145** 差异，policy 两份一致。

---

## 5. 逐 query 变化

改善 **3** / 退化 **0** / 页面次序变化但指标不变 **5**。最大退化：无。**全部 8 条都落在实测
平局集内**（越界 = 无）。下表来自完整页面 diff，不是去重后的 `matchSources`。

| query | 集合 | 变化 | 页面 |
| --- | --- | --- | --- |
| q03 | tuned | rank **2 → 1** | `t17,t03,…` → `t03,t17,…`（并连带 t12/t09 互换） |
| q14 | tuned | rank **2 → 1**，R-prec 0 → 1 | `t24,t18,…` → `t18,t24,…` |
| v13 | validation | rank **2 → 1**，R-prec 0 → 1 | `t08,t04,…` → `t04,t08,…`；修回 1b 唯一退化 |
| q02 | tuned | rank 2 不变 | 第 7、8 位 `t22,t08` → `t08,t22` |
| q10 | tuned | rank 1 不变 | 第 3、4 位 `t23,t15` → `t15,t23` |
| q20 | leakage | 无期望目标，泄漏仍 0 | 第 2、3 位 `t25,t07` → `t07,t25` |
| v16 | validation | rank 1 不变 | 第 4–7 位 `t08,t07,t04,t03` → `t07,t08,t03,t04` |
| v20 | validation | rank 1 不变 | 第 6、7 位 `t13,t10` → `t10,t13` |

后 5 条是 P1-2 修好之后才可见的——它们不动任何指标，但它们是「候选只在平局上生效」这个
论断的组成部分：**改动集必须完整可见，才谈得上证明它没有越界**。

---

## 6. 测试

```text
bun test          → 454 pass / 0 fail（2C 是 444，Gate D 第一轮 452）
bun run typecheck → 干净
git diff --check  → 干净
```

`tests/integration/retrieval-policy.test.ts` 的平局用例：

| 用例 | 钉住什么 |
| --- | --- |
| 默认策略回归锁 | 七字段，`tieBreak='semantic-rank'`，注明 `rrfK`/权重是刻意未动 |
| 同档 hybrid 平局 ×3 | `recency` 取更新者；**`source-confidence` 分辨不出，与 `recency` 同解**；`semantic-rank` 让语义第 1 胜出。前提（bm25 名次 1/2 与语义名次 2/1）用 `onCandidates` 断言 |
| **K=60 跨腿数平局可达** | `1/93 + 1/186 === 1/62`，且穷举出 ≥17 组解（P1-2） |
| **跨腿数平局：两策略同解** | `rrfK=1` 三方精确平局，前提用 `onFusion.ranked` 断言分数相等；两策略返回逐条相同、首位 hybrid（P1-2） |
| 跨腿平局与 `source-confidence` 同解 | 单腿对单腿时有语义名次者优先 |
| 不污染非精确平局 | 成对不变量：分数**严格不同**的候选对，三策略下相对次序一致；断言 fixture 确实含平局、可比对数 ≥ 8 |
| `onFusion` 报出实际融合分排序 | `ranked` 是 cap/limit 之前的全量，分数可按公式复算到 float64 精度（P2 的枚举就读它） |
| `validateRetrievalPolicy` | 三个合法值接受，非法值仍拒 |
| `/health`（`ingest.test.ts`） | 默认 `semantic-rank`；回滚仍 `recency` |

两条既有用例改为显式传 `tieBreak: 'recency'`（它们测的是这个取值本身，此前借用了「默认就是
recency」这个前提）。断言的行为一个字没改。

---

## 7. 已知限制

**本轮的证明性质**：这是**机制验证 + 无回退确认**，不是强泛化证据。判据经过三次修订（全部
有披露），因此"纯预登记实验"的证明强度被削弱；能站住的是三件事——缺陷机制由 fixture 与实测
平局集确定、最终策略选参只用了校准集与连续性锁、三份确认集在冻结之后按顺序运行且无回退。
不要把 validation 上的 MRR / R-precision 上升读成泛化收益。

1. **收益落在 tuned 与 validation 上；heldout 与审计集不可测。** heldout 只有 2 条平局且同解，
   审计集全是单腿页面。改善 3 条 query，量级小（tuned 单条 5.6pp / validation 5.0pp）。
2. **9 条平局里解决了 5 条，"解决"是可见口径、会低估。** 另 4 条上规则按证据判出的次序与
   recency 相同，所以不进改动集，但平局已不由时间戳决定。低估对结论安全：胜出者的改动集是
   次优者的严格超集（`{q02,q10,q20} ⊂ {q02,q03,q10,q14,q20}`）。
3. **§9.1 的「真实 ACP 每轮 4–6 条 heldout」未复现，也无法单变量复现。** 那是 1b 策略在 ACP
   模式下的读数；当前 2C 策略 + gold 语料下 heldout 有 2 条平局、0 条被改。要在 ACP 语料上做
   单变量对比需要「生成一次语料、两个 policy 各跑一遍」的复用机制，`run.ts` 没有。登记为缺失
   基础设施，本轮不建。
4. **`w_sem>1` 的第二段收益（q04）刻意没拿。** 它越界改动非平局候选，被 D1a 拒；要拿需要一份
   两腿都命中的冻结校准集。不要读成「加权 RRF 无效」。
5. **判据与实验装置被改过三次，三次都是被复核指出的。** 第一轮 B1/B2 分支不完备（A1）；
   第二轮平局集口径与 D1/D3 方向（A4）、策略比较顺序（A5）、网格可复现性（A6）；第三轮
   基线时间不确定（A7）、fingerprint 漏报（A8）、staging 只保护 JSON（A9）。全部在判据文档
   留档，未改动上一版正文。
6. **播种时间的确定性是「同天内逐位可复现，跨天整体平移」，不是绝对可复现。** 因为 `search`
   的 90 天窗口相对墙上时钟计算，绝对基准会让基准集某天静默失效（已实测：写死 2026-01-01
   当天全部 hit@5 归零）。跨天平移是均匀的，相对次序、间隔与落在窗口内都不变。要做到绝对
   可复现需要给 benchmark 注入固定"现在"，那要改产品的时间读取路径，超出 2D。
7. **既有 expected-empty 仍 1.00 / 门槛 ≤1，零余量。** Gate B 起登记，2D 未改善未恶化。
8. **Phase 2 校准集对融合层永久不可测。** 按 `ftsCount=0` 筛出，这对 2B 正确，对任何融合改动
   都是结构盲区。3A 之后若还要动融合，必须先建混合腿校准集。

---

## 8. 请求 Codex 复核

```bash
# P1-1（第三轮）：确定性。同一命令连跑 3 次，逐 query 必须 0 差异
BASE="--semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 --rrf-k=60 --fts-weight=1 --semantic-weight=1 --tie-break=recency"
for i in 1 2 3; do bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --validation $BASE \
  --report=/tmp/det-$i.md --json=/tmp/det-$i.json; done
bun -e 'const s=r=>{const{latencyMs,...x}=r;return JSON.stringify(x)};
  const [a,b,c]=await Promise.all([1,2,3].map(i=>Bun.file(`/tmp/det-${i}.json`).json()));
  for (const [n,x] of [["1v2",b],["1v3",c]]) console.log(n, a.queryRows.filter((r,i)=>s(r)!==s(x.queryRows[i])).length);
  console.log("v16", JSON.stringify(a.queryRows.find(r=>r.id==="v16").resultIds))'

# P1-2（第三轮）：完整页面 diff。resultIds 必须在 QueryRow 里且进入 fingerprint
grep -n "resultIds" benchmark/run.ts benchmark/run-phase2d-grid.ts

# P1-1/P2（第二、三轮）：三道保护。A 改坏 BASE_POLICY 任一非 tieBreak 字段 → 报"报告会说谎"；
#   B 删掉 flagsFor 里 tieBreak 的映射 → 报"未映射到 CLI 参数的字段"；
#   两者都必须在任何正式报告（MD 与 JSON 都是）落盘之前失败，且不留 .staging。
bun run benchmark/run-phase2d-grid.ts && bun run benchmark/select-phase2d-arm.ts

# P1-2（第二轮）：跨腿数平局 fixture + 同档 hybrid + 不污染成对不变量
bun test tests/integration/retrieval-policy.test.ts

# P2（第二轮）：平局集实测口径。ε arm 的改动集应 ⊆ 实测平局集（本轮 5 ⊆ 9）
bun -e 'const g=await Bun.file("benchmark/reports/phase2d/grid.json").json();
  const t=new Set(g.find(a=>a.arm==="baseline").tieInPageIds);
  const e=g.find(a=>a.arm==="diag-wsem-epsilon").diffIds;
  console.log("tie",t.size,"eps",e.length,"outside",e.filter(x=>!t.has(x)))'

# 三份确认集 + 全量
bun test && bun run typecheck
```

重点复核：

1. 播种时间口径（当天零点 − 30 天 + 序号分钟）是否可接受，以及「跨天整体平移」这个限制
   是否需要在 2D 内收口（我的判断是不需要：绝对可复现要给 benchmark 注入固定"现在"，会动
   产品的时间读取路径）；
2. `resultIds` 用数据集 id 是否够稳定，fingerprint 里是否还漏了别的会变的东西；
3. 比较器顺序确实是 `分档 → 语义名次 → recency → id`，且整段仍在 `b.score !== a.score` 之后；
4. K=60 反例的 17 组解可复算，fixture 用 `rrfK=1` 的等价性说明是否成立；
5. 平局集来自内核实际融合分而非任何推断，`exactTieInPage` 的「进结果页」口径是否合理；
6. D1a/D3/D4 的修订方向，以及三次判据修订的披露是否充分；
7. 加权 arm 的排除只依赖实测平局集（越界 q04、q11、q13），不依赖 ε；
8. 回滚 profile 仍是整份 1b，新平局策略没有混进回滚路径。

## 9. 证据文件

- `benchmark/reports/phase2d-criteria.md` — 判据 + **三次**修订披露（A1–A3 / A4–A6 / A7–A10）
- `benchmark/reports/phase2d-selection.{md,json}` — 确定性选参（含 ε 交叉核对）
- `benchmark/reports/phase2d/grid.json`、`grid-table.md` — 16 arm 汇总
- `benchmark/reports/phase2d/{baseline,tb-*,k*-wsem*,diag-wsem-epsilon}.{md,json}` — 逐 arm 留档
- `benchmark/reports/phase2d/confirm-{heldout,validation,audit}-{baseline,candidate}.{md,json}`
- `benchmark/reports/phase2d/default-policy.{md,json}` — 无 flag 默认策略
