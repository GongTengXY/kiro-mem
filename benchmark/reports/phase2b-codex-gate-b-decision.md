# Codex Gate B 决议

结论：**通过（PASS）**。Phase 2B 选定的独立语义召回策略可以进入 Phase 2C，
但本决议不直接修改生产默认策略；默认值切换、正式 feature flag、回滚和运行观测仍须
作为 Phase 2C 一起交付。

## 选定策略

| 参数 | 冻结值 |
| --- | --- |
| semanticDiscovery | `true` |
| semanticFloor | `0.197`（严格 `>`） |
| semanticOnlyLimit | `2` |
| rrfK | `60` |
| FTS / semantic 权重 | `1 / 1` |
| tieBreak | `recency` |

## 补充独立审计的隔离方式

上一份 `phase2b-codex-audit-input.json` 在创建前已经看过其他 Phase 2B 返回数据，
因此继续只作为补充证据，不用于 Gate B 放行。

本次重新建立了未运行过所选策略的新集合：20 条 zero-FTS relevance 与 20 条
empty/hard-negative。创建期间只允许运行 FTS-only 预检；7 条有词面候选的中文问法
仅依据 FTS 计数改写。全部 40 条 `ftsCount=0` 后，将输入冻结为：

```text
dc9a0ba59f1e6d638d71aed775e075da52eb0beda566678a77a88e58832f44e5
```

冻结记录时间为 `2026-07-31T14:19:37Z`。第一次所选策略运行发生在冻结之后，runner
通过 `--expected-input-sha256` 校验输入；运行后没有修改任何 query 或期望目标。

已知边界：Codex 在创建新集合前知道既有集合的汇总指标和其他 query 的返回结果，
所以这是“对本集合返回盲”的独立 holdout，不是第三方双盲评测。方案 §7.9.8 要求的
关键约束是创建时不查看所选策略对该审计集合的返回，本次满足该约束。

## 新审计结果

| 指标 | 结果 |
| --- | ---: |
| relevance query | 20 |
| relevance hit@5 | **100.0%** |
| relevance MRR | **1.000** |
| 目标位于 Rank 1 | 20 / 20 |
| empty/hard-negative | 20 |
| empty 平均返回 | **0.30** |
| empty 最坏返回 | **2** |
| 全部 query 的 FTS 候选数 | **0** |
| semantic-only 最大返回 | **2** |

20 条 hard-negative 中仅 3 条有返回，每条均为 2 条：

| query | 返回的 Observation / cosine |
| --- | --- |
| `cb-e03` 蝴蝶兰换盆 | `t02 / 0.2122`，`t03 / 0.2085` |
| `cb-e09` 意式浓缩 | `t02 / 0.2693`，`t18 / 0.2273` |
| `cb-e19` 家庭酿酒 | `t15 / 0.2885`，`t19 / 0.2747` |

这些是假阳性，但没有被均值隐藏：最坏返回 2，且 semantic-only cap=2 对三条均生效。
分数接近当前 floor，说明 Phase 2C 必须继续观测 semantic-only 返回率和低分段分布。

## Gate B 十项复核

| §7.9 项目 | 结论 | 证据摘要 |
| --- | --- | --- |
| 1. 12 个 arm 全部实际运行 | 通过 | 12 个 arm 报告齐全 |
| 2. 从 JSON 重算选择 | 通过 | 确定性选择脚本仍选 `0.197 / 2` |
| 3. 确认集在策略冻结后运行 | 通过 | heldout / validation confirmation provenance 完整 |
| 4. 复跑基线、最佳和相邻工作点 | 通过 | 12-arm 复跑结果与选择报告一致 |
| 5. cap 补位及硬过滤 | 通过 | scope/type/days/limit/cap 极端测试通过 |
| 6. zero-FTS 由语义找回 | 通过 | 新审计 40/40 `ftsCount=0`，relevance 20/20 由 semantic 找回 |
| 7. 检查 empty 内容与分数 | 通过 | 逐条结果和 cosine 已落盘，上表列出所有非空项 |
| 8. 冻结后建立独立审计集 | 通过 | 新输入先 FTS-only、后 checksum 冻结、再运行策略 |
| 9. 复算指标与失败归因 | 通过 | hit@5/MRR/empty/cap/逐 query 结果完整 |
| 10. Gate B 后才冻结生产默认 | 通过 | 当前默认仍未切换，交给 Phase 2C 完成 |

## 放行与剩余风险

Gate B 放行 Phase 2C。Phase 2C 不允许继续用本审计集调 floor 或 cap，只能验证冻结策略
和发布机制。生产切换必须同时完成：

1. 将 `0.197 / 2` 写入正式默认策略；
2. 用正式 `SEMANTIC_DISCOVERY_ENABLED` 灰度开关替代 Phase 2B 验证缝；
3. 提供显式关键词门回滚 profile；
4. 记录 discovery requested/effective/blocked、degraded、semantic-only 返回量和分数段；
5. 特别监控既有 expected-empty 平均 `1.00`（无安全余量）以及本审计的 3 条低分假阳性。

## 证据文件

- `benchmark/reports/phase2b-codex-blind-audit-input.json`
- `benchmark/reports/phase2b-codex-blind-audit-freeze.json`
- `benchmark/reports/phase2b-codex-blind-audit.json`
- `benchmark/reports/phase2b-codex-blind-audit.md`
- `benchmark/run-codex-phase2b-audit.ts`
- `benchmark/reports/phase2b-selection.json`
- `benchmark/reports/phase2b-heldout-confirmation.md`
- `benchmark/reports/phase2b-validation-confirmation.md`
