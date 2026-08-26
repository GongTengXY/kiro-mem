# kiro-mem V3 质量基准报告（gold 压缩器）

## Provenance

报告只记生成时间时无法自证是哪个版本、哪份数据集、哪条命令产出的——
文件 mtime 不是 provenance。下面这些是复现这份数字所需的全部输入。

| 项 | 值 |
| --- | --- |
| 生成时间 | 2026-07-31T13:09:44.252Z |
| commit | `b2e972f` **（工作区有未提交改动）** |
| 命令行 | `bun run benchmark/run.ts --compressor=gold --protocol=semantic-en --phase2 --no-heldout --semantic-discovery=on --semantic-floor=0.2 --semantic-only-limit=3 --report=benchmark/reports/phase2b/diagnostic-f0.2-c3.md --json=benchmark/reports/phase2b/diagnostic-f0.2-c3.json` |
| 数据集 turns.json | `aa8f9beda2a4`（30 turn） |
| 数据集 queries.json | `95ee03d880a9`（145 query） |
| 脚本 run.ts / scoring.ts / dataset.ts | `531b89402611` / `bb8e48403d71` / `e02509605c3f` |
| embedding 模型 | all-MiniLM-L6-v2 (384d) |
| 归一化协议 | `semantic-en`（双侧英文归一化，arm B） |
| 英文固定输入 | `mirror-en-acp-records.json` + `mirror-en-acp-records-other.json` + `mirror-en-acp-queries.json` + `mirror-en-acp-queries-heldout.json` + `mirror-en-acp-queries-empty.json` + `mirror-en-acp-queries-leakage.json` + `mirror-en-acp-queries-phase2.json`（记录 30 / query 163，由生产 ACP 产出） |
| 运行环境 | Bun 1.2.20 / darwin arm64 |
| 运行次数 | 1（多次运行与方差见 `--runs=N`） |
| 检索策略 | discovery=`on` floor=`0.2` semanticOnlyLimit=`3` rrfK=`60` w(fts:sem)=`1:1` tieBreak=`recency` |
| 策略注入自检 | 145 / 145 条 query 上报的 policy 与上表一致（不一致即退出） |

## 运行配置

- 压缩器：`gold`（直接返回人工标注，用于检索基线与打分器自检）
- Embedding：启用，coverage 1.00
- 数据集：30 个标注 turn（primary 26 / other 4），145 个标注 query（relevance 18 / empty 5 / leakage 122）
- 合成结果：normal 30 / fallback 0，summarize 总耗时 0.6s

## 门槛结论：存在未达标项

门槛按**举证能力**分表。把自检项与结构性恒真项和真实质量指标混在同一张
"全部通过"表里，对外阅读即构成夸大——所以它们在下面是分开的。

### 有判别力的门槛

relevance query 分成两个子集，举证能力完全不同：

- **tuned**（18 条）：检索实现就是在这批 query 上调的（D1 修复让 gold hit@5 从
  66.7% 升到 94.4%）。它的门槛是**连续性锁**，不能当泛化证据。
- **heldout**（18 条）：后补且未据此改任何检索参数。实测 hit@5 未测量（--no-heldout），
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
| R-precision（tuned；≥55.0% 为不回退锁，非质量目标） | 83.3% | ✅ |
| expected-empty query 平均返回条数（5 条，最坏 3；目标 0，门槛 ≤1） | 1.20 | ❌ |
| 英文派生值 ready 覆盖（30/30，pending 0 / failed 0） | 1.00 | ✅ |
| query 侧协议一致（145/145 走 semantic-en-v1，护栏拒绝 0） | 0 | ✅ |

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
| semantic-en-v1 向量数 == ready 派生值数（非法值入表为 0） | 30 == 30 | ✅ |
| raw-v1 腿仍然完整（降级路径可用） | 1.00 | ✅ |

### 性能门槛（余量充足）

