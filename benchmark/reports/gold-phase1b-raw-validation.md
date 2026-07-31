# kiro-mem V3 质量基准报告（gold 压缩器）

## Provenance

报告只记生成时间时无法自证是哪个版本、哪份数据集、哪条命令产出的——
文件 mtime 不是 provenance。下面这些是复现这份数字所需的全部输入。

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-07-30T14:43:27.101Z |
| commit | `07f8c50` **（工作区有未提交改动）** |
| 命令行 | `bun run benchmark/run.ts --compressor=gold --protocol=raw --validation --report=benchmark/reports/gold-phase1b-raw-validation.md --json=/tmp/armAv.json` |
| 数据集 turns.json | `aa8f9beda2a4`（30 turn） |
| 数据集 queries.json | `95ee03d880a9`（62 query） |
| 脚本 run.ts / scoring.ts / dataset.ts | `60251b2a053b` / `bb8e48403d71` / `283d29ddba69` |
| embedding 模型 | all-MiniLM-L6-v2 (384d) |
| 归一化协议 | `raw`（原文直接向量化，对照组 A） |
| 运行环境 | Bun 1.2.20 / darwin arm64 |
| 运行次数 | 1（多次运行与方差见 `--runs=N`） |

## 运行配置

- 压缩器：`gold`（直接返回人工标注，用于检索基线与打分器自检）
- Embedding：启用，coverage 1.00
- 数据集：30 个标注 turn（primary 26 / other 4），62 个标注 query（relevance 36 / empty 5 / leakage 21）
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
| search p95 延迟 < 300ms | 15.9ms | ✅ |
| bootstrap 构建 < 100ms 且在预算内 | 10.6ms / 3096B | ✅ |

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
| ├ MRR@10（tuned；排序敏感，阶段 1 主读数） | 0.769 |
| └ MRR@10（heldout；排序敏感，泛化读数） | 0.403 |
| recall@10 | 69.4% |
| R-precision（下界） | 50.0% |
| ├ R-precision（tuned） | 61.1% |
| └ R-precision（heldout） | 38.9% |
| heldout 中因零词汇锚点返回空的条数 | 9 / 18 |
| └ 同上，按 FTS 候选数为 0 计（拆门后的主口径） | 9 / 18 |
| expected-empty query 平均返回（5 条） | 0.00（最坏 0） |
| 跨 workspace 泄漏条数 | 0 |
| FTS-only 降级次数 | 0 / 62 |
| search p50 / p95 | 9.7ms / 15.9ms |
| bootstrap 当前 scope | 3096B / 10.6ms（预算 8192B） |
| bootstrap 另一 scope | 981B |
| bootstrap 空 scope | 485B |

### 逐 query 明细

| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| q01 FTS 特殊字符查询报错是怎么修的 | relevance | t01 | 1 | hybrid+semantic | 0 | 16.0ms |
| q02 search 为什么会降级成只用 FTS | relevance | t02 | 2 | hybrid+semantic+fts | 0 | 11.8ms |
| q03 hook 超时会不会拖慢 Kiro 启动 | relevance | t03,t19 | 3,2 | hybrid+semantic | 0 | 9.3ms |
| q04 日志里会不会有用户 prompt 正文 | relevance | t04,t19 | 5,1 | hybrid+semantic | 0 | 9.1ms |
| q05 版本号是在哪里统一管理的 | relevance | t05 | 1 | hybrid+semantic | 0 | 7.9ms |
| q06 MCP search 的 limit 最大能传多少 | relevance | t06 | 1 | hybrid+fts+semantic | 0 | 12.1ms |
| q07 ACP 连接池回收失败会不会导致任务永久挂住 | relevance | t07 | 2 | hybrid+semantic | 0 | 11.7ms |
| q08 压缩一直失败最后会写成什么样的记录 | relevance | t08 | 未命中 | — | 0 | 6.2ms |
| q09 本地 token 认证是怎么做到用户无感的 | relevance | t11 | 1 | hybrid+semantic | 0 | 13.0ms |
| q10 跑测试会不会污染我真实的数据目录 | relevance | t12 | 2 | semantic+fts | 0 | 11.3ms |
| q11 安装完 Worker 起不来说模块找不到 | relevance | t13 | 1 | hybrid | 0 | 12.0ms |
| q12 重新安装之后为什么还在跑旧代码 | relevance | t14 | 1 | hybrid+semantic | 0 | 8.6ms |
| q13 怎么发现运行中的 Worker 不是当前安装的版本 | relevance | t15 | 1 | hybrid | 0 | 21.6ms |
| q14 注入到会话里的上下文有多大 会不会超预算 | relevance | t18 | 3 | hybrid+semantic+fts | 0 | 12.4ms |
| q15 timeline 的邻居是按什么顺序排的 | relevance | t20 | 1 | hybrid+semantic | 0 | 10.2ms |
| q16 本地 embedding 模型是什么精度 多少维 | relevance | t23 | 1 | hybrid+semantic | 0 | 10.5ms |
| q17 跨项目会不会看到别的仓库的记忆 | relevance | t22 | 2 | semantic+fts | 0 | 10.6ms |
| q18 质量基准集还剩什么没做 | relevance | t26 | 1 | hybrid+semantic | 0 | 9.8ms |
| q19 虚拟滚动 react-window 帧率优化 | empty | — | 返回 0 条 | — | 0 | 9.7ms |
| q20 401 token 刷新重放请求 | leakage | — | 返回 10 条 | hybrid+semantic | 0 | 8.5ms |
| q21 Kubernetes Ingress 灰度发布配置 | empty | — | 返回 0 条 | — | 0 | 3.2ms |
| q22 支付回调 验签 对账差异 | empty | — | 返回 0 条 | — | 0 | 2.0ms |
| q23 iOS APNs 推送证书 续期 | empty | — | 返回 0 条 | — | 0 | 3.2ms |
| q24 Excel 导出 中文乱码 编码 | empty | — | 返回 0 条 | — | 0 | 1.3ms |
| q25 purge 之后重装会不会残留旧表 | relevance | t09 | 1 | hybrid+semantic | 0 | 8.4ms |
| q26 job 的类型名后来有没有改过 | relevance | t10 | 1 | hybrid+semantic | 0 | 6.5ms |
| q27 干净机器上装完做过验收吗 | relevance | t16 | 1 | hybrid+semantic | 0 | 7.1ms |
| q28 有没有真的跑通一整轮记忆生成 | relevance | t17 | 未命中 | — | 0 | 4.3ms |
| q29 两路检索结果是用什么算法合并的 | relevance | t21 | 未命中 | — | 0 | 4.4ms |
| q30 中文界面和中文提示是怎么支持的 | relevance | t24 | 未命中 | — | 0 | 4.4ms |
| q31 还有哪些类型错误没有修完 | relevance | t25 | 1 | fts+semantic | 0 | 9.4ms |
| q32 搜索词里带引号或括号会不会崩 | relevance | t01 | 未命中 | — | 0 | 5.5ms |
| q33 向量算不出来的时候搜索还能不能用 | relevance | t02 | 未命中 | — | 0 | 4.8ms |
| q34 报错日志会不会把模型原始输出写进去 | relevance | t04 | 1 | hybrid+semantic | 0 | 8.4ms |
| q35 改一次版本号要动几个文件 | relevance | t05 | 1 | hybrid+semantic | 0 | 6.1ms |
| q36 连接池里有个子进程死了会怎么处理 | relevance | t07 | 未命中 | — | 0 | 6.1ms |
| q37 模型输出解析不了会不会把这一轮丢掉 | relevance | t08 | 未命中 | — | 0 | 4.9ms |
| q38 单元测试用的数据库文件放在哪里 | relevance | t12 | 未命中 | hybrid+semantic | 0 | 14.0ms |
| q39 安装时少拷了一个文件会有什么现象 | relevance | t13 | 4 | hybrid+semantic | 0 | 10.8ms |
| q40 会话开头塞进去的索引占多少字节 | relevance | t18 | 未命中 | — | 0 | 5.0ms |
| q41 两个不同仓库的记忆是怎么分开的 | relevance | t22 | 1 | fts+semantic | 0 | 10.0ms |
| q42 向量是多少维 用了什么量化 | relevance | t23 | 未命中 | — | 0 | 4.2ms |
| v01 向量模型还没热起来的时候搜索会怎么样 | relevance | t02 | 未命中 | — | 0 | 5.4ms |
| v02 压缩用的子进程池坏掉一个之后会不会一直卡住 | relevance | t07 | 未命中 | — | 0 | 6.3ms |
| v03 本地 token 是怎么做到用户完全感觉不到的 | relevance | t11 | 1 | hybrid+semantic | 0 | 12.3ms |
| v04 装完之后 Worker 起不来过一次，当时是什么原因 | relevance | t13 | 2 | hybrid | 0 | 16.4ms |
| v05 会话开头注入的那段索引到底多大 | relevance | t18 | 未命中 | — | 0 | 4.4ms |
| v06 timeline 为什么按 turn 的顺序排而不是按编号 | relevance | t20 | 1 | hybrid+fts+semantic | 0 | 15.9ms |
| v07 别的项目的记忆有没有可能串进当前项目 | relevance | t22 | 2 | semantic+fts | 0 | 11.3ms |
| v08 本地那个句向量模型用的是什么精度 | relevance | t23 | 未命中 | — | 0 | 4.8ms |
| v09 还有没有没修完的类型报错 | relevance | t25 | 未命中 | — | 0 | 3.6ms |
| v10 彻底清掉再重装一遍，旧版本的表还会留着吗 | relevance | t09 | 未命中 | hybrid+semantic | 0 | 12.7ms |
| v11 does a search containing a quote or a bracket still throw | relevance | t01 | 1 | hybrid+fts | 0 | 9.9ms |
| v12 what happens to search when the embedding model is unavailable | relevance | t02 | 1 | hybrid+fts | 0 | 13.7ms |
| v13 are ACP failures logged without leaking the prompt content | relevance | t04 | 1 | hybrid+semantic+fts | 0 | 11.5ms |
| v14 which MCP arguments get validated before they reach SQLite | relevance | t06 | 1 | hybrid+fts+semantic | 0 | 13.8ms |
| v15 do the tests ever write into the developer's real data directory | relevance | t12 | 1 | hybrid+fts | 0 | 12.9ms |
| v16 why does a repair install have to restart the service | relevance | t14 | 1 | hybrid+fts+semantic | 0 | 12.0ms |
| v17 how does diagnose notice that the installed version drifted | relevance | t15 | 1 | hybrid+fts+semantic | 0 | 12.4ms |
| v18 what floor does the RRF fusion apply to semantic-only candidates | relevance | t21 | 1 | hybrid+fts | 0 | 8.0ms |
| v19 are the MCP tool descriptions available in more than one language | relevance | t24 | 1 | hybrid+fts+semantic | 0 | 13.3ms |
| v20 was the quality benchmark set treated as a release blocker | relevance | t26 | 2 | hybrid+fts | 0 | 10.6ms |

