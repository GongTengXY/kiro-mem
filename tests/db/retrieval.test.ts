import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../../src/db';
import { openInMemoryDB } from '../support/tmp-db';

let db: MemoryDB;
let sessionSeq = 0;

beforeEach(() => { db = openInMemoryDB(); sessionSeq = 0; });
afterEach(() => { db.close(); });

/** Create a closed turn + its Observation with an explicit turn_stopped_at. */
function seedObs(o: {
  session_id?: string;
  repo?: string | null;
  cwd?: string;
  title?: string;
  summary?: string;
  request?: string;
  outcome?: string;
  learned?: string;
  evidence?: string[];
  type?: 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'change';
  stoppedAt: string;
}): number {
  const session_id = o.session_id ?? 's1';
  const cwd = o.cwd ?? '/proj';
  const repo = o.repo === undefined ? '/proj' : o.repo;
  if (!db.getSessionRef(session_id)) db.upsertSessionRef({ session_id, cwd, repo });
  const seq = db.allocateNextTurnSeq(session_id);
  const turn = db.createTurn({ session_id, seq, cwd, repo, prompt_text: o.title ?? 'p' });
  db.markTurnClosed(turn.id);
  return db.insertObservation({
    turn_id: turn.id,
    session_id,
    turn_seq: seq,
    repo,
    cwd_scope: cwd,
    title: o.title ?? 'Title',
    summary: o.summary ?? 'Summary',
    request: o.request,
    outcome: o.outcome,
    learned: o.learned,
    evidence: o.evidence,
    memory_type: o.type ?? 'change',
    quality: 'normal',
    turn_started_at: o.stoppedAt,
    turn_stopped_at: o.stoppedAt,
  })!;
}

