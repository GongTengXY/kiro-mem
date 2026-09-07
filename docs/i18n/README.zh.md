<p align="center">
  <img src="../assets/logo.png" alt="kiro-mem logo" width="320" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/v/kiro-mem.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/dm/kiro-mem.svg" alt="npm downloads" /></a>
  <a href="https://github.com/GongTengXY/kiro-mem/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/kiro-mem.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript" alt="TypeScript" />
</p>

<p align="center">
  <a href="README.zh.md">🇨🇳 简体中文</a> | <a href="../../README.md">🇬🇧 English</a>
</p>

#### [Kiro CLI](https://kiro.dev) 的持久记忆系统

> 仅支持 Kiro CLI，不兼容 Kiro IDE。

[快速开始](#快速开始) • [工作原理](#工作原理) • [MCP 工具](#mcp-工具) • [Web 查看器](#web-查看器) • [配置](#配置) • [CLI 命令](#cli-命令) • [限制](#限制) • [许可证](#许可证)

---

kiro-mem 自动捕获 Kiro 会话中的每一轮对话（prompt → 工具调用 → stop），并将其压缩为一条不可变的 **Observation**——每个 closed turn 对应一条。它从不改写历史，也不在写入时猜测主题。会话开始时，它注入当前 workspace 历史工作的紧凑索引；Agent 先扫描这份"菜单"，再按需搜索、拉取完整详情。相关性组织发生在**读取时**，由 Agent 驱动，而非脆弱的写入期聚类。

**核心特性**

- 🧠 **持久记忆** — 跨会话保留项目上下文
- 🧩 **原子且不可变** — 一个 closed turn → 一条 Observation，文本永不改写或融合
- 🤖 **ACP 原生** — 压缩通过 Kiro CLI ACP 完成，无需配置 LLM API Key
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义召回，用 RRF 融合并按 workspace 硬隔离；词面零重叠的问法也能找回记录
- 📊 **读取期组织** — 先注入紧凑索引，Agent 按需拉取相关性（`search` → `timeline` → `get_observations`）
- 🔧 **MCP 工具** — `search`、`timeline`、`get_observations`、`pin`
- 🖥 **Web 查看器** — 本机浏览器界面：把每条 Observation 与产生它的 turn 并排对照、预览下一次会话真正会收到的上下文、把一条记忆连同它的原始 turn 一起永久删除
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 持久任务队列，不阻塞工具调用
- 🔄 **进程保活** — Worker 由 `launchd` 或 `systemd` 管理
- 🌐 **国际化** — CLI、运行时压缩提示词与 Web 查看器界面均支持中英文

## 快速开始

需要 [Bun](https://bun.sh) 和支持 `acp` 子命令的 [Kiro CLI](https://kiro.dev)。

> **V3 与 V2 完全不兼容，唯一受支持的升级方式是清空重装。** 不提供数据库迁移，也没有兼容模式；在 V2 数据上直接装 V3 不受支持，也没有测试过。
>
> ```bash
> kiro-mem stop
> kiro-mem uninstall --purge   # ⚠️ 先看下面的警告
> npm i -g kiro-mem@3
> kiro-mem install
> ```
>
> ### ⚠️ `--purge` 会永久删除全部历史记忆与配置
>
> 它删除整个 `~/.kiro-mem`：所有采集到的 turn、所有 Observation、所有向量、任务队列、你的 `config.json` 以及本地 Worker token。**不可恢复，也没有导出功能。** 如果这些历史对你有价值，先把 `~/.kiro-mem` 复制到别处——但要知道 V2 的副本 V3 读不回来。
>
> 前面那句 `kiro-mem stop` 不是可选项：它避免旧 Worker 往一个正在被删除的目录里继续写。

首次安装：

```bash
npm i -g kiro-mem@3
kiro-mem install
```

安装器会检查 Kiro CLI ACP 可用性，生成仅当前用户可读写的高熵本地 Worker token，把内置的 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models/`，搭建隔离的 `kiro-runtime`（压缩子 agent + prompt），然后注册并启动 Worker。**无需任何 API Key** —— 记忆压缩通过 `kiro-cli acp` 复用 Kiro 已有的登录态完成。

如果 `kiro-runtime` 不完整（agent 文件缺失、prompt 缺失，或 `tools` 字段意外非空），Worker 启动时会立刻 fail-fast，不会带病运行而悄悄破坏压缩纯净性。重新执行 `kiro-mem install` 即可修复。

### 设为默认 Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

或在聊天中切换：

```text
/agent kiro-mem
```

> **中途切换不会注入记忆索引。** `agentSpawn` 是会话启动那一刻的触发点 —— 它在数组格式里的别名就叫
> `SessionStart` —— Kiro CLI 切换 agent 时不会重放它。在 kiro-cli 2.19.1 上实测：用一个 `agentSpawn`
> hook 只往文件追加一行的探针 agent，`--agent probe` 启动会写入 1 行；先用别的 agent 启动再
> `/agent probe`，写入 0 行，尽管 TUI 已经回了 `Agent changed to probe`。
>
> 切进来的 agent 其余部分都是生效的：`/mcp` 显示 `kiro-mem ● running 4 tools`，
> `userPromptSubmit` / `postToolUse` / `stop` 三个 hook 照常触发，所以这一轮仍会被捕获和压缩 ——
> 丢的只是这次会话的注入索引。想补回来：直接用 kiro-mem 启动会话，或显式让 agent 调
> `@kiro-mem/search`，或把 hook 本该注入的那段原文粘给它：
>
> ```bash
> curl -s -H "Authorization: Bearer $(cat ~/.kiro-mem/.token)" \
>   "http://127.0.0.1:37778/context/bootstrap?cwd=$PWD"
> ```

### 验证安装

```bash
kiro-mem diagnose
kiro-mem status
curl http://127.0.0.1:37778/health
```

## 工作原理

**架构**

1. **核心真相层** — `session_id` → `turns` → `turn_events`（追加写入原始 hook payload）+ `turn_artifacts`（确定性提取：工具、文件、命令、测试/构建/lint 信号、错误）。该层永不改写，可重建任意投影。
2. **提炼层** — 持久任务（`summarize_turn` → `embed_observation`）驱动一个 **ACP runtime 池**：每次压缩都会向 `kiro-cli acp` 子进程发送 prompt，子进程内部跑的是 `tools: []` 的隔离 sub-agent `kiro-mem-compressor`。任何 tool-call 通知都视为污染，对应的 runtime 槽位会被立即回收。`summarize_turn` 消费用户 prompt、助手最终回复（`assistant_response`）与确定性 artifacts，对每个 closed turn 恰好写出一条不可变 Observation（按 `turn_id` 幂等）。它从不聚类、融合或 supersede。压缩失败时降级为 `quality=fallback` 的 Observation，只携带确定性证据——绝不虚构结果。
3. **检索层** — `observations_fts`（FTS5）与本地语义召回是两条**互相独立**的腿，用 RRF 融合并按 workspace 硬隔离 → MCP 工具 → 上下文注入。语义腿不需要关键词先命中才能跑：它可以召回 query 里一个字都没出现过的记录，边界是 cosine floor 与纯语义结果上限。

会话开始时，kiro-mem 为当前 workspace 注入一份紧凑的 **Observation 索引**：置顶观察、少数最近条目（附简短 outcome 片段）、以及更长的最近索引（每行带近似读取成本）。它是"菜单"而非正文——不做 LLM 合成，也没有主题。Agent 随后通过 `search` → `timeline` → `get_observations` 按需拉取相关性。

**数据模型**

- `session_refs` — 会话隔离元数据
- `turns` + `turn_events` — 每轮 prompt → stop 的生命周期行 + 追加写入的原始 hook payload（真相层）
- `turn_artifacts` — 确定性提取（工具、文件、命令、测试/构建/lint 信号、错误）
- `observations` — 不可变的按 turn 记忆单元：一个 closed turn → 一条 Observation，文本永不改写
- `observations_fts`（FTS5 trigram）+ `observation_embeddings` — 混合搜索的索引表
- `jobs` — 持久异步任务队列

## MCP 工具

| 工具 | 用途 |
|------|------|
| `search` | 混合搜索观察，支持 `type`、`days`、`repo`/`cwd` 过滤 |
| `timeline` | 按真实 source-turn 顺序展示某条观察前后相邻的观察 |
| `get_observations` | 按 ID 获取观察完整详情，含来源 turn 元数据 |
| `pin` | 标记/取消标记某条观察供后续上下文使用 |

```text
@kiro-mem/search query="auth 模块 bug" type="bugfix" limit=10
@kiro-mem/timeline observation_id=42 before=3 after=3 mode="scope"
@kiro-mem/get_observations ids=[42,56]
```

`search` 通过 `computeScopeKey(repo, cwd)` 硬隔离到当前 workspace——传 `repo`/`cwd` 指定 scope，或传 `all_scopes: true` 浏览全部。`timeline` 以观察的**来源 turn**（而非其 ID）为锚点，因此相邻项反映真实工作时间线；传 `mode="session"` 可只看同一会话，而非整个 workspace。

**观察类型（`memory_type`）：** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## 隐私

使用 `<private>` 标签在存储前脱敏：

```text
<private>数据库密码是 xxx</private>
帮我配置连接
```

`<private>` 标签内的内容会在写入存储前替换为 `[REDACTED]`——覆盖用户 prompt、工具 payload 和助手最终回复，因此私密内容不会进入任何 Observation 或注入索引。

## Web 查看器

```bash
kiro-mem viewer
```

由 Worker 自己提供的本机浏览器界面——零 CDN、零独立 dev server、除 loopback 之外不走网络。它默认显示**全部 workspace**；workspace 选择器可把 Feed 缩小到单个项目，并逐个列出完整路径、Observation 数量和最后活动时间。全局视图选中期间，界面上始终保留提示。

整个界面只渲染**一种语言，由 `config.language` 决定**，随 bootstrap 响应下发——没有中英并排的标签。改完 `kiro-mem config` 下次打开页面即生效；若该字段缺失（旧版 Worker），回退为英文。

它回答这些问题：

- **记住了什么** —— 实时 Feed，按时间倒序列出 Observation，带类型、质量、pin 状态和 summary/outcome 摘要。新的 Observation 在其压缩事务提交时出现。
- **生成得是否忠于原文** —— 每张卡片打开左右对照的详情：生成字段（`title`、`summary`、`request`、`outcome`、`learned`、`next_steps`、evidence、concepts、files）对照它们来自的真相层（`prompt_text`、确定性产物、事件数量与原始字节数）。原始 event payload 按需加载，单事件与单响应都有字节上限，所以一个 4MB 的 turn 不会拖垮页面。
- **下一次会话会收到什么** —— 上下文预览渲染 `agentSpawn` hook 实际注入的那一串文本，带 `usedBytes / effectiveMaxBytes` 和分段字节明细（frame、信任边界、usage、pinned、recent-detail、recent-index）。预算可临时调整，服务端强制封顶 9500 字节。
- **搜索为什么命中** —— 当前 scope 内的关键词搜索，逐条显示 `match_source`。查看器搜索是**纯关键词**的：它不会替你伪造 `semantic_query_en`，所以标为 `semantic` 的结果来自 agent 那条路径，而不是这个界面。
- **检索是否健康** —— 一个面板投影 `/health` 已有的 24 小时 `search_24h` 计数与 retrieval profile，另有 worker 错误日志抽屉。

查看器只有两个写操作，确认方式与可逆性对应：**pin** 采用乐观更新，结果用短暂的 toast 告知（Worker 拒绝时也会提示已回滚）；**删除**一律弹出模态框，写清将被销毁的内容。

### 永久删除

卡片（或详情头部）的垃圾桶图标会打开确认框，显示 Observation 的 ID 与标题、workspace、turn 的起止时间，以及将被销毁的原始 event 数量和原始字节数。确认后在**同一个 SQLite 事务**里删除：

Observation → 它的向量与语义归一化行 → 它的 FTS 条目 → 来源 turn 的 `turn_artifacts`、`turn_events` 和 `turns` 行 → 挂在该 turn 或 Observation 上的所有 `pending` 与终态 job。

刻意**没有**"只删记忆、保留 turn"的模式：保留下来的 turn 正好是 `kiro-mem repair` 会重新入队的对象，那条记录会回来。删除成功后，该 turn 无法再通过 `search`、`timeline`、`get_observations`、上下文注入或 `repair` 触达，所有打开的查看器会立即移除对应卡片。

拒绝是诚实的，而不是半途而废：

- 关联 job 处于 `leased` 状态时返回 **409** 且**不改动任何数据**——ACP 或 CPU 任务无法可靠中途取消，等它结束后重试；
- 任何 SQL 失败都整体回滚，各表行数保持不变；
- `pin` 不阻止删除，它只影响展示与注入优先级。

这是产品层面的永久删除——不可查询、不可检索、不可重建。它**不是**法证级擦除：普通 SQLite `DELETE` 会把旧字节留在 WAL、freelist、文件系统快照和你已经做过的备份里，kiro-mem 刻意不做自动 `VACUUM`，也不重写数据库。

### 安全模型

- 查看器跑在同一个仅监听 loopback 的 Worker 上，复用现有的本机 Bearer token。`/ui` 与它的两个静态资源是公开外壳；**所有** `/api/viewer/*` 路由在没有 token 时 fail closed。
- `kiro-mem viewer` 把 token 放在 URL 的 **fragment** 里，浏览器永远不会把 fragment 发给服务端。页面把它移入该标签页的 `sessionStorage` 并重写 URL，因此 token 不会进入历史记录、Referer 头或 Worker 日志。关闭标签页即结束会话；遇到 401 会显示"请重新运行 `kiro-mem viewer`"，而不是死循环重连。
- 请求必须带与 Worker 端口精确匹配的 loopback `Host`，用于阻断 DNS rebinding。`DELETE` 额外要求 `Origin` 与页面自身 origin 完全一致。
- 响应设置 `nosniff`、`DENY` 框架、`no-referrer`、同源 COOP/CORP，以及 `default-src 'none'`、仅允许 `'self'` 脚本与样式的 CSP。
- 已记录的记忆是不可信输入，只按 text node 渲染。整个 bundle 里没有 `dangerouslySetInnerHTML`、没有 Markdown 渲染、没有任何自动链接。

如果查看器 bundle 缺失（源码检出且没跑过 `bun run build:ui`），Worker 仍然正常启动，`/ui` 返回可读的构建提示。

## 配置

编辑 `~/.kiro-mem/config.json`，或运行 `kiro-mem config` 交互式配置：

```json
{
  "language": "zh",
  "compression": {
    "concurrency": 3,
    "minWarmRuntimes": 1,
    "idleTtlMs": 600000,
    "timeoutMs": 30000,
    "startupTimeoutMs": 30000,
    "maxRetries": 2
  },
  "context": {
    "maxOutputBytes": 8192
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  },
  "retrieval": {
    "semanticDiscovery": true
  },
  "runtime": {
    "kiroHome": ""
  }
}
```

- `language`：`zh` 或 `en`。同时决定 CLI 输出、运行时压缩 prompt **和** Web 查看器界面语言，界面只渲染这一种语言。
- `compression.concurrency`：并行运行的 `kiro-cli acp` 进程数（默认 `3`）。这是对**进程数**的硬上限，而不只是对池内槽位的限制：正在关闭的 runtime 在其进程真正退出前仍占用配额，所以永远不会出现替补进程和尚未退出的旧进程并存。
- `compression.minWarmRuntimes`：空闲回收永远不会动的 runtime 数量（默认 `1`，会被夹到 `[0, concurrency]`）。这是下限而不是目标——从未压缩过任何东西的 Worker 仍然是 0 个。设为 `0` 允许高峰过后池子完全清空，代价是下一次压缩要付 ACP 冷启动。
- `compression.idleTtlMs`：runtime 释放后允许空闲多久才被回收（默认 `600000`，即 10 分钟；通过 `kiro-mem config` 修改时夹在 `[1000, 86400000]`）。**`0` 表示关闭空闲回收**，绝不表示"立即杀掉"。负数、`NaN` 和 `Infinity` 一律回退到默认值。
- `compression.timeoutMs`：单次压缩超时（毫秒），夹在 `[5000, 60000]`（默认 `30000`）。0、负数、`NaN` 和非数字一律回退到默认值——这里没有"0 表示不限时"的语义，0ms 预算会让每次压缩在下一个 tick 就超时。
- `compression.startupTimeoutMs`：ACP 握手预算（毫秒），覆盖 `initialize` 和紧随其后的 `session/new`，夹在 `[5000, 120000]`（默认 `30000`）。**和 `timeoutMs` 刻意分开**：握手等的是进程起来并完成协商（实测随后端冷热在 2 秒到 20 秒以上之间飘），压缩等的是模型写完摘要；共用一个预算时，调大到够压缩用会让真卡死的进程很久才被发现，调小到够握手用又会腰斩压缩。这不是吞吐参数而是**记忆质量**参数：握手预算不够时 `summarize_turn` 会失败，重试耗尽后那个 turn 被写成只有确定性证据的 `quality=fallback` Observation。与同结构的 `idleTtlMs` 相反，`0` 在这里**不表示关闭**，而是回退到默认值。
- `compression.maxRetries`：JSON 修复重试次数，超出后降级为 `quality=fallback` 的 Observation（默认 `2`）。
- `runtime.kiroHome`：压缩子 agent 使用的隔离 `KIRO_HOME`。空串时会回退到 `<dataDir>/kiro-runtime`，这是 `kiro-mem install` 默认布局。
- `context.maxOutputBytes`：注入 Observation 索引的字节预算，保持在 `agentSpawn` 的 10KB 上限之下（默认 `8192`）。
- `retrieval.semanticDiscovery`：语义相似度是否可以浮出关键词从未命中的记录（默认 `true`）。见下。

### ACP 进程治理

压缩跑在 `kiro-cli acp` 子进程里，每个都占真实的常驻内存——开发机上实测单个 runtime 约 38MB（直接子进程 9.8MB，加上它自己的一个 28.1MB 子进程）。多个 Kiro 窗口**不会**各自启动一个 Worker：它们都通过 loopback 进入同一个 `~/.kiro-mem` Worker、共享同一个池，所以下面这个上限是整机上限，不是每个窗口的上限。

池子初始为空，直到第一个压缩任务才创建进程。之后：

- 任务结束的 runtime 会被**复用**给下一个任务，而不是重启；
- 空闲超过 `idleTtlMs` 的 runtime 会被**回收**——进程被杀掉且不建替补——前提是回收后仍留有至少 `minWarmRuntimes` 个；
- `concurrency` 约束的是**进程**而不是账面数字：正在回收的 runtime 在其进程真正退出前仍占着配额，所以替补永远不会和尚未关完的旧进程并存；
- 达到 `maxJobsPerProcess` 或发生 ACP 错误/污染的 runtime 会**原地重启**。槽位数量不变，因此 warm 下限不会挡住它——即使池里只剩最后一个 runtime；
- 进程自己死掉的槽位会被无条件清除，既不看 TTL 也不受 warm 下限保护。死掉的 runtime 不算 warm。

在途任务不会被打断：空闲时间只从任务释放 runtime 之后开始计算，正在忙的 runtime 永远不会被回收。

有两个读数能判断它是否在工作：

```bash
curl -s http://127.0.0.1:37778/health | jq '.acp'   # idleRecycles、生效配置、逐 slot 空闲时长
kiro-mem diagnose                                    # 同样的信号，已排版
```

`/health.acp` 把 runtime 被关闭的三种原因分开——`jobLimitRecycles`、`errorRecycles`、`idleRecycles`——另有 `deadDrops` 表示自己消失的进程。`restarts` 保持原义，只统计原地重启（`jobLimitRecycles + errorRecycles`），所以空闲回收永远不会被读成不稳定。`config` 报告的是那个 Worker 进程中**实际生效**的值，不一定等于 `config.json` 现在写的内容：池参数在 Worker 启动时读取，改完要 `kiro-mem stop && kiro-mem start` 才生效。

关闭时池子会在 Worker 等待在途任务写完最终状态**之前**先关闭，因此不会有 ACP 子进程活得比 Worker 更久。`kiro-mem stop`、`uninstall` 和 `uninstall --purge` 都走这条路径，而且每一条都只对 `.worker.pid` 里记录的那个 PID 发信号——kiro-mem 从不扫描或杀掉不是自己启动的进程。

### 独立语义召回与回滚

`retrieval.semanticDiscovery: true` 是当前代码默认值：只要 `search` 带上合法的 `semantic_query_en`，即使当前 workspace 的 FTS 一条都没命中，语义腿也会照常执行——于是一个和记录用词完全不同的问法仍然能找回它。该 profile **尚未通过最终 P6 误召回门**（C1 实测 **1.900**，门槛 `≤ 1`）。默认开启是一次**已登记的知情决定**——`benchmark/reports/release-decision-2026-08-14.md`——而不是"通过了门"：关掉它不是"少两条结果"，而是**关键词一条都没命中时整个搜索直接返回空**，而盲审把这项能力量成旧记录 hit@5 从 0% 提升到 80.77%。门的读数本身没有变，[限制](#限制)里列出的每一项代价也没有变。后续一轮在一份独立校准集上扫过 floor 0.197–0.325 × cap 1–2，结论是**没有任何安全工作点**——读数见[限制](#限制)里的"没有一个余弦门槛能分开真假两侧"，那里同时写明了读数各自来自哪份数据集、以及为什么两份都不能用来选阈值。请把 `0.197` 当作已校准的默认值，而不是一个"调高就更安全"的旋钮。当前两个数字来自此前的完整链路参数扫描：cosine floor `0.197`，以及**每次搜索最多 2 条纯语义结果**。这个上限约束的是**一个来源标签**，不是整个页面——`fts` 与 `hybrid` 结果从来不受它限制，而默认时间窗放宽之后关键词腿的触及范围也跟着变大了。把它当作"未核实纯语义线索的配额"，不要当作整页安全保证。只靠语义找到的结果标记为 `match_source: "semantic"`，据此行动前应当核实。

设为 `false` 就是回滚。对**带合法 `semantic_query_en`** 的 query，它恢复此前的行为——必须有关键词锚点、floor `0.2`、纯语义结果无上限、平局按时间新旧——对编辑之后启动的 Kiro 会话生效。

有一件事回滚**故意不恢复**：`semantic_query_en` 缺失或被护栏拒绝的搜索，在两种设置下都是纯关键词的。旧版本在这种情况下会去给 `raw-v1` 空间打分，而那个空间没有可辩护的阈值，于是**一条关键词命中**就足以把一条无关记录标成 `semantic` 送上页面。那是一个被修掉的安全漏洞，不是回滚的缺口。


```bash
# 回滚
kiro-mem config --show   # 查看当前生效的 profile
# 编辑 ~/.kiro-mem/config.json："retrieval": { "semanticDiscovery": false }
```

这个开关只改检索。它不动数据库 schema、不动已存向量、不动 embedding 协议，所以可以来回切换，不需要重建，也不会丢数据。

### 检索指标

`curl http://127.0.0.1:37778/health` 与 `kiro-mem diagnose` 会报出最近 24 小时的搜索计数。里面只有计数、枚举原因和延迟——没有 query 正文、Observation 正文或 workspace 路径。

| 字段（`search_24h`） | 含义 |
| --- | --- |
| `requests` / `latencyMsP50` / `latencyMsP95` | 搜索量与延迟。 |
| `protocolSemanticEn` / `semanticEnRate` | 真正跑在英文向量空间里的搜索占比。独立语义召回只在那个空间成立，所以这个比例低就意味着功能发布了但基本不可达。 |
| `semanticQueryIssues` | 英文形式为什么不可用，按原因分：`missing`（Agent 压根没传 `semantic_query_en`），以及 `untranslated`、`placeholder` 等护栏拒绝原因。 |
| `ftsOnly` / `degradeRate` | 因为拿不到 query 向量（Worker 挂了、超时）而退回纯关键词的搜索。降级是能力失败，不是策略选择。 |
| `zeroFts` / `zeroFtsRecalled` | 关键词一条都没命中的搜索数，以及其中仍然靠语义召回返回了结果的数量。这就是这个功能要抬起来的那个数字。 |
| `semanticOnlyTotal` / `semanticOnlyPerRequest` / `semanticOnlyMax` | 未核实的纯语义线索的量。`semanticOnlyMax` 永远不应超过 cap。 |
| `comparableVectors`（均值） | 语义腿实际打过分的已存向量数。候选池是全 scope 的，所以它反映这次搜索真正比对了 workspace 的多少，而不再饱和在一个常数上。 |
| `scopeVectors`（均值 / 最小 / 测量到） | 整个搜索 scope 内该空间的向量数——不是候选池。"这个 workspace 到底建过这个协议的向量吗"只有这个数能回答。语义步骤没跑到时记 `null`，与 0 刻意区分。 |
| `emptyScopeRequests` | scope 内一条向量都没有的搜索数。非 0 说明这些请求的语义召回结构性不可能——是重建或任务积压问题，不是相关性问题。 |

`/health` 还会在 `retrieval` 下报出当前生效的 profile（每次调用都从磁盘读），所以"我的回滚生效了吗"不需要读代码就能回答。它报的是**下一个**会话会用的 profile——已经在跑的会话保持它启动时的那份。

## CLI 命令

```bash
kiro-mem install
kiro-mem status
kiro-mem start
kiro-mem stop
kiro-mem config
kiro-mem config --show
kiro-mem diagnose
kiro-mem repair
kiro-mem viewer
kiro-mem uninstall
kiro-mem uninstall --purge
```

## 系统要求

- **Bun**：最新版本
- **Kiro CLI**：**>= 2.3.0** —— 更早版本既没有 `acp` 子命令，也不支持隔离压缩子 agent 所依赖的 `KIRO_HOME` 覆盖。可通过 `kiro-cli --version` 与 `kiro-cli acp --help` 验证。
- **macOS / Linux**：Worker 保活需要 `launchd` / `systemd`

## 限制

| 限制 | 影响 | 缓解 |
|------|------|------|
| 采集是 best-effort | Hook 只给 Worker 约 700ms，且从不阻塞你的对话。Worker 重启或临时错误会丢掉原始事件，**丢掉的输入事后无法重建——记忆不保证完整** | 按 Hook 与原因计数；见 `/health` 的 `capture_misses_24h` 与 `kiro-mem diagnose` 的告警行 |
| 删除是一条一条的，而且必须手动 | 没有任何东西会自己过期：没有保留期策略、没有自动清理、没有批量 `prune`，因为 kiro-mem 不替你判断哪些记忆没价值。Web 查看器每次确认删除**一条** Observation 连同它的来源 turn，没有导出、没有批量删除、没有软删除、没有撤销。关联 job 处于 `leased` 时，这一条删除会持续返回 409 直到它结束 | 想清掉的就在查看器里删；`<private>` 标签从源头阻止敏感内容入库；`kiro-mem uninstall --purge` 仍然可以一次清空全部 |
| 删除不是法证级擦除 | 普通 SQLite `DELETE` 会把旧字节留在 WAL、freelist、文件系统快照和你已经做过的备份里。kiro-mem 刻意不做自动 `VACUUM`、也从不重写数据库，所以“永久删除”指的是 kiro-mem 所有读取路径都触达不到——不是把磁盘上的痕迹擦干净 | 请按产品层面的承诺理解：不可查询、不可检索、不可重建。需要介质级保证请用全盘加密并自己管好备份 |
| 原始事件 payload 有上限 | 单个字符串字段超过 32KB 会被截断，单个 turn 最多存 4MB 原始 payload。截断会就地标记，但丢掉的字节不可恢复 | `payload_size` 仍记录原始大小；artifacts 提取在截断后的 payload 上继续工作 |
| 依赖 Kiro CLI ACP | `kiro-cli acp` 不可用时无法压缩 | `kiro-mem diagnose` 会跑 ACP smoke 测试 |
| 会常驻一个 warm ACP runtime | 高峰之间池子保留 `minWarmRuntimes` 个进程，让下一个 turn 不必付 ACP 冷启动——默认 1 个约 38MB。空闲回收永远不会低于这个下限；另外，用隔离 `KIRO_MEMORY_DATA_DIR` 起的第二个 Worker 会各自保留自己的下限而不是共用一个，普通多窗口使用不会产生第二个 Worker | 设 `compression.minWarmRuntimes: 0` 让池子清空，或缩短 `compression.idleTtlMs`。两者都是用下一次压缩的冷启动延迟换内存 |
| 池参数在 Worker 启动时读取 | 改 `config.json` 里的 `concurrency`、`minWarmRuntimes` 或 `idleTtlMs` 不会影响已在运行的 Worker，所以在重启前进程行为和配置文件可能不一致 | `/health.acp.config` 报告该进程中实际生效的值；`kiro-mem stop && kiro-mem start`（或 `kiro-mem config`，它会替你重启）才生效 |
| `agentSpawn` 输出限制 10KB | 注入索引必须紧凑 | 预算控制的 context builder |
| 中途 `/agent` 切换不注入任何东西 | `agentSpawn` 是会话启动触发点，用 `/agent` 切进 kiro-mem 的那次会话拿不到记忆索引。捕获和 MCP 工具仍然正常——缺的只是被注入的那份菜单 | 用 kiro-mem 启动会话（`--agent kiro-mem` 或 `chat.defaultAgent`），显式要求 `@kiro-mem/search`，或把 `/context/bootstrap` 的输出粘进去——见[设为默认 Agent](#设为默认-agent) |
| 搜索词短于 3 字符 | 回退到 `LIKE`，精度较低 | 尽量使用较长搜索词 |
| 默认搜索不限时间，也没有保留期策略 | `search` 默认搜索**全部历史**，因此可搜范围等于注入索引能展示的范围——两年前的记录也找得到，不会再出现"索引里看得见、搜索却搜不到"。代价是语义腿的工作集随语料增长，而且什么都不会过期。实测上界：50,000 条记录铺开在 3 年里，三次复现 p95 203–260ms、检索循环内存 +264…+294MB；超过这个规模的行为**未测** | 用 `days=N` 收窄单次搜索。`retrieval.semanticDiscovery: false` 会恢复旧 profile，同时也恢复它的 200 条候选池 |
| 纯语义结果未经核实 | 词面零重叠的 query 现在能只靠语义找回记录，但这些结果的全部依据就是向量相似度；一个本项目从未做过的问题，仍然可能返回最多 2 条看起来很像的记录。独立盲审在 30 条 hard negative 上实测平均返回 **1.9 条**——几乎每一条都把配额用满了 | 它们标记为 `match_source: "semantic"`，每次搜索最多 2 条；据此行动前用 `get_observations` 或当前代码核实。该上限只覆盖 `semantic` 一档，`fts` 与 `hybrid` 不受它约束 |
| 没有一个余弦门槛能分开真假两侧 | 两个读数，来自**两份都已被消耗**的数据集——它们都不是新的独立验证集。**P3 集**（40 条记录 / 131 条 query；独立于此前的盲审集，但已被 P3 自己的 floor × cap 选参消耗）：得分最高的假线索到 **0.604**，而得分最高的真答案只有 **0.602**——假的反超了真的。因此不存在一个单一绝对余弦 floor，能同时让 17 条零 FTS 的 foreign-domain 负例全部归零、又保留每一条 `primary_gold` 的语义召回资格；floor 高过 0.604 时那 61 条全部失去该资格。**P4.0 探针**（另一份、同样已消耗的集：26 条 relevance + 30 条 hard-negative）：相对归一化比直接用原始分数**更差**——z-score AUC **0.735** 对原始 top1 AUC **0.841**——因为一个项目从未做过的问题语料背景更低，归一化反而奖励它 | **数字必须连边界一起读。** 两份集都已消耗：它们只能作描述性证据，**不得在其上选任何阈值**。P3 那个读数只在零 FTS 的 query 上量过，**不适用于**词面锚点 query——后者的页面是 FTS 腿填满的；它的负例侧是"页面最高分"，正例侧是"query 到自己 gold 的余弦"，两者可比的只有"这条 query 在这个空间里能拿到的最高相似度"这一点。失去语义召回资格**不等于**答案丢失——FTS 腿仍可能返回它，整页召回在 floor 0.197–0.300 上恒为 primary hit@5 **67.2%**。两个读数都**不覆盖**上面那个 1.9，那一条来自盲审。标注者与撰写者是同一人 |
| 词面准入试过了，堵不住这个缺口 | FTS 腿只要命中**一个三字滑窗**就准入一条记录，而专门去修这件事的一轮**没通过**：在 60,066 行的中文竞争装置上扫了 16 个 arm（滑窗覆盖度比例 × 单元 df 上限），40 条词面 hard negative 的整页 `distinctContent` 超限条数从 38/40 压到 9/40，**始终压不到上限 2**。剩下这 9 条的锚点在语料里都真实存在，它们的滑窗覆盖度是天然达标的。继续收紧只是在花正例：primary hit@5 0.813 → 0.713，80 条正例里 `primary_gold` 不在页面的从 11 条升到 19 条 | 完整读数见 `benchmark/reports/fts-round/f4-completion.md`，机械裁定是 `no-safe-arm`（`f4-selection.json`）。**生产行为未改变**——准入变量从未上线，只存在于 benchmark 的注入接缝里。已登记的下一个方向是内容级证据，不是词面计数 |
| 语义检索依赖英文形式 | 语义腿**只**在 `semantic-en-v1` 空间里运行。Agent 没传 `semantic_query_en` 或护栏拒绝时，这次搜索是**纯关键词**的：不计算 query 向量、不读取任何已存向量，所以该请求既失去语义召回、也失去语义重排。`raw-v1` 空间永不参与打分——它没有可用的相关性阈值，标注命中与纯噪声在其中区间重叠 | `/health` 与 `kiro-mem diagnose` 的 `semanticEnRate`、`semanticQueryIssues`（含 `missing`）会报出这件事发生的频率 |
| 只有前 1,000 条语义候选保留名次 | 候选池是**全 scope** 的：所搜 scope 里的每一个向量都会被打分，默认也不再有时间窗收窄它，所以不再有记录因为年代久远而对语义腿不可见。被限制的是保留量——候选按块读取、立即打分，只有最好的 1,000 条保留名次（外加全部词面命中，不论分数）。返回页在所有已测语料上与全量打分**完全一致**，包括 50,000 条那一档：4,618 条过 floor 的候选里只活下来 163 条，返回页仍然逐位相同——名次到了几千位就进不了 10 条的页面。真正改变的是可观测性：排在 1,000 名之外的记录没有语义名次记录 | 50,000 条实测：完整 search p95 158–286ms（预算 300ms），检索循环内存 +225…+324MB（预算 512MB） |
| 安装阶段 | 把内置 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models` | 模型随包分发，无需下载模型 |
| 查看器搜索是纯关键词的 | 查看器不会伪造 `semantic_query_en`，所以它的搜索只跑 FTS 腿：措辞与记录完全不同的问题在这里搜不到，即使 agent 自己的 `search` 能搜到 | 需要语义召回时在 Kiro 会话里用 `@kiro-mem/search`；查看器给每条结果都标了 `match_source`，差异是可见的 |
| 查看器仅限 loopback、单用户 | 它由本机 Worker 在 127.0.0.1 上提供，用同一个本机 token 鉴权，token 通过 URL fragment 交接。没有多用户模型、没有远程访问，会话不超出你打开的那个浏览器标签页 | 在存有数据的那台机器上运行 `kiro-mem viewer`；关闭标签页即结束会话 |
| 仅本地 | 无内置跨机器同步 | 未来：git sync 或云存储 |

## 许可证

MIT