### 逐 query 分路明细（§4.4）

一次 miss 有四种成因，在上面那张表里长得一模一样：FTS 没召回 / 语义没召回 /
两路都召回但 RRF 排坏 / 被结果上限截掉。这张表把它们拆开。`ftsRank`、
`semRank` 是期望记录在**各自那一路的候选名次表**里的位次，0 = 没进该路。

| query | 类型 | 协议 | fts候选 | 语义候选 | 返回 | 仅语义 | ftsRank | semRank | 最终名次 | 降级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q01 | relevance/tuned | raw | 4 | 23 | 10 | 6 | 1 | 1 | 1 | 否 |
| q02 | relevance/tuned | raw | 6 | 23 | 10 | 4 | 2 | 2 | 2 | 否 |
| q03 | relevance/tuned | raw | 8 | 13 | 10 | 2 | 2 | 2 | 2 | 否 |
| q04 | relevance/tuned | raw | 3 | 11 | 10 | 7 | 2 | 2 | 1 | 否 |
| q05 | relevance/tuned | raw | 1 | 11 | 10 | 9 | 1 | 1 | 1 | 否 |
| q06 | relevance/tuned | raw | 8 | 12 | 10 | 2 | 1 | 1 | 1 | 否 |
| q07 | relevance/tuned | raw | 4 | 17 | 10 | 6 | 1 | 6 | 2 | 否 |
| q08 | relevance/tuned | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q09 | relevance/tuned | raw | 5 | 20 | 10 | 5 | 1 | 1 | 1 | 否 |
| q10 | relevance/tuned | raw | 3 | 6 | 9 | 6 | 1 | — | 2 | 否 |
| q11 | relevance/tuned | raw | 11 | 19 | 10 | 0 | 1 | 1 | 1 | 否 |
| q12 | relevance/tuned | raw | 1 | 20 | 10 | 9 | 1 | 16 | 1 | 否 |
| q13 | relevance/tuned | raw | 12 | 21 | 10 | 0 | 1 | 3 | 1 | 否 |
| q14 | relevance/tuned | raw | 3 | 12 | 10 | 7 | 2 | — | 3 | 否 |
| q15 | relevance/tuned | raw | 2 | 10 | 10 | 8 | 1 | 1 | 1 | 否 |
| q16 | relevance/tuned | raw | 3 | 6 | 6 | 3 | 2 | 1 | 1 | 否 |
| q17 | relevance/tuned | raw | 1 | 8 | 9 | 8 | 1 | — | 2 | 否 |
| q18 | relevance/tuned | raw | 1 | 9 | 9 | 8 | 1 | 5 | 1 | 否 |
| q19 | empty | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q20 | leakage | raw | 5 | 19 | 10 | 5 | — | — | — | 否 |
| q21 | empty | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q22 | empty | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q23 | empty | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q24 | empty | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q25 | relevance/heldout | raw | 3 | 16 | 10 | 7 | 1 | 1 | 1 | 否 |
| q26 | relevance/heldout | raw | 3 | 17 | 10 | 7 | 1 | 1 | 1 | 否 |
| q27 | relevance/heldout | raw | 1 | 13 | 10 | 9 | 1 | 1 | 1 | 否 |
| q28 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q29 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q30 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q31 | relevance/heldout | raw | 1 | 5 | 6 | 5 | 1 | — | 1 | 否 |
| q32 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q33 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q34 | relevance/heldout | raw | 1 | 15 | 10 | 9 | 1 | 2 | 1 | 否 |
| q35 | relevance/heldout | raw | 1 | 14 | 10 | 9 | 1 | 1 | 1 | 否 |
| q36 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q37 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q38 | relevance/heldout | raw | 5 | 18 | 10 | 5 | — | 11 | — | 否 |
| q39 | relevance/heldout | raw | 1 | 19 | 10 | 9 | — | 3 | 4 | 否 |
| q40 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q41 | relevance/heldout | raw | 1 | 11 | 10 | 9 | 1 | — | 1 | 否 |
| q42 | relevance/heldout | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| v01 | relevance/validation | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| v02 | relevance/validation | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| v03 | relevance/validation | raw | 5 | 21 | 10 | 5 | 1 | 1 | 1 | 否 |
| v04 | relevance/validation | raw | 11 | 21 | 10 | 0 | 1 | 3 | 2 | 否 |
| v05 | relevance/validation | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| v06 | relevance/validation | raw | 11 | 12 | 10 | 1 | 1 | 1 | 1 | 否 |
| v07 | relevance/validation | raw | 1 | 11 | 10 | 9 | 1 | — | 2 | 否 |
| v08 | relevance/validation | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| v09 | relevance/validation | raw | 0 | 0 | 0 | 0 | — | — | — | 否 |
| v10 | relevance/validation | raw | 1 | 10 | 10 | 9 | — | — | — | 否 |
| v11 | relevance/validation | raw | 5 | 2 | 5 | 0 | 3 | 1 | 1 | 否 |
| v12 | relevance/validation | raw | 8 | 2 | 8 | 0 | 1 | 1 | 1 | 否 |
| v13 | relevance/validation | raw | 7 | 7 | 9 | 2 | 2 | 1 | 1 | 否 |
| v14 | relevance/validation | raw | 6 | 8 | 10 | 4 | 1 | 1 | 1 | 否 |
| v15 | relevance/validation | raw | 12 | 2 | 10 | 0 | 2 | 1 | 1 | 否 |
| v16 | relevance/validation | raw | 5 | 6 | 8 | 3 | 1 | 1 | 1 | 否 |
| v17 | relevance/validation | raw | 5 | 4 | 7 | 2 | 1 | 1 | 1 | 否 |
| v18 | relevance/validation | raw | 2 | 1 | 2 | 0 | 1 | 1 | 1 | 否 |
| v19 | relevance/validation | raw | 5 | 7 | 9 | 4 | 1 | 1 | 1 | 否 |
| v20 | relevance/validation | raw | 7 | 2 | 7 | 0 | 2 | 2 | 2 | 否 |