| 门槛 | 实测 | 结果 |
| --- | --- | --- |
| search p95 延迟 < 300ms | 14.4ms | ✅ |
| bootstrap 构建 < 100ms 且在预算内 | 13.2ms / 3096B | ✅ |

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
| hit@5（全部 18 条 relevance） | 100.0% |
| ├ hit@5（tuned 18 条，检索曾在其上调优） | 100.0% |
| └ hit@5（heldout 未测量） | 未测量（--no-heldout） |
| hit@10 | 100.0% |
| MRR@10 | 0.889 |
| ├ MRR@10（tuned；排序敏感，阶段 1 主读数） | 0.889 |
| └ MRR@10（heldout；排序敏感，泛化读数） | 未测量（--no-heldout） |
| recall@10 | 100.0% |
| R-precision（下界） | 83.3% |
| ├ R-precision（tuned） | 83.3% |
| └ R-precision（heldout） | 未测量（--no-heldout） |
| heldout 中零词汇锚点条数（FTS 候选=0，**主口径**） | 未测量（--no-heldout） |
| └ 旧口径：最终返回条数为 0（拆门后会分叉） | 未测量（--no-heldout） |
| zero-FTS relevance（跨 origin 汇总） | 1 条 |
| ├ zero-FTS hit@5 | 100.0% |
| └ zero-FTS MRR | 1.000 |
| expected-empty query 平均返回（5 条） | 1.20（最坏 3） |
| └ 同上的语义候选数（越过 floor，拆门前的误召回压力） | 平均 1.40（最坏 4） |
| semantic-only 返回分布 | 总 189 / 均值 1.30 / p95 3 / max 3 |
| └ 被 cap 丢弃 | 78（cap=3） |
| discovery 请求 / 生效 / 被协议边界挡住 | 145 / 145 / 0 |

### Phase 2 校准集（Gate A 冻结，全部 `ftsCount = 0`）

> 这一组是方案 §7.4 可行性门槛与 §7.5 选择规则的**唯一**输入。它与上面的
> tuned / heldout 严格分桶：既有样本不进这组指标，这组样本也不进既有指标。
> 它是校准集，不是泛化证据——见 `phase2-calibration-set.md` §0。

| 指标 | 值 | §7.4 门槛 |
| --- | ---: | --- |
| relevance 条数 | 72 | — |
| hit@5 | 52.8% | 高于关键词门基线 |
| MRR | 0.465 | 高于关键词门基线 |
| R-precision | 41.0% | — |
| ├ 中文 hit@5 / MRR（56 条） | 53.6% / 0.467 | 分层读数 |
| └ 英文 hit@5 / MRR（16 条） | 50.0% / 0.458 | 分层读数 |
| empty 条数 | 49 | — |
| empty 平均返回 | 0.69 | ≤ 1 |
| empty 最坏返回 | 3 | ≤ 3 |
| ├ 中文 empty 平均 | 0.59 | 分层读数 |
| └ 英文 empty 平均 | 1.00 | 分层读数 |
| empty 语义候选数 | 平均 1.00（最坏 9） | — |
| 跨 workspace 泄漏条数 | 0 |
| FTS-only 降级次数 | 0 / 145 |
| search p50 / p95 | 6.8ms / 14.4ms |
| bootstrap 当前 scope | 3096B / 13.2ms（预算 8192B） |
| bootstrap 另一 scope | 981B |
| bootstrap 空 scope | 485B |

### 逐 query 明细

