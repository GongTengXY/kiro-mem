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

[快速开始](#快速开始) • [工作原理](#工作原理) • [MCP 工具](#mcp-工具) • [配置](#配置) • [CLI 命令](#cli-命令) • [限制](#限制) • [许可证](#许可证)

---

kiro-mem 自动捕获 Kiro 会话中的每一轮对话（prompt → 工具调用 → stop），并将其压缩为一条不可变的 **Observation**——每个 closed turn 对应一条。它从不改写历史，也不在写入时猜测主题。会话开始时，它注入当前 workspace 历史工作的紧凑索引；Agent 先扫描这份"菜单"，再按需搜索、拉取完整详情。相关性组织发生在**读取时**，由 Agent 驱动，而非脆弱的写入期聚类。

**核心特性**

- 🧠 **持久记忆** — 跨会话保留项目上下文
- 🧩 **原子且不可变** — 一个 closed turn → 一条 Observation，文本永不改写或融合
- 🤖 **ACP 原生** — 压缩通过 Kiro CLI ACP 完成，无需配置 LLM API Key
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义召回，用 RRF 融合并按 workspace 硬隔离；词面零重叠的问法也能找回记录
- 📊 **读取期组织** — 先注入紧凑索引，Agent 按需拉取相关性（`search` → `timeline` → `get_observations`）
- 🔧 **MCP 工具** — `search`、`timeline`、`get_observations`、`pin`
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 持久任务队列，不阻塞工具调用
- 🔄 **进程保活** — Worker 由 `launchd` 或 `systemd` 管理
- 🌐 **国际化** — CLI 与运行时压缩提示词支持中英文

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

## 配置

编辑 `~/.kiro-mem/config.json`，或运行 `kiro-mem config` 交互式配置：

```json
{
  "language": "zh",
  "compression": {
    "concurrency": 3,
    "timeoutMs": 30000,
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

- `compression.concurrency`：并行运行的 `kiro-cli acp` 进程数（默认 `3`）。
- `compression.timeoutMs`：单次压缩超时（毫秒）。通过 `kiro-mem config` 修改时会限制在 `[5000, 60000]` 区间内（默认 `30000`）。
- `compression.maxRetries`：JSON 修复重试次数，超出后降级为 `quality=fallback` 的 Observation（默认 `2`）。
- `runtime.kiroHome`：压缩子 agent 使用的隔离 `KIRO_HOME`。空串时会回退到 `<dataDir>/kiro-runtime`，这是 `kiro-mem install` 默认布局。
- `context.maxOutputBytes`：注入 Observation 索引的字节预算，保持在 `agentSpawn` 的 10KB 上限之下（默认 `8192`）。
- `retrieval.semanticDiscovery`：语义相似度是否可以浮出关键词从未命中的记录（默认 `true`）。见下。

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
| 无细粒度删除 | 采集到的 turn 会无限期保留。`kiro-mem uninstall --purge` 清除**全部**数据；3.x **没有**按 Observation、按 scope、按时间段的删除，也没有导出与保留期策略 | 用 `<private>` 标签从源头阻止敏感内容入库 |
| 原始事件 payload 有上限 | 单个字符串字段超过 32KB 会被截断，单个 turn 最多存 4MB 原始 payload。截断会就地标记，但丢掉的字节不可恢复 | `payload_size` 仍记录原始大小；artifacts 提取在截断后的 payload 上继续工作 |
| 依赖 Kiro CLI ACP | `kiro-cli acp` 不可用时无法压缩 | `kiro-mem diagnose` 会跑 ACP smoke 测试 |
| `agentSpawn` 输出限制 10KB | 注入索引必须紧凑 | 预算控制的 context builder |
| 搜索词短于 3 字符 | 回退到 `LIKE`，精度较低 | 尽量使用较长搜索词 |
| 默认搜索不限时间，也没有保留期策略 | `search` 默认搜索**全部历史**，因此可搜范围等于注入索引能展示的范围——两年前的记录也找得到，不会再出现"索引里看得见、搜索却搜不到"。代价是语义腿的工作集随语料增长，而且什么都不会过期。实测上界：50,000 条记录铺开在 3 年里，三次复现 p95 203–260ms、检索循环内存 +264…+294MB；超过这个规模的行为**未测** | 用 `days=N` 收窄单次搜索。`retrieval.semanticDiscovery: false` 会恢复旧 profile，同时也恢复它的 200 条候选池 |
| 纯语义结果未经核实 | 词面零重叠的 query 现在能只靠语义找回记录，但这些结果的全部依据就是向量相似度；一个本项目从未做过的问题，仍然可能返回最多 2 条看起来很像的记录。独立盲审在 30 条 hard negative 上实测平均返回 **1.9 条**——几乎每一条都把配额用满了 | 它们标记为 `match_source: "semantic"`，每次搜索最多 2 条；据此行动前用 `get_observations` 或当前代码核实。该上限只覆盖 `semantic` 一档，`fts` 与 `hybrid` 不受它约束 |
| 没有一个余弦门槛能分开真假两侧 | 两个读数，来自**两份都已被消耗**的数据集——它们都不是新的独立验证集。**P3 集**（40 条记录 / 131 条 query；独立于此前的盲审集，但已被 P3 自己的 floor × cap 选参消耗）：得分最高的假线索到 **0.604**，而得分最高的真答案只有 **0.602**——假的反超了真的。因此不存在一个单一绝对余弦 floor，能同时让 17 条零 FTS 的 foreign-domain 负例全部归零、又保留每一条 `primary_gold` 的语义召回资格；floor 高过 0.604 时那 61 条全部失去该资格。**P4.0 探针**（另一份、同样已消耗的集：26 条 relevance + 30 条 hard-negative）：相对归一化比直接用原始分数**更差**——z-score AUC **0.735** 对原始 top1 AUC **0.841**——因为一个项目从未做过的问题语料背景更低，归一化反而奖励它 | **数字必须连边界一起读。** 两份集都已消耗：它们只能作描述性证据，**不得在其上选任何阈值**。P3 那个读数只在零 FTS 的 query 上量过，**不适用于**词面锚点 query——后者的页面是 FTS 腿填满的；它的负例侧是"页面最高分"，正例侧是"query 到自己 gold 的余弦"，两者可比的只有"这条 query 在这个空间里能拿到的最高相似度"这一点。失去语义召回资格**不等于**答案丢失——FTS 腿仍可能返回它，整页召回在 floor 0.197–0.300 上恒为 primary hit@5 **67.2%**。两个读数都**不覆盖**上面那个 1.9，那一条来自盲审。标注者与撰写者是同一人 |
| 词面准入试过了，堵不住这个缺口 | FTS 腿只要命中**一个三字滑窗**就准入一条记录，而专门去修这件事的一轮**没通过**：在 60,066 行的中文竞争装置上扫了 16 个 arm（滑窗覆盖度比例 × 单元 df 上限），40 条词面 hard negative 的整页 `distinctContent` 超限条数从 38/40 压到 9/40，**始终压不到上限 2**。剩下这 9 条的锚点在语料里都真实存在，它们的滑窗覆盖度是天然达标的。继续收紧只是在花正例：primary hit@5 0.813 → 0.713，80 条正例里 `primary_gold` 不在页面的从 11 条升到 19 条 | 完整读数见 `benchmark/reports/fts-round/f4-completion.md`，机械裁定是 `no-safe-arm`（`f4-selection.json`）。**生产行为未改变**——准入变量从未上线，只存在于 benchmark 的注入接缝里。已登记的下一个方向是内容级证据，不是词面计数 |
| 语义检索依赖英文形式 | 语义腿**只**在 `semantic-en-v1` 空间里运行。Agent 没传 `semantic_query_en` 或护栏拒绝时，这次搜索是**纯关键词**的：不计算 query 向量、不读取任何已存向量，所以该请求既失去语义召回、也失去语义重排。`raw-v1` 空间永不参与打分——它没有可用的相关性阈值，标注命中与纯噪声在其中区间重叠 | `/health` 与 `kiro-mem diagnose` 的 `semanticEnRate`、`semanticQueryIssues`（含 `missing`）会报出这件事发生的频率 |
| 只有前 1,000 条语义候选保留名次 | 候选池是**全 scope** 的：所搜 scope 里的每一个向量都会被打分，默认也不再有时间窗收窄它，所以不再有记录因为年代久远而对语义腿不可见。被限制的是保留量——候选按块读取、立即打分，只有最好的 1,000 条保留名次（外加全部词面命中，不论分数）。返回页在所有已测语料上与全量打分**完全一致**，包括 50,000 条那一档：4,618 条过 floor 的候选里只活下来 163 条，返回页仍然逐位相同——名次到了几千位就进不了 10 条的页面。真正改变的是可观测性：排在 1,000 名之外的记录没有语义名次记录 | 50,000 条实测：完整 search p95 158–286ms（预算 300ms），检索循环内存 +225…+324MB（预算 512MB） |
| 安装阶段 | 把内置 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models` | 模型随包分发，无需下载模型 |
| 暂无 Web 查看器 | 通过 CLI/MCP/DB 查看记忆 | 单独规划中 |
| 仅本地 | 无内置跨机器同步 | 未来：git sync 或云存储 |

## 许可证

MIT
