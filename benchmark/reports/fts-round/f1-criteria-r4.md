# FTS 安全策略轮次 F1 判据 **r4**：冻结前数据资格门

> 日期：2026-08-14　修订：**r4（增量文档）**
>
> 轮次标识：**`fts-safety-round-2026-08-12-r2`**
>
> **本文是增量，不是重写。** 基线是 `benchmark/reports/fts-round/f1-criteria.md`（r3），
> 它**保持逐字节不变**并与本文一同进入新冻结记录。r3 未被本文替换的条款全部继续有效。
>
> 触发原因：F2 的 S4 在完整装置上拦下 9 条零命中词面负例，
> 证据保留在 `benchmark/reports/fts-round/f2-fixture.json`（**不覆盖**）。
> 原冻结 `f1-freeze.json` 及其 14 项输入同样**保持逐字节不变**，作为历史记录。
>
> 裁定：`2026-08-14` 操作者裁定（四项），本文逐条落地于 §14–§17。

---

## 14. 作废重开的形式（裁定第 1 项）

| 项 | 处置 |
| --- | --- |
| `f1-criteria.md`（r3） | **不动**，作为 r4 的基线一并冻结 |
| `f1-freeze.json` + 其 14 项输入 | **不动**，逐字节保留为历史 |
| `f2-fixture.json` | **不动**，保留为 S4 拦截证据 |
| `f2-strata.json` | **不动**；其读数（并集 24/15/13/28）**随 query 改动失效，不得带入新轮** |
| 轮次标识 | `fts-safety-round-2026-08-12-r2` |
| 新建 | `f1-criteria-r4.md`（本文）、`queries-fts-round-r2.json`、`mirror-en-acp-queries-fts-round-r2.json`、`f1-precheck-r2.json`、`f1-freeze-r2.json`、`f2-strata-r2.json`、`f2-fixture-r2.json`、`f2-freeze-r2.json` |
| 按原 SHA 复用（无缺陷，不重新生成） | `turns-fts-round.json`、`mirror-en-acp-records-fts-round.json`、`fts-round-filler-zh-10k.json` 及其 meta 与生成脚本、`pool-policy-filler-10k.json`、`turns.json` |

**记录侧一个字节都不改。** 缺陷全部在 query 侧，改动范围严格限定在 query 文本与其锚点字段。

---

## 15. 缺陷 3 的修法：只改 query token（裁定第 2 项）

**不改记录正文，不把 token 塞进记录。** 每条保护线的 token 必须是它**原 `primary_gold`**
的 Observation **可索引字段**里真实存在的专有名词 / 路径 / 数字。

可索引字段 = `observations_fts` 索引的 9 列：
`title` / `summary` / `request` / `outcome` / `learned` / `next_steps` /
`concepts_json` / `files_touched_json` / `evidence_json`。

**明确不可用**：只存在于 `fact_source`、`key_facts`、`annotation_basis` 等非索引字段里的值。
（这正是缺陷 3 的成因：`semanticFloor` / `Clopper-Pearson` / `97/109` 只出现在 `fact_source`
与 `key_facts` 里，而 Observation 的可索引投影里没有它们。）

**若原 gold 没有符合该保护类别的可索引 token**：换一条真实的保护 query，
并重新检查 `primary_gold` 覆盖（每条记录至少一次）。
**不得**为了命中而把 `primary_gold` 指向一条语义上不回答该 query 的记录。

---

## 16. 冻结前数据资格门（裁定第 3 项）

**S4 不从 F2 搬走。** r4 新增**冻结前**的资格门，F2 的 S4 保留为**冻结后的独立复现**。

### 16.1 四道资格门（先写死，再跑工具）

| 门 | 覆盖 | 判定 |
| --- | --- | --- |
| **Q1** 负例词面命中 | 40 条词面负例 | 在完整文本投影上实测 `ftsCount ≥ 1`，**逐条** |
| **Q2** 锚点索引可达 | 40 条词面负例 | 锚点必须**存在于真实索引投影**：该 query 至少有一个 `extractFtsSearchUnits` 单元**包含该锚点**且其 `df ≥ 1`。**仅子串存在不算**（缺陷 1 的 7 条正是子串存在而单元不可达） |
| **Q3** 保护线词面可达 | 40 条保护线 | 其 `primary_gold` 必须在**对应词面分支**可达：`short-query` 类验证 **LIKE 回退分支**，其余四类验证 **FTS 分支**。判定用生产 `searchObservationsFts` 的返回集合是否含该 gold |
| **Q4** 基线非空门 | 40 条保护线 | 逐 query 冻结 `primaryLexicalReachable`（布尔）与命中位次。**任一条不可达即 Q3 失败**，因此"不得回退"不会退化成 0 ≥ 0 的空门 |

**四门全过才允许冻结。** 任一条失败即修 query（§15），修完重跑，不得放宽门。

