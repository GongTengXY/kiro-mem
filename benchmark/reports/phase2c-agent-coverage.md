# Phase 2C 灰度实测：真实 Agent 的检索行为与 `semantic_query_en` 覆盖率

> 本报告只读 `metric_events`。里面没有 query 正文、没有 Observation 正文、没有 workspace 路径。

## Provenance

| 项 | 值 |
| --- | --- |
| generatedAt | `2026-08-03T03:12:53.444Z` |
| commit | `b2e972f` |
| dirty | `true` |
| kiroCli | `kiro-cli 2.15.1` |
| bun | `1.2.20` |
| packageVersion | `3.0.0` |
| agent | `kiro-mem (install 模板，去掉 resources)` |
| policy | `DEFAULT_RETRIEVAL_POLICY (discovery=on floor=0.197 cap=2)` |
| worker | `子进程 bun run src/server/worker.ts（隔离 KIRO_MEMORY_DATA_DIR，端口 62071）` |
| workerImportedInProbe | `false` |
| dataDir | `(临时目录，已删除)` |
| seededObservations | `6` |
| rounds | `3` |
| promptsPerRound | `5` |

## 两种失败必须分开读

| 口径 | 实测 | 含义 |
| --- | ---: | --- |
| prompt 调用了 search | **15/15（100.0%）** | Agent 是否稳定选择检索。0/0 会让下面那行显示 100%，所以它必须单独报 |
| 完全没搜的轮次 | **0/3** | 一整轮 prompt 都没触发检索 |
| 调了工具但没落盘 | 0 | 工具被调用却没进检索内核（如 scope 解析失败） |
| search 走英文空间 | **18/18** | 发生了的 search 里，英文形式合法的比例 |
| search 缺失或被拒英文形式 | **0/18** | 传了但被护栏拒，或压根没传 |
| 会话级错误 | 0/3 | ACP 会话本身失败 |

## 逐轮结果（全部留档）

| round | sessionId | prompt 调用 search | 会话错误 |
| ---: | --- | ---: | --- |
| 1 | `4bcad1fc-5bfb-493e-8853-cdfc324c2cc0` | 5/5 | — |
| 2 | `94940bf4-b72f-463f-9a7a-ec095f3ed53f` | 5/5 | — |
| 3 | `f482d53e-5f41-4456-8693-d32072d80195` | 5/5 | — |

### 逐 prompt

| round | prompt | stopReason | search 行 | en | 缺失/被拒 | 备注 |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 1 | 我们之前处理密钥切换顺序的那次改动，具体是怎么做的？ | end_turn | 1 | 1 | 0 |  |
| 1 | 以前有没有遇到过下游变慢之后越查越慢、把队列打满的问题？ | end_turn | 1 | 1 | 0 |  |
| 1 | 前端为什么会把"没搜到"当成接口坏了？当时怎么收口的？ | end_turn | 1 | 1 | 0 |  |
| 1 | 有没有哪次改动是因为把用户信息写进了不该写的地方？ | end_turn | 1 | 1 | 0 |  |
| 1 | 我们做过 Kubernetes 上的 Istio 灰度发布吗？ | end_turn | 1 | 1 | 0 |  |
| 2 | 我们之前处理密钥切换顺序的那次改动，具体是怎么做的？ | end_turn | 2 | 2 | 0 |  |
| 2 | 以前有没有遇到过下游变慢之后越查越慢、把队列打满的问题？ | end_turn | 2 | 2 | 0 |  |
| 2 | 前端为什么会把"没搜到"当成接口坏了？当时怎么收口的？ | end_turn | 2 | 2 | 0 |  |
| 2 | 有没有哪次改动是因为把用户信息写进了不该写的地方？ | end_turn | 1 | 1 | 0 |  |
| 2 | 我们做过 Kubernetes 上的 Istio 灰度发布吗？ | end_turn | 1 | 1 | 0 |  |
| 3 | 我们之前处理密钥切换顺序的那次改动，具体是怎么做的？ | end_turn | 1 | 1 | 0 |  |
| 3 | 以前有没有遇到过下游变慢之后越查越慢、把队列打满的问题？ | end_turn | 1 | 1 | 0 |  |
| 3 | 前端为什么会把"没搜到"当成接口坏了？当时怎么收口的？ | end_turn | 1 | 1 | 0 |  |
| 3 | 有没有哪次改动是因为把用户信息写进了不该写的地方？ | end_turn | 1 | 1 | 0 |  |
| 3 | 我们做过 Kubernetes 上的 Istio 灰度发布吗？ | end_turn | 1 | 1 | 0 |  |

