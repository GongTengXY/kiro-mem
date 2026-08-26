#!/usr/bin/env bun
/** 临时诊断：S4 里零命中的那批词面负例，锚点与单元 df 的实测。 */
import { MemoryDB, computeScopeKey, extractFtsSearchUnits } from '../src/db';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const db = new MemoryDB(join(process.env.TMPDIR ?? '/tmp', 'fts-round-f2.db'));
const raw = (db as unknown as { db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } } }).db;
const SCOPE = computeScopeKey('/fts-round/primary', '/fts-round/primary');
const qs = JSON.parse(readFileSync(join(import.meta.dir, 'dataset', 'queries-fts-round.json'), 'utf-8')).queries as any[];
const report = JSON.parse(readFileSync(join(import.meta.dir, 'reports', 'fts-round', 'f2-fixture.json'), 'utf-8'));
const bad = (report.s4.negatives as { id: string; ftsCount: number }[]).filter((n) => n.ftsCount < 1).map((n) => n.id);

const df = (u: string): number => (raw.query(
  `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o ON fts.rowid=o.id
     WHERE observations_fts MATCH ? AND o.scope_key = ?`,
).all(`"${u.replaceAll('"', '""')}"`, SCOPE) as { n: number }[])[0]!.n;
/** 锚点本身作为子串在语料里出现几次（绕过三字单元下限，回答"词在不在语料里"）。 */
const likeCount = (s: string): number => (raw.query(
  `SELECT count(*) AS n FROM observations WHERE scope_key = ?
     AND (title LIKE ? OR summary LIKE ? OR outcome LIKE ? OR learned LIKE ? OR concepts_json LIKE ?)`,
).all(SCOPE, `%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`) as { n: number }[])[0]!.n;

for (const id of bad) {
  const q = qs.find((x) => x.id === id)!;
  const units = extractFtsSearchUnits(q.query);
  console.log(`\n${id}  锚点「${q.lexical_anchor}」${q.lexical_anchor.length} 字，子串在语料出现 ${likeCount(q.lexical_anchor)} 行`);
  console.log(`  单元 ${units.length} 个：${units.map((u) => `${u}:${df(u)}`).join('  ')}`);
}
db.close();