## 新增验证集（§5.6，只读一次，不设门槛）

共 20 条（中文 10 / 英文 10），
在实现冻结之后才标注，未参与协议选择、prompt 调整、护栏规则或 floor 取值。

**诚实边界**：它由实现者本人依据 `turns.json` 的标注写成，写的时候已经看过
tuned / heldout 的结果，所以它弱于独立第三方标注。它唯一强的地方是：这些具体
问法从未参与任何选择。引用它时必须带上这句限定。

| 子集 | 条数 | hit@5 | MRR | R-precision |
| --- | --- | --- | --- | --- |
| 全部 | 20 | 70.0% | 0.625 | 55.0% |
| 中文 | 10 | 40.0% | 0.300 | — |
| 英文 | 10 | 100.0% | 0.950 | — |

其中 5 条一个字面词都没命中（FTS 候选为 0）。
这批 query 的上限由词汇锚点门决定，不由归一化协议决定——门在阶段 2 才拆。

## 协议明细（阶段 1b）
| 项 | 值 |
| --- | --- |
| 配置协议 | `raw` |
| raw-v1 向量覆盖 | 30/30（1.00） |
| semantic-en-v1 向量覆盖 | 0/30（0.00） |
| 英文派生值 ready / pending / failed | 0 / 30 / 0 |
| query 走 semantic-en-v1 / raw-v1 | 0 / 62 |
| 英文形式被护栏拒绝 | 0 |

两个空间同时存在且互不排序：读取时按 `model:dtype:dims:protocol` 过滤，所以
`raw-v1` 与 `semantic-en-v1` 虽同为 384 维同一模型，也不会被放进同一次 cosine
比较。arm B 里 raw 那条腿仍然建满，是为了让"调用方没给英文形式"时有降级路径，
而不是只剩 FTS。

## 复现

```bash
bun run benchmark/run.ts --compressor=gold --protocol=raw
```

评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。
