# 阶段 2B：拆门与 floor × cap 矩阵

> 日期：2026-07-31
> 依据：`plan/V3/retrieval-recall-implementation-plan-2026-07-31.md` §7
> 压缩器：`gold`（固定语料），**唯一自变量 = `semanticFloor` × `semanticOnlyLimit`**
> 请求验证：**Codex Gate B**

## 0. 一句话结论

拆门通过。选中 **`semanticFloor=0.197` / `semanticOnlyLimit=2`**：

| 集合 | 指标 | 关键词门 | 2B | §7 门槛 |
| --- | --- | ---: | ---: | --- |
| Phase 2 校准集（121 条，全 zero-FTS） | relevance hit@5 | 0.0% | **50.0%** | 高于基线 |
| 同上 | relevance MRR | 0.000 | **0.458** | 高于基线 |
| 同上 | empty 平均 / 最坏 | 0.00 / 0 | **0.59 / 2** | ≤1 / ≤3 |
| heldout（确认集，只跑一次） | hit@5 | 50.0% | **83.3%** | **严格 >50.0%** |
| 同上 | MRR | 0.417 | **0.764** | ≥0.417 |
| 同上 | R-precision | 0.389 | **0.722** | 不低于 1b |
| 同上 | zero-FTS hit@5 / MRR | 0 / 0 | **0.800 / 0.750** | >0 |
| validation（第二确认集） | hit@5 | 75.0% | **100.0%** | **严格 >75.0%** |
| 同上 | 中文 hit@5 | 50.0% | **100.0%** | ≥50.0% |
| 同上 | 英文 hit@5 | 100.0% | **100.0%** | =100% |
| 既有 tuned（连续性锁） | hit@5 / MRR / R-prec | 94.4% / 0.833 / 77.8% | **100.0% / 0.889 / 83.3%** | 不回退 |
| 既有 expected-empty | 平均 / 最坏 | 0.00 / 0 | **1.00 / 2** | ≤1 / ≤3 |

`heldoutReturnedEmpty` 9 → **0**：9 条原本"一个字都对不上就返回空"的 query，现在全部
拿到了结果。这是方案 §17 第 1 条要的那个变化。

**一处不能被均值吸收的代价**：既有 expected-empty 平均**正好等于门槛 1.00，没有余量**。
详见 §5。

## 1. 唯一产品改动

`semanticDiscovery=true`，使合法 `semantic-en-v1` 查询在 `ftsCount=0` 时仍执行语义召回。

§7.1 固定项由选择脚本**运行时断言**（不是靠承诺）：`rrfK=60`、权重 `1:1`、
`tieBreak=recency` 任一被改动即拒绝该 arm 并退出。模型、协议、FTS tokenizer、
候选池 200 条、`days=90`、`limit` 全部未动。

## 2. 纪律机制（先写判据，再跑候选）

| 机制 | 落地方式 |
| --- | --- |
| 门槛与顺位先写死 | `benchmark/select-phase2b-arm.ts`，在任何 arm 运行**之前**写完。§7.4 的 13 项门槛与 §7.5 的 5 级顺位全部编码在内，选择过程零人工判断 |
| 确认集物理隔离 | 新增 `--no-heldout`：heldout 在**加载阶段**就被移除，矩阵 arm 的 JSON 里 `heldout*` 全为 `null`。选择脚本读到非 null 即报错退出 |
| validation 隔离 | 矩阵 arm 不传 `--validation`；选择脚本断言 `validationQueries === 0` |
| 策略确实生效 | 每条 query 由 `onCandidates` 上报实际 policy，与声明值逐条核对，不一致即 `exit 2` |
| 非法参数 | `validateRetrievalPolicy()` 在播种前拦截（Gate A 整改产物） |

`--no-heldout` 是阶段 2A 那次 heldout 偷看的**结构性补救**：把"我没看"从承诺变成
"报告里不存在这个数字"，Codex 可以直接从 JSON 验证。

### 执行时序（策略冻结在确认之前的凭据）

