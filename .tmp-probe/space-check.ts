import { readFileSync } from 'fs';
import { join } from 'path';
import { loadDataset, annotationToResult, annotationSearchText } from '../benchmark/dataset';
import { semanticEnSearchTextFields, type SemanticEnRecord } from '../src/semantic-en';
import { generateEmbedding, buildObservationSearchText, DIMENSIONS } from '../src/embedding';

const ds = loadDataset();
const primary = ds.turns.filter((t) => t.scope === 'primary');
const enRecords = JSON.parse(
  readFileSync(join('benchmark', 'dataset', 'mirror-en-acp-records.json'), 'utf-8'),
).records as Record<string, SemanticEnRecord>;

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0; for (let i = 0; i < DIMENSIONS; i++) s += a[i]! * b[i]!; return s;
};
const q = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))]!;

for (const space of ['semantic-en-v1', 'raw-v1'] as const) {
  const vecs: { id: string; v: Float32Array }[] = [];
  for (const t of primary) {
    const text = space === 'semantic-en-v1'
      ? buildObservationSearchText(semanticEnSearchTextFields(enRecords[t.id]!, annotationToResult(t.annotation).files_touched))
      : annotationSearchText(t.annotation);
    vecs.push({ id: t.id, v: await generateEmbedding(text) });
  }
  const pairs: { a: string; b: string; c: number }[] = [];
  for (let i = 0; i < vecs.length; i++)
    for (let j = i + 1; j < vecs.length; j++)
      pairs.push({ a: vecs[i]!.id, b: vecs[j]!.id, c: dot(vecs[i]!.v, vecs[j]!.v) });
  const cs = pairs.map((p) => p.c).sort((x, y) => x - y);
  const top = [...pairs].sort((x, y) => y.c - x.c).slice(0, 3);
  console.log(`\n[${space}] pairs=${cs.length}`);
  console.log(`  min ${cs[0]!.toFixed(3)}  p50 ${q(cs,0.5).toFixed(3)}  p90 ${q(cs,0.9).toFixed(3)}  p95 ${q(cs,0.95).toFixed(3)}  p99 ${q(cs,0.99).toFixed(3)}  max ${cs.at(-1)!.toFixed(3)}`);
  console.log(`  above 0.450: ${cs.filter((c) => c > 0.45).length}`);
  console.log(`  top3: ${top.map((t) => `${t.a}×${t.b} ${t.c.toFixed(3)}`).join('  ')}`);
}
