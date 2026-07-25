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

kiro-mem automatically captures each turn (prompt → tool calls → stop) during Kiro sessions and compresses it into a single immutable **Observation** — one per closed turn. It never rewrites history or guesses topics up front. At session start it injects a compact index of prior work in the current workspace; the agent scans that menu, then searches and pulls full details on demand. Organizing relevance happens at **read time**, driven by the agent, not by fragile write-time clustering.

**Key Features**

- 🧠 **Persistent Memory** — Keep project context across sessions
- 🧩 **Atomic & Immutable** — One closed turn → one Observation; text is never rewritten or merged
- 🤖 **ACP-native** — Compression runs through Kiro CLI ACP — no LLM API key required
- 🔍 **Hybrid Search** — FTS5 full-text search + local semantic reranking, hard-scoped per workspace
- 📊 **Read-time Organization** — Inject a compact index; the agent pulls relevance on demand (`search` → `timeline` → `get_observations`)
- 🔧 **MCP Tools** — `search`, `timeline`, `get_observations`, `pin`
- 🔒 **Privacy Control** — Use `<private>` tags to redact sensitive content before storage
- 🚀 **Async Processing** — Persistent job queue, no tool-call blocking
- 🔄 **Process Keepalive** — Worker managed by `launchd` or `systemd`
- 🌐 **i18n** — `zh` and `en` for CLI and runtime compressor prompts

## Quick Start

Requires [Bun](https://bun.sh) and a [Kiro CLI](https://kiro.dev) build that supports the `acp` subcommand.

> **V3 is a clean break from V2.** Existing users must remove all V2 data and runtime files before installing V3. There is no database migration or compatibility mode.
>
> ```bash
> kiro-mem uninstall --purge
> npm i -g kiro-mem@3
> kiro-mem install
> ```

For a first-time installation:

```bash
npm i -g kiro-mem@3
kiro-mem install
```

The installer checks Kiro CLI ACP availability, creates a high-entropy local Worker token with owner-only permissions, copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models/`, lays out the isolated `kiro-runtime` (compressor sub-agent + prompt), and registers the Worker. **No API key required** — memory compression runs through `kiro-cli acp` against your existing Kiro session.

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

**Architecture**

1. **Core Truth Layer** — `session_id` → `turns` → `turn_events` (append-only raw hook payloads) + `turn_artifacts` (deterministic extraction: tools, files, commands, test/build/lint signals, errors). This layer is never rewritten and can rebuild any projection.
2. **Synthesis Layer** — Persistent jobs (`summarize_turn` → `embed_observation`) drive an **ACP runtime pool**: each prompt goes to a `kiro-cli acp` sub-process running an isolated `kiro-mem-compressor` sub-agent declared with `tools: []`. Any tool-call notification on that session is treated as contamination and the runtime slot is recycled. `summarize_turn` consumes the user prompt, the assistant's final response (`assistant_response`), and the deterministic artifacts, then writes exactly one immutable Observation per closed turn (idempotent on `turn_id`). It never clusters, merges, or supersedes. On compression failure it degrades to a `quality=fallback` Observation carrying only deterministic evidence — never a fabricated result.
3. **Retrieval Layer** — `observations_fts` (FTS5) + local semantic reranking, fused with RRF and hard-scoped by workspace → MCP tools → context injection.

At session start, kiro-mem injects a compact **Observation index** for the current workspace: pinned observations, a few recent entries with a short outcome snippet, and a longer recent index where each line carries an approximate read cost. It is a menu, not the content — no LLM synthesis, no topics. The agent then pulls relevance on demand via `search` → `timeline` → `get_observations`.

**Data Model**

- `session_refs` — Session isolation metadata
- `turns` + `turn_events` — Per-turn lifecycle row + append-only raw hook payloads (truth layer)
- `turn_artifacts` — Deterministic extraction (tools, files, commands, test/build/lint signals, errors)
- `observations` — Immutable per-turn memory unit: one closed turn → one Observation, text never rewritten
- `observations_fts` (FTS5 trigram) + `observation_embeddings` — Hybrid search backing tables
- `jobs` — Persistent async task queue

## MCP Tools

| Tool               | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `search`           | Hybrid search observations with `type`, `days`, `repo`/`cwd` filters           |
| `timeline`         | Show temporally adjacent observations around one, in real source-turn order    |
| `get_observations` | Fetch full observation details by ID, with source-turn metadata                |
| `pin`              | Mark or unmark an observation for later context                                |

```text
@kiro-mem/search query="auth module bug" type="bugfix" limit=10
@kiro-mem/timeline observation_id=42 before=3 after=3 mode="scope"
@kiro-mem/get_observations ids=[42,56]
```

`search` is hard-scoped to the current workspace via `computeScopeKey(repo, cwd)` — pass `repo`/`cwd` to target a specific scope, or `all_scopes: true` to browse everything. `timeline` anchors on an observation's **source turn** (not its ID), so neighbors reflect the real work timeline; use `mode="session"` to stay within one conversation instead of the whole workspace.

**Observation Types (`memory_type`):** `decision` | `bugfix` | `feature` | `refactor` | `discovery` | `change`

## Privacy

Use `<private>` tags to redact sensitive content before storage:

```text
<private>database password is xxx</private>
Help me configure the connection
```

Content inside `<private>` tags is replaced with `[REDACTED]` before it is written to storage — this covers the user prompt, tool payloads, and the assistant's final response, so private text never reaches an Observation or the injected index.

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

- `compression.concurrency`: number of parallel `kiro-cli acp` runtime processes (default `3`).
- `compression.timeoutMs`: per-prompt timeout in milliseconds, clamped to `[5000, 60000]` when set via `kiro-mem config` (default `30000`).
- `compression.maxRetries`: how many JSON-repair retries to attempt before degrading to a `quality=fallback` Observation (default `2`).
- `runtime.kiroHome`: isolated `KIRO_HOME` for the compressor sub-agent. Empty falls back to `<dataDir>/kiro-runtime`, which is the layout `kiro-mem install` lays down.
- `context.maxOutputBytes`: byte budget for the injected Observation index, kept below the `agentSpawn` 10KB limit (default `8192`).

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
- **Kiro CLI**: **>= 2.3.0** — earlier versions lack the `acp` subcommand and the `KIRO_HOME` override that the isolated compressor sub-agent depends on. Run `kiro-cli --version` and `kiro-cli acp --help` to verify.
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

## License

MIT