| 时刻 | 产物 |
| --- | --- |
| 21:08:49 | `phase2b/baseline.json` |
| 21:08:52 – 21:09:31 | 12 个 `phase2b/arm-*.json` |
| 21:09:5x | `phase2b/diagnostic-f0.2-c3.json` |
| **21:10:21** | `phase2b-selection.json` ← **策略在此冻结** |
| 21:10:57 | `phase2b-heldout-confirmation.json` |
| 21:11:17 | `phase2b-validation-confirmation.json` |

两个确认集的产出时刻都晚于选择，且 14 份矩阵 JSON 的 `heldoutQueries` 全为 `null`、
`validationQueries` 全为 `0`（实测核对通过）。

### 一处必须披露的脚本改动

选择脚本在 12 个 arm 跑完之后、选择执行之前改过一次：原先的确认集断言写成
"任何 `heldout*` / `validation*` 字段非 null 即违规"，这条判据本身是错的——不传
`--validation` 时 `validationQueries` 是 `0` 而不是 `null`，于是基线被误判为违规。

改动只涉及那一段断言（改成 `heldoutQueries === null` 且 `validationQueries === 0`），
**门槛常量与 `rank()` 顺位函数一字未动**。checksum `9a0b2ba82db3` → `0674e6fb1c7b`。
Codex 可对照两处：门槛常量区（`TUNED_*` / `PHASE2_EMPTY_*` / `LEGACY_EMPTY_*` /
`P95_MAX_MS`）与 `rank()`。

## 3. 12 个 arm 全表（含失败项与失败原因）

Phase 2 校准集读数；`empty 均/坏` 为 Phase 2 empty（49 条）。

| arm | Phase2 hit@5 | Phase2 MRR | empty 均/坏 | tuned hit@5/MRR/R | semOnly max | p95 | 可行 | 失败原因 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | :--: | --- |
| floor=0.197 cap=1 | 41.7% | 0.417 | 0.39/1 | 100.0%/0.889/83.3% | 1 | 12.0ms | ✅ | — |
| **floor=0.197 cap=2** | **50.0%** | **0.458** | 0.59/2 | 100.0%/0.889/83.3% | 2 | 12.4ms | ✅ | — |
| floor=0.197 cap=3 | 55.6% | 0.477 | 0.76/3 | 100.0%/0.889/83.3% | 3 | 22.0ms | ❌ | 既有 expected-empty 平均 1.20 > 1 |
| floor=0.197 cap=5 | 55.6% | 0.477 | 0.94/5 | 100.0%/0.889/83.3% | 5 | 12.1ms | ❌ | Phase 2 empty 最坏 5 > 3；既有 expected-empty 平均 1.40 > 1、最坏 4 > 3 |
| floor=0.223 cap=1 | 37.5% | 0.375 | 0.31/1 | 100.0%/0.889/83.3% | 1 | 11.8ms | ✅ | — |
| floor=0.223 cap=2 | 40.3% | 0.389 | 0.45/2 | 100.0%/0.889/83.3% | 2 | 16.9ms | ✅ | — |
| floor=0.223 cap=3 | 41.7% | 0.394 | 0.57/3 | 100.0%/0.889/83.3% | 3 | 11.5ms | ✅ | — |
| floor=0.223 cap=5 | 41.7% | 0.394 | 0.67/5 | 100.0%/0.889/83.3% | 5 | 13.4ms | ❌ | Phase 2 empty 最坏 5 > 3 |
| floor=0.275 cap=1 | 26.4% | 0.264 | 0.20/1 | 100.0%/0.889/83.3% | 1 | 13.8ms | ✅ | — |
| floor=0.275 cap=2 | 26.4% | 0.264 | 0.27/2 | 100.0%/0.889/83.3% | 2 | 12.7ms | ✅ | — |
| floor=0.275 cap=3 | 26.4% | 0.264 | 0.29/3 | 100.0%/0.889/83.3% | 3 | 12.5ms | ✅ | — |
| floor=0.275 cap=5 | 26.4% | 0.264 | 0.29/3 | 100.0%/0.889/83.3% | 4 | 13.5ms | ✅ | — |

可行 9 个，不可行 3 个。**失败 arm 全部留档**（`benchmark/reports/phase2b/`），不只提交最佳。

### 3.1 诊断 arm（§7.2，不参与选择）

