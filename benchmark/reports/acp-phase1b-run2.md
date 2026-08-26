# kiro-mem V3 质量基准报告（acp 压缩器）

## Provenance

报告只记生成时间时无法自证是哪个版本、哪份数据集、哪条命令产出的——
文件 mtime 不是 provenance。下面这些是复现这份数字所需的全部输入。

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-07-30T16:18:55.559Z |
| commit | `07f8c50` **（工作区有未提交改动）** |
| 命令行 | `bun run benchmark/run.ts --compressor=acp --protocol=semantic-en --report=benchmark/reports/acp-phase1b-run2.md --json=/tmp/acp2.json` |
| 数据集 turns.json | `aa8f9beda2a4`（30 turn） |
| 数据集 queries.json | `95ee03d880a9`（42 query） |
| 脚本 run.ts / scoring.ts / dataset.ts | `3e5496c08285` / `bb8e48403d71` / `283d29ddba69` |
| embedding 模型 | all-MiniLM-L6-v2 (384d) |
| 归一化协议 | `semantic-en`（双侧英文归一化，arm B） |
| 英文固定输入 | `mirror-en-acp-records.json` + `mirror-en-acp-records-other.json` + `mirror-en-acp-queries.json` + `mirror-en-acp-queries-heldout.json` + `mirror-en-acp-queries-empty.json` + `mirror-en-acp-queries-leakage.json`（记录 30 / query 42，由生产 ACP 产出） |
| 运行环境 | Bun 1.2.20 / darwin arm64 |
| 运行次数 | 1（多次运行与方差见 `--runs=N`） |

## 运行配置

- 压缩器：`acp`（kiro-runtime=~/.kiro-mem/kiro-runtime，timeoutMs=30000，maxRetries=2）
- Embedding：启用，coverage 1.00
- 数据集：30 个标注 turn（primary 26 / other 4），42 个标注 query（relevance 36 / empty 5 / leakage 1）
- 合成结果：normal 30 / fallback 0，summarize 总耗时 168.6s
- 压缩器计数（§12.4）：JSON repair 0，repair 耗尽降级 0，runtime 回收 1，工具调用污染 0。job 层的超时/失败由 JobRunner 重试吸收，最终仍为 30 条 normal。

## 门槛结论：全部通过

门槛按**举证能力**分表。把自检项与结构性恒真项和真实质量指标混在同一张
"全部通过"表里，对外阅读即构成夸大——所以它们在下面是分开的。

### 有判别力的门槛

relevance query 分成两个子集，举证能力完全不同：

- **tuned**（18 条）：检索实现就是在这批 query 上调的（D1 修复让 gold hit@5 从
  66.7% 升到 94.4%）。它的门槛是**连续性锁**，不能当泛化证据。
- **heldout**（18 条）：后补且未据此改任何检索参数。实测 hit@5 72.2%，
  与 tuned 差了约 50 个百分点——**这是当前最实质的检索缺口**，也把"存在过拟合
  风险"变成了实测事实。它的门槛同样是不回退锁，锁在一个很差的水平上。

R-precision 与 expected-empty 是**误召回**侧指标——只测 hit@k 只能证明
"没漏"，证明不了"没乱给"。两者的性质不同：

- R-precision 的阈值是"不回退锁"，不是质量目标：实测远低于 hit@5，说明正确答案
  通常进了 Top-5 但常常不在第 1 位，排序还有明显空间。
