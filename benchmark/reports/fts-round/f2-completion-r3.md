# FTS 安全策略轮次 F2 收口 **r3**：冻结证据链修复

> 日期：2026-08-14　轮次：**`fts-safety-round-2026-08-12-r2`**（round id 不变：数据、判据、装置、K 逐字节未变）
>
> 触发：**Codex F2 验收「暂不通过」**，阻塞点是冻结证据链，不是 F2 读数。
>
> 判据：`f1-criteria-r4.md`（增量）+ `f1-criteria.md`（r3 基线，逐字节未改）
>
> 新冻结：`f1-freeze-r3.json`（`1 + 21`，自校验 21/21 ✓）、`f2-freeze-r3.json`（`1 + 19`，自校验 19/19 ✓）
>
> **本文不含任何门（G1–G4）读数。** F3 尚未跑。
>
> 本文是增量：`f2-completion-r2.md` **逐字节保留**为历史，它的 §1 有一句不成立的声明，
> 由本文 §1 更正——不回改原文，理由见 §7 第 4 条。

---

## 0. 一页结论

| 验收要求 | 处置 | 证据 |
| --- | --- | --- |
| 1. 当前 validator 固化到版本化新路径 | `validate-fts-round-dataset-r2.ts`，**逐字节复制** | SHA 仍为 `cf81527b…`，与 F2 实际跑过的字节相同 |
| 2. 恢复旧 validator 原始字节，旧冻结回 14/14 | 原路径恢复 `cc56ef92…` | 旧 `f1-freeze.json` → **判据 1/1 + 输入 14/14 ✓** |
| 3. 不覆盖 r2 冻结，新建冻结链并显式冻结旧 freeze record | `f1-freeze-r3.json` + `f2-freeze-r3.json`；三份历史记录作为**输入项**被钉住字节 | `f2-freeze-r3.json` 的 `f1FreezeR1Historical` / `f1FreezeR2Historical` / `f2FreezeR2Historical` |
| 4. 冻结后另出 strata 复现，F2 冻结必须要求它通过 | `verify-fts-round-f2-strata.ts` → `f2-strata-verify-r3.json`；**G-f 是硬前置** | 80/80 逐条一致，最大 \|Δ\| = 0.000497 |
| 5. F3 按「修补/未修补」× ftsCount 档报告负例 | 口径 + 基线条数**预登记**在 `f2-freeze-r3.json` 的 `payload.nextPhase.f3.negativeBreakdown` | 修补 26 / 未修补 14；档 `1=4 / 2-9=23 / 10-99=0 / 100-999=8 / ≥1000=5` |

**数据、ACP 镜像、中文语料、60,066 行装置与 20,066 次编码、K = 200、四档分层全部未重新生成。**
本次只修证据链——这一点由 `f1-freeze-r3.json` 的 `payload.chain.diffVsR2` 机械自证：
21 项输入里 **20 项与 r2 记录逐字节相同**，唯一变化是 validator 的路径。

---

## 1. 更正 r2 的那句声明

`f2-completion-r2.md` §1 写：

> 原 `f1-freeze.json`（14 项输入）…全部**逐字节保留**，覆盖由 `freeze-util` 硬失败保证而不是靠自觉。

**准确的表述是**：冻结记录**文件本身**逐字节保留了（`freeze-util` 拒绝覆盖，这部分成立），
但它引用的**第 13 项输入** `benchmark/validate-fts-round-dataset.ts` 被就地改动，
因此"14 项输入逐字节保留"**不成立**。Codex 实测：

```text
旧 f1-freeze.json   判据 1/1 + 输入 13/14
validator           expected cc56ef92…   actual cf81527b…
```

### 1.1 缺陷的结构性成因

**`freeze-util` 防的是"覆盖冻结记录"，防不了"改动被冻结的输入"。** 这两件事需要两种机制：