`floor=0.2 / cap=3`——旧 `SEMANTIC_FLOOR` 常数在新协议下的位置：

**不可行**，既有 expected-empty 平均 1.20 > 1。这条读数的用途只有一个：说明旧常数
0.2 不是"已经验证过的安全值"，它只是在门关着时从未被检验。落盘
`phase2b/diagnostic-f0.2-c3.json`。

## 4. §7.5 顺位与选择

`floor=0.197 / cap=2` 在第 1 顺位（Phase 2 hit@5 最大）就胜出，没有用到后续顺位：

| # | arm | Phase2 hit@5 | Phase2 MRR |
| ---: | --- | ---: | ---: |
| 1 | **floor=0.197 cap=2** | **50.0%** | 0.458 |
| 2 | floor=0.197 cap=1 | 41.7% | 0.417 |
| 3 | floor=0.223 cap=3 | 41.7% | 0.394 |

第 2 与第 3 名 hit@5 完全相同（41.7%），由第 2 顺位（MRR 0.417 > 0.394）分开——这说明
分辨力判据在这份数据上确实会被用到，不是装饰。

**heldout 与 validation 未参与任何顺位判断**，两者都在策略冻结之后才第一次运行。

## 5. 代价：既有 expected-empty 平均正好卡在门槛上

`1.00 / 2`，门槛 `≤1 / ≤3`。**没有余量。**

它由 5 条 query 构成，单条权重 0.2，也就是说任何一条多返回一条记录就会越界。这个样本量
撑不起"误召回已受控"的结论；Phase 2 的 49 条 empty（0.59 / 2）才是主证据，而既有 5 条
只是历史口径连续性。

方案 §7.4 把它列为"历史口径连续性"而不是主约束，正是因为它只有 5 条。但**卡在门槛上
这件事本身要作为风险登记**：2C 灰度必须实测真实 empty query 的返回分布，不能只靠这 5 条。

## 6. 逐 query 前后对比（heldout confirmation vs Phase 1b）

改善 **8** / 退化 **1** / 不变 33。

### 改善（最终名次）

| query | 子集 | 前 | 后 |
| --- | --- | --- | --- |
| q08 | tuned | 未命中 | **1** |
| q28 | heldout | 未命中 | **2** |
| q29 | heldout | 未命中 | **1** |
| q30 | heldout | 未命中 | **1** |
| q32 | heldout | 未命中 | **1** |
| q36 | heldout | 未命中 | **1** |
| q40 | heldout | 未命中 | **1** |
| q42 | heldout | 未命中 | **1** |

八条全部是 `ftsCount=0`，在门关着时结构上不可达。q08 是唯一一条零锚点的 **tuned**
query，它的恢复也是 tuned hit@5 94.4% → 100.0% 的原因——连续性锁不仅没回退，还上升了。

### 退化与剩余 miss：单一原因

| query | ftsCount | 语义候选 | semRank | 仅语义返回 | 最终名次 |
| --- | ---: | ---: | ---: | ---: | --- |
| q39 | 1 | 7 → 9 | 3 | 6 → **2** | 4 → **未命中** |
| q33 | 0 | 0 → 3 | 3 | 0 → **2** | 未命中（但**已召回候选**） |
| q37 | 0 | 0 → 3 | 3 | 0 → **2** | 未命中（但**已召回候选**） |

三条共享同一个成因：**目标的语义名次是第 3，而 cap=2 只保留 2 条 semantic-only**。

两件事要分开读：

- q33 / q37 从"压根不召回"变成"召回了但被 cap 截掉"。语义腿已经把它们找出来并排到
  第 3 位——**拓扑确实改变了**，剩下的是限额问题，不是召回能力问题。
- q39 是**净损失**：它原本靠 semantic 排在第 4 位进了结果页，cap=2 把它挤出去了。

`cap=3` 能同时救回这三条（`floor=0.197 cap=3` 的 Phase 2 hit@5 是 55.6%，比选中的
50.0% 更高），但它的既有 expected-empty 平均是 1.20，**超出 §7.4 硬门**。所以这不是
"没想到"，是门槛在起作用：多召回三条真阳性的代价是误召回越界。

