<p align="center">
  <img src="docs/assets/logo.png" alt="kiro-mem logo" width="320" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/v/kiro-mem.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/kiro-mem"><img src="https://img.shields.io/npm/dm/kiro-mem.svg" alt="npm downloads" /></a>
  <a href="https://github.com/GongTengXY/kiro-mem/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/kiro-mem.svg" alt="license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?logo=typescript" alt="TypeScript" />
</p>

<p align="center">
  <a href="docs/i18n/README.zh.md">🇨🇳 简体中文</a> | <a href="README.md">🇬🇧 English</a>
</p>

#### Persistent memory system for [Kiro CLI](https://kiro.dev).

> Kiro CLI only. Not compatible with Kiro IDE.

[Quick Start](#quick-start) • [How It Works](#how-it-works) • [MCP Tools](#mcp-tools) • [Configuration](#configuration) • [CLI](#cli) • [Limitations](#limitations) • [License](#license)

---

kiro-mem automatically captures each turn (prompt → tool calls → stop) during Kiro sessions, compresses them into structured **memories**, organizes them by **topics**, and injects a compact memory index into later sessions. The agent scans the index first, then fetches details only when needed.

**Key Features**

- 🧠 **Persistent Memory** — Keep project context across sessions
- 🔍 **Hybrid Search** — FTS5 full-text search + local semantic reranking
- 📊 **Progressive Disclosure** — Inject a small index first, fetch details on demand
- 🔧 **MCP Tools** — `search`, `get_memories`, `trace_memory`, `topics`, `pin`
- 🔒 **Privacy Control** — Use `<private>` tags to redact sensitive content before storage
- 🚀 **Async Processing** — Persistent job queue, no tool-call blocking
- 🔄 **Process Keepalive** — Worker managed by `launchd` or `systemd`
- 🌐 **i18n** — `zh` and `en` for CLI and compression prompts

## Quick Start

Requires [Bun](https://bun.sh) and [Kiro CLI](https://kiro.dev).

```bash
npm i -g kiro-mem
kiro-mem install
```

The installer will ask for language, model provider, model name, and API key, then register and start the Worker automatically.

### Set As Default Agent

```bash
kiro-cli settings chat.defaultAgent kiro-mem
```

Or switch inside a chat session:

```text
/agent kiro-mem
```

### Verify Installation

```bash
kiro-mem diagnose
kiro-mem status
curl http://127.0.0.1:37778/health
```

## How It Works

**Architecture (V2 Turn+)**

1. **Truth Layer** — `session_id` → `turns` → `turn_events` (append-only raw payloads)
2. **Synthesis Layer** — Persistent jobs: `summarize_turn` → `normalize_topic` → `merge_cluster_to_memory`
3. **Retrieval Layer** — `memories_fts` + semantic reranking → MCP tools → context injection

At session start, kiro-mem injects a compact memory index organized by **Pinned Memories**, **Active Topics**, and **Recent Memories**. The agent can then use MCP tools to search, inspect, and trace memories on demand.

**Data Model**

- `session_refs` — Session isolation metadata
- `turns` — One per user prompt → stop cycle
- `turn_events` — Append-only raw hook payloads
- `memories` — User-facing memory units (turn or merged)
- `topics` — Normalized topic labels for aggregation
- `jobs` — Persistent async task queue

## MCP Tools

| Tool | Purpose |
|------|---------|
| `search` | Hybrid search memories with `type`, `days`, `repo` filters |
| `get_memories` | Fetch full memory details by ID |
| `trace_memory` | Show source turns and neighboring memories |
| `topics` | Browse active topics and unresolved items |
| `pin` | Mark or unmark important memories |

```text
@kiro-mem/search query="auth module bug" type="bugfix" limit=10
@kiro-mem/trace_memory memory_id=42 before=3 after=3
@kiro-mem/get_memories ids=[42,56]
```

**Memory Types:** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## Privacy

Use `<private>` tags to redact sensitive content before storage:

```text
<private>database password is xxx</private>
Help me configure the connection
```

Content inside `<private>` tags is replaced with `[REDACTED]` before it is written to memory.

## Configuration

Edit `~/.kiro-mem/config.json`, or run `kiro-mem config` for interactive setup:

```json
{
  "language": "zh",
  "compression": {
    "provider": "openai",
    "model": "gpt-5.4",
    "apiKey": "sk-proj-xxx",
    "concurrency": 6
  },
  "context": {
    "maxMemories": 50,
    "maxOutputBytes": 8192,
    "includePinned": true,
    "includeSummary": false
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  }
}
```

## CLI

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

## System Requirements

- **Bun**: Latest version
- **Kiro CLI**: Must support hooks and agent system
- **macOS / Linux**: Required for Worker keepalive via `launchd` / `systemd`

## Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| `agentSpawn` output limit 10KB | Injected index must stay compact | Budget-controlled context builder |
| Search queries shorter than 3 chars | Falls back to `LIKE`, less precise | Use longer terms when possible |
| First semantic-search use | Downloads local embedding model once | Cached locally after first use |
| No Web Viewer UI yet | Memory inspected through CLI/MCP/DB | Planned separately |
| Local only | No built-in cross-machine sync | Future: git sync or cloud storage |
| Topic normalization | LLM-dependent, may drift | Periodic re-normalization planned |

## License

MIT
