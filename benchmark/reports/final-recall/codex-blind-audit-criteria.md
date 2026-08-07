# 最终检索召回独立盲审判据

> 状态：**已冻结**。冻结记录：`codex-blind-audit-freeze.json`；冻结前未运行任何语义 arm。
>
> 目的：裁定 Phase 3C P6、复核 raw-v1 FTS-only 边界，并给出 V3 检索召回最终结论。

## 1. 盲审边界

1. 查询和标注只依据 `benchmark/dataset/turns.json` 的事实，不依据检索返回。
2. 不复用 Kiro 或 Codex 已经运行过的 query 集。
3. 冻结前只允许 JSON/schema、`semantic_query_en` 护栏和纯 FTS 预检；禁止生成 query embedding、
   禁止读取向量、禁止查看 cosine/rank/最终页面。
4. 冻结后输入文件任何字节变化都使审计失效；只能重新登记为另一轮审计，不能覆盖本轮。
5. 两个时间窗 arm 必须在同一个数据库、同一策略、同一结果上限下运行，唯一差别是 `days=90`
   与省略 `days`。

## 2. 装置

- 26 条 primary gold Observation 全部放在审计基准时刻前 400 天。
- `pool-policy-filler-10k.json` 重复五份形成 50,000 条语料，并均匀铺在 1,095 天内。
- 26 条 `old-relevance`、30 条 `hard-negative` 全部要求 FTS 候选为 0。
- 正常组全部使用冻结的合法 `semantic_query_en`；raw 控制组按输入文件指定 missing/reject 形状。
- 默认生产策略必须保持 discovery=on / floor=0.197 / cap=2 / RRF K=60 / 1:1 /
  semantic-rank tie-break / pool=Infinity / Top-K=1000 / bigramAux=false。

## 3. 必须记录的逐 query 字段

每个 arm 至少记录：

- 有序 `resultIds`；
- 与结果逐项对齐的 `match_source`；
- 与结果逐项对齐的 `semantic_score`，无分数写 `null`；
- `ftsIds`、`semanticIds`、`comparableVectors`、`aboveFloorCount`；
- `goldRank`、`returned`、`semanticOnly`；
- 相对另一 arm 的新增、移除、位次变化和来源变化；
- 满页时被挤出的记录，以及替代它的新增记录。

不得只报告返回条数净变化。新增与替换必须按有序页面逐项计算。

## 4. 预登记门槛

### A. 装置与不变量

- A1：26 条正例与 30 条负例在纯文本预检中全部 `ftsCount=0`。
- A2：26 条 gold 全在 90 天窗外；50,000 条语料中至少 90% 在窗外。
- A3：两臂 degrade=0、跨 scope 泄漏=0、协议混排=0。
- A4：semantic-only 每条不超过 2；所有 semantic-only 来源均为 `semantic`。

### B. 旧记录正例

- B1：无界 arm 的 hit@5 和 MRR 必须都严格大于 `days=90` arm。
- B2：无界 arm 至少找回 1 条此前被 90 天窗口挡住的 gold 到 Top-5。
- B3：所有改善和失败逐条登记，不允许只给聚合值。

这组门槛不发明新的绝对召回率：V3 方案 §17 对独立确认集的最低要求是至少一条正确找回，
本轮的主要悬案是 P6 误召回，而不是重新选 floor/cap。

### C. hard-negative / empty

- C1：无界 arm 平均返回 `<= 1`。
- C2：无界 arm 单条最坏返回 `<= 3`。
- C3：无界 arm `semanticOnlyMax <= 2`。
- C4：必须同时报告 `days=90` 绝对值、无界绝对值和逐页替换；不得用两臂净差接替 C1/C2。

C1/C2 直接沿用 V3 方案 §17 的最终完成定义。因为本集全部零 FTS，读数不会再被合成 filler 的
词面命中数量污染；若仍失败，不能把责任推给 FTS filler，也不能事后改阈值。

### D. raw 降级控制

两条时间窗 arm 中，每个 raw 控制都必须：

- `embedCalls=0`、`comparableVectors=0`、`semanticCount=0`、`aboveFloorCount=0`；
- 结果逐位等于同 arm 的纯 FTS 查询；
- 结果来源只有 `fts`，不得出现 `semantic` 或 `hybrid`；
- unbounded 可以因旧 FTS gold 进入而优于 `days=90`，但不得来自 raw 向量。

## 5. 裁定分支

- A 或 D 任一失败：实现/仪表未通过，先修代码，不裁定 P6。
- B 失败：无界历史在独立旧记录集上没有确认收益，默认时间窗不得正式验收。
- C1 或 C2 失败：P6 不通过；按已登记分支回滚默认时间窗，或另开安全策略轮次。
- A/B/C/D 全过：P6 通过，Phase 3C 可从有条件通过升级为通过。
- 不得根据本审计结果调整 floor、cap、Top-K、候选池或查询；若要调整，必须使用另一份校准集，
  本审计只可作为调整后的确认集再次整体运行，并如实标注已被消耗。

## 6. 交付物

1. `codex-blind-audit-input.json`；
2. `codex-blind-audit-freeze.json`；
3. 机器可读的两臂逐 query 结果和差异；
4. 最终 Markdown 报告；
5. Codex 最终裁定。