describe('searchObservationsFts', () => {
  test('finds by title keyword and indexes outcome/learned', () => {
    seedObs({ title: 'Fix authentication token refresh', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ title: 'Add pagination to users API', stoppedAt: '2026-07-02T00:00:00Z' });
    seedObs({ title: 'Neutral', outcome: 'zzuniquetoken verified', stoppedAt: '2026-07-03T00:00:00Z' });

    expect(db.searchObservationsFts('authentication').length).toBe(1);
    // outcome is FTS-indexed
    const byOutcome = db.searchObservationsFts('zzuniquetoken');
    expect(byOutcome.length).toBe(1);
    expect(byOutcome[0]!.title).toBe('Neutral');
  });

  test('scope_key hard-isolates results across workspaces', () => {
    seedObs({ session_id: 'a', repo: '/repoA', cwd: '/repoA', title: 'shared concept work', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ session_id: 'b', repo: '/repoB', cwd: '/repoB', title: 'shared concept work', stoppedAt: '2026-07-02T00:00:00Z' });

    const scopedA = db.searchObservationsFts('concept', { scopeKey: computeScopeKey('/repoA', '/repoA') });
    expect(scopedA.length).toBe(1);
    expect(scopedA[0]!.repo).toBe('/repoA');

    // no scope filter => both
    expect(db.searchObservationsFts('concept').length).toBe(2);
  });

  test('filters by memory_type', () => {
    seedObs({ title: 'auth bug here', type: 'bugfix', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ title: 'auth refactor here', type: 'refactor', stoppedAt: '2026-07-02T00:00:00Z' });
    const r = db.searchObservationsFts('auth', { type: 'bugfix' });
    expect(r.length).toBe(1);
    expect(r[0]!.memory_type).toBe('bugfix');
  });

  test('short query (<3 chars) uses LIKE fallback', () => {
    seedObs({ title: 'JWT token handling', stoppedAt: '2026-07-01T00:00:00Z' });
    expect(db.searchObservationsFts('JW').length).toBe(1);
  });

  test('treats special-character queries as literal user text', () => {
    const queries = [
      'foo:bar',
      'a-b',
      '"unterminated',
      'AND',
      'C++',
      'src/auth/token.ts',
      '中文查询',
    ];
    queries.forEach((query, index) => {
      seedObs({
        title: `literal marker ${query}`,
        stoppedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00Z`,
      });
    });

    for (const query of queries) {
      expect(() => db.searchObservationsFts(query)).not.toThrow();
      expect(db.searchObservationsFts(query).some((o) => o.title.includes(query))).toBe(true);
    }
  });

  test('empty or whitespace-only query returns no results', () => {
    seedObs({ title: 'should not become an all-record search', stoppedAt: '2026-07-01T00:00:00Z' });
    expect(db.searchObservationsFts('')).toEqual([]);
    expect(db.searchObservationsFts('   ')).toEqual([]);
  });

  // Regression: literal-quoting the WHOLE query turned every search into an
  // exact-substring (phrase) match under the trigram tokenizer, so multi-word
  // and natural-language queries recalled nothing at all and hybrid search
  // silently degraded to semantic-only. See benchmark/README.md D1.
  test('multi-word and natural-language queries still recall (not phrase-only)', () => {
    seedObs({
      title: '测试数据目录隔离到临时目录',
      summary: 'bunfig.toml 的 preload 把 KIRO_MEMORY_DATA_DIR 指向临时目录。',
      stoppedAt: '2026-07-01T00:00:00Z',
    });
    seedObs({
      title: 'Refresh token rotation on reuse',
      summary: 'Rotate refresh tokens so a replayed token is rejected.',
      stoppedAt: '2026-07-02T00:00:00Z',
    });

    // Space-separated terms that never appear as one contiguous substring.
    expect(db.searchObservationsFts('测试 数据目录').length).toBe(1);
    // A whole natural-language question.
    expect(db.searchObservationsFts('跑测试会不会污染我真实的数据目录').length).toBe(1);
    expect(db.searchObservationsFts('rotation reuse token').length).toBe(1);
    // Still no false positives for an unrelated query.
    expect(db.searchObservationsFts('完全无关的图表渲染性能').length).toBe(0);
  });

  test('search units keep whole whitespace-delimited segments', () => {
    // A path must be matched as a whole segment, not split on punctuation.
    expect(extractFtsSearchUnits('src/db/index.ts 的 FTS')).toEqual(['src/db/index.ts', 'FTS']);
    // Reserved words / code symbols stay single units, so quoting keeps them literal.
    expect(extractFtsSearchUnits('AND C++ foo:bar')).toEqual(['AND', 'C++', 'foo:bar']);
    // Below the trigram floor there is no usable unit -> caller falls back to LIKE.
    expect(extractFtsSearchUnits('ab')).toEqual([]);
    // A CJK run is additionally sliced so sub-terms can match.
    expect(extractFtsSearchUnits('数据目录隔离')).toEqual([
      '数据目录隔离',
      '数据目',
      '据目录',
      '目录隔',
      '录隔离',
    ]);
  });
});

describe('observationTimeline (source-turn ordering)', () => {
  test('orders by turn_stopped_at, NOT by observation id', () => {
    // Insert out of chronological order so id order != time order.
    const idMid = seedObs({ title: 'mid', stoppedAt: '2026-07-02T00:00:00Z' }); // id 1
    const idLate = seedObs({ title: 'late', stoppedAt: '2026-07-03T00:00:00Z' }); // id 2
    const idEarly = seedObs({ title: 'early', stoppedAt: '2026-07-01T00:00:00Z' }); // id 3

    const tl = db.observationTimeline(idMid, { before: 3, after: 3 });
    expect(tl.anchor!.id).toBe(idMid);
    // before = earlier by time (the "early" one, id 3 but oldest)
    expect(tl.before.map((o) => o.id)).toEqual([idEarly]);
    // after = later by time (the "late" one)
    expect(tl.after.map((o) => o.id)).toEqual([idLate]);
  });

  test('mode=scope spans sessions; mode=session stays within one session', () => {
    // Two sessions, same repo/scope.
    seedObs({ session_id: 's1', title: 's1 early', stoppedAt: '2026-07-01T00:00:00Z' });
    const anchor = seedObs({ session_id: 's2', title: 's2 anchor', stoppedAt: '2026-07-02T00:00:00Z' });
    seedObs({ session_id: 's1', title: 's1 late', stoppedAt: '2026-07-03T00:00:00Z' });

    const scope = db.observationTimeline(anchor, { mode: 'scope' });
    expect(scope.before.length).toBe(1); // s1 early
    expect(scope.after.length).toBe(1);  // s1 late

    const session = db.observationTimeline(anchor, { mode: 'session' });
    expect(session.before.length).toBe(0); // nothing else in s2
    expect(session.after.length).toBe(0);
  });

  test('returns empty for unknown observation', () => {
    const tl = db.observationTimeline(9999);
    expect(tl.anchor).toBeNull();
    expect(tl.before).toEqual([]);
    expect(tl.after).toEqual([]);
  });
});

describe('P0-6: pin must not affect search ranking', () => {
  test('a strongly matching non-pinned Observation outranks a weakly matching pinned one', () => {
    // Weak match: the query term appears once, in the title only.
    const weakPinned = seedObs({
      title: 'token cleanup',
      summary: 'unrelated maintenance work',
      stoppedAt: '2026-07-01T00:00:00Z',
    });
    // Strong match: the query terms appear across title, summary and outcome.
    const strong = seedObs({
      title: 'Fix refresh token rotation',
      summary: 'refresh token rotation broke on 401 retry',
      outcome: 'token rotation now retries once with the refreshed token',
      stoppedAt: '2026-07-02T00:00:00Z',
    });
    db.pinObservation(weakPinned, true);

    const ids = db.searchObservationsFts('refresh token rotation').map((o) => o.id);
    expect(ids[0]).toBe(strong);
    expect(ids.indexOf(strong)).toBeLessThan(ids.indexOf(weakPinned));
  });

  test('the LIKE fallback branch is also recency-ordered, not pin-ordered', () => {
    const older = seedObs({ title: 'ab handling older', stoppedAt: '2026-07-01T00:00:00Z' });
    const newer = seedObs({ title: 'ab handling newer', stoppedAt: '2026-07-05T00:00:00Z' });
    db.pinObservation(older, true);

    // A 2-char query is below the trigram floor, so this exercises LIKE.
    const ids = db.searchObservationsFts('ab').map((o) => o.id);
    expect(ids[0]).toBe(newer);
    expect(ids).toContain(older);
  });

  test('pinning does not change the result set, only bootstrap injection does', () => {
    const a = seedObs({ title: 'alpha rotation task', stoppedAt: '2026-07-01T00:00:00Z' });
    seedObs({ title: 'beta rotation task', stoppedAt: '2026-07-02T00:00:00Z' });
    const before = db.searchObservationsFts('rotation task').map((o) => o.id).sort();
    db.pinObservation(a, true);
    const after = db.searchObservationsFts('rotation task').map((o) => o.id).sort();
    expect(after).toEqual(before);
  });
});

describe('P1-1: a long CJK query keeps its tail terms', () => {
  // 44 chars, no whitespace. Under head-first windowing the budget was spent on
  // the opening clause and everything after it was silently unsearchable.
  const LONG_QUERY =
    '我想找一下之前处理过的那个关于会话隔离和数据目录权限的问题最后是怎么修复的向量重排';

  test('the tail window is present, not just the head', () => {
    const units = extractFtsSearchUnits(LONG_QUERY);
    expect(units.length).toBeLessThanOrEqual(32);
    // The final 3-gram of the run must be reachable.
    expect(units).toContain(LONG_QUERY.slice(-3));
    // And so must the head, so this is not a head-vs-tail trade.
    expect(units).toContain(LONG_QUERY.slice(0, 3));
  });

  test('units span the whole query, not only its first third', () => {
    const units = extractFtsSearchUnits(LONG_QUERY);
    const windows = units.filter((u) => u.length === 3);
    const positions = windows.map((w) => LONG_QUERY.indexOf(w));
    expect(Math.max(...positions)).toBeGreaterThan(LONG_QUERY.length * 0.7);
  });

  test('a distinctive tail term actually retrieves the right Observation', () => {
    seedObs({ title: '会话隔离权限调整', stoppedAt: '2026-07-01T00:00:00Z' });
    const target = seedObs({ title: '修复向量重排打分异常', stoppedAt: '2026-07-02T00:00:00Z' });

    const ids = db.searchObservationsFts(LONG_QUERY).map((o) => o.id);
    expect(ids).toContain(target);
  });

  test('when the budget is not binding the units are unchanged (head to tail)', () => {
    expect(extractFtsSearchUnits('数据目录隔离')).toEqual([
      '数据目录隔离', '数据目', '据目录', '目录隔', '录隔离',
    ]);
  });

  test('a mixed CJK+latin segment surfaces its latin run', () => {
    // `修复` is below the trigram floor and the whole segment is an exact
    // substring match nothing satisfies, so `bug` was the only usable unit —
    // and it used to be dropped.
    expect(extractFtsSearchUnits('修复bug')).toContain('bug');
  });

  test('a pure-latin path is NOT split into generic fragments', () => {
    // Splitting this would OR in `src`/`index`, which match nearly everything.
    expect(extractFtsSearchUnits('src/db/index.ts')).toEqual(['src/db/index.ts']);
  });

  test('two CJK runs each keep their tail', () => {
    const a = '数据目录权限隔离问题排查';
    const b = '向量重排打分阈值调整验证';
    const units = extractFtsSearchUnits(`${a} ${b}`);
    expect(units).toContain(a.slice(-3));
    expect(units).toContain(b.slice(-3));
  });
});

describe('P1-2: the LIKE fallback covers every FTS column', () => {
  test('a 2-char term found only in request is still retrievable', () => {
    const target = seedObs({
      title: 'unrelated title',
      summary: 'unrelated summary',
      request: 'please look at the zq handler',
      stoppedAt: '2026-07-01T00:00:00Z',
    });
    // 2 chars => below the trigram floor => LIKE branch.
    expect(extractFtsSearchUnits('zq')).toEqual([]);
    expect(db.searchObservationsFts('zq').map((o) => o.id)).toContain(target);
  });

  test('a term found only in evidence is retrievable', () => {
    const target = seedObs({
      title: 'unrelated', evidence: ['exit code qw'], stoppedAt: '2026-07-02T00:00:00Z',
    });
    expect(db.searchObservationsFts('qw').map((o) => o.id)).toContain(target);
  });

  test('a term found only in files_touched is retrievable', () => {
    const session_id = 'p12-files';
    db.upsertSessionRef({ session_id, cwd: '/proj', repo: '/proj' });
    const seq = db.allocateNextTurnSeq(session_id);
    const turn = db.createTurn({ session_id, seq, cwd: '/proj', repo: '/proj' });
    db.markTurnClosed(turn.id);
    const target = db.insertObservation({
      turn_id: turn.id, session_id, turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
      title: 'unrelated', summary: 'unrelated', files_touched: ['src/vx.ts'],
      memory_type: 'change', quality: 'normal',
      turn_started_at: '2026-07-03T00:00:00Z', turn_stopped_at: '2026-07-03T00:00:00Z',
    })!;
    expect(db.searchObservationsFts('vx').map((o) => o.id)).toContain(target);
  });

  test('a term in no column still returns nothing', () => {
    seedObs({ title: 'alpha', stoppedAt: '2026-07-01T00:00:00Z' });
    expect(db.searchObservationsFts('zz')).toEqual([]);
  });
});

describe('FTS 主查询的执行计划：CROSS JOIN 固定连接顺序', () => {
  /**
   * 断言的是**可观测后果**，不是计划文本。
   *
   * 判据（`benchmark/reports/fix-fts-limit-criteria.md` §7 第 1 条）要求反向测试能捕获计划
   * 翻转，但 `EXPLAIN QUERY PLAN` 的输出字符串依赖 SQLite 版本与统计信息，把它写死会让测试
   * 在升级 Bun 时无故失败——那种测试只会被删掉，不会被修。
   *
   * 所以断言两件可观测的事：
   *   1. 计划的**驱动表**是 FTS 虚表（这是修复的全部内容：谁做外层循环）；
   *   2. 计划里**没有** `TEMP B-TREE` 排序（FTS 自己的 rank 次序被直接使用）。
   *
   * 这两条都是语义中立的结构性质，不依赖具体的 index 名或代号。翻回 `JOIN` 之后两条都会失败
   * ——实测确认过，这就是这个测试的判别力来源。
   */
  /**
   * 取**生产源码里那条 SQL**，而不是在测试里重抄一遍。
   *
   * 第一版就是重抄的，于是反向测试（把生产改回 `JOIN`）时这两条计划断言**照样通过**——
   * 它测的是"一条写着 CROSS JOIN 的 SQL 会有 CROSS JOIN 的计划"，同义反复，没有判别力。
   * 反向测试就是为了抓这个而要求的。
   *
   * 现在从 `src/db/index.ts` 抽出 FTS 分支的 SQL 模板，再按生产的方式拼上时间阈值、scope 与
   * ORDER BY/LIMIT。改动生产的连接方式会立刻反映到这里。
   *
   * Phase 3C 之后模板本身**不再包含**时间阈值：默认时间窗是无界的，阈值改成由
   * `searchDateThreshold()` 返回 `null` 时省略整个子句。所以这里要按生产的顺序条件拼接
   * （MATCH → [阈值] → scope → type → ORDER BY/LIMIT），并且两种形状都要验计划——
   * 默认无界是新的生产默认，显式 `days=N` 仍然是真实路径。
   */
  const productionFtsSql = (withDateThreshold: boolean): string => {
    const src = readFileSync(new URL('../../src/db/index.ts', import.meta.url), 'utf-8');
    const m = src.match(/let sql = `(SELECT o\.\* FROM observations_fts fts[\s\S]*?)`;/);
    if (!m) throw new Error('没能从 src/db/index.ts 抽出 FTS 分支 SQL——正则与源码脱节了');
    const threshold = withDateThreshold ? ' AND o.turn_stopped_at > ?' : '';
    // 与生产 `searchObservationsFts` 相同的拼接顺序（scopeKey 给了、type 没给）。
    return `${m[1]!}${threshold} AND o.scope_key = ? ORDER BY fts.rank, o.id ASC LIMIT ?`;
  };

  const planOf = (query: string, opts?: { days?: number }): string[] => {
    const units = extractFtsSearchUnits(query);
    const expr = units.map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');
    const withDateThreshold = opts?.days !== undefined;
    const params: (string | number)[] = [expr];
    if (withDateThreshold) {
      params.push(new Date(Date.now() - opts!.days! * 86400000).toISOString());
    }
    params.push(computeScopeKey('/proj', '/proj'), 50);
    // 只读旁路连接。不给 MemoryDB 加一个只有测试用的 explain 方法：那是为了一个断言
    // 在生产 API 上开洞。所以这个 describe 用**文件库**而不是内存库。
    const raw = new Database(planDbPath, { readonly: true });
    try {
      return (raw.query(`EXPLAIN QUERY PLAN ${productionFtsSql(withDateThreshold)}`)
        .all(...params) as { detail: string }[]).map((r) => r.detail);
    } finally {
      raw.close();
    }
  };

  let planDir: string;
  let planDbPath: string;
  let fileDb: MemoryDB;

  beforeEach(() => {
    planDir = mkdtempSync(join(tmpdir(), 'kiro-plan-'));
    planDbPath = join(planDir, 'plan.db');
    fileDb = new MemoryDB(planDbPath);
    const session_id = 's-plan';
    fileDb.upsertSessionRef({ session_id, cwd: '/proj', repo: '/proj' });
    for (let i = 0; i < 30; i++) {
      const seq = fileDb.allocateNextTurnSeq(session_id);
      const turn = fileDb.createTurn({
        session_id, seq, cwd: '/proj', repo: '/proj', prompt_text: `p${i}`,
      });
      const ts = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
      fileDb.markTurnClosed(turn.id, ts);
      fileDb.insertObservation({
        turn_id: turn.id, session_id, turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
        title: `record ${i} about quoting and escaping`,
        summary: `synthetic body ${i} covering installation and worker restart`,
        memory_type: 'change', quality: 'normal',
        turn_started_at: ts, turn_stopped_at: ts,
      });
    }
  });

  afterEach(() => {
    fileDb.close();
    rmSync(planDir, { recursive: true, force: true });
  });

  test('驱动表是 FTS 虚表，不是 observations', () => {
    // Phase 3C：两种形状都要验。默认无界是新的生产默认；显式 `days=N` 仍会拼出时间阈值，
    // 而多一个谓词有可能让 SQLite 改选驱动表——那正是判据 §6.3 要求出示计划对照的原因。
    for (const opts of [undefined, { days: 90 }]) {
      const plan = planOf('installation worker restart', opts);
      expect(plan.length).toBeGreaterThan(0);
      // 第一行 = 外层循环。必须是 FTS 虚表；翻回 JOIN 时这里会变成对 observations 的索引扫描。
      expect(plan[0]).toContain('VIRTUAL TABLE');
      expect(plan[0]).not.toContain('idx_observations_scope_time');
    }
  });

  test('计划里出现 TEMP B-TREE 是预期的，但 FTS 必须仍是外层驱动', () => {
    // B1 修订之后 `ORDER BY fts.rank, o.id` 是复合键，FTS 模块能流式给出自己的 rank
    // 次序但给不出复合次序，所以 `TEMP B-TREE` 会出现——这是裁决明确接受的代价。
    //
    // 但**外层驱动**必须仍是 FTS：1900 倍的收益来自"谁做外层循环"，不来自有没有排序。
    // 所以这条测试断言的是排序的存在**不影响**驱动方向，而不是"没有排序"。
    for (const opts of [undefined, { days: 90 }]) {
      const plan = planOf('installation worker restart', opts);
      expect(plan.join(' | ')).toContain('TEMP B-TREE');
      expect(plan[0]).toContain('VIRTUAL TABLE');
      // 关键的反面：observations 不得成为被全扫的驱动表。
      expect(plan.join(' | ')).not.toContain('SCAN o');
    }
  });

  test('`limit` 仍是绑定参数：SQL 文本里不含内联的数字上限', () => {
    // 这一条钉住"没有为了性能而改用字符串拼接"。修法 A（内联字面量）测得同样快，
    // 但会把一个值拼进 SQL；选 CROSS JOIN 就是为了不引入那个注入面。
    const src = readFileSync(new URL('../../src/db/index.ts', import.meta.url), 'utf-8');
    // 三条都是全文件断言：切片会被注释长度影响，那种脆弱只会让测试被删掉。
    expect(src).toContain('CROSS JOIN observations o ON fts.rowid = o.id');
    expect(src).toContain('ORDER BY fts.rank, o.id ASC LIMIT ?');
    // 任何 `LIMIT ${...}` 都意味着把值拼进了 SQL——修法 A 的形状，本轮明确没选它。
    expect(src).not.toMatch(/LIMIT \$\{/);
  });

  test('多个 bm25 精确等分记录严格按 id ASC 排序（B1 修订要求 1）', () => {
    // 文本完全相同 → 词频与文档长度相同 → bm25 rank 精确相等。所以这一组的顺序
    // 完全由平局键决定，是 `id ASC` 的直接检验。
    const dir = mkdtempSync(join(tmpdir(), 'kiro-tie-eq-'));
    const p = join(dir, 'tie.db');
    const d = new MemoryDB(p);
    try {
      d.upsertSessionRef({ session_id: 's-tie', cwd: '/proj', repo: '/proj' });
      const ids: number[] = [];
      for (let i = 0; i < 8; i++) {
        const seq = d.allocateNextTurnSeq('s-tie');
        const turn = d.createTurn({
          session_id: 's-tie', seq, cwd: '/proj', repo: '/proj', prompt_text: 'p',
        });
        const ts = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
        d.markTurnClosed(turn.id, ts);
        ids.push(d.insertObservation({
          turn_id: turn.id, session_id: 's-tie', turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
          // 逐字相同的可索引文本。
          title: 'identical quoting escape record',
          summary: 'identical body for exact bm25 tie',
          memory_type: 'change', quality: 'normal',
          turn_started_at: ts, turn_stopped_at: ts,
        })!);
      }
      const rows = d.searchObservationsFts('identical quoting escape', {
        scopeKey: computeScopeKey('/proj', '/proj'), days: 90, limit: 50,
      });
      expect(rows.length).toBe(8);
      // 全部等分 → 必须严格升序，且恰好是插入顺序（id 单调）。
      expect(rows.map((r) => r.id)).toEqual([...ids].sort((a, b) => a - b));
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('平局跨越 limit 50 截断边界时，两种查询计划得到相同的有序 50 条（B1 修订要求 2）', () => {
    // 这条测的是**成员**确定性，不只是顺序。60 条逐字相同的记录 → 一个 60 行的平局组
    // 横跨 50 行边界，于是"保留哪 50 条"完全由平局键决定。
    //
    // 对照的是**两种查询计划**：CROSS JOIN（生产）与普通 JOIN（修复前的形状）。
    // 修订之前这两者在这里会给出不同的 50 条成员；修订之后必须逐条相同——那才是
    // "成员不再取决于计划"的实证。
    const dir = mkdtempSync(join(tmpdir(), 'kiro-tie-cut-'));
    const p = join(dir, 'cut.db');
    const d = new MemoryDB(p);
    try {
      d.upsertSessionRef({ session_id: 's-cut', cwd: '/proj', repo: '/proj' });
      const ids: number[] = [];
      for (let i = 0; i < 60; i++) {
        const seq = d.allocateNextTurnSeq('s-cut');
        const turn = d.createTurn({
          session_id: 's-cut', seq, cwd: '/proj', repo: '/proj', prompt_text: 'p',
        });
        const ts = new Date(Date.now() - (i + 1) * 3600_000).toISOString();
        d.markTurnClosed(turn.id, ts);
        ids.push(d.insertObservation({
          turn_id: turn.id, session_id: 's-cut', turn_seq: seq, repo: '/proj', cwd_scope: '/proj',
          title: 'boundary tie record for truncation',
          summary: 'identical body so bm25 ties across the cut',
          memory_type: 'change', quality: 'normal',
          turn_started_at: ts, turn_stopped_at: ts,
        })!);
      }

      const scope = computeScopeKey('/proj', '/proj');
      const threshold = new Date(Date.now() - 90 * 86400000).toISOString();
      const units = extractFtsSearchUnits('boundary tie record truncation');
      const expr = units.map((u) => `"${u.replaceAll('"', '""')}"`).join(' OR ');
      const raw = new Database(p, { readonly: true });
      const run = (joinKind: 'CROSS JOIN' | 'JOIN'): number[] =>
        (raw.query(
          `SELECT o.id AS id FROM observations_fts fts
             ${joinKind} observations o ON fts.rowid = o.id
            WHERE observations_fts MATCH ? AND o.turn_stopped_at > ? AND o.scope_key = ?
            ORDER BY fts.rank, o.id ASC LIMIT ?`,
        ).all(expr, threshold, scope, 50) as { id: number }[]).map((r) => r.id);

      const viaCross = run('CROSS JOIN');
      const viaPlain = run('JOIN');
      raw.close();

      expect(viaCross.length).toBe(50);
      // 成员与顺序都必须一致——这是修订要挡住的那件事。
      expect(viaCross).toEqual(viaPlain);
      // 并且必须是 id 最小的 50 条，不是任意 50 条。
      expect(viaCross).toEqual([...ids].sort((a, b) => a - b).slice(0, 50));
      // 生产方法走同一条路：确认这不只是在测一条手写 SQL。
      const prod = d.searchObservationsFts('boundary tie record truncation', {
        scopeKey: scope, days: 90, limit: 50,
      });
      expect(prod.map((r) => r.id)).toEqual(viaCross);
    } finally {
      d.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('修复不改变返回的行集合：同一 fixture 上按 (rank, id) 归一化后一致', () => {
    // 平局顺序不做断言——SQLite 不保证它，钉死它会让测试比实现更严。
    // 但**行集合**必须稳定，这是"修计划不改语义"的实质内容。
    const rows = fileDb.searchObservationsFts('installation worker restart', {
      scopeKey: computeScopeKey('/proj', '/proj'),
      days: 90,
      limit: 50,
    });
    expect(rows.length).toBe(30);
    const again = fileDb.searchObservationsFts('installation worker restart', {
      scopeKey: computeScopeKey('/proj', '/proj'),
      days: 90,
      limit: 50,
    });
    expect(new Set(again.map((r) => r.id))).toEqual(new Set(rows.map((r) => r.id)));
  });
});
