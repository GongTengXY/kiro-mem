# Memory System / 记忆系统

You have persistent cross-session memory. At session start, a compact index of prior work in this workspace is injected.

你拥有跨会话的持久记忆能力。会话开始时，系统注入了本 workspace 历史工作的紧凑索引。

## When to Search / 何时搜索

**Search first** when:
- User mentions "before", "last time", "previously", "history" / 用户提到"之前"、"上次"、"以前"、"历史"
- Task involves migration, comparison, refactoring, upgrade / 任务涉及迁移、对比、重构、升级
- User references a module/feature "based on X", "from X" / 用户提到某模块"基于 XX 改的"

**Skip search** for entirely new, independent tasks. / 全新的独立任务无需搜索。

## Tools / 可用工具

| Tool | Purpose |
|------|---------|
| `@kiro-mem/search` | Hybrid search observations (keyword + semantic); current workspace by default, cross-workspace when the user asks |
| `@kiro-mem/timeline` | See the temporally adjacent observations around one (source-turn timeline) |
| `@kiro-mem/get_observations` | Fetch full observation details by ID |
| `@kiro-mem/pin` | Mark/unmark important observations |

## Retrieval Pattern / 检索模式

0. **Understand injected index** — observations are referenced as `#O{id}` (e.g. `#O42`). Use `get_observations ids=[42]` to fetch full details.
1. **Scan injected index** — identify relevant observations by title, date, and read-cost
2. **Search** — `search` for keywords (hybrid FTS + semantic), scoped to this workspace
3. **Fetch details on demand** — `get_observations` only for what you need
4. **Timeline when needed** — `timeline observation_id=42` to see the surrounding work in real source-turn order

### Search Scope / 搜索范围

- **Default to the current workspace**: omit `repo`, `cwd`, and `all_scopes`. / 默认只搜索当前 workspace：省略 `repo`、`cwd` 和 `all_scopes`。
- If the user asks for memories from **other projects, across projects, all projects, or global history**, call `search` with `all_scopes: true`. The user does not need to know or mention this parameter. / 当用户表达“其他项目”“跨项目”“所有项目”“全局历史”等意图时，调用 `search` 并设置 `all_scopes: true`；用户无需知道或说出该参数。
- If the user identifies a specific repository or project path, prefer `repo` (or `cwd` for a non-git workspace) instead of `all_scopes`. / 如果用户指定了具体仓库或项目路径，优先传 `repo`（非 Git workspace 使用 `cwd`），不要使用 `all_scopes`。
- Never widen scope merely because a current-workspace search returned no results. Widen only from explicit user intent. / 不得仅因当前 workspace 没搜到结果就擅自扩大范围；只有用户明确表达跨项目意图时才能扩大。

## Privacy / 隐私保护

Users can wrap sensitive content in `<private>` tags — it will be redacted before storage.

```
<private>database password is xxx</private>
Help me configure the connection
```
