# kiro-mem V3 质量基准报告（acp 压缩器）

> ⚠️ **这份报告已过期，不要引用其误召回数字。** 它产出于检索层加入词汇锚点规则
> （`plan/V3/open-risks-2026-07-27.md` S4）与 query 集改为三类 kind 之前：那时
> expected-empty 的分母是 2 条且误把 leakage 类的 q20 算了进去。gold 模式下同一
> 指标在收口后是 0.00（见 `gold-latest.md`）。acp 模式需要真实 `kiro-cli acp`，
> 尚未复跑。摘要质量类指标（关键事实召回、memory_type 一致率等）不受这两处改动
> 影响，仍可引用，但必须带上 `acp-variance.md` 的运行次数与 `min`。

## Provenance

报告只记生成时间时无法自证是哪个版本、哪份数据集、哪条命令产出的——
文件 mtime 不是 provenance。下面这些是复现这份数字所需的全部输入。

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-07-28T07:36:57.139Z |
| commit | `a47b9d6` **（工作区有未提交改动）** |
| 命令行 | `bun run benchmark/run.ts --compressor=acp` |
| 数据集 turns.json | `aa8f9beda2a4`（30 turn） |
| 数据集 queries.json | `202381761a7a`（20 query） |
| 脚本 run.ts / scoring.ts | `339680d44b3c` / `bb8e48403d71` |
| embedding 模型 | all-MiniLM-L6-v2 (384d) |
| 运行环境 | Bun 1.2.20 / darwin arm64 |
| 运行次数 | 1（多次运行与方差见 `--runs=N`） |

## 运行配置

- 压缩器：`acp`（kiro-runtime=~/.kiro-mem/kiro-runtime，timeoutMs=30000，maxRetries=2）
- Embedding：启用，coverage 1.00
- 数据集：30 个标注 turn（primary 26 / other 4），20 个标注 query（relevance 18 / leakage 2）
- 合成结果：normal 30 / fallback 0，summarize 总耗时 119.0s
- 压缩器计数（§12.4）：JSON repair 0，repair 耗尽降级 0，runtime 回收 0，工具调用污染 0。job 层的超时/失败由 JobRunner 重试吸收，最终仍为 30 条 normal。

## 门槛结论：全部通过

门槛按**举证能力**分表。把自检项与结构性恒真项和真实质量指标混在同一张
"全部通过"表里，对外阅读即构成夸大——所以它们在下面是分开的。

### 有判别力的门槛

R-precision 与 expected-empty 是本轮新增的**误召回**侧指标。它们的阈值是
"不回退锁"，取当前实测值向下留一档余量，**不是**质量目标：

- R-precision 实测远低于 hit@5，说明正确答案通常进了 Top-5 但常常不在第 1 位。
- expected-empty 的目标值是 0——标注为"本 scope 不该有匹配"的 query 理想应返回空。
  当前值接近返回上限，要真正压下来需要给检索加相关性下限（见 open-risks S4）。

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| Top-5 至少一条标注 Observation 命中 | 100.0% | ✅ |
| R-precision（下界；≥55.0% 为不回退锁，非质量目标） | 66.7% | ✅ |
| expected-empty query 平均返回条数（2 条，最坏 10；目标 0，≤9 为不回退锁） | 5.50 | ✅ |
| outcome 非空率 | 100.0% | ✅ |
| next_steps 未完成项召回（5 条有未完成项） | 100.0% | ✅ |
| 关键事实召回（token 边界匹配） | 93.3% | ✅ |
| 关键文件召回 | 100.0% | ✅ |
| 虚构完成状态 turn 数 | 0 | ✅ |
| 幻觉文件 turn 数 | 0 | ✅ |

### 结构性门槛（恒真，仅防回归）

三条检索 SQL 都无条件拼 `AND scope_key = ?`，所以这两项测的是"那行 WHERE 没
被删掉"，恒为 0。真正会出错的授权层是 `src/server/mcp-scope.ts`，本基准不调用它。

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| 跨 workspace 检索泄漏为 0 | 0 | ✅ |
| 跨 workspace bootstrap 注入为 0 | 0 | ✅ |

### 性能门槛（余量充足）

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| search p95 延迟 < 300ms | 33.3ms | ✅ |
| bootstrap 构建 < 100ms 且在预算内 | 20.3ms / 3618B | ✅ |

## 摘要质量（§12.3 Summary 完整性 / 事实准确性）

| 指标 | 值 |
| --- | --- |
| Observation 总数 | 30 |
| fallback 数 | 0 |
| outcome 非空率 | 100.0% |
| next_steps 未完成项召回（分母 5） | 100.0% |
| next_steps 过度生成率（分母 25，仅参考） | 8.0% |
| 关键事实逐字召回 | 93.3% |
| 关键文件召回 | 100.0% |
| memory_type 与标注一致率 | 73.3% |
| 出现幻觉文件的 turn 数 | 0 |
| 出现虚构完成断言的 turn 数 | 0 |