按纪律不调门槛、不在本阶段改融合层。这三条登记给 **2D**：如果 `source-confidence`
tie-break 或加权 RRF 能把它们的名次从 3 提到 ≤2，就能在不放大 cap 的前提下拿回来。

## 7. Gate B 后续整改（真实 MCP 测试 + v20 修复）

Codex 在矩阵通过后要求补两项。**floor/cap 与选择结果一字未动**：策略仍是
`floor=0.197 / cap=2`，`phase2b-selection.json` 未重跑、未改写。

### 7.1 真实 MCP 集成测试（§7.7 后半）

新增 `tests/integration/mcp-discovery.test.ts`，**7 项全过**。它 spawn 真实的
`src/server/mcp-server.ts` 子进程，用 stdio JSON-RPC 说话，并起一个真实 Worker
（`createApp` + `Bun.serve`，把 `.worker.port` 与 `.token` 写进临时 dataDir），
所以链路是完整的：

```text
tools/call → schema 校验 → scope 解析 → Worker HTTP 取 query 向量
           → 检索内核（协议边界 + cap）→ compactCard 投影 → JSON-RPC 返回
```

必须走进程边界的原因：MCP server 在模块层构造 DB 单例与 Worker embedder，没有依赖
注入缝。直接 import 它就是在测试进程里建一个生产单例，测的也不再是"Kiro 真的调用
MCP 时会发生什么"。必须起真 Worker 的原因：MCP 进程**不持有模型**，query 向量只能来自
`POST /embed/query`，不起 Worker 就只能测到降级路径。

| Codex 要求 | 用例 | 断言 |
| --- | --- | --- |
| 合法 `semantic_query_en` + zero-FTS 能召回 | `合法 semantic_query_en + zero-FTS 能召回目标` | `total=1`、命中目标 id、`match_source='semantic'` |
| 返回保留 `match_source` / `semantic_score` | `返回卡片保留 match_source 与 semantic_score` | 两个键都在卡片上；`semantic_score ≈ 1`（fixture 两侧对齐同一基向量，所以能断具体值而不只是"非空"） |
| 缺失英文形式明确降级 | `缺失英文形式：明确降级` | 不传该参数 → 协议落回 raw-v1 → 协议边界拒绝独立召回 → `total=0` |
| 非法英文形式明确降级 | `非法英文形式（占位符）` | 传 `'...'`（v20 踩到的那个值）→ 护栏拒 → `total=0` |
| empty query 受 cap 限制 | `无关 query 受 cap 限制` | 6 条语义全对齐的记录 → `total ≤ 2` 且 `> 0`，全部 `match_source='semantic'`。断言的是"受 cap 限制"这个不变量，**不再断言结构上必为空** |
| —（自加）| `默认仍是关键词门` | 不设验证开关时同一 query 返回空，证明生产默认未被本轮改动 |
| —（自加）| `FTS 有命中时默认与开关一致` | 有词面锚点时两种配置返回 id 逐条相同 |

#### 一处必须披露的产品代码改动

生产默认仍是 `semanticDiscovery: false`（写入 Gate B 的 floor/cap 是 2C 的事），而 MCP
模块没有注入缝，所以"zero-FTS 能召回"这条在真实 MCP 路径上原本**不可能**被测到。

为此加了一个进程级验证缝：

```ts
// src/server/mcp-server.ts
const GATE_B_SELECTED_POLICY = { semanticDiscovery: true, semanticFloor: 0.197, semanticOnlyLimit: 2 };
function verificationPolicyOverride() {
  return process.env.KIRO_MEM_SEMANTIC_DISCOVERY === 'on' ? GATE_B_SELECTED_POLICY : undefined;
}
```

边界说清楚：

- **不设时返回 `undefined`**，内核取 `DEFAULT_RETRIEVAL_POLICY`，生产行为与阶段 1b
  逐字节一致。已有专门用例（`默认仍是关键词门`）钉住这一点。
- **刻意不叫 `SEMANTIC_DISCOVERY_ENABLED`**。那个名字属于 2C §8.1 第 4 项，随它一起
  交付的还有默认值变更、回滚路径、README/运维说明与 `metric_events` 观测。这里只有
  一个进程级开关，没有改默认值、没有动文档、没有动 schema。
