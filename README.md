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
- 🔍 **Hybrid Search** — FTS5 full-text search + local semantic recall, fused with RRF and hard-scoped per workspace; a query with no shared wording can still find the record
- 📊 **Read-time Organization** — Inject a compact index; the agent pulls relevance on demand (`search` → `timeline` → `get_observations`)
- 🔧 **MCP Tools** — `search`, `timeline`, `get_observations`, `pin`
- 🔒 **Privacy Control** — Use `<private>` tags to redact sensitive content before storage
- 🚀 **Async Processing** — Persistent job queue, no tool-call blocking
- 🔄 **Process Keepalive** — Worker managed by `launchd` or `systemd`
- 🌐 **i18n** — `zh` and `en` for CLI and runtime compressor prompts

## Quick Start

Requires [Bun](https://bun.sh) and a [Kiro CLI](https://kiro.dev) build that supports the `acp` subcommand.

> **V3 is a clean break from V2, and the only supported upgrade path is a full wipe and reinstall.** There is no database migration and no compatibility mode; running a V3 install over V2 data is not supported and is not tested.
>
> ```bash
> kiro-mem stop
> kiro-mem uninstall --purge   # ⚠️ see the warning below
> npm i -g kiro-mem@3
> kiro-mem install
> ```
>
> ### ⚠️ `--purge` permanently deletes all memory and configuration
>
> It removes `~/.kiro-mem` in full: every captured turn, every Observation, every vector, the job queue, your `config.json`, and the local Worker token. **This cannot be undone and there is no export.** If any of that history matters to you, copy `~/.kiro-mem` somewhere else before running it — note that a V2 copy cannot be read back by V3.
>
> `kiro-mem stop` first is not optional: it prevents the old Worker from writing into a directory that is being removed underneath it.

For a first-time installation:

```bash
npm i -g kiro-mem@3
kiro-mem install
```

The installer checks Kiro CLI ACP availability, creates a high-entropy local Worker token with owner-only permissions, copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models/`, lays out the isolated `kiro-runtime` (compressor sub-agent + prompt), then registers and starts the Worker under `launchd`/`systemd`. **No API key required** — memory compression runs through `kiro-cli acp` against your existing Kiro session.

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
3. **Retrieval Layer** — `observations_fts` (FTS5) and local semantic recall run as two independent legs, fused with RRF and hard-scoped by workspace → MCP tools → context injection. The semantic leg does not need a keyword hit to run: it can recall a record nothing in the query literally matches, bounded by a cosine floor and a semantic-only cap.

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
  "retrieval": {
    "semanticDiscovery": true
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
- `retrieval.semanticDiscovery`: whether semantic similarity may surface records that keyword search never matched (default `true`). See below.

### Semantic Discovery and Rollback

`retrieval.semanticDiscovery: true` is the current code default: a `search` that carries a legal `semantic_query_en` runs the semantic leg even when FTS matched nothing in this workspace, so a question phrased entirely differently from the record can still find it. This profile has not passed the final P6 false-recall gate and remains blocked from a stable public release. Its current bounds, selected by an earlier full-pipeline parameter scan, are a cosine floor of `0.197` and **at most 2 semantic-only results per search**. Results that only the semantic leg found are labelled `match_source: "semantic"` and should be verified before you act on them.

The cap bounds one source label, not the whole page: `fts` and `hybrid` results were never subject to it, and once the default time window became unbounded the keyword leg's reach grew with it. Treat the cap as a quota on unverified pure-semantic leads, not as complete page safety.

Setting it to `false` is the rollback. For queries that carry a legal `semantic_query_en` it restores the previous behavior — keyword anchor required, floor `0.2`, no semantic-only cap, recency tie-break — and takes effect for Kiro sessions started after the edit.

One thing the rollback deliberately does **not** restore: a search with a missing or refused `semantic_query_en` stays keyword-only under either setting. The old build scored the `raw-v1` space in that case, and that space has no defensible threshold, so a single keyword hit was enough to put an unrelated record on the page labelled `semantic`. That is a fixed safety hole, not a rollback gap.

```bash
# roll back
kiro-mem config --show   # shows the active profile
# edit ~/.kiro-mem/config.json: "retrieval": { "semanticDiscovery": false }
```

The switch changes retrieval only. It does not touch the database schema, the stored vectors or the embedding protocol, so it can be flipped back and forth with no rebuild and no data loss.

### Retrieval Metrics

`curl http://127.0.0.1:37778/health` and `kiro-mem diagnose` report a trailing 24h window of search counters. They hold counts, enum reasons and latency only — never query text, Observation text or workspace paths.

| Field (`search_24h`) | Meaning |
| --- | --- |
| `requests` / `latencyMsP50` / `latencyMsP95` | Search volume and latency. |
| `protocolSemanticEn` / `semanticEnRate` | How many searches actually ran in the English vector space. Independent semantic recall only works there, so a low rate means the feature is shipped but mostly unreachable. |
| `semanticQueryIssues` | Why the English form was unusable, by reason: `missing` (the agent never passed `semantic_query_en`) plus guardrail rejections such as `untranslated` or `placeholder`. |
| `ftsOnly` / `degradeRate` | Searches that fell back to keyword-only because the query embedding was unavailable (Worker down, timeout). A degraded request is a capability failure, not a policy choice. |
| `zeroFts` / `zeroFtsRecalled` | Searches with no keyword match at all, and how many of those still returned something via semantic recall. This is the number the feature exists to move. |
| `semanticOnlyTotal` / `semanticOnlyPerRequest` / `semanticOnlyMax` | Volume of unverified semantic-only leads. `semanticOnlyMax` must never exceed the cap. |
| `comparableVectors` (avg) | How many stored vectors the semantic leg scored. The candidate pool is scope-wide, so this tracks how much of the workspace a search actually compared against rather than saturating at a constant. |
| `scopeVectors` (avg / min / measured) | Vectors in the active space across the WHOLE searched scope — not the candidate pool. This is the number that answers "has this workspace been embedded under this protocol?". `null` (not counted) when the semantic step never ran, which is deliberately different from 0. |
| `emptyScopeRequests` | Searches whose scope had no vectors at all. Non-zero means semantic recall was structurally impossible for them — a rebuild or job-backlog problem, not a relevance one. |

`/health` also reports the active profile under `retrieval`, read from disk on every call, so "did my rollback take effect?" is answerable without reading code. It reports what the **next** session will serve — a session already running keeps the profile it started with.

## CLI

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

## System Requirements

- **Bun**: Latest version
- **Kiro CLI**: **>= 2.3.0** — earlier versions lack the `acp` subcommand and the `KIRO_HOME` override that the isolated compressor sub-agent depends on. Run `kiro-cli --version` and `kiro-cli acp --help` to verify.
- **macOS / Linux**: Required for Worker keepalive via `launchd` / `systemd`

## Limitations

| Limitation                          | Impact                                                                | Mitigation                                    |
| ----------------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| Capture is best-effort              | Hooks give the Worker ~700ms and never block your turn, so a Worker restart or transient error can drop a raw event. Dropped input cannot be reconstructed later — memory is not guaranteed to be complete | Misses are counted per hook and reason; see `capture_misses_24h` in `/health` and the warning line in `kiro-mem diagnose` |
| No fine-grained deletion            | Captured turns are kept indefinitely. `kiro-mem uninstall --purge` wipes **everything**; there is no per-observation, per-scope or per-time-range delete, no export, and no retention policy in 3.x | Use `<private>` tags to keep sensitive content out of storage in the first place |
| Raw event payloads are capped        | A tool response over 32KB per string field is truncated, and a single turn stores at most 4MB of raw payload. Truncation is marked inline, but the dropped bytes are not recoverable | `payload_size` still records the original size; artifacts extraction keeps working on the capped payload |
| Requires Kiro CLI ACP               | Compression cannot run without a working `kiro-cli acp` subcommand    | `kiro-mem diagnose` runs an ACP smoke test    |
| `agentSpawn` output limit 10KB      | Injected index must stay compact                                      | Budget-controlled context builder             |
| Search queries shorter than 3 chars | Falls back to `LIKE`, less precise                                    | Use longer terms when possible                |
| Search has no default time limit, and no retention policy | `search` defaults to the whole history, so the searchable range equals what the injected index can show — a record from two years ago is reachable. The cost is that the semantic leg's working set grows with the corpus and nothing ever expires. Measured ceiling: 50,000 records spread over 3 years, p95 203–260ms and search-loop memory +264…+294MB across three runs. Beyond that size the behavior is unmeasured | Pass `days=N` to narrow one search. `retrieval.semanticDiscovery: false` restores the previous profile, which also restores its 200-record pool |
| Semantic-only results are unverified | A query with no keyword overlap can now find records through meaning alone, but those results rest on vector similarity only, and a query about work this project never did can still return up to 2 plausible-looking records. An independent blind audit measured a mean of 1.9 returned records across 30 hard negatives — the cap is reached on nearly every one of them | They are labelled `match_source: "semantic"` and capped at 2 per search; verify with `get_observations` or the current code before acting. The cap covers only the `semantic` label — `fts` and `hybrid` results are not bounded by it |
| Semantic search needs the English form | The semantic leg runs ONLY in the `semantic-en-v1` space. If the agent omits `semantic_query_en` or the guardrail refuses it, the search is **keyword-only**: no query vector is computed and no stored vector is read, so that request loses semantic reranking as well as semantic recall. The `raw-v1` space is never scored, because it has no usable relevance threshold — annotated matches and pure noise overlap in it | `semanticEnRate` and `semanticQueryIssues` (including `missing`) in `/health` / `kiro-mem diagnose` show how often that happens |
| Only the top 1,000 semantic candidates keep a rank | The candidate pool is scope-wide — every vector in the searched scope gets scored, and by default no time window narrows that, so no record is invisible to the semantic leg because of its age. What is bounded is retention: candidates are read in chunks, scored immediately, and only the best 1,000 keep a rank (plus every keyword hit, at any score). Returned pages were identical to full scoring on every measured corpus, including at 50,000 records where only 163 of 4,618 above-floor candidates survived — a rank in the thousands cannot reach a page of 10. What does change is observability: a record outside the top 1,000 has no recorded semantic rank | Measured at 50,000 records: full-search p95 158–286ms against a 300ms budget, search-loop memory +225…+324MB against 512MB |
| Install step                        | Copies the bundled embedding model (~23 MB) into `~/.kiro-mem/models` | Model ships in the package — no model download |
| No Web Viewer UI yet                | Memory inspected through CLI/MCP/DB                                   | Planned separately                            |
| Local only                          | No built-in cross-machine sync                                        | Future: git sync or cloud storage             |

## License

MIT