| query | 类型 | 期望 | 命中名次 | match_source | 泄漏 | 延迟 |
| --- | --- | --- | --- | --- | --- | --- |
| q01 FTS 特殊字符查询报错是怎么修的 | relevance | t01 | 1 | hybrid+semantic | 0 | 19.2ms |
| q02 search 为什么会降级成只用 FTS | relevance | t02 | 2 | hybrid+semantic+fts | 0 | 12.8ms |
| q03 hook 超时会不会拖慢 Kiro 启动 | relevance | t03,t19 | 2,5 | hybrid+semantic+fts | 0 | 11.5ms |
| q04 日志里会不会有用户 prompt 正文 | relevance | t04,t19 | 3,2 | hybrid+semantic+fts | 0 | 11.9ms |
| q05 版本号是在哪里统一管理的 | relevance | t05 | 1 | hybrid+semantic | 0 | 7.1ms |
| q06 MCP search 的 limit 最大能传多少 | relevance | t06 | 1 | hybrid+fts+semantic | 0 | 13.4ms |
| q07 ACP 连接池回收失败会不会导致任务永久挂住 | relevance | t07 | 1 | hybrid+semantic+fts | 0 | 9.9ms |
| q08 压缩一直失败最后会写成什么样的记录 | relevance | t08 | 1 | semantic | 0 | 9.2ms |
| q09 本地 token 认证是怎么做到用户无感的 | relevance | t11 | 1 | hybrid+fts | 0 | 12.0ms |
| q10 跑测试会不会污染我真实的数据目录 | relevance | t12 | 1 | hybrid+fts+semantic | 0 | 13.6ms |
| q11 安装完 Worker 起不来说模块找不到 | relevance | t13 | 1 | hybrid+fts | 0 | 13.3ms |
| q12 重新安装之后为什么还在跑旧代码 | relevance | t14 | 1 | hybrid+semantic | 0 | 9.7ms |
| q13 怎么发现运行中的 Worker 不是当前安装的版本 | relevance | t15 | 1 | hybrid+fts | 0 | 25.0ms |
| q14 注入到会话里的上下文有多大 会不会超预算 | relevance | t18 | 2 | hybrid+semantic | 0 | 15.2ms |
| q15 timeline 的邻居是按什么顺序排的 | relevance | t20 | 1 | hybrid+semantic+fts | 0 | 12.3ms |
| q16 本地 embedding 模型是什么精度 多少维 | relevance | t23 | 1 | hybrid+fts | 0 | 10.9ms |
| q17 跨项目会不会看到别的仓库的记忆 | relevance | t22 | 1 | hybrid | 0 | 11.7ms |
| q18 质量基准集还剩什么没做 | relevance | t26 | 1 | hybrid+semantic | 0 | 9.6ms |
| q19 虚拟滚动 react-window 帧率优化 | empty | — | 返回 0 条 | — | 0 | 11.6ms |
| q20 401 token 刷新重放请求 | leakage | — | 返回 6 条 | hybrid+fts+semantic | 0 | 7.1ms |
| q21 Kubernetes Ingress 灰度发布配置 | empty | — | 返回 3 条 | semantic | 0 | 4.0ms |
| q22 支付回调 验签 对账差异 | empty | — | 返回 2 条 | semantic | 0 | 4.3ms |
| q23 iOS APNs 推送证书 续期 | empty | — | 返回 0 条 | — | 0 | 5.7ms |
| q24 Excel 导出 中文乱码 编码 | empty | — | 返回 1 条 | semantic | 0 | 2.3ms |
| z01 搜索框里敲个奇怪符号程序就崩了 | relevance | t01 | 1 | semantic | 0 | 14.3ms |
| z02 为什么用户随手输的东西会被当成命令解释 | relevance | t01 | 未命中 | semantic | 0 | 10.1ms |
| z03 打分那步没成的时候还剩什么本事 | relevance | t02 | 未命中 | semantic | 0 | 7.7ms |
| z04 那一步太慢了是怎么被打断的 | relevance | t02 | 未命中 | semantic | 0 | 7.7ms |
| z05 开始聊天那会儿顿了一下是不是它干的 | relevance | t03 | 未命中 | semantic | 0 | 10.4ms |
| z06 后台那个东西死掉之后谁负责把它拉回来 | relevance | t03,t19 | 未命中 | semantic | 0 | 10.2ms |
| z07 排查的时候会不会把我说过的话留在文件里 | relevance | t04,t19 | 2,1 | semantic | 0 | 13.2ms |
| z08 同一个数字散落在好几处怎么收敛成一处 | relevance | t05 | 未命中 | — | 0 | 9.1ms |
| z09 传个负数进去会不会把整张表都捞出来 | relevance | t06 | 未命中 | — | 0 | 8.6ms |
| z10 有个子进程没了后面排队的活会不会全卡住 | relevance | t07 | 1 | semantic | 0 | 9.4ms |
| z11 拿不到结果的时候宁可空着也别瞎编 | relevance | t08 | 未命中 | — | 0 | 7.7ms |
| z12 卸干净再来一遍会不会有旧东西留着 | relevance | t09,t16 | 2,1 | semantic | 0 | 9.6ms |
| z13 反正要推平重来那名字还用加后缀吗 | relevance | t10 | 1 | semantic | 0 | 8.8ms |
| z15 跑一遍会不会把我自己那份东西弄脏 | relevance | t12,t09 | 未命中 | semantic | 0 | 8.9ms |
| z16 装好之后它一直不肯上线说少了点什么 | relevance | t13 | 未命中 | semantic | 0 | 8.0ms |
| z17 明明盖掉了为什么表现还是老样子 | relevance | t14 | 2 | semantic | 0 | 7.0ms |
| z18 怎么看出来跑着的那个跟装上的不是同一份 | relevance | t15 | 1 | semantic | 0 | 14.4ms |
| z19 在真机上从零走一遍通了没有 | relevance | t16 | 未命中 | semantic | 0 | 5.6ms |
| z20 一整条链子真的完整跑过一次吗 | relevance | t17 | 未命中 | semantic | 0 | 8.1ms |
| z21 开场塞进去那坨东西有多大 | relevance | t18 | 1 | semantic | 0 | 5.9ms |
| z22 各种坏掉的情况都挨个试过了吗 | relevance | t19 | 1 | semantic | 0 | 5.1ms |
| z23 前后挨着的那几条是按什么先后摆的 | relevance | t20 | 1 | semantic | 0 | 5.8ms |
| z24 两条路子各自的结果最后怎么并成一份 | relevance | t21 | 1 | semantic | 0 | 6.1ms |
| z25 别的项目那边的东西会不会串到这边来 | relevance | t22 | 未命中 | semantic | 0 | 10.7ms |
| z26 本地跑的那个小家伙精度和宽度是多少 | relevance | t23 | 未命中 | — | 0 | 7.2ms |
| z27 给模型看的那些说明怎么换成另一种话 | relevance | t24 | 1 | semantic | 0 | 8.0ms |
| z28 静态检查那边还剩几处没弄完 | relevance | t25 | 未命中 | semantic | 0 | 7.9ms |
| z29 衡量好坏那套东西什么时候必须搞出来 | relevance | t26 | 1 | semantic | 0 | 6.5ms |
| z30 用户打的字要原样对待还是当指令看 | relevance | t01 | 未命中 | semantic | 0 | 7.9ms |
| z31 为什么慢的那条腿要有自己的死线 | relevance | t02 | 1 | semantic | 0 | 6.8ms |
| z33 出问题要留线索又不许留原话怎么办 | relevance | t04 | 未命中 | — | 0 | 7.1ms |
| z34 发出去之后发现几处数字对不上 | relevance | t05 | 未命中 | — | 0 | 5.9ms |
| z35 标记一个根本没有的条目为什么会说成功 | relevance | t06 | 2 | semantic | 0 | 7.7ms |
| z36 回收的时候连新的也建不出来怎么收场 | relevance | t07 | 1 | semantic | 0 | 7.6ms |
| z37 反复试都不成最后落下来的是个什么东西 | relevance | t08 | 未命中 | semantic | 0 | 7.0ms |
| z38 为什么验收不能碰我本人那份真东西 | relevance | t09,t12 | 3 | semantic | 0 | 6.2ms |
| z39 凭据存哪儿了别人能看见吗 | relevance | t11 | 1 | semantic | 0 | 5.2ms |
| z40 手写的清单为什么早晚会漏东西 | relevance | t13 | 未命中 | semantic | 0 | 5.5ms |
| z41 已经在跑就啥也不做这种写法什么时候会害人 | relevance | t14 | 3 | semantic | 0 | 7.7ms |
| z42 为什么不能让它自己声称装对了 | relevance | t15 | 未命中 | semantic | 0 | 5.3ms |
| z43 半装不装的状态怎么才能看出来 | relevance | t16 | 1 | semantic | 0 | 6.0ms |
| z44 直接喊那几个钩子等不等于真人在聊 | relevance | t17 | 1 | semantic | 0 | 5.9ms |
| z45 换个地方打开为什么塞进来的东西就少了一大截 | relevance | t18 | 1 | semantic | 0 | 8.1ms |
| z46 被弄死之后多久能自己回来 | relevance | t19 | 未命中 | — | 0 | 4.8ms |
| z47 为什么自增的编号不能当先后顺序用 | relevance | t20 | 1 | semantic | 0 | 7.7ms |
| z48 名次合出来的那个数能当相关程度看吗 | relevance | t21 | 1 | semantic | 0 | 9.3ms |
| z49 为什么归属要写下来的时候就定死 | relevance | t22 | 未命中 | semantic | 0 | 14.8ms |
| z50 为什么要牺牲一点精度换随包带走 | relevance | t23 | 2 | semantic | 0 | 14.2ms |
| z51 给机器看的说明也要翻吗 | relevance | t24 | 1 | semantic | 0 | 5.8ms |
| z52 缺不缺这个东西要不要在类型上写清楚 | relevance | t25 | 2 | semantic | 0 | 7.9ms |
| z53 门槛应该绑在什么范围上才不会被一直推后 | relevance | t26 | 2 | semantic | 0 | 10.5ms |
| z54 光看单元那层够不够说明东西是好的 | relevance | t26 | 1 | semantic | 0 | 7.9ms |
| z55 换个地方打开就一条都没有了 | relevance | t22,t18 | 未命中 | — | 0 | 6.0ms |
| z56 近期那批候选是按什么挑出来的 | relevance | t21 | 未命中 | — | 0 | 7.5ms |
| z57 那个小东西多大随包一起走吗 | relevance | t23 | 未命中 | — | 0 | 12.4ms |
| z58 钩子那头要是连不上会怎么样 | relevance | t03,t19 | 1,2 | semantic | 0 | 50.0ms |
| y01 冰箱压缩机噪音大怎么处理 | empty | — | 返回 1 条 | semantic | 0 | 21.2ms |
| y02 鸡兔同笼这道题怎么给小学生讲 | empty | — | 返回 0 条 | — | 0 | 7.0ms |
| y04 膝盖跑步之后疼要不要看医生 | empty | — | 返回 0 条 | — | 0 | 6.2ms |
| y05 房贷提前还款划不划算 | empty | — | 返回 0 条 | — | 0 | 4.5ms |
| y06 多肉植物冬天怎么浇水 | empty | — | 返回 0 条 | — | 0 | 7.5ms |
| y07 钢琴考级曲目怎么选 | empty | — | 返回 0 条 | — | 0 | 4.6ms |
| y09 去冰岛看极光哪个月合适 | empty | — | 返回 0 条 | — | 0 | 5.2ms |
| y10 羽毛球拍磅数怎么选 | empty | — | 返回 0 条 | — | 0 | 4.5ms |
| y12 小孩牙齿矫正几岁开始合适 | empty | — | 返回 0 条 | — | 0 | 7.2ms |
| y13 换成 Postgres 之后连接数怎么调 | empty | — | 返回 0 条 | — | 0 | 4.1ms |
| y14 Redis 缓存穿透怎么防 | empty | — | 返回 3 条 | semantic | 0 | 4.6ms |
| y15 Kafka 消费者组重平衡太频繁 | empty | — | 返回 2 条 | semantic | 0 | 6.6ms |
| y16 OAuth 第三方登录接入流程 | empty | — | 返回 1 条 | semantic | 0 | 6.9ms |
| y17 GPU 批量推理吞吐怎么提上去 | empty | — | 返回 0 条 | — | 0 | 5.4ms |
| y18 镜像多阶段构建瘦身 | empty | — | 返回 0 条 | — | 0 | 3.9ms |
| y19 灰度放量到一成流量怎么控 | empty | — | 返回 0 条 | — | 0 | 4.4ms |
| y20 分库分表之后主键怎么生成 | empty | — | 返回 0 条 | — | 0 | 5.4ms |
| y21 重排模型放在哪一层比较合适 | empty | — | 返回 3 条 | semantic | 0 | 6.6ms |
| y22 近邻索引建好之后内存涨多少 | empty | — | 返回 3 条 | semantic | 0 | 6.8ms |
| y23 多台机器之间怎么互相同步 | empty | — | 返回 0 条 | — | 0 | 6.3ms |
| y24 网页端界面什么时候能看到 | empty | — | 返回 0 条 | — | 0 | 4.9ms |
| y25 按时间自动清理老数据的策略 | empty | — | 返回 0 条 | — | 0 | 6.2ms |
| y26 导出成别的格式怎么弄 | empty | — | 返回 0 条 | — | 0 | 5.1ms |
| y27 换一家云上的托管服务要改什么 | empty | — | 返回 0 条 | — | 0 | 7.5ms |
| y28 移动端小屏怎么适配 | empty | — | 返回 0 条 | — | 0 | 3.7ms |
| y29 多人协作的时候冲突怎么合 | empty | — | 返回 0 条 | — | 0 | 4.4ms |
| y30 计费和额度怎么算 | empty | — | 返回 0 条 | — | 0 | 3.3ms |
| y31 传输加密要不要上 | empty | — | 返回 0 条 | — | 0 | 3.1ms |
| y32 插件机制怎么设计才好扩展 | empty | — | 返回 0 条 | — | 0 | 6.5ms |
| y33 灰度期间怎么对比两版效果 | empty | — | 返回 3 条 | semantic | 0 | 5.9ms |
| y34 上游限速之后重试要怎么排 | empty | — | 返回 3 条 | semantic | 0 | 4.8ms |
| y35 字段级别的多份表示怎么存 | empty | — | 返回 0 条 | — | 0 | 6.1ms |
| y36 两字词的切分怎么加进去 | empty | — | 返回 0 条 | — | 0 | 5.2ms |
| y37 换个更大的编码器代价多少 | empty | — | 返回 1 条 | semantic | 0 | 6.1ms |
| y38 五万条规模下的耗时分布 | empty | — | 返回 1 条 | semantic | 0 | 4.9ms |
| y39 手机上怎么查历史 | empty | — | 返回 0 条 | — | 0 | 4.6ms |
| y40 团队之间共享要怎么授权 | empty | — | 返回 1 条 | semantic | 0 | 5.9ms |
| e01 typing a stray symbol makes it blow up | relevance | t01 | 未命中 | semantic | 0 | 3.8ms |
| e02 what if vectorising exceeds its allotted cutoff | relevance | t02 | 未命中 | — | 0 | 3.2ms |
| e03 why must a synchronous hop never manage child lifecycles | relevance | t03 | 1 | semantic | 0 | 3.8ms |
| e04 could my own phrasing be kept anywhere on disk | relevance | t04,t19 | 未命中 | — | 0 | 3.4ms |
| e05 how do you keep one number from drifting across many places | relevance | t05 | 未命中 | — | 0 | 9.2ms |
| e06 passing a negative bound pulls in everything | relevance | t06 | 1 | semantic | 0 | 8.7ms |
| e07 one broken child jams everybody queued behind it | relevance | t07 | 1 | semantic | 0 | 7.9ms |
| e08 when nothing can be produced prefer an empty honest record | relevance | t08 | 3 | semantic | 0 | 5.5ms |
| e09 where do we keep credentials who may see them | relevance | t11 | 1 | semantic | 0 | 4.6ms |
| e10 will a full sweep soil my personal folder | relevance | t12,t09 | 1 | semantic | 0 | 2.9ms |
| e11 why does stale behaviour survive an overwrite | relevance | t14 | 未命中 | semantic | 0 | 12.9ms |
| e12 what fixes ordering among neighbouring rows | relevance | t20 | 1 | semantic | 0 | 4.2ms |
| e13 how do two independent candidate lists become one ranking | relevance | t21 | 未命中 | — | 0 | 22.1ms |
| e14 can a different clone bleed into my results | relevance | t22 | 未命中 | semantic | 0 | 4.0ms |
| e15 what width plus numeric format ships inside | relevance | t23 | 1 | semantic | 0 | 3.9ms |
| e16 how many analyser complaints remain unfixed | relevance | t25 | 未命中 | semantic | 0 | 5.7ms |
| f01 how do I quiet a noisy fridge motor | empty | — | 返回 0 条 | — | 0 | 3.9ms |
| f02 best month to see northern lights | empty | — | 返回 0 条 | — | 0 | 3.6ms |
| f03 which vintage pairs with steak | empty | — | 返回 0 条 | — | 0 | 3.2ms |
| f04 how to explain simultaneous equations to a child | empty | — | 返回 0 条 | — | 0 | 3.2ms |
| f05 how do I tune a Postgres connection ceiling | empty | — | 返回 1 条 | semantic | 0 | 3.8ms |
| f06 preventing cache stampede in Redis | empty | — | 返回 3 条 | semantic | 0 | 4.7ms |
| f07 rebalancing storms in Kafka consumer groups | empty | — | 返回 0 条 | — | 0 | 5.6ms |
| f08 wiring up external OAuth login | empty | — | 返回 1 条 | semantic | 0 | 5.2ms |
| f09 throughput of batched GPU inference | empty | — | 返回 0 条 | — | 0 | 2.9ms |
| f10 shrinking images with multi stage builds | empty | — | 返回 2 条 | semantic | 0 | 4.6ms |
| f11 where should a reranking stage sit | empty | — | 返回 2 条 | semantic | 0 | 4.6ms |
| f12 footprint growth once an approximate lookup is built | empty | — | 返回 3 条 | semantic | 0 | 8.1ms |