- `GATE_B_SELECTED_POLICY` 是一个**具名的非默认常量**，不是 `DEFAULT_RETRIEVAL_POLICY`。
  2C 决定是否把它提升为默认值。

### 7.2 v20 占位符修复

**根因**：v20 的原文本来就是英文（`was the quality benchmark set treated as a release
blocker`），而固定输入是用中→英 prompt 生成的。阶段 1b §5 已经记录过这个形状——
"喂进一句已经是英文的话时，模型更容易回一句解释而不是 JSON"。首轮落进
`mirror-en-acp-queries-validation.json` 的是字面 `'...'`，生产护栏以 `placeholder`
正确拒绝，于是该 query 在 arm 里静默落回 raw-v1。

**修法**：用 Gate A 整改后的探针（parse 里过一遍 `checkSemanticEnQuery`）重译。这次
正确产出了恒等形式——护栏明确允许 "An English source legitimately normalizes to
itself"。修复记录写进该文件的 `provenance.v20Repair`。

`benchmark/dataset/queries-validation.json` 的 20 条英文形式现在 **20/20 通过护栏**。
Gate A 冻结的 phase2 数据 checksum 未变（`908efa997041` / `8aa7109144d0`）。

### 7.3 validation confirmation 重跑（同一策略）

| 指标 | 修复前 | 修复后 | 门槛 |
| --- | ---: | ---: | --- |
| 门槛结论 | **存在未达标项** | **全部通过** | — |
| 护栏拒绝 | 1 | **0** | 0 |
| semantic-en / raw 腿 | 61 / 1 | **62 / 0** | protocol 混排 0 |
| validation hit@5 | 100.0% | 100.0% | 严格 >75.0% |
| validation MRR | 0.892 | **0.917** | ≥0.667 |
| validation R-precision | 0.800 | **0.850** | — |
| 中文 / 英文 hit@5 | 100% / 100% | 100% / 100% | ≥50% / =100% |
| 既有 expected-empty 平均 / 最坏 | 1.00 / 2 | 1.00 / 2 | ≤1 / ≤3 |
| tuned hit@5 / MRR | 100.0% / 0.889 | 100.0% / 0.889 | 不回退 |
| 跨 scope 泄漏 | 0 | 0 | 0 |

v20 逐条：协议 `raw(拒:placeholder)` → `en`，`semRank` 无 → **1**，最终名次
**2 → 1**。MRR 增量 1/20 × (1 − 1/2) = 0.025，与实测 0.892 → 0.917 吻合。

这次重跑**没有改变任何选参输入**：它只修了一条 query 的固定输入缺陷，策略参数、
矩阵结果、选择脚本输出全部不变。

### 7.4 原登记的既有缺陷（已修）

validation 确认运行里有一道结构门失败：`query 侧协议一致（61/62，护栏拒绝 1）`。

被拒的是 **v20**，其英文形式在 `mirror-en-acp-queries-validation.json` 里存的是字面
`'...'`——护栏以 `placeholder` 正确拒绝。**Phase 1b 的同一份报告第 60 行有完全相同的
读数并已标 ❌**，所以这是 1b 遗留的固定输入缺陷，不是 2B 引入。

它不影响 2B 结论：v20 有 7 条 FTS 候选，命中在第 2 位，validation hit@5 仍是 100%。
它落在协议边界的正确一侧（缺失/非法英文形式 → 不允许 raw-v1 独立 discovery）。

**已在 Gate B 后续整改中修复**，见 §7.2 / §7.3。它也验证了 Gate A 整改 3 的判断：
"冻结前跑全量护栏校验"这一步确实应该补跑到既有固定输入上——补跑就抓到了这一条。

## 8. 结构与性能

| 项 | 值 | 门槛 |
| --- | ---: | --- |
| semantic-only 每条数量 | ≤ 2 = min(cap, limit) | 不变量 |
| semantic-only 来源标记 | 100% `semantic` | 不变量 |
| 跨 scope 泄漏 | 0 | 硬门 |
| protocol 混排（raw 腿条数） | 0 | 硬门 |
| discovery 请求 / 生效 / 被协议边界挡 | 42 / 42 / 0 | 观测 |
| search p95 | 12.6ms（validation run 15.8ms） | <300ms |