- expected-empty 的阈值就是目标值（0）。检索层要求词汇锚点——本 scope 的 FTS
  无命中即返回空——所以一条与本 workspace 无关的 query 在结构上返回 0 条。

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| Top-5 至少一条标注命中（tuned 18 条；连续性锁） | 100.0% | ✅ |
| R-precision（tuned；≥55.0% 为不回退锁，非质量目标） | 88.9% | ✅ |
| Top-5 至少一条标注命中（heldout 18 条；泛化读数，≥40.0% 为不回退锁） | 72.2% | ✅ |
| R-precision（heldout；≥35.0% 为不回退锁） | 50.0% | ✅ |
| expected-empty query 平均返回条数（5 条，最坏 0；目标 0，门槛 ≤1） | 0.00 | ✅ |
| outcome 非空率 | 100.0% | ✅ |
| next_steps 未完成项召回（5 条有未完成项） | 100.0% | ✅ |
| 关键事实召回（token 边界匹配） | 96.1% | ✅ |
| 关键文件召回 | 100.0% | ✅ |
| 虚构完成状态 turn 数 | 0 | ✅ |
| 幻觉文件 turn 数 | 0 | ✅ |
| 英文派生值 ready 覆盖（30/30，pending 0 / failed 0） | 1.00 | ✅ |
| query 侧协议一致（42/42 走 semantic-en-v1，护栏拒绝 0） | 0 | ✅ |

### 结构性门槛（恒真，仅防回归）

三条检索 SQL 都无条件拼 `AND scope_key = ?`，所以这两项测的是"那行 WHERE 没
被删掉"，恒为 0。真正会出错的授权层是 `src/server/mcp-scope.ts`，本基准不调用它。

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| 跨 workspace 检索泄漏为 0 | 0 | ✅ |
| 跨 workspace bootstrap 注入为 0 | 0 | ✅ |
| semantic-en-v1 向量数 == ready 派生值数（非法值入表为 0） | 30 == 30 | ✅ |
| raw-v1 腿仍然完整（降级路径可用） | 1.00 | ✅ |

### 性能门槛（余量充足）

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| search p95 延迟 < 300ms | 19.0ms | ✅ |
| bootstrap 构建 < 100ms 且在预算内 | 20.4ms / 3545B | ✅ |

## 摘要质量（§12.3 Summary 完整性 / 事实准确性）

| 指标 | 值 |
| --- | --- |
| Observation 总数 | 30 |
| fallback 数 | 0 |
| outcome 非空率 | 100.0% |
| next_steps 未完成项召回（分母 5） | 100.0% |
| next_steps 过度生成率（分母 25，仅参考） | 12.0% |
| 关键事实逐字召回 | 96.1% |
| 关键文件召回 | 100.0% |
| memory_type 与标注一致率 | 70.0% |
| 出现幻觉文件的 turn 数 | 0 |
| 出现虚构完成断言的 turn 数 | 0 |

### 逐条问题明细

| turn | quality | 问题 |
| --- | --- | --- |
| t02 | normal | memory_type 不符（参考） |
| t05 | normal | next_steps 过度生成（参考） |
| t08 | normal | memory_type 不符（参考） |
| t12 | normal | next_steps 过度生成（参考）；memory_type 不符（参考） |
| t17 | normal | memory_type 不符（参考） |
| t19 | normal | next_steps 过度生成（参考）；事实缺失: REDACTED |
| t20 | normal | memory_type 不符（参考） |
| t23 | normal | memory_type 不符（参考）；事实缺失: 23M |
| t25 | normal | memory_type 不符（参考）；事实缺失: 3 errors |
| x02 | normal | memory_type 不符（参考） |
| x04 | normal | memory_type 不符（参考） |

## 检索质量（§12.3 pull 检索精度 / Scope 隔离 / 延迟）

| 指标 | 值 |
| --- | --- |
| hit@5（全部 36 条 relevance） | 86.1% |
| ├ hit@5（tuned 18 条，检索曾在其上调优） | 100.0% |
| └ hit@5（heldout 18 条，未据此调参） | **72.2%** |
| hit@10 | 86.1% |
| MRR@10 | 0.771 |
| ├ MRR@10（tuned；排序敏感，阶段 1 主读数） | 0.944 |
| └ MRR@10（heldout；排序敏感，泛化读数） | 0.597 |
| recall@10 | 86.1% |
| R-precision（下界） | 69.4% |
| ├ R-precision（tuned） | 88.9% |
| └ R-precision（heldout） | 50.0% |
| heldout 中因零词汇锚点返回空的条数 | 4 / 18 |
| └ 同上，按 FTS 候选数为 0 计（拆门后的主口径） | 4 / 18 |
| expected-empty query 平均返回（5 条） | 0.00（最坏 0） |
| 跨 workspace 泄漏条数 | 0 |
| FTS-only 降级次数 | 0 / 42 |
| search p50 / p95 | 10.0ms / 19.0ms |
| bootstrap 当前 scope | 3545B / 20.4ms（预算 8192B） |
| bootstrap 另一 scope | 1350B |
| bootstrap 空 scope | 485B |

