# kiro-mem V3 质量基准报告（acp 压缩器）

- 生成时间：2026-07-27T07:00:32.058Z
- 压缩器：`acp`（kiro-runtime=~/.kiro-mem/kiro-runtime，timeoutMs=30000，maxRetries=2）
- Embedding：启用，coverage 1.00
- 数据集：30 个标注 turn（primary 26 / other 4），20 个标注 query（relevance 18 / leakage 2）
- 合成结果：normal 30 / fallback 0，summarize 总耗时 180.4s
- 压缩器计数（§12.4）：JSON repair 0，repair 耗尽降级 0，runtime 回收 1，工具调用污染 0。job 层的超时/失败由 JobRunner 重试吸收，最终仍为 30 条 normal。

## 门槛结论：全部通过

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| Top-5 至少一条标注 Observation 命中 | 94.4% | ✅ |
| 跨 workspace 检索泄漏为 0 | 0 | ✅ |
| 跨 workspace bootstrap 注入为 0 | 0 | ✅ |
| outcome 非空率 | 100.0% | ✅ |
| next_steps 未完成项召回（5 条有未完成项） | 100.0% | ✅ |
| 关键事实逐字召回 | 96.1% | ✅ |
| 关键文件召回 | 100.0% | ✅ |
| 虚构完成状态 turn 数 | 0 | ✅ |
| 幻觉文件 turn 数 | 0 | ✅ |
| search p95 延迟 < 300ms | 14.7ms | ✅ |
| bootstrap 构建 < 100ms 且在预算内 | 12.0ms / 3306B | ✅ |

## 摘要质量（§12.3 Summary 完整性 / 事实准确性）

| 指标 | 值 |
| --- | --- |
| Observation 总数 | 30 |
| fallback 数 | 0 |
| outcome 非空率 | 100.0% |
| next_steps 未完成项召回（分母 5） | 100.0% |
| next_steps 过度生成率（分母 25，仅参考） | 8.0% |
| 关键事实逐字召回 | 96.1% |
| 关键文件召回 | 100.0% |
| memory_type 与标注一致率 | 76.7% |
| 出现幻觉文件的 turn 数 | 0 |
| 出现虚构完成断言的 turn 数 | 0 |

### 逐条问题明细

| turn | quality | 问题 |
| --- | --- | --- |
| t02 | normal | memory_type 不符（参考） |
| t05 | normal | next_steps 过度生成（参考） |
| t08 | normal | memory_type 不符（参考） |
| t12 | normal | next_steps 过度生成（参考） |
| t17 | normal | memory_type 不符（参考）；事实缺失: coverage 1.0 |
| t20 | normal | memory_type 不符（参考） |
| t23 | normal | memory_type 不符（参考） |
| t24 | normal | 事实缺失: zh |
| t25 | normal | memory_type 不符（参考）；事实缺失: 3 errors |
| x02 | normal | memory_type 不符（参考） |

## 检索质量（§12.3 pull 检索精度 / Scope 隔离 / 延迟）

| 指标 | 值 |
| --- | --- |
| hit@5（Top-5 至少一条标注命中） | 94.4% |
| hit@10 | 100.0% |
| MRR@10 | 0.813 |
| recall@10 | 100.0% |
| 跨 workspace 泄漏条数 | 0 |
| FTS-only 降级次数 | 0 / 20 |
| search p50 / p95 | 7.6ms / 14.7ms |
| bootstrap 当前 scope | 3306B / 12.0ms（预算 8192B） |
| bootstrap 另一 scope | 1055B |
| bootstrap 空 scope | 227B |

### 逐 query 明细

| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| q01 FTS 特殊字符查询报错是怎么修的 | relevance | t01 | 1 | hybrid+fts+semantic | 0 | 12.7ms |
| q02 search 为什么会降级成只用 FTS | relevance | t02 | 1 | hybrid+semantic | 0 | 14.7ms |
| q03 hook 超时会不会拖慢 Kiro 启动 | relevance | t03,t19 | 2,3 | hybrid+fts+semantic | 0 | 8.3ms |
| q04 日志里会不会有用户 prompt 正文 | relevance | t04,t19 | 7,8 | hybrid+semantic+fts | 0 | 8.6ms |
| q05 版本号是在哪里统一管理的 | relevance | t05 | 1 | hybrid+semantic | 0 | 6.6ms |
| q06 MCP search 的 limit 最大能传多少 | relevance | t06 | 1 | hybrid+semantic | 0 | 9.5ms |
| q07 ACP 连接池回收失败会不会导致任务永久挂住 | relevance | t07 | 2 | hybrid+semantic+fts | 0 | 9.8ms |
| q08 压缩一直失败最后会写成什么样的记录 | relevance | t08 | 2 | semantic+fts | 0 | 7.2ms |
| q09 本地 token 认证是怎么做到用户无感的 | relevance | t11 | 1 | hybrid+fts+semantic | 0 | 6.6ms |
| q10 跑测试会不会污染我真实的数据目录 | relevance | t12 | 2 | semantic+fts | 0 | 7.6ms |
| q11 安装完 Worker 起不来说模块找不到 | relevance | t13 | 1 | hybrid | 0 | 7.8ms |
| q12 重新安装之后为什么还在跑旧代码 | relevance | t14 | 1 | hybrid+semantic | 0 | 6.0ms |
| q13 怎么发现运行中的 Worker 不是当前安装的版本 | relevance | t15 | 1 | hybrid | 0 | 12.8ms |
| q14 注入到会话里的上下文有多大 会不会超预算 | relevance | t18 | 2 | hybrid+fts+semantic | 0 | 7.6ms |
| q15 timeline 的邻居是按什么顺序排的 | relevance | t20 | 1 | hybrid+semantic | 0 | 6.2ms |
| q16 本地 embedding 模型是什么精度 多少维 | relevance | t23 | 1 | hybrid+semantic+fts | 0 | 6.8ms |
| q17 跨项目会不会看到别的仓库的记忆 | relevance | t22 | 1 | fts+semantic | 0 | 5.8ms |
| q18 质量基准集还剩什么没做 | relevance | t26 | 1 | fts+semantic | 0 | 5.1ms |
| q19 虚拟滚动 react-window 帧率优化 | leakage | — | 返回 3 条 | semantic | 0 | 5.8ms |
| q20 401 token 刷新重放请求 | leakage | — | 返回 10 条 | hybrid+fts+semantic | 0 | 5.0ms |

## 复现

```bash
bun run benchmark/run.ts --compressor=acp
```

评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。
