/**
 * 冻结记录的**唯一写入口**（FTS 安全策略轮次 plan §6）。
 *
 * 为什么存在：P3 的 `frozenAt` 是手写的，比判据文件的 mtime 早 2.5 分钟
 * （`safety-round/p3-completion.md` §11）。复核接受了那次实验，但要求下一轮把它修掉。
 * 手写时间与手写 SHA 是同一类缺陷——它们让"冻结在跑第一个 arm 之前"这句话变成
 * 无法核对的声明，而整个"先写后跑"的纪律都压在这句话上。
 *
 * 三条职责，逐条对应 plan §6：
 *
 *  1. `frozenAt` 由本模块生成，**API 不接受调用方传入时间**；
 *  2. 每个被冻结的文件逐项 `sha256()`，**写入前校验文件确实存在**；
 *  3. 计数标签由本模块生成 —— 判据一项与其余输入**分开计**。
 *
 * 第 3 条是在修 P3 遗留的标签缺陷：`run-safety-round-grid.ts` 的 S1 先单独校验判据、
 * 再校验 15 项输入，控制台却打印 `15/15`，把真实的 16 项说成 15 项
 * （`p3-completion.md` §11 第 2 条）。本模块把判据放在 `criteria` 字段、其余放在 `inputs`，
 * 计数标签写成 `1 + N` 并由代码生成，**结构上无法再打印出那个数字**。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/** 仓库根目录：本文件在 `benchmark/` 下，冻结记录里的路径统一记成仓库相对路径。 */
const REPO_ROOT = resolve(import.meta.dir, '..');

export interface FreezeItem {
  /** 读数与报告里引用它的名字，例如 `newGold`、`queries`。 */
  name: string;
  /** 文件路径。绝对或相对当前工作目录都可以，记录里统一存仓库相对路径。 */
  path: string;
}

export interface FrozenFile {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
}

export interface FreezeInput {
  /** 轮次标识，例如 `fts-safety-round-2026-08-12`。 */
  round: string;
  /** 阶段标识，例如 `F1`。 */
  phase: string;
  /** 判据文件。单独一个字段，不与 `inputs` 混在一起 —— 这就是 `1 + N` 的那个 1。 */
  criteria: string;
  /** 其余被冻结的输入（数据集、语料、脚本…）。 */
  inputs: FreezeItem[];
  /** 冻结说明。写给后来读记录的人，不参与任何校验。 */
  note?: string;
  /**
   * 调用方自有的冻结内容（网格、门、选择规则…）。原样落盘。
   *
   * 里面**不得**出现任何 `frozenAt` 形状的键：那正是本模块要消灭的手写时间。
   */
  payload?: Record<string, unknown>;
}

export interface FreezeRecord {
  frozen: true;
  /** 由本模块生成。调用方无法传入。 */
  frozenAt: string;
  round: string;
  phase: string;
  criteria: FrozenFile;
  inputs: FrozenFile[];
  /**
   * 由本模块生成的计数标签，形如 `1 + 15`（判据 1 项 + 输入 15 项，合计 16 项）。
   * 脚本必须打印这个字段，不得自己拼计数字符串。
   */
  itemCountLabel: string;
  itemCount: number;
  note?: string;
  payload?: Record<string, unknown>;
  /** 生成本记录的模块，供后来者判断记录格式来源。 */
  generatedBy: 'benchmark/freeze-util.ts';
}