### 逐 query 明细

| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| q01 FTS 特殊字符查询报错是怎么修的 | relevance | t01 | 1 | hybrid+semantic | 0 | 19.0ms |
| q02 search 为什么会降级成只用 FTS | relevance | t02 | 2 | hybrid+fts+semantic | 0 | 13.1ms |
| q03 hook 超时会不会拖慢 Kiro 启动 | relevance | t03,t19 | 3,1 | hybrid+fts+semantic | 0 | 9.0ms |
| q04 日志里会不会有用户 prompt 正文 | relevance | t04,t19 | 2,5 | hybrid+fts+semantic | 0 | 10.4ms |
| q05 版本号是在哪里统一管理的 | relevance | t05 | 1 | hybrid+semantic | 0 | 6.9ms |
| q06 MCP search 的 limit 最大能传多少 | relevance | t06 | 1 | hybrid+fts | 0 | 12.5ms |
| q07 ACP 连接池回收失败会不会导致任务永久挂住 | relevance | t07 | 1 | hybrid+fts+semantic | 0 | 13.9ms |
| q08 压缩一直失败最后会写成什么样的记录 | relevance | t08 | 1 | hybrid+semantic | 0 | 10.7ms |
| q09 本地 token 认证是怎么做到用户无感的 | relevance | t11 | 1 | hybrid+fts | 0 | 12.3ms |
| q10 跑测试会不会污染我真实的数据目录 | relevance | t12 | 1 | hybrid+fts+semantic | 0 | 9.9ms |
| q11 安装完 Worker 起不来说模块找不到 | relevance | t13 | 1 | hybrid+fts | 0 | 12.4ms |
| q12 重新安装之后为什么还在跑旧代码 | relevance | t14 | 1 | hybrid+fts+semantic | 0 | 10.2ms |
| q13 怎么发现运行中的 Worker 不是当前安装的版本 | relevance | t15 | 1 | hybrid+fts | 0 | 21.4ms |
| q14 注入到会话里的上下文有多大 会不会超预算 | relevance | t18 | 1 | hybrid | 0 | 12.2ms |
| q15 timeline 的邻居是按什么顺序排的 | relevance | t20 | 1 | hybrid+fts | 0 | 21.3ms |
| q16 本地 embedding 模型是什么精度 多少维 | relevance | t23 | 1 | hybrid+fts | 0 | 18.4ms |
| q17 跨项目会不会看到别的仓库的记忆 | relevance | t22 | 1 | hybrid+fts | 0 | 10.2ms |
| q18 质量基准集还剩什么没做 | relevance | t26 | 1 | hybrid+semantic | 0 | 10.1ms |
| q19 虚拟滚动 react-window 帧率优化 | empty | — | 返回 0 条 | — | 0 | 9.7ms |
| q20 401 token 刷新重放请求 | leakage | — | 返回 7 条 | hybrid+fts+semantic | 0 | 8.8ms |
| q21 Kubernetes Ingress 灰度发布配置 | empty | — | 返回 0 条 | — | 0 | 2.6ms |
| q22 支付回调 验签 对账差异 | empty | — | 返回 0 条 | — | 0 | 3.0ms |
| q23 iOS APNs 推送证书 续期 | empty | — | 返回 0 条 | — | 0 | 3.3ms |
| q24 Excel 导出 中文乱码 编码 | empty | — | 返回 0 条 | — | 0 | 1.6ms |
| q25 purge 之后重装会不会残留旧表 | relevance | t09 | 1 | hybrid+fts+semantic | 0 | 9.5ms |
| q26 job 的类型名后来有没有改过 | relevance | t10 | 1 | hybrid+fts+semantic | 0 | 9.1ms |
| q27 干净机器上装完做过验收吗 | relevance | t16 | 未命中 | — | 0 | 3.5ms |
| q28 有没有真的跑通一整轮记忆生成 | relevance | t17 | 2 | fts+semantic | 0 | 9.8ms |
| q29 两路检索结果是用什么算法合并的 | relevance | t21 | 1 | semantic+fts | 0 | 10.6ms |
| q30 中文界面和中文提示是怎么支持的 | relevance | t24 | 1 | semantic+fts | 0 | 9.8ms |
| q31 还有哪些类型错误没有修完 | relevance | t25 | 1 | hybrid+semantic | 0 | 8.8ms |
| q32 搜索词里带引号或括号会不会崩 | relevance | t01 | 2 | fts+semantic | 0 | 8.7ms |
| q33 向量算不出来的时候搜索还能不能用 | relevance | t02 | 未命中 | — | 0 | 6.1ms |
| q34 报错日志会不会把模型原始输出写进去 | relevance | t04 | 1 | hybrid+semantic+fts | 0 | 10.4ms |
| q35 改一次版本号要动几个文件 | relevance | t05 | 1 | hybrid+semantic | 0 | 8.6ms |
| q36 连接池里有个子进程死了会怎么处理 | relevance | t07 | 1 | hybrid+fts+semantic | 0 | 9.8ms |
| q37 模型输出解析不了会不会把这一轮丢掉 | relevance | t08 | 未命中 | fts+semantic | 0 | 11.3ms |
| q38 单元测试用的数据库文件放在哪里 | relevance | t12 | 4 | hybrid+semantic+fts | 0 | 13.0ms |
| q39 安装时少拷了一个文件会有什么现象 | relevance | t13 | 2 | hybrid+semantic | 0 | 11.2ms |
| q40 会话开头塞进去的索引占多少字节 | relevance | t18 | 未命中 | — | 0 | 4.3ms |
| q41 两个不同仓库的记忆是怎么分开的 | relevance | t22 | 1 | hybrid+fts+semantic | 0 | 10.0ms |
| q42 向量是多少维 用了什么量化 | relevance | t23 | 未命中 | — | 0 | 3.2ms |

