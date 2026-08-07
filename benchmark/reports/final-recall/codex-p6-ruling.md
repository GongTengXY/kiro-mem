# Codex 最终裁定：P6 不通过，进入独立安全策略轮次

> 签发：Codex
>
> 日期：2026-08-07
>
> 证据：`codex-blind-audit-result.json` / `codex-blind-audit-report.md`

## 1. 正式结论

冻结判据 C1 要求无界 arm 的 hard-negative 平均返回 `<= 1`，实测为 **1.900**。
判据 §5 已写死 `C1` 失败即 P6 不通过，因此正式结论是：

- **P6 不通过**；
- **Phase 3C 最终状态为不通过**，不再是“有条件通过 / P6 挂起”；
- P0–P5、Q1–Q6 及盲审 A/B/D 的通过记录继续有效，但不能覆盖 P6 的安全门失败；
- 默认无界时间窗尚未获得发布验收。

## 2. 补救分支

选择：**另开安全策略轮次，不回滚默认时间窗。**

理由：`days=90` 对照臂的 C1 也是 **1.800 > 1**。回滚只减少 0.100，不能让门槛通过，
却会撤掉独立盲审确认的旧记录收益（hit@5 `0% -> 80.77%`，21/26 进入 Top-5，0 退化）。

在新轮次完成前：

- 工作分支与内部验证继续保持默认无界，以保留已确认收益；
- 对外稳定发布继续阻塞，不得把当前状态描述为 Phase 3C 已通过；
- 显式 `days=N` 仍可由调用方用于收窄，但不把它包装成 C1 的修复。

## 3. 新安全轮次的变量

主矩阵同时扫描 **floor 与 cap**，不只动其中一个：

- `semanticFloor in {0.197, 0.223, 0.275}`；
- `semanticOnlyLimit in {1, 2}`；
- `cap=0` 只作“关闭 semantic-only”诊断基线，不得作为成功候选；
- 时间窗保持无界，Top-K=1000、候选池=Infinity、RRF、权重、tie-break、FTS tokenizer 均冻结。

选择顺序：先满足完整负例门槛，再在可行 arm 中最大化旧记录 relevance 的 hit@5 / MRR；
若无 arm 同时满足安全和收益，则安全轮次不通过，不得继续加数字追着确认集调参。

`cap=1` 能结构性保证零 FTS 页面至多返回 1 条 semantic-only，但不自动解决 FTS/hybrid 暴露面；
因此不能只凭 cap 的算术上界宣称完整安全。

## 4. 新校准集与确认集

当前最终盲审集已被消耗，**不得用于选 floor/cap**。新轮次使用一份独立的选参装置：

- 从未作为 gold 使用的独立事实记录中建立至少 40 条旧记录 relevance；
- 至少 40 条零 FTS hard-negative，用于 semantic floor/cap；
- 至少 30 条“有词面锚点但事实不成立”的 hard-negative，用于覆盖 FTS/hybrid 绕过 cap；
- 年龄、文本长度、插入顺序独立随机，不能重现“最旧记录恰好最短”的混淆；
- query、标注依据和数据 checksum 在首个 arm 之前冻结。

Kiro 可以建立并使用这份**校准集**选参。策略冻结后：

1. 当前 `codex-blind-audit-input.json` 整体重跑，明确标注为“已消耗回归确认集”；
2. Codex 再从未参与校准的事实记录建立一份新的独立确认集，作为最终发布证据。

## 5. 两个附加装置的归属

- **词面锚点 hard-negative**：并入安全策略轮次，属于完整误召回门槛。若它失败，说明
  floor/cap 无法约束 FTS/hybrid，需要另开 FTS 安全策略，不能继续调语义参数掩盖。
- **等 bm25、年龄/长度解耦 fixture**：独立成 FTS 排序轮次。它只比较技术全序键与显式
  recency tie-break，不参与 floor/cap 选择。该轮可与安全轮次并行取证，但必须单独报告和裁定。

在隔离证据出来前不修改 `ORDER BY fts.rank, o.id ASC`。同时停止把 `id ASC` 描述成完全
“不携带排名意见”：在无界且 ID 与插入时间相关的语料里，它实际编码 oldest-first。

## 6. 护栏语义

`semanticOnlyLimit=2` 仍是纯语义来源的完整数量约束，但**不是整页误召回护栏**。
FTS/hybrid 不经过它是既有设计事实。后续文档必须称其为“semantic-only 配额”，完整安全结论
由跨来源的 hard-negative 门槛给出。
