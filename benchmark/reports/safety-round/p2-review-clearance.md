# P2 复核放行记录

> 日期：2026-08-11
>
> 作用：登记"P2 第二轮复核通过"这一事实，作为 P3 解除阻塞的出处。
>
> 上游：`p2-completion.md` §6（六项复核请求）、`p2-calibration-criteria.md`（r3）、
> `p2-calibration-freeze.json`（`frozen: true`）

---

## 1. 放行事实

| 项 | 内容 |
| --- | --- |
| 结论 | **P2 复核通过**，可以进入 P3 |
| 复核方 | Codex |
| 传达方式 | **由操作者（本仓库使用者）在会话中口头转达** |
| 传达时间 | 2026-08-11T20:49+08:00 |
| Codex 原文 | **未落盘** |

## 2. 诚实边界（必须与结论一起读）

本记录**不引用任何未见的原文**。它登记的是"操作者转达了通过结论"这一事实，
而不是 Codex 的论证过程。因此：

1. 本轮此前每个决策都有可核验的落盘裁定（`codex-p6-ruling.md`、
   `p2-step3-review-and-step4-ruling.md`），**P2 的通过在证据强度上弱于它们**；
2. `p2-completion.md` §6 提了六项具体复核请求，本记录**无法逐项对应**——
   转达的是整体通过，不是逐项答复；
3. 若 P5 的发布证据链需要 Codex 对 P2 的原文裁定，**必须在那时补录**，
   不得把本记录当作原文的替代品。

## 3. 本记录授权什么、不授权什么

**授权**：解除"复核通过之前不得运行 P3 的任何 arm"这一条阻塞（方案 §7.8、
判据 §7 第 4 步末句）。

**不授权**（逐条列出，防止放行被扩大解释）：

- 不得修改 `p2-calibration-freeze.json` 的任何冻结物；
- 不得修改判据 r3 的任何一条，特别是 F1 / N1 / N2 / N3 与 `cap ≤ 1` 排除项；
- 不得重判 C1（正式读数永远 1.900）、P6 或 Phase 3C（永远不通过）；
- 不得修改任何生产策略值（P5 之前，方案 §4 第 6 条）。

## 4. 放行时的冻结物状态（本记录落盘时实测）

`p2-calibration-freeze.json` 登记的 14 个可校验 SHA-256 **逐项与盘上文件一致**：

```text
criteria / turns / queries / semanticEn.records / semanticEn.queries /
semanticEn.generator / verify.zeroFts / verify.lowScoreStrata /
verify.ageAssignment / verify.ageScript / ftsZero.oldPrimary /
ftsZero.filler / overlap.screen / overlap.adjudication        14/14 matched
```

P3 的 runner 在启动时必须重复这项校验，任何一项不匹配即退出非零。