### 逐 query 分路明细（§4.4）

一次 miss 有四种成因，在上面那张表里长得一模一样：FTS 没召回 / 语义没召回 /
两路都召回但 RRF 排坏 / 被结果上限截掉。这张表把它们拆开。`ftsRank`、
`semRank` 是期望记录在**各自那一路的候选名次表**里的位次，0 = 没进该路。

| query | 类型 | 协议 | fts候选 | 语义候选 | 返回 | 仅语义 | ftsRank | semRank | 最终名次 | 降级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q01 | relevance/tuned | en | 5 | 9 | 9 | 4 | 2 | 1 | 1 | 否 |
| q02 | relevance/tuned | en | 8 | 8 | 10 | 3 | 3 | 2 | 2 | 否 |
| q03 | relevance/tuned | en | 12 | 9 | 10 | 1 | 3 | 1 | 1 | 否 |
| q04 | relevance/tuned | en | 4 | 3 | 5 | 1 | 4 | 1 | 2 | 否 |
| q05 | relevance/tuned | en | 2 | 4 | 4 | 2 | 1 | 1 | 1 | 否 |
| q06 | relevance/tuned | en | 9 | 3 | 9 | 0 | 1 | 1 | 1 | 否 |
| q07 | relevance/tuned | en | 8 | 9 | 10 | 4 | 1 | 1 | 1 | 否 |
| q08 | relevance/tuned | en | 1 | 9 | 9 | 8 | 1 | 2 | 1 | 否 |
| q09 | relevance/tuned | en | 5 | 1 | 5 | 0 | 1 | 1 | 1 | 否 |
| q10 | relevance/tuned | en | 3 | 6 | 7 | 4 | 2 | 1 | 1 | 否 |
| q11 | relevance/tuned | en | 11 | 4 | 10 | 0 | 1 | 1 | 1 | 否 |
| q12 | relevance/tuned | en | 2 | 7 | 8 | 6 | 1 | 1 | 1 | 否 |
| q13 | relevance/tuned | en | 12 | 12 | 10 | 0 | 1 | 1 | 1 | 否 |
| q14 | relevance/tuned | en | 3 | 3 | 3 | 0 | 1 | 1 | 1 | 否 |
| q15 | relevance/tuned | en | 2 | 1 | 2 | 0 | 1 | 1 | 1 | 否 |
| q16 | relevance/tuned | en | 4 | 2 | 4 | 0 | 1 | 1 | 1 | 否 |
| q17 | relevance/tuned | en | 2 | 1 | 2 | 0 | 1 | 1 | 1 | 否 |
| q18 | relevance/tuned | en | 1 | 5 | 5 | 4 | 1 | 1 | 1 | 否 |
| q19 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q20 | leakage | en | 5 | 3 | 7 | 2 | — | — | — | 否 |
| q21 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q22 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q23 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q24 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q25 | relevance/heldout | en | 4 | 4 | 5 | 1 | 1 | 1 | 1 | 否 |
| q26 | relevance/heldout | en | 4 | 3 | 5 | 1 | 3 | 1 | 1 | 否 |
| q27 | relevance/heldout | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q28 | relevance/heldout | en | 1 | 5 | 6 | 5 | — | 1 | 2 | 否 |
| q29 | relevance/heldout | en | 1 | 1 | 2 | 1 | — | 1 | 1 | 否 |
| q30 | relevance/heldout | en | 1 | 1 | 2 | 1 | — | 1 | 1 | 否 |
| q31 | relevance/heldout | en | 1 | 12 | 10 | 9 | 1 | 1 | 1 | 否 |
| q32 | relevance/heldout | en | 1 | 2 | 3 | 2 | — | 1 | 2 | 否 |
| q33 | relevance/heldout | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q34 | relevance/heldout | en | 2 | 3 | 4 | 2 | 1 | 1 | 1 | 否 |
| q35 | relevance/heldout | en | 2 | 3 | 3 | 1 | 1 | 1 | 1 | 否 |
| q36 | relevance/heldout | en | 2 | 8 | 9 | 7 | 2 | 1 | 1 | 否 |
| q37 | relevance/heldout | en | 1 | 1 | 2 | 1 | — | — | — | 否 |
| q38 | relevance/heldout | en | 4 | 9 | 10 | 6 | — | 1 | 4 | 否 |
| q39 | relevance/heldout | en | 1 | 3 | 3 | 2 | — | 1 | 2 | 否 |
| q40 | relevance/heldout | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q41 | relevance/heldout | en | 2 | 4 | 5 | 3 | 1 | 1 | 1 | 否 |
| q42 | relevance/heldout | en | 0 | 0 | 0 | 0 | — | — | — | 否 |

## 协议明细（阶段 1b）
| 项 | 值 |
| --- | --- |
| 配置协议 | `semantic-en` |
| raw-v1 向量覆盖 | 30/30（1.00） |
| semantic-en-v1 向量覆盖 | 30/30（1.00） |
| 英文派生值 ready / pending / failed | 30 / 0 / 0 |
| query 走 semantic-en-v1 / raw-v1 | 42 / 0 |
| 英文形式被护栏拒绝 | 0 |

两个空间同时存在且互不排序：读取时按 `model:dtype:dims:protocol` 过滤，所以
`raw-v1` 与 `semantic-en-v1` 虽同为 384 维同一模型，也不会被放进同一次 cosine
比较。arm B 里 raw 那条腿仍然建满，是为了让"调用方没给英文形式"时有降级路径，
而不是只剩 FTS。

## 复现

```bash
bun run benchmark/run.ts --compressor=acp --protocol=semantic-en
```

评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。