/** 文件的 sha256（十六进制全长）。文件不存在时抛错，绝不返回占位值。 */
export function sha256File(path: string): string {
  if (!existsSync(path)) throw new Error(`[freeze] 被冻结的文件不存在：${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 记录里的路径口径：仓库相对、正斜杠。仓库外的路径原样保留绝对形式。 */
function repoRelative(path: string): string {
  const abs = resolve(path);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..')) return abs;
  return rel.split('\\').join('/');
}

function freezeFile(item: FreezeItem): FrozenFile {
  const abs = resolve(item.path);
  if (!existsSync(abs)) throw new Error(`[freeze] 被冻结的文件不存在：${item.name} → ${item.path}`);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`[freeze] 被冻结的路径不是文件：${item.name} → ${item.path}`);
  return { name: item.name, path: repoRelative(abs), sha256: sha256File(abs), bytes: st.size };
}

/** 递归找出 payload 里任何 `frozenAt` 形状的键。手写时间视为缺陷，直接拒绝。 */
function findTimestampKeys(value: unknown, trail: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findTimestampKeys(v, [...trail, String(i)]));
  if (value && typeof value === 'object') {
    const hits: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (k.toLowerCase().replace(/[_-]/g, '') === 'frozenat') hits.push([...trail, k].join('.'));
      hits.push(...findTimestampKeys(v, [...trail, k]));
    }
    return hits;
  }
  return [];
}

/**
 * 构造冻结记录：生成时间、逐项 SHA、生成计数标签。
 *
 * 校验（任一失败即抛错，不产出半成品记录）：
 *  - 判据与每一项输入都必须存在且是文件；
 *  - `inputs` 的 `name` 不得重复 —— 重名会让"逐项一致"变成一句无法核对的话；
 *  - `inputs` 的路径不得重复，也不得包含判据本身 —— 那会把 16 项算成 17 项；
 *  - `payload` 里不得出现 `frozenAt` 形状的键。
 */
export function buildFreezeRecord(input: FreezeInput): FreezeRecord {
  if (!input.round.trim()) throw new Error('[freeze] round 不得为空');
  if (!input.phase.trim()) throw new Error('[freeze] phase 不得为空');

  const tsKeys = findTimestampKeys(input.payload);
  if (tsKeys.length) {
    throw new Error(
      `[freeze] payload 里出现手写时间键：${tsKeys.join(', ')}。`
      + 'frozenAt 只能由 freeze-util 生成（plan §6 第 2 条）。',
    );
  }

  const criteria = freezeFile({ name: 'criteria', path: input.criteria });

  const names = new Set<string>();
  const paths = new Set<string>([criteria.path]);
  const inputs = input.inputs.map((item) => {
    if (item.name === 'criteria') throw new Error('[freeze] inputs 里不得再出现名为 criteria 的项');
    if (names.has(item.name)) throw new Error(`[freeze] inputs 的 name 重复：${item.name}`);
    names.add(item.name);
    const frozen = freezeFile(item);
    if (paths.has(frozen.path)) throw new Error(`[freeze] inputs 的路径重复（或与判据相同）：${frozen.path}`);
    paths.add(frozen.path);
    return frozen;
  });

  return {
    frozen: true,
    frozenAt: new Date().toISOString(),
    round: input.round,
    phase: input.phase,
    criteria,
    inputs,
    itemCountLabel: `1 + ${inputs.length}`,
    itemCount: 1 + inputs.length,
    ...(input.note ? { note: input.note } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    generatedBy: 'benchmark/freeze-util.ts',
  };
}

/**
 * 构造并落盘。父目录不存在时创建。返回写入的记录。
 *
 * **目标文件已存在时硬失败。** 冻结记录一经写入就是证据链的锚点：若这里允许覆盖，
 * 那么"输入改完再跑一遍"就能把 `frozenAt` 与全部 SHA 重写成新的，
 * "冻结后不得修订"这句话也就不再可核对——而整个"先写后跑"的纪律都压在这句话上。
 *
 * 作废重开必须换一个**明确的新路径或新 round id**（例如 `…-r2.json`），
 * 让两份记录同时在库里可比，而不是让后一份把前一份吃掉。
 */
export function writeFreezeRecord(outPath: string, input: FreezeInput): FreezeRecord {
  const abs = resolve(outPath);
  if (existsSync(abs)) {
    throw new Error(
      `[freeze] 冻结记录已存在，拒绝覆盖：${abs}。`
      + '冻结记录不可修订；作废重开请使用新的路径或新的 round id。',
    );
  }
  const record = buildFreezeRecord(input);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export interface VerifyEntry { name: string; path: string; ok: boolean; expected: string; actual: string | null }
export interface VerifyResult {
  ok: boolean;
  /** 判据那一项，单独报。 */
  criteria: VerifyEntry;
  /** 其余输入，逐项报。 */
  inputs: VerifyEntry[];
  /** 由本模块生成的标签，形如 `判据 1/1 + 输入 15/15`。脚本必须打印它，不得自己拼。 */
  label: string;
  failures: VerifyEntry[];
}

/**
 * 校验一份冻结记录：判据一项与其余输入**分开计数**。
 *
 * 这是 P3 那个 `15/15` 标签缺陷的结构性修法：调用方拿到的是两个独立计数与一个生成好的
 * 标签，没有任何位置可以把 16 项写成 15 项。
 */
export function verifyFreezeRecord(record: FreezeRecord): VerifyResult {
  const check = (f: FrozenFile): VerifyEntry => {
    const abs = resolve(REPO_ROOT, f.path);
    const actual = existsSync(abs) ? sha256File(abs) : null;
    return { name: f.name, path: f.path, ok: actual === f.sha256, expected: f.sha256, actual };
  };
  const criteria = check(record.criteria);
  const inputs = record.inputs.map(check);
  const okInputs = inputs.filter((e) => e.ok).length;
  const failures = [criteria, ...inputs].filter((e) => !e.ok);
  return {
    ok: failures.length === 0,
    criteria,
    inputs,
    label: `判据 ${criteria.ok ? 1 : 0}/1 + 输入 ${okInputs}/${inputs.length}`,
    failures,
  };
}

/** 从磁盘读一份冻结记录并校验。 */
export function verifyFreezeRecordFile(path: string): VerifyResult {
  if (!existsSync(path)) throw new Error(`[freeze] 冻结记录不存在：${path}`);
  return verifyFreezeRecord(JSON.parse(readFileSync(path, 'utf-8')) as FreezeRecord);
}