| 风险 | 机制 | r2 时的状态 |
| --- | --- | --- |
| 冻结记录被重写 | `writeFreezeRecord` 目标存在即硬失败 | ✅ 已有，且生效 |
| 被冻结的输入被改动 | `verifyFreezeRecordFile` 对该记录跑校验 | ⚠️ 函数早就有，但**没有任何脚本对旧记录跑过它** |

F2 的三个 runner 都只校验**当轮**的 `f1-freeze-r2.json`，没有一处回头校验 r1 的记录。
于是"旧记录仍然有效"从一句可核对的断言退化成了一句无人执行的声明——而 r2 的收口报告
正是照着那句声明写的。

### 1.2 我当时为什么会就地改它

r4 §18 要求 validator 补一条 `token_source` 校验，同时 r2 换了 query 集路径。
两处改动都落在同一个文件上，而那个文件是 r1 冻结的输入之一。**判据 §9 第 14 条只写了
"不得覆盖任何冻结记录"，没写"不得改动被冻结的输入"**，我按字面执行，漏掉了后者。
这是第二次同形错误：r2 那轮的 §6 第 5 条已经登记过一次"未测量就断言"，
这次是"未校验就声明"。

---

## 2. 旧字节从哪里来，怎么证明它是对的

`benchmark/validate-fts-round-dataset.ts` 是未跟踪文件（`.gitignore` 之外但从未提交），
**git 里没有历史**。恢复源是 Kiro CLI 自己的会话记录：

```text
~/.kiro/sessions/cli/af12cae7-c618-417a-a754-37de9e0788b1.jsonl
  → 一次 write / command=create 调用，path 以 benchmark/validate-fts-round-dataset.ts 结尾
  → 其 content 的 sha256 = cc56ef921e2e6ef7681d6d3cb0abfe1d3f9aa60747f0cc7d22ecd7f23102110f
```

**这个 SHA 与旧冻结记录期望的值逐字节相同**，所以恢复不依赖"我记得当时写了什么"：
提取脚本先算 SHA、与期望值比对通过后才落盘，落盘后再用 `shasum -a 256` 独立复核一次。
恢复的字节数 11,486（r2 版本 12,438）。

两件独立的可运行证据：

| 检查 | 结果 |
| --- | --- |
| 恢复后的 r1 validator 校验 **r1 数据集**（`queries-fts-round.json`） | ✓ 全部通过（记录 40 / query 120 / 覆盖 40/40） |
| 固化后的 r2 validator 校验 **r2 数据集**（`queries-fts-round-r2.json`） | ✓ 全部通过（含 `token_source` 那条 r4 §18 的新校验） |

SHA 相同只说明字节一致；两次实跑说明**恢复的不是一堆碰巧同哈希的字节，而是一份能跑的脚本**。

---

## 3. r2 冻结记录现在处于什么状态

修复有一个**无法消除**的连带后果，必须显式登记而不是掩盖：

```text
f1-freeze-r2.json   判据 1/1 + 输入 20/21     ← validator 一项失败
```

原因是这份记录把 **r2 的字节钉在了原路径上**，而原路径已按裁定恢复 r1 字节。
两者不可同时成立：

| 记录 | 对 `validate-fts-round-dataset.ts` 的要求 |
| --- | --- |
| `f1-freeze.json`（r1） | = `cc56ef92…` |
| `f1-freeze-r2.json` | = `cf81527b…` |

裁定选择了恢复 r1，因此 r2 记录的这一项**结构性失败**。处置：

1. **文件逐字节保留**，不回改、不覆盖；
2. 失败原因写进 `f1-freeze-r3.json` 与 `f2-freeze-r3.json` 的 `payload.chain`；
3. `f2-freeze-r3.ts` 的 **G-d 门要求它的失败项恰好只有 `validator` 一项**——
   若哪天多出第二项，说明还有别的冻结输入被改动过，"只修证据链"的断言当场失效；
4. 同一份实现的字节由 `f1-freeze-r3.json` 用**版本化路径**承接，其余 20 项与 r2 逐项相同。

### 3.1 全链现状（可复算）