`discovery 被挡 = 0` 说明这批固定输入的英文形式覆盖率是满的；生产里的真实覆盖率
必须在 2C 灰度实测，本阶段测不到。

## 9. 测试

`bun test` **423 pass / 0 fail**（Gate B 后续新增 7 项真实 MCP 集成测试），`bun run typecheck` 干净。

§7.7 要求的测试全部落地。方案指名 `tests/integration/search.test.ts`，实际写在
`tests/integration/retrieval-policy.test.ts`（discovery 相关断言集中一处便于维护），
逐项对应：

| §7.7 要求 | 位置 |
| --- | --- |
| zero FTS 时 embedder 必须被调用 | `semanticDiscovery > true：…可只靠语义召回`（断言 `embedCalls=1`） |
| zero FTS + semantic hit 返回 semantic-only | 同上（断言 `match_source='semantic'`） |
| zero FTS + 无候选过 floor 返回空 | `semanticDiscovery > true 但语义候选全部低于 floor` |
| zero FTS + embedder timeout 等到 deadline 后返回空并记录 degrade | `§7.7 > zero FTS + embedder 超时`（断言耗时 ≥55ms 且 <2s、`degraded=1`） |
| FTS 有命中 + embedding failure 仍返回 FTS | `tests/integration/search.test.ts`（既有） |
| cap 为 1/2/3/5 均严格生效 | `semanticOnlyLimit > cap=%i` |
| semantic-only 被丢弃后继续补入 | `cap 丢弃的候选不占 limit` |
| limit=1/5/20 不变量 | `§7.7 > limit=%i` |
| type/scope/days 对纯语义候选生效 | `§7.7 > type / days / scope 过滤对纯语义候选生效` |
| raw/en space 不混排 | `tests/integration/semantic-en-search.test.ts`（既有） |

真实 MCP 集成测试（§7.7 后半）**已补齐**，见 §7.1。

## 10. 复现

```bash
# 基线
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --no-heldout \
  --semantic-discovery=off \
  --report=benchmark/reports/phase2b/baseline.md --json=benchmark/reports/phase2b/baseline.json

# 12 个 arm
for floor in 0.197 0.223 0.275; do for cap in 1 2 3 5; do
  bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --no-heldout \
    --semantic-discovery=on --semantic-floor=$floor --semantic-only-limit=$cap \
    --report=benchmark/reports/phase2b/arm-f$floor-c$cap.md \
    --json=benchmark/reports/phase2b/arm-f$floor-c$cap.json
done; done

# 诊断 arm（不参与选择）
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --no-heldout \
  --semantic-discovery=on --semantic-floor=0.2 --semantic-only-limit=3 \
  --report=benchmark/reports/phase2b/diagnostic-f0.2-c3.md \
  --json=benchmark/reports/phase2b/diagnostic-f0.2-c3.json

# 确定性选择
bun run benchmark/select-phase2b-arm.ts \
  --baseline=benchmark/reports/phase2b/baseline.json \
  --arms='benchmark/reports/phase2b/arm-*.json' \
  --report=benchmark/reports/phase2b-selection.md --json=benchmark/reports/phase2b-selection.json

# 确认（策略冻结后各跑一次）
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en \
  --semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 \
  --report=benchmark/reports/phase2b-heldout-confirmation.md \
  --json=benchmark/reports/phase2b-heldout-confirmation.json

bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --validation \
  --semantic-discovery=on --semantic-floor=0.197 --semantic-only-limit=2 \
  --report=benchmark/reports/phase2b-validation-confirmation.md \
  --json=benchmark/reports/phase2b-validation-confirmation.json
```

Gate B 后续整改（§7）：

