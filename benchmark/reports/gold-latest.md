# kiro-mem V3 质量基准报告（gold 压缩器）

## Provenance

报告只记生成时间时无法自证是哪个版本、哪份数据集、哪条命令产出的——
文件 mtime 不是 provenance。下面这些是复现这份数字所需的全部输入。

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-07-29T03:07:27.174Z |
| commit | `a47b9d6` **（工作区有未提交改动）** |
| 命令行 | `bun run benchmark/run.ts --compressor=gold` |
| 数据集 turns.json | `aa8f9beda2a4`（30 turn） |
| 数据集 queries.json | `95ee03d880a9`（42 query） |
| 脚本 run.ts / scoring.ts | `3e0df6d13f4b` / `bb8e48403d71` |
| embedding 模型 | all-MiniLM-L6-v2 (384d) |
| 运行环境 | Bun 1.2.20 / darwin arm64 |
| 运行次数 | 1（多次运行与方差见 `--runs=N`） |

## 运行配置

- 压缩器：`gold`（直接返回人工标注，用于检索基线与打分器自检）
- Embedding：启用，coverage 1.00
- 数据集：30 个标注 turn（primary 26 / other 4），42 个标注 query（relevance 36 / empty 5 / leakage 1）
- 合成结果：normal 30 / fallback 0，summarize 总耗时 0.6s

## 门槛结论：全部通过

门槛按**举证能力**分表。把自检项与结构性恒真项和真实质量指标混在同一张
"全部通过"表里，对外阅读即构成夸大——所以它们在下面是分开的。

### 有判别力的门槛

relevance query 分成两个子集，举证能力完全不同：

- **tuned**（18 条）：检索实现就是在这批 query 上调的（D1 修复让 gold hit@5 从
  66.7% 升到 94.4%）。它的门槛是**连续性锁**，不能当泛化证据。
- **heldout**（18 条）：后补且未据此改任何检索参数。实测 hit@5 44.4%，
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
| Top-5 至少一条标注命中（tuned 18 条；连续性锁） | 94.4% | ✅ |
| R-precision（tuned；≥55.0% 为不回退锁，非质量目标） | 61.1% | ✅ |
| Top-5 至少一条标注命中（heldout 18 条；泛化读数，≥40.0% 为不回退锁） | 44.4% | ✅ |
| R-precision（heldout；≥35.0% 为不回退锁） | 38.9% | ✅ |
| expected-empty query 平均返回条数（5 条，最坏 0；目标 0，门槛 ≤1） | 0.00 | ✅ |

### 自检门槛（gold 模式下不构成质量证据）

gold 压缩器把人工标注逐字搬进结果，而打分器读的是同一份标注，因此这些项
在 gold 下证明的是"评分管道与播种→job→入库→检索链路是通的"，而不是摘要
质量。要拿它们当质量证据，必须用 `--compressor=acp` 跑。

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| outcome 非空率 | 100.0% | ✅ |
| next_steps 未完成项召回（5 条有未完成项） | 100.0% | ✅ |
| 关键事实召回（token 边界匹配） | 100.0% | ✅ |
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
| search p95 延迟 < 300ms | 13.5ms | ✅ |
| bootstrap 构建 < 100ms 且在预算内 | 9.7ms / 3096B | ✅ |

## 摘要质量（§12.3 Summary 完整性 / 事实准确性）

| 指标 | 值 |
| --- | --- |
| Observation 总数 | 30 |
| fallback 数 | 0 |
| outcome 非空率 | 100.0% |
| next_steps 未完成项召回（分母 5） | 100.0% |
| next_steps 过度生成率（分母 25，仅参考） | 0.0% |
| 关键事实逐字召回 | 100.0% |
| 关键文件召回 | 100.0% |
| memory_type 与标注一致率 | 100.0% |
| 出现幻觉文件的 turn 数 | 0 |
| 出现虚构完成断言的 turn 数 | 0 |

全部 turn 无标注偏差。

## 检索质量（§12.3 pull 检索精度 / Scope 隔离 / 延迟）

| 指标 | 值 |
| --- | --- |
| hit@5（全部 36 条 relevance） | 69.4% |
| ├ hit@5（tuned 18 条，检索曾在其上调优） | 94.4% |
| └ hit@5（heldout 18 条，未据此调参） | **44.4%** |
| hit@10 | 69.4% |
| MRR@10 | 0.586 |
| recall@10 | 69.4% |
| R-precision（下界） | 50.0% |
| ├ R-precision（tuned） | 61.1% |
| └ R-precision（heldout） | 38.9% |
| heldout 中因零词汇锚点返回空的条数 | 9 / 18 |
| expected-empty query 平均返回（5 条） | 0.00（最坏 0） |
| 跨 workspace 泄漏条数 | 0 |
| FTS-only 降级次数 | 0 / 42 |
| search p50 / p95 | 8.6ms / 13.5ms |
| bootstrap 当前 scope | 3096B / 9.7ms（预算 8192B） |
| bootstrap 另一 scope | 981B |
| bootstrap 空 scope | 485B |

### 逐 query 明细

| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| q01 FTS 特殊字符查询报错是怎么修的 | relevance | t01 | 1 | hybrid+semantic | 0 | 14.9ms |
| q02 search 为什么会降级成只用 FTS | relevance | t02 | 2 | hybrid+semantic+fts | 0 | 11.5ms |
| q03 hook 超时会不会拖慢 Kiro 启动 | relevance | t03,t19 | 3,2 | hybrid+semantic | 0 | 7.4ms |
| q04 日志里会不会有用户 prompt 正文 | relevance | t04,t19 | 5,1 | hybrid+semantic | 0 | 8.6ms |
| q05 版本号是在哪里统一管理的 | relevance | t05 | 1 | hybrid+semantic | 0 | 8.0ms |
| q06 MCP search 的 limit 最大能传多少 | relevance | t06 | 1 | hybrid+fts+semantic | 0 | 11.4ms |
| q07 ACP 连接池回收失败会不会导致任务永久挂住 | relevance | t07 | 2 | hybrid+semantic | 0 | 12.1ms |
| q08 压缩一直失败最后会写成什么样的记录 | relevance | t08 | 未命中 | — | 0 | 5.6ms |
| q09 本地 token 认证是怎么做到用户无感的 | relevance | t11 | 1 | hybrid+semantic | 0 | 11.0ms |
| q10 跑测试会不会污染我真实的数据目录 | relevance | t12 | 2 | semantic+fts | 0 | 10.8ms |
| q11 安装完 Worker 起不来说模块找不到 | relevance | t13 | 1 | hybrid | 0 | 13.5ms |
| q12 重新安装之后为什么还在跑旧代码 | relevance | t14 | 1 | hybrid+semantic | 0 | 8.5ms |
| q13 怎么发现运行中的 Worker 不是当前安装的版本 | relevance | t15 | 1 | hybrid | 0 | 20.4ms |
| q14 注入到会话里的上下文有多大 会不会超预算 | relevance | t18 | 3 | hybrid+semantic+fts | 0 | 12.3ms |
| q15 timeline 的邻居是按什么顺序排的 | relevance | t20 | 1 | hybrid+semantic | 0 | 10.8ms |
| q16 本地 embedding 模型是什么精度 多少维 | relevance | t23 | 1 | hybrid+semantic | 0 | 9.7ms |
| q17 跨项目会不会看到别的仓库的记忆 | relevance | t22 | 2 | semantic+fts | 0 | 10.1ms |
| q18 质量基准集还剩什么没做 | relevance | t26 | 1 | hybrid+semantic | 0 | 10.3ms |
| q19 虚拟滚动 react-window 帧率优化 | empty | — | 返回 0 条 | — | 0 | 9.8ms |
| q20 401 token 刷新重放请求 | leakage | — | 返回 10 条 | hybrid+semantic | 0 | 7.8ms |
| q21 Kubernetes Ingress 灰度发布配置 | empty | — | 返回 0 条 | — | 0 | 4.0ms |
| q22 支付回调 验签 对账差异 | empty | — | 返回 0 条 | — | 0 | 2.2ms |
| q23 iOS APNs 推送证书 续期 | empty | — | 返回 0 条 | — | 0 | 3.4ms |
| q24 Excel 导出 中文乱码 编码 | empty | — | 返回 0 条 | — | 0 | 1.5ms |
| q25 purge 之后重装会不会残留旧表 | relevance | t09 | 1 | hybrid+semantic | 0 | 8.7ms |
| q26 job 的类型名后来有没有改过 | relevance | t10 | 1 | hybrid+semantic | 0 | 6.5ms |
| q27 干净机器上装完做过验收吗 | relevance | t16 | 1 | hybrid+semantic | 0 | 8.5ms |
| q28 有没有真的跑通一整轮记忆生成 | relevance | t17 | 未命中 | — | 0 | 4.2ms |
| q29 两路检索结果是用什么算法合并的 | relevance | t21 | 未命中 | — | 0 | 4.4ms |
| q30 中文界面和中文提示是怎么支持的 | relevance | t24 | 未命中 | — | 0 | 4.3ms |
| q31 还有哪些类型错误没有修完 | relevance | t25 | 1 | fts+semantic | 0 | 9.1ms |
| q32 搜索词里带引号或括号会不会崩 | relevance | t01 | 未命中 | — | 0 | 4.1ms |
| q33 向量算不出来的时候搜索还能不能用 | relevance | t02 | 未命中 | — | 0 | 4.7ms |
| q34 报错日志会不会把模型原始输出写进去 | relevance | t04 | 1 | hybrid+semantic | 0 | 8.8ms |
| q35 改一次版本号要动几个文件 | relevance | t05 | 1 | hybrid+semantic | 0 | 7.9ms |
| q36 连接池里有个子进程死了会怎么处理 | relevance | t07 | 未命中 | — | 0 | 6.7ms |
| q37 模型输出解析不了会不会把这一轮丢掉 | relevance | t08 | 未命中 | — | 0 | 5.0ms |
| q38 单元测试用的数据库文件放在哪里 | relevance | t12 | 未命中 | hybrid+semantic | 0 | 13.3ms |
| q39 安装时少拷了一个文件会有什么现象 | relevance | t13 | 4 | hybrid+semantic | 0 | 11.8ms |
| q40 会话开头塞进去的索引占多少字节 | relevance | t18 | 未命中 | — | 0 | 5.4ms |
| q41 两个不同仓库的记忆是怎么分开的 | relevance | t22 | 1 | fts+semantic | 0 | 10.7ms |
| q42 向量是多少维 用了什么量化 | relevance | t23 | 未命中 | — | 0 | 4.1ms |

## 复现

```bash
bun run benchmark/run.ts --compressor=gold
```

评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。