## 实测读数（24h 窗口 = 本次运行）

| 指标 | 实测 |
| --- | ---: |
| search 请求数 | 18 |
| `semantic-en-v1` 请求数 / 覆盖率 | 18 / 100.0% |
| `raw-v1` 请求数 | 0 |
| 英文形式问题分布 | `{}` |
| discovery 生效请求数 | 18 |
| 降级（FTS-only）/ 降级率 | 0 / 0.0% |
| zero-FTS / 其中靠语义召回 | 11 / 8 |
| semantic-only 总数 / 每请求 / 最坏 | 16 / 0.889 / 2 |
| 候选池可比向量均值 | 6 |
| **scope 内向量** 均值 / 最小 / 测量到 | 6 / 6 / 18 |
| scope 无向量的请求数 | 0 |
| 延迟 p50 / p95 | 13ms / 37ms |

## 逐请求指标行

| # | protocol | reject | ftsCount | semanticCount | semanticOnly | 池内可比 | scope 向量 | discovery | degraded | ms |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | :--: | :--: | ---: |
| 1 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 37 |
| 2 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 9 |
| 3 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 4 |
| 4 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 6 |
| 5 | semantic-en-v1 | — | 0 | 0 | 0 | 6 | 6 | ✅ | — | 19 |
| 6 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 16 |
| 7 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 15 |
| 8 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 14 |
| 9 | semantic-en-v1 | — | 0 | 2 | 2 | 6 | 6 | ✅ | — | 14 |
| 10 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 10 |
| 11 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 12 |
| 12 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 31 |
| 13 | semantic-en-v1 | — | 0 | 0 | 0 | 6 | 6 | ✅ | — | 8 |
| 14 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 23 |
| 15 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 11 |
| 16 | semantic-en-v1 | — | 1 | 2 | 1 | 6 | 6 | ✅ | — | 12 |
| 17 | semantic-en-v1 | — | 0 | 1 | 1 | 6 | 6 | ✅ | — | 13 |
| 18 | semantic-en-v1 | — | 0 | 0 | 0 | 6 | 6 | ✅ | — | 9 |

## 已知边界

- 样本是脚本内置的 5 条 prompt 与 6 条虚构语料，不是真实用户流量；它证明的是"这个 agent 定义 + 这个 prompt 在当前模型下会不会传英文形式"，不是长期覆盖率分布。
- agent JSON 去掉了 `resources`（本机 skill/steering 通配），其余与 `kiro-mem install` 写下的一致。
- Worker 以子进程启动（隔离 `KIRO_MEMORY_DATA_DIR`），本脚本进程不导入 `worker.ts`，因此不会打开真实 `~/.kiro-mem` 库。
- 本次会话自身被 hooks 采集进临时库并由真实 ACP 压缩器摘要，因此库里会多出探针自己的 Observation；它们晚于播种语料，可能出现在后续搜索结果里。
- 多轮共用同一个临时 dataDir 与 Worker，只有 ACP 会话是每轮新建；因此后一轮可能搜到前一轮对话被压缩出的 Observation。
- 临时 dataDir / KIRO_HOME / workspace 均在 tmpdir 下，退出即删（`--keep` 可保留）。