```bash
bun -e 'import { verifyFreezeRecordFile as v } from "./benchmark/freeze-util";
for (const p of ["f1-freeze","f1-freeze-r2","f1-freeze-r3","f2-freeze-r2","f2-freeze-r3"])
  { const r = v(`benchmark/reports/fts-round/${p}.json`); console.log(p.padEnd(14), r.ok?"✓":"✗", r.label); }'
```

| 记录 | 校验 | 地位 |
| --- | --- | --- |
| `f1-freeze.json` | **判据 1/1 + 输入 14/14 ✓** | r1 历史，已恢复 |
| `f1-freeze-r2.json` | 判据 1/1 + 输入 **20/21** | r2 历史，validator 项结构性失败（§3，已登记） |
| `f1-freeze-r3.json` | **判据 1/1 + 输入 21/21 ✓** | **F3 依据的 F1 冻结** |
| `f2-freeze-r2.json` | **判据 1/1 + 输入 10/10 ✓** | r2 历史，读数仍有效 |
| `f2-freeze-r3.json` | **判据 1/1 + 输入 19/19 ✓** | **F3 依据的 F2 冻结** |

---

## 4. 新增的两道机械门

缺陷的教训是"声明没有落点"，所以修复的形式是把两句声明变成脚本断言。

### 4.1 validator 字节的写死断言

`freeze-fts-round-f1-r3.ts` 与 `freeze-fts-round-f2-r3.ts` 都在冻结**之前**断言两份
validator 的 SHA 恰为 `cc56ef92…` 与 `cf81527b…`。**写死期望值而不是"当前是什么就冻什么"**——
后者正是本次缺陷能悄悄通过的原因。

### 4.2 strata 的冻结后复现（Codex 第 4 项）

`f2-strata-r2.json` 是**冻结前**测的：裁定的执行顺序是"先重测四档 → 再新路径冻结"，
所以那次运行必须 `--pre-freeze` 跳过冻结校验。它的 runner 注释承诺了"冻结之后再跑一次带校验的"，
但 `freeze-fts-round-f2.ts` 只检查 `strata.pass`，那句承诺没有落点。

新脚本 `benchmark/verify-fts-round-f2-strata.ts` → `f2-strata-verify-r3.json`：

| 检查 | 读数 |
| --- | --- |
| 冻结校验（`f1-freeze-r3.json`，**不跳过**） | 判据 1/1 + 输入 21/21 ✓ |
| 逐条 `band` 一致 | **80/80** |
| 逐条余弦一致 | **80/80**，最大 \|Δ\| = **0.000497**（阈值 5e-4） |
| 逐条英文形一致 | **80/80** |
| 三套四档条数与冻结记录一致 | **12/12 项**（并集 / relevance / 保护线） |
| 并集每档 ≥ 8 | 20 / 19 / 14 / 27 |

**余弦阈值的口径**：预冻结报告只存三位小数，所以"舍入前同值"的上界就是半个最后一位 = 5e-4，
判定取**含等号**。实测最大 0.000497 正是舍入残差；写成严格小于会让恰好落在舍入边界的条目假失败。
真实漂移会先在三位小数上不等，那一条单独判。

**输出走独立路径，不覆盖预冻结报告**——两份读数并存才能比对。

---

## 5. F3 的交接（Codex 第 5 项 + 一个判据缺口）

### 5.1 负例分组报告口径（预登记，先写后跑）

冻结在 `f2-freeze-r3.json` 的 `payload.nextPhase.f3.negativeBreakdown`：

- **修补 / 未修补**：query 是否带 `repair` 字段（r2 补丁表的机械标记）；
- **ftsCount 档**：`1 / 2-9 / 10-99 / 100-999 / ≥1000`，**等比铺开**，与判据 §2.4 的刻度生成规则
  同一形态，**不引用任何门读数**；
- **分组不改变 G2 的判定**（仍是逐条 `distinctContent ≤ 2`），它是额外的归因切面。

| 分组 | n | `1` | `2-9` | `10-99` | `100-999` | `≥1000` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 修补 | 26 | 3 | 14 | 0 | 5 | 4 |
| 未修补 | 14 | 1 | 9 | 0 | 3 | 1 |
| **合计** | **40** | **4** | **23** | **0** | **8** | **5** |

