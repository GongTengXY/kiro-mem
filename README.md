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
- 🤖 **ACP-native** — Compression runs through Kiro CLI ACP — no LLM API key required
- 🔍 **Hybrid Search** — FTS5 full-text search + local semantic reranking
- 📊 **Progressive Disclosure** — Inject a small index first, fetch details on demand
- 🔧 **MCP Tools** — `search`, `get_memories`, `trace_memory`, `topics`, `pin`
- 🔒 **Privacy Control** — Use `<private>` tags to redact sensitive content before storage
- 🚀 **Async Processing** — Persistent job queue, no tool-call blocking
- 🔄 **Process Keepalive** — Worker managed by `launchd` or `systemd`
- 🌐 **i18n** — `zh` and `en` for CLI and runtime compressor prompts

## Quick Start

Requires [Bun](https://bun.sh) and a [Kiro CLI](https://kiro.dev) build that supports the `acp` subcommand.

```bash
npm i -g kiro-mem
kiro-mem install
```

The installer checks Kiro CLI ACP availability, copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models/`, lays out the isolated `kiro-runtime` (compressor sub-agent + prompt), and registers the Worker. **No API key required** — memory compression runs through `kiro-cli acp` against your existing Kiro session.

The Worker fails fast on startup if `kiro-runtime` is incomplete (missing agent file, missing prompt, or `tools` accidentally non-empty), so a broken layout never silently degrades compression purity. Re-run `kiro-mem install` to repair.

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
2. **Synthesis Layer** — Persistent jobs (`summarize_turn` → `normalize_topic` → `summarize_topic` / `merge_cluster_to_memory`) drive an **ACP runtime pool**: each prompt goes to a `kiro-cli acp` sub-process running an isolated `kiro-mem-compressor` sub-agent declared with `tools: []`. Any tool-call notification on that session is treated as contamination and the runtime slot is recycled. `normalize_topic` first tries a deterministic pre-match (case/whitespace/trailing-punctuation only) and falls back to the model only when no exact hit exists. `summarize_topic` fires when a topic crosses 3/5/10/20 memories or right after a merge, so Active Topics stays in sync with the current memory set.
3. **Retrieval Layer** — `memories_fts` + semantic reranking → MCP tools → context injection

At session start, kiro-mem injects a compact memory index organized by **Pinned Memories**, **Active Topics**, and **Recent Memories**. The agent can then use MCP tools to search, inspect, and trace memories on demand.

**Data Model**

- `session_refs` — Session isolation metadata
- `turns` + `turn_events` — Per-turn lifecycle row + append-only raw hook payloads (truth layer)
- `turn_artifacts` — Deterministic extraction (tools, files, commands, errors)
- `memories` + `memory_turn_links` — User-facing memory units (turn or merged) and their source-turn pointers
- `topics` — Normalized topic labels with `summary` / `unresolved_summary`
- `memories_fts` (FTS5 trigram) + `memory_embeddings` — Hybrid search backing tables
- `jobs` — Persistent async task queue

## MCP Tools

| Tool           | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `search`       | Hybrid search memories with `type`, `days`, `repo` filters |
| `get_memories` | Fetch full memory details by ID                            |
| `trace_memory` | Show source turns and neighboring memories                 |
| `topics`       | Browse active topics                                       |
| `pin`          | Mark or unmark important memories                          |

```text
@kiro-mem/search query="auth module bug" type="bugfix" limit=10
@kiro-mem/trace_memory memory_id=42 before=3 after=3
@kiro-mem/get_memories ids=[42,56]
@kiro-mem/topics cwd="/path/to/non-git-project"
```

`topics` accepts an optional `cwd` so non-git workspaces stay isolated even though they share a `NULL` repo. Pass `repo` to filter by git root, `cwd` to filter by workspace, or omit both to see everything.

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
    "concurrency": 3,
    "timeoutMs": 30000,
    "maxRetries": 2
  },
  "context": {
    "maxMemories": 50,
    "maxOutputBytes": 8192,
    "includePinned": true,
    "includeSummary": false
  },
  "filter": {
    "skipTools": ["introspect", "todo_list", "@kiro-mem/*"]
  },
  "runtime": {
    "kiroHome": ""
  }
}
```

- `compression.concurrency`: number of parallel `kiro-cli acp` runtime processes (default `3`).
- `compression.timeoutMs`: per-prompt timeout in milliseconds, clamped to `[5000, 60000]` when set via `kiro-mem config` (default `30000`).
- `compression.maxRetries`: how many JSON-repair retries to attempt before falling back to a stub memory (default `2`).
- `runtime.kiroHome`: isolated `KIRO_HOME` for the compressor sub-agent. Empty falls back to `<dataDir>/kiro-runtime`, which is the layout `kiro-mem install` lays down.
- `context.includeSummary`: when `true`, each Recent Memories entry carries a short summary line in the injected context. Each entry becomes ~3× the size, so kiro-mem automatically caps the list at 20 entries to stay within the agentSpawn byte budget.

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
- **Kiro CLI**: Must support hooks, agents, and the `acp` subcommand (run `kiro-cli acp --help` to verify)
- **macOS / Linux**: Required for Worker keepalive via `launchd` / `systemd`

## Limitations

| Limitation                          | Impact                                                                | Mitigation                                    |
| ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Requires Kiro CLI ACP               | Compression cannot run without a working `kiro-cli acp` subcommand    | `kiro-mem diagnose` runs an ACP smoke test    |
| `agentSpawn` output limit 10KB      | Injected index must stay compact                                      | Budget-controlled context builder             |
| Search queries shorter than 3 chars | Falls back to `LIKE`, less precise                                    | Use longer terms when possible                |
| Install step                        | Copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models` | Local-only — no network needed once installed |
| No Web Viewer UI yet                | Memory inspected through CLI/MCP/DB                                   | Planned separately                            |
| Local only                          | No built-in cross-machine sync                                        | Future: git sync or cloud storage             |
| Topic normalization                 | LLM-dependent, may drift                                              | Periodic re-normalization will be added later |

## License

MIT