### 逐条问题明细

| turn | quality | 问题 |
| --- | --- | --- |
| t02 | normal | memory_type 不符（参考） |
| t05 | normal | next_steps 过度生成（参考）；memory_type 不符（参考） |
| t08 | normal | memory_type 不符（参考） |
| t12 | normal | next_steps 过度生成（参考）；memory_type 不符（参考） |
| t17 | normal | memory_type 不符（参考） |
| t20 | normal | memory_type 不符（参考） |
| t23 | normal | memory_type 不符（参考）；事实缺失: 23M |
| t24 | normal | 事实缺失: zh / en |
| t25 | normal | 事实缺失: 3 errors |
| x02 | normal | memory_type 不符（参考） |
| x04 | normal | 事实缺失: 58fps |

## 检索质量（§12.3 pull 检索精度 / Scope 隔离 / 延迟）

| 指标 | 值 |
| --- | --- |
| hit@5（Top-5 至少一条标注命中） | 100.0% |
| hit@10 | 100.0% |
| MRR@10 | 0.780 |
| recall@10 | 100.0% |
| R-precision（下界） | 66.7% |
| expected-empty query 平均返回（2 条） | 5.50（最坏 10） |
| 跨 workspace 泄漏条数 | 0 |
| FTS-only 降级次数 | 0 / 20 |
| search p50 / p95 | 10.5ms / 33.3ms |
| bootstrap 当前 scope | 3618B / 20.3ms（预算 8192B） |
| bootstrap 另一 scope | 1202B |
| bootstrap 空 scope | 485B |

### 逐 query 明细

| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| q01 FTS 特殊字符查询报错是怎么修的 | relevance | t01 | 2 | hybrid+semantic+fts | 0 | 33.3ms |
| q02 search 为什么会降级成只用 FTS | relevance | t02 | 1 | hybrid+semantic+fts | 0 | 11.7ms |
| q03 hook 超时会不会拖慢 Kiro 启动 | relevance | t03,t19 | 4,2 | hybrid+fts+semantic | 0 | 9.9ms |
| q04 日志里会不会有用户 prompt 正文 | relevance | t04,t19 | 7,2 | hybrid+fts+semantic | 0 | 9.1ms |
| q05 版本号是在哪里统一管理的 | relevance | t05 | 1 | hybrid+semantic | 0 | 7.6ms |
| q06 MCP search 的 limit 最大能传多少 | relevance | t06 | 1 | hybrid+semantic+fts | 0 | 10.0ms |
| q07 ACP 连接池回收失败会不会导致任务永久挂住 | relevance | t07 | 3 | hybrid+fts+semantic | 0 | 14.4ms |
| q08 压缩一直失败最后会写成什么样的记录 | relevance | t08 | 1 | hybrid+semantic | 0 | 9.2ms |
| q09 本地 token 认证是怎么做到用户无感的 | relevance | t11 | 1 | hybrid+semantic+fts | 0 | 10.5ms |
| q10 跑测试会不会污染我真实的数据目录 | relevance | t12 | 5 | semantic+fts | 0 | 10.9ms |
| q11 安装完 Worker 起不来说模块找不到 | relevance | t13 | 2 | hybrid | 0 | 11.7ms |
| q12 重新安装之后为什么还在跑旧代码 | relevance | t14 | 1 | hybrid+semantic | 0 | 10.9ms |
| q13 怎么发现运行中的 Worker 不是当前安装的版本 | relevance | t15 | 1 | hybrid | 0 | 20.1ms |
| q14 注入到会话里的上下文有多大 会不会超预算 | relevance | t18 | 2 | hybrid+fts+semantic | 0 | 11.8ms |
| q15 timeline 的邻居是按什么顺序排的 | relevance | t20 | 1 | hybrid+semantic | 0 | 9.7ms |
| q16 本地 embedding 模型是什么精度 多少维 | relevance | t23 | 1 | hybrid+semantic+fts | 0 | 9.5ms |
| q17 跨项目会不会看到别的仓库的记忆 | relevance | t22 | 1 | fts+semantic | 0 | 10.1ms |
| q18 质量基准集还剩什么没做 | relevance | t26 | 1 | hybrid+semantic | 0 | 8.9ms |
| q19 虚拟滚动 react-window 帧率优化 | leakage | — | 返回 1 条 | semantic | 0 | 10.6ms |
| q20 401 token 刷新重放请求 | leakage | — | 返回 10 条 | hybrid+semantic+fts | 0 | 6.8ms |

## 复现

```bash
bun run benchmark/run.ts --compressor=acp
```

评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。