### 逐 query 分路明细（§4.4）

一次 miss 有四种成因，在上面那张表里长得一模一样：FTS 没召回 / 语义没召回 /
两路都召回但 RRF 排坏 / 被结果上限截掉。这张表把它们拆开。`ftsRank`、
`semRank` 是期望记录在**各自那一路的候选名次表**里的位次，0 = 没进该路。

| query | 类型 | 协议 | fts候选 | 语义候选 | 返回 | 仅语义 | ftsRank | semRank | 最终名次 | 降级 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| q01 | relevance/tuned | en | 4 | 8 | 7 | 3 | 1 | 1 | 1 | 否 |
| q02 | relevance/tuned | en | 6 | 7 | 8 | 2 | 2 | 2 | 2 | 否 |
| q03 | relevance/tuned | en | 8 | 7 | 9 | 1 | 2 | 1 | 2 | 否 |
| q04 | relevance/tuned | en | 3 | 4 | 5 | 2 | 2 | 1 | 2 | 否 |
| q05 | relevance/tuned | en | 1 | 5 | 4 | 3 | 1 | 1 | 1 | 否 |
| q06 | relevance/tuned | en | 8 | 4 | 9 | 1 | 1 | 1 | 1 | 否 |
| q07 | relevance/tuned | en | 4 | 8 | 7 | 3 | 1 | 1 | 1 | 否 |
| q08 | relevance/tuned | en | 0 | 6 | 3 | 3 | — | 1 | 1 | 否 |
| q09 | relevance/tuned | en | 5 | 1 | 5 | 0 | 1 | 1 | 1 | 否 |
| q10 | relevance/tuned | en | 3 | 7 | 6 | 3 | 1 | 1 | 1 | 否 |
| q11 | relevance/tuned | en | 11 | 4 | 10 | 0 | 1 | 1 | 1 | 否 |
| q12 | relevance/tuned | en | 1 | 7 | 4 | 3 | 1 | 1 | 1 | 否 |
| q13 | relevance/tuned | en | 12 | 11 | 10 | 0 | 1 | 1 | 1 | 否 |
| q14 | relevance/tuned | en | 3 | 5 | 5 | 2 | 2 | 1 | 2 | 否 |
| q15 | relevance/tuned | en | 2 | 2 | 3 | 1 | 1 | 1 | 1 | 否 |
| q16 | relevance/tuned | en | 3 | 2 | 3 | 0 | 2 | 1 | 1 | 否 |
| q17 | relevance/tuned | en | 1 | 1 | 1 | 0 | 1 | 1 | 1 | 否 |
| q18 | relevance/tuned | en | 1 | 7 | 4 | 3 | 1 | 1 | 1 | 否 |
| q19 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q20 | leakage | en | 5 | 2 | 6 | 1 | — | — | — | 否 |
| q21 | empty | en | 0 | 4 | 3 | 3 | — | — | — | 否 |
| q22 | empty | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| q23 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| q24 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| z01 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 1 | 1 | 否 |
| z02 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z03 | relevance/phase2 | en | 0 | 8 | 3 | 3 | — | — | — | 否 |
| z04 | relevance/phase2 | en | 0 | 5 | 3 | 3 | — | — | — | 否 |
| z05 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z06 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| z07 | relevance/phase2 | en | 0 | 5 | 3 | 3 | — | 1 | 1 | 否 |
| z08 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z09 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z10 | relevance/phase2 | en | 0 | 6 | 3 | 3 | — | 1 | 1 | 否 |
| z11 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z12 | relevance/phase2 | en | 0 | 3 | 3 | 3 | — | 1 | 1 | 否 |
| z13 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z15 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| z16 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| z17 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 2 | 2 | 否 |
| z18 | relevance/phase2 | en | 0 | 4 | 3 | 3 | — | 1 | 1 | 否 |
| z19 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z20 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| z21 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z22 | relevance/phase2 | en | 0 | 8 | 3 | 3 | — | 1 | 1 | 否 |
| z23 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z24 | relevance/phase2 | en | 0 | 3 | 3 | 3 | — | 1 | 1 | 否 |
| z25 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z26 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z27 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 1 | 1 | 否 |
| z28 | relevance/phase2 | en | 0 | 9 | 3 | 3 | — | — | — | 否 |
| z29 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z30 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z31 | relevance/phase2 | en | 0 | 5 | 3 | 3 | — | 1 | 1 | 否 |
| z33 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z34 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z35 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 2 | 2 | 否 |
| z36 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z37 | relevance/phase2 | en | 0 | 9 | 3 | 3 | — | 9 | — | 否 |
| z38 | relevance/phase2 | en | 0 | 5 | 3 | 3 | — | 3 | 3 | 否 |
| z39 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z40 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z41 | relevance/phase2 | en | 0 | 5 | 3 | 3 | — | 3 | 3 | 否 |
| z42 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| z43 | relevance/phase2 | en | 0 | 4 | 3 | 3 | — | 1 | 1 | 否 |
| z44 | relevance/phase2 | en | 0 | 3 | 3 | 3 | — | 1 | 1 | 否 |
| z45 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z46 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z47 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z48 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z49 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| z50 | relevance/phase2 | en | 0 | 4 | 3 | 3 | — | 2 | 2 | 否 |
| z51 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z52 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 2 | 2 | 否 |
| z53 | relevance/phase2 | en | 0 | 3 | 3 | 3 | — | 2 | 2 | 否 |
| z54 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| z55 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z56 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z57 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| z58 | relevance/phase2 | en | 0 | 3 | 3 | 3 | — | 1 | 1 | 否 |
| y01 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| y02 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y04 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y05 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y06 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y07 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y09 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y10 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y12 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y13 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y14 | empty | en | 0 | 6 | 3 | 3 | — | — | — | 否 |
| y15 | empty | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| y16 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| y17 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y18 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y19 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y20 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y21 | empty | en | 0 | 3 | 3 | 3 | — | — | — | 否 |
| y22 | empty | en | 0 | 5 | 3 | 3 | — | — | — | 否 |
| y23 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y24 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y25 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y26 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y27 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y28 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y29 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y30 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y31 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y32 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y33 | empty | en | 0 | 4 | 3 | 3 | — | — | — | 否 |
| y34 | empty | en | 0 | 6 | 3 | 3 | — | — | — | 否 |
| y35 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y36 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y37 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| y38 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| y39 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| y40 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| e01 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| e02 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| e03 | relevance/phase2 | en | 0 | 4 | 3 | 3 | — | 1 | 1 | 否 |
| e04 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| e05 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| e06 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 1 | 1 | 否 |
| e07 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 1 | 1 | 否 |
| e08 | relevance/phase2 | en | 0 | 4 | 3 | 3 | — | 3 | 3 | 否 |
| e09 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| e10 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| e11 | relevance/phase2 | en | 0 | 8 | 3 | 3 | — | — | — | 否 |
| e12 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | 1 | 1 | 否 |
| e13 | relevance/phase2 | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| e14 | relevance/phase2 | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| e15 | relevance/phase2 | en | 0 | 1 | 1 | 1 | — | 1 | 1 | 否 |
| e16 | relevance/phase2 | en | 0 | 5 | 3 | 3 | — | — | — | 否 |
| f01 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| f02 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| f03 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| f04 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| f05 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| f06 | empty | en | 0 | 9 | 3 | 3 | — | — | — | 否 |
| f07 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| f08 | empty | en | 0 | 1 | 1 | 1 | — | — | — | 否 |
| f09 | empty | en | 0 | 0 | 0 | 0 | — | — | — | 否 |
| f10 | empty | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| f11 | empty | en | 0 | 2 | 2 | 2 | — | — | — | 否 |
| f12 | empty | en | 0 | 3 | 3 | 3 | — | — | — | 否 |

## 协议明细（阶段 1b）
| 项 | 值 |
| --- | --- |
| 配置协议 | `semantic-en` |
| raw-v1 向量覆盖 | 30/30（1.00） |
| semantic-en-v1 向量覆盖 | 30/30（1.00） |
| 英文派生值 ready / pending / failed | 30 / 0 / 0 |
| query 走 semantic-en-v1 / raw-v1 | 145 / 0 |
| 英文形式被护栏拒绝 | 0 |

两个空间同时存在且互不排序：读取时按 `model:dtype:dims:protocol` 过滤，所以
`raw-v1` 与 `semantic-en-v1` 虽同为 384 维同一模型，也不会被放进同一次 cosine
比较。arm B 里 raw 那条腿仍然建满，是为了让"调用方没给英文形式"时有降级路径，
而不是只剩 FTS。

## 复现

```bash
bun run benchmark/run.ts --compressor=gold --protocol=semantic-en
```

评估全程使用临时数据目录与临时 SQLite，不读写开发者真实 `~/.kiro-mem`（ACP 模式仅只读引用真实 `kiro-runtime` 以复用已安装的压缩子 Agent）。