按类别：`false-premise` 15（修补 9）、`same-word-other-thing` 15（修补 10）、
`stale-state-confusion` 10（修补 7）。`ftsCount` 区间 1…2899。

两条口径说明：

1. **`10-99` 档两侧都是 0 是数据的真实形态**（词面命中要么只有个别行、要么成百上千行），
   **不因此调整档位**——档位是报告口径，不是门槛；
2. 验收意见里提到的"21/40"我没有去反推它的阈值口径。`f2-freeze-r3.json` 里
   **逐条冻结了 40 条负例的 `ftsCount`**（`negativeBreakdown.perQuery`），
   任何阈值口径都能由它复算：`≤ 1` 是 4 条、`≤ 9` 是 27 条。
   F3 的报告会同时给逐条明细与分档汇总。

### 5.2 页面 limit 是判据缺口，按继承处理

F1 冻结了 `internalCandidateLimit = 50`（V4，FTS 腿返回内核的条数），
但**没有冻结请求级页面 limit**。而 G2 的"≤ 2"是 Phase 2B 在 `limit = 10` 下预登记选出的，
P3 网格同样是 10（`p3-grid-freeze.json`）。

**F3 因此只能沿用 10**：换任何其他值都会改变那个已冻结阈值的含义。这是**被迫沿用而不是选值**，
已登记在 `f2-freeze-r3.json` 的 `payload.nextPhase.f3.pageLimitInherited`。

---

## 6. 本次未动的东西

| 项 | 状态 |
| --- | --- |
| `turns-fts-round.json` / `queries-fts-round*.json` / 两份镜像 / 中文语料 / 英文 filler | 逐字节未变（`diffVsR2` 自证） |
| 60,066 行装置、20,066 次真实编码 | 未重建，`$TMPDIR/fts-round-f2-r2.db` 原样复用 |
| K = 200 与 S7a 的 1920 组比对 | 未重跑、未改动 |
| 四档 20/19/14/27、S2–S4 八项、S6 120/120 | 读数不变，只增加冻结后复现 |
| 生产代码 | **零改动**（`git diff src/` 为空） |
| `f2-completion-r2.md`、`f2-strata-r2.json`、`f2-fixture.json`、`f2-strata.json` | 逐字节保留 |

---

## 7. 诚实边界

1. **恢复源是 Kiro CLI 的会话记录，属项目外部证据。** 它不在版本库里，因此复核者无法从仓库
   独立重放这次恢复；能独立核对的是**结果**——恢复后的字节 SHA 等于旧冻结记录里记载的值，
   而那份记录早于本次修复且未被覆盖。
2. **两份 validator 的文件头用法行都写不带后缀的路径。** 这是保 SHA 的代价（改一个字就不再是
   "F2 实际跑过的字节"）。正确入口以冻结记录为准：**r2 数据必须用 `-r2` 那份校验**，
   这条已写进 `f1-freeze-r3.json` 的 `chain.validatorVersions.knownTextDefect`。
3. **`f1-freeze-r2.json` 无法再自校验通过，这是不可消除的。** 任何修法都要在"旧记录能验"与
   "r2 记录能验"之间选一个，裁定选了前者。G-d 门保证这个失败范围不扩大。
4. **没有回改 `f2-completion-r2.md`。** 它是已提交给验收的历史文本；就地更正它会重演本次缺陷的
   同一种动作——**改动一份已被引用的旧产物**。因此更正写在本文 §1，两份并存可比。
5. **本次修复没有产生任何新的门读数**，也没有触碰判据。G1–G4、保护线、性能门、选择规则
   全部仍是 r3 + r4 的原文。
6. **撰写者、修复者与登记者仍是同一人。** 缓解方式与前几轮相同：本次的每一条断言都是机械计算
   （SHA 断言、14/14 与 20/21 的计数标签、80/80 的逐条比对），由脚本硬失败，不依赖人工复核。
