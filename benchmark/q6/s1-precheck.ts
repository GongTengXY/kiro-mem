#!/usr/bin/env bun
/**
 * Q6 取证：S1 包装器预检。
 *
 * 判据：`benchmark/reports/agent-behavior/q6-criteria.md`（r4）§8 S1 + §8.1
 *
 * 为什么不是"比对两臂的实际 trial 响应"：不同 agent 会话会生成**不同的 `search` 参数**
 * （措辞、`limit`、`days` 都可能不同），所以两臂的实际响应本来就不该相同——要求它们逐字节
 * 相同会让 S1 永远失败，或者逼着运行者去放宽它。
 *
 * 因此 S1 是**跑任何 trial 之前的确定性预检**，与 agent 行为无关：
 *
 *  1. 取同一个**已捕获**的 JSON-RPC `search` 响应（`fixtures/captured-search-response.json`）；
 *  2. 分别投影到 L-full 与 L-hidden 两条改写路径；
 *  3. **解析后**（不是按字符串）比较；
 *  4. 断言：**仅**目标卡的 `match_source` 被删除，其余字段、其余卡、帧结构全部不变。
 *
 * 用法：`bun run benchmark/q6/s1-precheck.ts`（失败退出非零）
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectSearchResponse } from './project-response';

const FIXTURE = join(import.meta.dir, 'fixtures', 'captured-search-response.json');
const REPORT = join(import.meta.dir, '..', 'reports', 'agent-behavior', 's1-precheck.json');

export interface S1Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface S1Result {
  pass: boolean;
  checks: S1Check[];
  targetObservationId: number;
  samples: { label: string; cardCount: number; sha256: string }[];
}

interface CapturedSample {
  label: string;
  rpcId: number;
  cardSources: (string | null)[];
  rawLine: string;
  rawLineSha256: string;
}

interface Captured {
  targetObservationId: number;
  samples: CapturedSample[];
  provenance?: Record<string, unknown>;
}

function cardsOf(frame: unknown): Record<string, unknown>[] {
  const text = (frame as any).result.content[0].text as string;
  return JSON.parse(text).results as Record<string, unknown>[];
}

function payloadOf(frame: unknown): Record<string, unknown> {
  return JSON.parse((frame as any).result.content[0].text as string);
}

/** 纯函数，供测试直接调用。对**每个**捕获样本各跑一遍全部断言。 */
export function runS1(captured: Captured): S1Result {
  const checks: S1Check[] = [];
  const target = captured.targetObservationId;
  const summaries: S1Result['samples'] = [];

  for (const sample of captured.samples) {
    const p = `[${sample.label}] `;
    const add = (name: string, pass: boolean, detail: string) =>
      checks.push({ name: p + name, pass, detail });

    const actualSha = createHash('sha256').update(sample.rawLine).digest('hex');
    add(
      'captured-sha-matches',
      actualSha === sample.rawLineSha256,
      `recorded=${sample.rawLineSha256.slice(0, 16)} actual=${actualSha.slice(0, 16)}`,
    );

    const frame = JSON.parse(sample.rawLine);
    const opts = { targetObservationId: target } as const;
    const full = projectSearchResponse(frame, { ...opts, arm: 'L-full' });
    const hidden = projectSearchResponse(frame, { ...opts, arm: 'L-hidden' });

    add(
      'recognized-as-search-response',
      full.isSearchResponse && hidden.isSearchResponse,
      `full=${full.isSearchResponse} hidden=${hidden.isSearchResponse}`,
    );
    add(
      'target-present-on-captured-page',
      full.targetPresent && hidden.targetPresent,
      `cardCount=${full.cardCount}`,
    );
    add(
      'target-original-match-source-is-semantic',
      full.targetOriginalMatchSource === 'semantic',
      `got=${String(full.targetOriginalMatchSource)}`,
    );
    add('l-full-removes-nothing', full.removedCount === 0, `removed=${full.removedCount}`);
    add('l-hidden-removes-exactly-one', hidden.removedCount === 1, `removed=${hidden.removedCount}`);

    const fullCards = cardsOf(full.frame);
    const hiddenCards = cardsOf(hidden.frame);
    add(
      'card-count-unchanged',
      fullCards.length === hiddenCards.length && fullCards.length === full.cardCount,
      `full=${fullCards.length} hidden=${hiddenCards.length}`,
    );

    // 核心断言：解析后逐卡比较，两臂唯一差别必须是目标卡的 match_source。
    const diffs: string[] = [];
    for (let i = 0; i < fullCards.length; i++) {
      const a: Record<string, unknown> = { ...fullCards[i]! };
      const b: Record<string, unknown> = { ...hiddenCards[i]! };
      if (a.id === target) {
        if (!('match_source' in a)) diffs.push(`card#${i}: L-full 丢了 match_source`);
        if ('match_source' in b) diffs.push(`card#${i}: L-hidden 仍带 match_source`);
        delete a.match_source;
      }
      const ka = Object.keys(a).sort();
      const kb = Object.keys(b).sort();
      if (JSON.stringify(ka) !== JSON.stringify(kb)) {
        diffs.push(`card#${i}(id=${String(a.id)}): 键集不同 ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`);
        continue;
      }
      for (const k of ka) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
          diffs.push(`card#${i}(id=${String(a.id)}).${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
        }
      }
    }
    add('only-target-match-source-differs', diffs.length === 0, diffs.join(' | ') || 'no other diff');

    // 非目标卡必须保留自己的来源标签（禁止全局替换的直接体现）。
    // 这一条只有在多卡页上才有内容——mixed-source 样本就是为它捕的。
    const others = hiddenCards.filter((c) => c.id !== target);
    const othersFull = fullCards.filter((c) => c.id !== target);
    const othersKept = others.every(
      (c, i) => JSON.stringify(c.match_source) === JSON.stringify(othersFull[i]!.match_source),
    );
    add(
      'non-target-cards-keep-their-source',
      othersKept,
      others.length === 0
        ? 'vacuous (single-card page)'
        : `n=${others.length} sources=${JSON.stringify(others.map((c) => c.match_source ?? null))}`,
    );

    // 信封与页元数据不受影响。
    const fp = payloadOf(full.frame);
    const hp = payloadOf(hidden.frame);
    add(
      'envelope-and-page-meta-unchanged',
      (full.frame as any).id === (frame as any).id &&
        (hidden.frame as any).id === (frame as any).id &&
        (full.frame as any).jsonrpc === (frame as any).jsonrpc &&
        fp.total === hp.total &&
        JSON.stringify(fp.hint) === JSON.stringify(hp.hint),
      `id=${JSON.stringify((frame as any).id)} total=${JSON.stringify(fp.total)}`,
    );

    summaries.push({ label: sample.label, cardCount: full.cardCount, sha256: actualSha });
  }

  // 跨样本的覆盖要求：必须有一个多卡、含非 semantic 来源的样本，
  // 否则 `non-target-cards-keep-their-source` 全是空跑。
  const hasMixed = captured.samples.some(
    (s) => s.cardSources.length >= 2 && s.cardSources.some((x) => x && x !== 'semantic'),
  );
  checks.push({
    name: '[coverage] has-mixed-source-multi-card-sample',
    pass: hasMixed,
    detail: captured.samples.map((s) => `${s.label}=${JSON.stringify(s.cardSources)}`).join(' '),
  });

  return {
    pass: checks.every((c) => c.pass),
    checks,
    targetObservationId: target,
    samples: summaries,
  };
}

if (import.meta.main) {
  const captured = JSON.parse(readFileSync(FIXTURE, 'utf-8')) as Captured;
  const result = runS1(captured);

  for (const c of result.checks) {
    console.log(`${c.pass ? '✅' : '❌'} ${c.name} — ${c.detail}`);
  }
  console.log(`\nS1 ${result.pass ? '通过' : '失败'}（${result.checks.filter((c) => c.pass).length}/${result.checks.length}）`);

  writeFileSync(
    REPORT,
    `${JSON.stringify(
      {
        purpose: 'Q6 S1 包装器预检结果（判据 §8 / §8.1）。跑在任何 trial 之前，与 agent 行为无关。',
        generatedAt: new Date().toISOString(),
        fixture: 'benchmark/q6/fixtures/captured-search-response.json',
        capturedProvenance: captured.provenance ?? null,
        ...result,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`报告：${REPORT}`);
  if (!result.pass) process.exit(1);
}
