# 安全策略轮次 P2 第 3 步：8 条新记录样本（供审口径，不冻结）

> 判据：`benchmark/reports/safety-round/p2-calibration-criteria.md`（SHA-256
> `dd61359bd938011eebe17eab6262cbc421fa818af2667b7e1a25fe597a0035a1`，已冻结）
>
> 判据 §7 写明：本步**不冻结**，只供审 annotation 与 `fact_source` 的写法；
> **口径未通过前不得进入第 4 步。**

---

## 1. 产出

| 文件 | 内容 |
| --- | --- |
| `benchmark/dataset/turns-safety-round-sample.json` | 8 条样本记录（`s01`–`s08`） |
| `benchmark/dataset/mirror-en-acp-records-safety-round-sample.json` | 英文派生值，生产 ACP 译者产出，8/8 成功 |
| `benchmark/screen-safety-round-overlap.ts` | 重叠筛查脚本（第 0/1/2 层） |
| `benchmark/reports/safety-round/p2-overlap-screen-safety-round-sample.json` | 筛查读数 |
| `benchmark/reports/safety-round/p2-overlap-adjudication-safety-round-sample.json` | 复核带逐对裁决 |

样本刻意覆盖全部三种 `fact_source.kind` 中的两种（`report` / `code`）与五种 `memory_type`
（`decision` ×3、`discovery` ×3、`change` ×1、`bugfix` ×1）。
**`commit` 这一种本批没有用到**——这是待审的一个点，见 §5。

## 2. 八条的事实与出处

| id | 类型 | 事实一句话 | 出处 |
| --- | --- | --- | --- |
| s01 | decision | 只译记录侧、query 不译，MRR 0.437 < 不译的 0.529，所以英文归一化必须两侧同时做 | `probe-en-normalization.md` 第 37/179 行 + `src/semantic-en.ts:15` |
| s02 | decision | 空间身份是模型:量化:维度:协议四段；两侧协议不一致读数 0.613，一致 0.972 | `embeddingSpaceKey` + `probe-en-normalization.md` 第 125 行 |
| s03 | discovery | 误召回门实测 1.900 不通过；`days=90` 对照 1.800，回滚只降 0.100 | `codex-p6-ruling.md` §1 + `codex-blind-audit-report.md` §4.1/§4.3 |
| s04 | discovery | 复印件让读数虚高 0.6：去重后 1.3，30 条负例里 18 条返回同源副本 | `duplicate-supplement.md` §3.1/§4 |
| s05 | discovery | 相对背景归一化更差：AUC 0.735 < 0.841；负例 μ_q 中位 0.095 < 正例 0.129 | `p40-relative-score-probe.md` |
| s06 | change | 默认时间窗 90 天 → 无界（`DEFAULT_SEARCH_DAYS = Infinity`），四处兜底清零 | `src/db/index.ts:72` + `phase3c-criteria.md` |
| s07 | bugfix | `LIMIT` 用绑定参数让计划翻转：同一 SQL 0.93ms → 1506.57ms，返回 50 行相同 | `fix-fts-limit-criteria.md` 文首 + `phase3b-submission.md` §4 |
| s08 | decision | 每页 2 条只是 semantic-only 配额；28/30 条负例填满配额且返回项 100% 为 semantic | `codex-p6-ruling.md` §6 + `codex-blind-audit-report.md` §4.2 |

`annotation` 里出现的每个数字都能在对应 `fact_source` 里查到，无一个约等于或凭记忆
（判据 §2.2 与 §8.7）。

## 3. 机械校验（脚本，硬失败）

`screen-safety-round-overlap.ts` 在算余弦之前先跑三项确定性检查：

| 检查 | 结果 |
| --- | --- |
| `fact_source` 非空，且 `memory_type=decision` 至少 2 个 | ✅ 8/8 |
| `report` 必须有 `path`+`section`；`code` 必须有 `path`+(`symbol`\|`line`)；`commit` 必须有 `sha`+`supports` | ✅ 全部齐全 |
| `fact_source.path` 指向的文件真实存在 | ✅ 全部存在 |