```bash
# 真实 MCP 集成测试（spawn MCP server + 真 Worker）
bun test tests/integration/mcp-discovery.test.ts

# v20 重译（走真实 ACP；探针已带生产护栏）
bun run benchmark/probe-acp-translate.ts --target=queries --query-set=validation \
  --ids=v20 --concurrency=1 --timeout-ms=60000 --out=/tmp/v20-fix.json

# validation 固定输入全量护栏校验（应为 20/20）
bun -e "
const { checkSemanticEnQuery } = await import('./src/semantic-en');
const qs = JSON.parse(await Bun.file('benchmark/dataset/queries-validation.json').text());
const mir = JSON.parse(await Bun.file('benchmark/dataset/mirror-en-acp-queries-validation.json').text());
let ok = 0; for (const q of qs) if (checkSemanticEnQuery(mir.queries[q.id], q.query).ok) ok++;
console.log(ok, '/', qs.length);
"
```

## 11. 已知限制与登记项

| 项 | 状态 |
| --- | --- |
| 既有 expected-empty 平均正好 1.00 | 无余量，5 条样本单条权重 0.2。2C 灰度必须实测真实分布，见 §5 |
| q39 净退化 | rank 4 → 未命中，成因是 cap=2 截掉 semRank=3。登记 2D |
| q33 / q37 仍 miss | 已被语义召回但排第 3 被 cap 截。登记 2D，与 q39 同因 |
| `cap=3` 更高召回但越界 | `floor=0.197 cap=3` 的 Phase 2 hit@5 55.6% > 50.0%，被既有 expected-empty 1.20 挡住。若 2D 改善名次，可重新评估 |
| ~~v20 英文形式是 `'...'`~~ | **已修**（§7.2）。validation 固定输入 20/20 过护栏，确认运行门槛全部通过 |
| ~~真实 MCP 集成测试~~ | **已补**（§7.1），7 项全过 |
| MCP 验证缝 `KIRO_MEM_SEMANTIC_DISCOVERY` | 进程级开关，不设即旧行为。2C 需用正式的 `SEMANTIC_DISCOVERY_ENABLED` 替换它并连带交付默认值/回滚/文档/观测 |
| 生产 profile 未改 | `DEFAULT_RETRIEVAL_POLICY` 仍是关键词门。写入默认值是 2C，须 Gate B 通过 |
| 校准集独立性 | Phase 2 集由实现者本人标注，已看过 1a/1b 结果。它是校准集不是泛化证据 |
| 2A 污染残留 | `(floor=0.223, cap=3)` 的 heldout 读数在 2A 被偷看过并已披露。它在本轮排第 3，**未被用于打破任何平局**（第 1 顺位就已决出胜者） |
| ACP 模式未跑 | 全程 `--compressor=gold` 固定语料，保证唯一自变量是 policy。ACP 运行波动按 §14.5 单独测，不与本读数混算 |

## 12. 请求 Codex 验证

**Gate B**。建议独立复跑：

1. §10 全部命令，从 JSON 重新计算选择结果；
2. 确认 12 个 arm 的 JSON 里 `heldoutQueries` 全为 `null`、`validationQueries` 全为 0；
3. 确认 `phase2b-heldout-confirmation.json` 与 `phase2b-validation-confirmation.json` 的
   文件 mtime **晚于**全部 arm 与 `phase2b-selection.json`（策略冻结后才运行的凭据）；
4. 复核 §2 披露的选择脚本改动：门槛常量与 `rank()` 是否真的未变；
5. 独立复跑基线、最佳 arm、相邻 floor（0.223 cap=2）与相邻 cap（0.197 cap=1 / cap=3）；
6. 构造极端候选测试 cap 补位与 scope/type 过滤（或直接跑 §9 的测试）；
7. 检查 zero-FTS 的恢复是由语义找回，而不是 FTS tokenizer 或数据被顺手改了
   （`benchmark/dataset/` 的 checksum 应与 Gate A 一致：`queries-phase2.json`
   `908efa997041`、`mirror-en-acp-queries-phase2.json` `8aa7109144d0`）；
8. 检查 expected-empty 返回的**内容与分数**，不只看均值——§5 已指出均值卡在门槛上；
9. 按 §7.9 第 8 条建立独立审计集（≥20 条 zero-FTS relevance + ≥20 条 empty/hard-negative），
   建立时不看本报告的返回结果，再复算 hit@5 / MRR / empty 分布与逐 query 失败归因。

按 §16.5 给出「通过 / 有条件通过 / 不通过」。§5 与 §6 的退化项请重点看。
