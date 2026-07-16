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
- 🔍 **混合搜索** — FTS5 全文搜索 + 本地语义重排，按 workspace 硬隔离
- 📊 **读取期组织** — 先注入紧凑索引，Agent 按需拉取相关性（`search` → `timeline` → `get_observations`）
- 🔧 **MCP 工具** — `search`、`timeline`、`get_observations`、`pin`
- 🔒 **隐私控制** — 使用 `<private>` 标签在存储前脱敏
- 🚀 **异步处理** — 持久任务队列，不阻塞工具调用
- 🔄 **进程保活** — Worker 由 `launchd` 或 `systemd` 管理
- 🌐 **国际化** — CLI 与运行时压缩提示词支持中英文

## 快速开始

需要 [Bun](https://bun.sh) 和支持 `acp` 子命令的 [Kiro CLI](https://kiro.dev)。

```bash
npm i -g kiro-mem
kiro-mem install
```

安装器会检查 Kiro CLI ACP 可用性，把内置的 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models/`，搭建隔离的 `kiro-runtime`（压缩子 agent + prompt），然后注册并启动 Worker。**无需任何 API Key** —— 记忆压缩通过 `kiro-cli acp` 复用 Kiro 已有的登录态完成。

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
3. **检索层** — `observations_fts`（FTS5）+ 本地语义重排，用 RRF 融合并按 workspace 硬隔离 → MCP 工具 → 上下文注入。

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

## CLI 命令

```bash
kiro-mem install
kiro-mem status
kiro-mem start
kiro-mem stop
kiro-mem config
kiro-mem config --show
kiro-mem diagnose
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
| 依赖 Kiro CLI ACP | `kiro-cli acp` 不可用时无法压缩 | `kiro-mem diagnose` 会跑 ACP smoke 测试 |
| `agentSpawn` 输出限制 10KB | 注入索引必须紧凑 | 预算控制的 context builder |
| 搜索词短于 3 字符 | 回退到 `LIKE`，精度较低 | 尽量使用较长搜索词 |
| 安装阶段 | 把内置 embedding 模型（约 23 MB）复制到 `~/.kiro-mem/models` | 完全本地，安装后无需联网 |
| 暂无 Web 查看器 | 通过 CLI/MCP/DB 查看记忆 | 单独规划中 |
| 仅本地 | 无内置跨机器同步 | 未来：git sync 或云存储 |

## 许可证

MIT