"章节确实陈述该事实"这一条只能人看，脚本不假装能查。

## 4. 重叠筛查

### 第 1 层 硬重复（确定性）

**0 对。** 无逐字相同的嵌入文本，无 id 撞车。

### 第 2 层 复核带（`> 0.450`，仅筛查）

新 8 条 × 旧 26 条 = 208 对：min −0.073 / p50 0.174 / p95 0.354 / **max 0.476**。
进复核带 **2 对**；新集内部 28 对里另有 **2 对**。四对全部裁决为 `related`：

| 对 | 余弦 | 裁决 | 理由摘要 |
| --- | ---: | --- | --- |
| s06 × t06 | 0.476 | related | 同改 `mcp-server.ts` 参数处理，但 t06 是入参边界校验与 pin 错误，s06 是删默认时间窗 |
| s03 × t26 | 0.465 | related | 都关于能否发布，但 t26 定规则（基准集发布前必须完成），s03 是一次具体裁定 |
| s03 × s08 | 0.466 | related | 同引 `codex-p6-ruling.md`，但一条引 §1、一条引 §6，事实不同 |
| s01 × s05 | 0.459 | related | 都含"归一化"字样，但一条指文本归一化、一条指分数归一化 |

对照 pilot：那 5 条同区域记录里有 2 条撞上既有 gold（0.670 / 0.558）。本批最高只有
0.476，且 p95 0.354——**说明先看过 26 条旧 gold 清单再选事实，确实能把重叠压下来。**
第 4 步应沿用同一顺序：先列旧 gold 覆盖面，再选事实，最后逐对筛查。

## 5. 需要审的四个点（进第 4 步之前）

1. **`commit` 这一种 `fact_source` 本批未使用。** 判据 §2.2 为它写了规则（`sha` +
   必须说明哪项改动支持该事实）。本批的事实都能落到报告或当前代码上，硬凑一个 commit
   反而不实。**建议**：不强制每批都出现三种 kind，但第 4 步的 40 条里至少要有几条用
   `commit`——尤其是"某个行为已被删除"这类只能靠 commit 佐证的事实。
2. **`age_days` 目前是占位。** 判据 §8.8 要求年龄、文本长度、插入顺序三者独立随机。
   本批只是把它写成字段形状，没有随机化。**第 4 步必须**用一个记录在案的种子一次性
   重排全部 40 条，并在报告里给出"年龄 vs 文本长度"与"年龄 vs 插入序"的相关系数。
3. **`prompt` / `assistant_response` / `events` 的重建深度。** 本批写得比较简短，只保
   证结构合法与内容不矛盾。因为它们不进 Observation 也不进向量（已核实），把它们写得
   更长不会改变任何读数，只会让这份语料更像真实捕获——而判据 §8.1 恰恰禁止那样称呼它。
   **建议**：维持现在的简短程度，并在冻结记录里写明这是刻意的。
4. **单 gold 的理由怎么写。** 判据 §3.4 要求 `acceptable_gold` 只有一条时必须写明"为什么
   只有这一条能回答"。本批已经暴露了两个天然的多 gold 关系（s03×t26、s03×s08），说明
   §3.4 的判断是对的：多 gold 是常态。第 4 步的 query 标注要默认往多 gold 方向查一遍。

## 6. 纪律声明

- 本步**不冻结**任何东西，也没有向 `p2-calibration-freeze.json` 写入第 3 步的产物。
- 本步**不跑检索、不建数据库、不播种**：所有读数都是记录向量的两两余弦。
- 本步**没有**使用最终盲审集的任何 query（判据 §8.3）；样本记录不含 query。
- `turns-safety-round-sample.json` 是**基于真实产物重建的 gold fixture**，不是真实捕获
  的对话或生产数据，也不得用于 ACP 压缩质量评估（判据 §2.1、§8.1、§8.2）。