### 16.1.1 Q2 的实现更正（写在跑之前，但在写 §16.1 之后）

§16.1 的 Q2 原文写成"该 query 至少有一个单元**包含该锚点**且 df ≥ 1"。
**这个措辞在锚点长于三字时恒假**——单元就是三字窗，三字窗不可能包含一个四字或五字锚点。
按原文执行会把所有多字锚点判成失败，与裁定原意（"锚点必须存在于真实索引投影"）相反。

因此 Q2 的判定形式化为**单元与锚点有重叠**，两个方向都认：

```text
存在单元 u：df(u) ≥ 1  且  ( u ⊆ anchor  或  anchor ⊆ u )
```

- `u ⊆ anchor`：四字以上锚点被切成若干三字窗，窗口落在锚点内部；
- `anchor ⊆ u`：三字以内锚点被某个窗口覆盖。

**仅"锚点作为子串出现在语料里"仍然不算**——那正是缺陷 1 那 7 条的形态（`记录` 出现在
10,012 行，但跨过它的三字窗在语料里对不上邻字）。这条更正**收紧的是可执行性，不是门槛**：
它没有放宽任何通过条件，只是让原本恒假的判定变得可判。

**登记边界**：本更正发生在看到第一次预检结果之后。它改的是判定的可执行性
（与 Q6 判据 §8.1 那次"自证不可执行必须重写而不是降低标准"同一形态），
**不改变任何门槛数值**，且当时尚无任何 arm 读数。

### 16.2 与 F2 的 S4 的关系

- 预检在**纯文本投影**上跑（无向量、无 ACP）；
- F2 的 S4 在**完整装置**（含向量）上重跑同一批判定；
- **预检与 F2 结果不一致则整轮作废。** 一致性本身是装置正确性的证据：
  两个装置的词面投影必须逐条相同，否则说明播种路径有差异。

### 16.3 冻结记录必须纳入预检

`f1-freeze-r2.json` 的输入项必须包含 `f1-precheck-r2.json`（含其 SHA），
`payload` 必须携带四门的通过结论与逐 query 的可达性表。
**没有预检记录的冻结无效。**

---

## 17. 轻量工具的契约（裁定第 4 项）

工具：`benchmark/precheck-fts-round-data.ts`

| 要求 | 落地 |
| --- | --- |
| 装置规模 | **完整 60,066 行**：40 新 gold + 26 旧 gold + 50,000 英文 filler（10,000 × 5 副本）+ 10,000 中文 filler |
| 不做的事 | **不生成向量、不调 ACP**。因此拉丁标识符、路径、数字与 bm25 排名都能按正式装置复现，而成本只有播种 |
| 必须复用生产实现 | `annotationToResult`、`extractFtsSearchUnits`、`searchObservationsFts`（含其 LIKE 回退分支）。**不得另写一套近似切分或近似匹配** |
| 时间布局 | 与 F2 装置同一套（新 gold 按 `age_days`、插入顺序解耦；旧 gold 400 天；filler 铺 1,095 天），seed 与 F2 一致，保证词面投影可比 |
| 输出 | `f1-precheck-r2.json`：四门结论 + 逐 query 明细（单元、单元 df、锚点可达性、`ftsCount`、gold 命中位次、走的是 FTS 还是 LIKE 分支） |
| 失败行为 | 任一门失败即非零退出，并逐条打印失败原因与可用替代 token 的候选（从该 gold 的可索引字段里机械提取） |

**"可用替代 token 候选"必须由工具机械产出**，不得由撰写者凭印象挑——
缺陷 2 正是凭印象断言 `候选池` / `时间窗` 在语料里（实测子串出现 0 行）。

---

## 18. sample gate 的漏项（裁定末段）

上一轮 sample gate 检查了 gold 语义关系与类别覆盖，但**没有要求 token 必须存在于
Observation 的实际索引投影**。r4 把它变成机械门（§16 的 Q1–Q4 + §17 的工具），
不再依赖人工复核。

`benchmark/validate-fts-round-dataset.ts` 同时补一条：
**保护线与词面负例的 token 字段必须带 `token_source`**，取值只能是
`indexed-field`（来自 gold 的可索引字段，机械校验）或 `synthetic-filler`（来自合成语料，
机械校验）。缺失或取值非法即校验失败。

---

## 19. r4 不改变什么

- **G1–G4、召回保护线、性能资格门、S7 的 K 阶梯、选择规则**全部沿用 r3，一字不改；
- **网格刻度**（`r ∈ {0,0.1,0.2,0.3}` × `d ∈ {1.0,0.3,0.1,0.03}`）沿用 r3；
- **生产策略值**全程冻结不动；
- C1 = 1.900、P6 不通过、Phase 3C 不通过，照旧。

r4 只做两件事：**把冻结前的数据资格门补上**，以及**按裁定修正 query 侧的三个缺陷**。
