/**
 * Phase 3B 装置生成器：recall-scale 填充语料 + performance-scale 生成规则。
 *
 * 判据：`benchmark/reports/phase3b-criteria.md`（A0 + B1，冻结于本脚本第一次运行之前）。
 *
 * 产出的是**文本**而不是一个预建的 SQLite 文件，理由有两条，都不是风格问题：
 *
 *   1. 向量必须每次由生产路径现算。存一份 blob 意味着模型或 `buildObservationSearchText`
 *      改了之后，装置仍然安静地报告旧空间的读数——那正是 `embeddingSpaceKey` 存在要挡的事。
 *   2. 冻结物要能被人读、被 diff、被 checksum。50,000 条向量存下来是 73MB 二进制，
 *      复核者除了信任没有别的办法。
 *
 * performance-scale 同理不落盘：存的是 PRNG 种子和生成规则，10,000/50,000 条单位向量
 * 在测量时现生成。种子固定 → 逐位可复现。
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const DATASET_DIR = join(import.meta.dir, 'dataset');
const REPORTS_DIR = join(import.meta.dir, 'reports');
const FILLER_FILE = join(DATASET_DIR, 'phase3b-filler.json');
const META_FILE = join(DATASET_DIR, 'phase3b-fixture-meta.json');

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const stage = arg('stage') ?? 'full';

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// 判据 §3.4 修订 B1：禁用词表（机械导出，不手工挑选）
// ---------------------------------------------------------------------------
//
// 手工挑选的禁用表是不可复核的——读者无法判断某个词是"漏了"还是"故意放过"。所以两个
// 来源都从既有数据集里按规则算出来：
//
//   独特 concept  = 含空格 / 含大写 / 含 _ - 数字
//   文件基名      = 标注里 key_files 的 basename
//
// 通用单词按 B1 有意放过：共享通用词会**提高**噪声压力，让 §6.2 的误召回读数更严。

interface EnRecord {
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
}

function bannedTerms(): { distinctive: string[]; fileBasenames: string[] } {
  const mirror = JSON.parse(
    readFileSync(join(DATASET_DIR, 'mirror-en-acp-records.json'), 'utf-8'),
  ) as { records?: Record<string, EnRecord> };
  const concepts = new Set<string>();
  for (const r of Object.values(mirror.records ?? {})) {
    for (const c of r.concepts ?? []) concepts.add(c);
  }
  const isDistinctive = (c: string): boolean =>
    /\s/.test(c) || /[A-Z]/.test(c) || /[_\-0-9]/.test(c);

  const turns = JSON.parse(readFileSync(join(DATASET_DIR, 'turns.json'), 'utf-8')) as {
    annotation?: { key_files?: string[] };
  }[];
  const basenames = new Set<string>();
  for (const t of turns) {
    for (const f of t.annotation?.key_files ?? []) {
      const base = f.split('/').pop();
      if (base && base.length >= 4) basenames.add(base);
    }
  }
  return {
    distinctive: [...concepts].filter(isDistinctive).sort(),
    fileBasenames: [...basenames].sort(),
  };
}

// ---------------------------------------------------------------------------
// 主题表（判据 §3.4 第 2 条：与本项目 26 条 Observation 的题材不相交）
// ---------------------------------------------------------------------------
//
// 每个域给出自己的名词/组件/动作/结论词库。不共用词库是刻意的：共用会让 2,000 条填充
// 在向量空间里挤成一团，于是"最近 200 条"里的噪声上限被人为压低。

interface Domain {
  key: string;
  area: string;
  components: string[];
  subjects: string[];
  actions: string[];
  outcomes: string[];
  lessons: string[];
  files: string[];
}

const DOMAINS: Domain[] = [
  {
    key: 'android-ui',
    area: 'Android UI',
    components: ['RecyclerView', 'ConstraintLayout', 'ViewPager2', 'BottomSheet', 'MotionLayout'],
    subjects: ['list scrolling jank', 'nested touch conflicts', 'view recycling', 'gesture dispatch', 'dark theme colors'],
    actions: ['reworked the adapter diffing', 'moved layout passes off the main thread', 'replaced the custom touch handler', 'cached measured heights', 'switched to a themed attribute'],
    outcomes: ['frame drops fell from 12 per screen to 1', 'the janky frame ratio dropped below two percent', 'touch events now reach the child first', 'the layout pass no longer runs twice'],
    lessons: ['measuring twice per frame is what made the list stutter', 'a custom touch handler must return false to keep the chain alive', 'hardcoded colors break every theme switch'],
    files: ['app/ui/FeedAdapter.kt', 'app/ui/FeedFragment.kt', 'app/res/layout/feed_item.xml'],
  },
  {
    key: 'game-render',
    area: 'game engine rendering',
    components: ['shadow cascade', 'sprite batcher', 'particle emitter', 'shader cache', 'occlusion culler'],
    subjects: ['draw call spikes', 'shadow acne on sloped ground', 'texture atlas seams', 'GPU stalls at level load', 'overdraw in transparent layers'],
    actions: ['merged the batches by material', 'tuned the depth bias per cascade', 'padded the atlas cells', 'warmed the shader cache during the loading screen', 'sorted the transparent queue back to front'],
    outcomes: ['draw calls dropped from 2400 to 380', 'shadow acne disappeared at every camera angle', 'the seam artifacts are gone at mip level 3', 'level load no longer freezes for two seconds'],
    lessons: ['batching by texture instead of material was the wrong key', 'a single depth bias cannot serve four cascades', 'atlas padding has to survive mipmapping'],
    files: ['engine/render/Batcher.cpp', 'engine/render/ShadowPass.cpp', 'engine/shaders/particle.frag'],
  },
  {
    key: 'payment-settle',
    area: 'payment settlement',
    components: ['ledger writer', 'reconciliation runner', 'refund pipeline', 'currency rounding', 'chargeback handler'],
    subjects: ['penny mismatches at month end', 'duplicate refunds', 'rounding drift across currencies', 'a settlement file rejected by the bank', 'late chargeback records'],
    actions: ['switched the amounts to integer minor units', 'made the refund idempotent on the provider reference', 'aligned the rounding mode with the bank spec', 'regenerated the settlement file with the fixed record length'],
    outcomes: ['month end reconciliation closed with zero variance', 'duplicate refunds went to zero over 30 days', 'the drift no longer accumulates past one minor unit'],
    lessons: ['floating point amounts cannot survive a reconciliation', 'the provider reference is the only stable idempotency key', 'the bank spec fixes record length, not just field order'],
    files: ['settle/ledger.go', 'settle/reconcile.go', 'settle/format/bankfile.go'],
  },
  {
    key: 'k8s-operator',
    area: 'Kubernetes operator',
    components: ['reconcile loop', 'admission webhook', 'custom resource', 'leader election', 'status subresource'],
    subjects: ['a hot reconcile loop', 'stale resource versions', 'webhook timeouts during rollout', 'two replicas both acting as leader', 'status flapping between phases'],
    actions: ['added a resync backoff', 'requeued on conflict instead of erroring', 'raised the webhook timeout and made it fail open for reads', 'shortened the lease renew deadline', 'wrote the status only when the observed generation changed'],
    outcomes: ['reconcile rate fell from 400 per minute to 6', 'conflict errors stopped appearing in the logs', 'rollout no longer blocks on the webhook'],
    lessons: ['a conflict is a normal outcome and must be requeued, not surfaced', 'a webhook on the read path becomes an availability dependency', 'writing status unconditionally makes its own next event'],
    files: ['controllers/cluster_controller.go', 'webhooks/validate.go', 'api/v1alpha1/types.go'],
  },
  {
    key: 'ios-build',
    area: 'iOS build pipeline',
    components: ['code signing step', 'archive action', 'dependency resolver', 'bitcode stripper', 'simulator matrix'],
    subjects: ['provisioning profile drift', 'archive failures on the runner only', 'a resolver picking the wrong minor version', 'ballooning artifact size', 'flaky simulator boots'],
    actions: ['pinned the profile by UUID', 'made the runner import the keychain before the archive step', 'locked the resolver to an exact version', 'stripped debug symbols into a separate artifact', 'serialized the simulator boots'],
    outcomes: ['signing failures dropped to zero across 40 builds', 'artifact size fell from 180MB to 62MB', 'simulator flakes went from one in three to none in fifty'],
    lessons: ['a profile matched by name silently picks a different one after renewal', 'the runner keychain is not the developer keychain', 'parallel simulator boots contend on one daemon'],
    files: ['fastlane/Fastfile', 'ci/sign.sh', 'Package.resolved'],
  },
  {
    key: 'warehouse-etl',
    area: 'data warehouse ETL',
    components: ['partition writer', 'schema evolver', 'late arrival buffer', 'dedupe stage', 'backfill runner'],
    subjects: ['skewed partitions', 'a column type widening mid stream', 'events arriving a day late', 'duplicate rows after a retry', 'a backfill overrunning its window'],
    actions: ['salted the partition key', 'made the evolver widen instead of reject', 'held late events in a side buffer for 48 hours', 'deduped on the source event identifier', 'chunked the backfill by day'],
    outcomes: ['the longest partition task fell from 40 minutes to 4', 'schema changes stopped failing the nightly run', 'late events now land in the right partition'],
    lessons: ['a natural key with heavy skew needs salting, not more workers', 'widening is compatible, narrowing is not', 'a retry without an event identifier always duplicates'],
    files: ['pipelines/ingest.py', 'pipelines/schema.py', 'pipelines/backfill.py'],
  },
  {
    key: 'css-layout',
    area: 'CSS layout',
    components: ['grid template', 'flex container', 'sticky header', 'container query', 'aspect ratio box'],
    subjects: ['a collapsing margin', 'sticky header jumping on scroll', 'grid items overflowing on narrow screens', 'inconsistent line heights', 'a stretched hero image'],
    actions: ['replaced the float with a grid template', 'gave the sticky element its own containing block', 'switched the track sizing to minmax', 'set a single line height on the root', 'used an aspect ratio box instead of fixed heights'],
    outcomes: ['the layout holds from 320 to 2560 pixels wide', 'the header no longer shifts by one pixel per scroll tick', 'no horizontal scrollbar at any breakpoint'],
    lessons: ['a sticky child of an overflow container never sticks', 'minmax with auto is not the same as fr', 'fixed heights and responsive images do not coexist'],
    files: ['styles/layout.css', 'styles/tokens.css', 'components/Hero.tsx'],
  },
  {
    key: 'bluetooth',
    area: 'Bluetooth protocol stack',
    components: ['GATT server', 'pairing agent', 'connection interval negotiator', 'notification queue', 'advertising rotator'],
    subjects: ['dropped notifications under load', 'pairing failing on one phone model', 'battery drain from a short connection interval', 'an advertising packet exceeding the payload limit', 'reconnect storms after suspend'],
    actions: ['bounded the notification queue and dropped oldest', 'added the legacy pairing fallback', 'negotiated a longer interval when idle', 'moved the service data into the scan response', 'added jitter to the reconnect backoff'],
    outcomes: ['notification loss fell from 8 percent to under 0.5', 'pairing now succeeds on all 14 test devices', 'idle current dropped from 4mA to 0.9mA'],
    lessons: ['an unbounded notification queue turns latency into memory growth', 'one vendor still requires the legacy pairing path', 'the advertising payload is 31 bytes, not 31 characters'],
    files: ['firmware/gatt_server.c', 'firmware/pairing.c', 'firmware/advert.c'],
  },
  {
    key: 'map-tiles',
    area: 'map tile serving',
    components: ['tile cache', 'vector tile encoder', 'label collision solver', 'zoom pyramid builder', 'style resolver'],
    subjects: ['cache misses at popular zoom levels', 'labels overlapping at zoom 14', 'oversized vector tiles', 'seams between adjacent tiles', 'a style rule applying at the wrong zoom'],
    actions: ['pre-rendered the top three zoom levels', 'ran the collision solver per tile with a shared margin', 'simplified geometry per zoom', 'buffered the tile clip by 64 units', 'moved the zoom bounds into the style spec'],
    outcomes: ['cache hit ratio rose from 61 to 94 percent', 'label overlap disappeared at every zoom', 'the 95th percentile tile size fell from 480KB to 90KB'],
    lessons: ['a shared collision margin is what keeps labels aligned across tiles', 'geometry simplification must be per zoom, not global', 'clipping without a buffer produces visible seams'],
    files: ['tiles/cache.rs', 'tiles/encode.rs', 'tiles/labels.rs'],
  },
  {
    key: 'reco-ranking',
    area: 'recommendation ranking',
    components: ['feature store', 'candidate generator', 'ranker model', 'diversity reranker', 'unseen item handler'],
    subjects: ['training and serving features disagreeing', 'popularity dominating the top slots', 'a new item never being shown', 'stale features after a schema change', 'oscillating recommendations between refreshes'],
    actions: ['unified the feature transform between offline and online', 'added a diversity penalty on the same publisher', 'reserved two slots for unseen items', 'versioned the feature schema', 'anchored the ordering on a stable tiebreaker'],
    outcomes: ['offline and online scores now agree within 0.001', 'the top five no longer come from one publisher', 'new items reach first impression within an hour'],
    lessons: ['two implementations of one transform is the whole skew problem', 'diversity has to be a penalty in the objective, not a filter after it', 'without a stable tiebreaker equal scores reorder on every request'],
    files: ['ranking/features.py', 'ranking/candidates.py', 'ranking/rerank.py'],
  },
  {
    key: 'video-encode',
    area: 'video encoding',
    components: ['bitrate ladder', 'keyframe placer', 'audio muxer', 'thumbnail extractor', 'hardware encoder path'],
    subjects: ['banding in dark scenes', 'audio drift over long files', 'keyframes landing off scene cuts', 'a ladder rung nobody selects', 'hardware encoder falling back silently'],
    actions: ['raised the bit depth for the low bitrate rungs', 'resampled audio against the video clock', 'ran scene detection before keyframe placement', 'removed the unused rung', 'made the fallback loud instead of silent'],
    outcomes: ['banding is gone below 800kbps', 'audio drift over a two hour file fell under 20ms', 'seek accuracy improved to within one frame'],
    lessons: ['banding is a bit depth problem before it is a bitrate problem', 'two clocks always drift, one clock cannot', 'a silent hardware fallback hides a tenfold cost change'],
    files: ['transcode/ladder.py', 'transcode/keyframes.py', 'transcode/mux.py'],
  },
  {
    key: 'warehouse-robot',
    area: 'warehouse robotics',
    components: ['path planner', 'battery scheduler', 'pick arm controller', 'traffic manager', 'shelf localizer'],
    subjects: ['two robots deadlocking in a narrow aisle', 'a pick arm overshooting on heavy items', 'robots queuing at the charger', 'shelf drift after a collision', 'planner thrashing near a blocked lane'],
    actions: ['gave the aisle a directional reservation', 'added mass estimation before the pick motion', 'staggered the charge windows', 'recalibrated localization against floor markers', 'added hysteresis to the replan trigger'],
    outcomes: ['aisle deadlocks dropped from 5 per shift to zero', 'overshoot on heavy items fell within tolerance', 'charger queue length stays under two robots'],
    lessons: ['a narrow aisle needs a reservation, not a better planner', 'the arm profile depends on mass, which nobody was measuring', 'replanning without hysteresis oscillates forever'],
    files: ['robot/planner.cpp', 'robot/arm.cpp', 'robot/traffic.cpp'],
  },
  {
    key: 'email-delivery',
    area: 'transactional email delivery',
    components: ['bounce processor', 'domain reputation tracker', 'template renderer', 'suppression list', 'warmup scheduler'],
    subjects: ['soft bounces treated as hard', 'a template breaking in one mail client', 'reputation dropping after a campaign', 'suppressed addresses still receiving mail', 'warmup ramping too fast for a new domain'],
    actions: ['split the bounce classes by response code', 'inlined the styles for the legacy client', 'throttled the campaign by domain', 'checked suppression at send time rather than queue time', 'slowed the ramp to a fixed daily curve'],
    outcomes: ['recoverable addresses stopped being permanently suppressed', 'the template renders correctly in all nine clients', 'reputation recovered within four days'],
    lessons: ['a soft bounce is not a hard bounce and the code says which', 'queue time suppression checks are always stale by the time of send', 'one legacy client still needs inline styles'],
    files: ['mail/bounce.rb', 'mail/render.rb', 'mail/warmup.rb'],
  },
  {
    key: 'audio-dsp',
    area: 'audio DSP',
    components: ['echo canceller', 'noise gate', 'resampler', 'limiter', 'voice activity detector'],
    subjects: ['echo returning on speakerphone', 'the gate clipping soft speech', 'aliasing after resampling', 'pumping from an aggressive limiter', 'voice detection failing on whispers'],
    actions: ['extended the filter tail length', 'added a hysteresis window to the gate', 'moved to a polyphase resampler', 'lengthened the release time', 'lowered the detector threshold with a longer hangover'],
    outcomes: ['echo return loss improved by 11dB', 'soft speech survives the gate at every tested level', 'aliasing artifacts are below the noise floor'],
    lessons: ['a short filter tail cannot cancel a long room', 'a gate without hysteresis chatters on every syllable', 'linear interpolation is not a resampler'],
    files: ['dsp/aec.c', 'dsp/gate.c', 'dsp/resample.c'],
  },
  {
    key: 'iot-fleet',
    area: 'IoT fleet management',
    components: ['firmware rollout controller', 'telemetry batcher', 'device shadow', 'certificate rotator', 'offline queue'],
    subjects: ['a rollout bricking one hardware revision', 'telemetry costs from tiny frequent payloads', 'shadow state diverging from the device', 'certificates expiring in the field', 'an offline queue filling flash'],
    actions: ['gated the rollout on hardware revision', 'batched telemetry into 60 second windows', 'made the device the authority on its own state', 'rotated certificates 30 days before expiry', 'bounded the offline queue with oldest-first eviction'],
    outcomes: ['no bricked devices across a 40,000 unit rollout', 'telemetry egress cost fell by 78 percent', 'shadow divergence reports dropped to zero'],
    lessons: ['one firmware image per hardware revision is not optional', 'per-message overhead dominates when payloads are tiny', 'the cloud is never the authority on physical state'],
    files: ['fleet/rollout.ts', 'fleet/telemetry.ts', 'fleet/shadow.ts'],
  },
];

// ---------------------------------------------------------------------------
// 确定性 PRNG（mulberry32）
// ---------------------------------------------------------------------------
//
// 不用 Math.random：装置必须逐位可复现，否则"填充里最高 cosine 是多少"这个读数每次
// 运行都不一样，而它是 §3.4 第 4 条要求披露的数字。

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILLER_SEED = 0x3b0000;
const FILLER_COUNT = 1970;

interface FillerRecord {
  id: string;
  domain: string;
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
  files: string[];
}

function generateFiller(count: number, seed: number): FillerRecord[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const out: FillerRecord[] = [];
  for (let i = 0; i < count; i++) {
    const d = DOMAINS[i % DOMAINS.length]!;
    const component = pick(d.components);
    const subject = pick(d.subjects);
    const action = pick(d.actions);
    const outcome = pick(d.outcomes);
    const lesson = pick(d.lessons);
    const other = pick(d.components.filter((c) => c !== component));
    // 序号进标题：2,000 条里必须条条不同，否则重复文本会共享向量，
    // "池里有多少条可比向量"就不再等于"池里有多少条记录"。
    //
    // 写成 `04-01` 而不是 `0401`：本项目的 concept 里有 `401`（HTTP 状态码）和 `0600`
    // （文件权限位），而词面规则是子串匹配。连续四位数字会让 f0401 / f0600 撞上它们——
    // 那是我的编号造成的假阳性，不是题材重叠。断开数字连续段即消除，同时保留可读性。
    // 不放宽规则去迁就编号：规则本身没错，撞的是编号格式。
    const n = `${String(Math.floor(i / 100)).padStart(2, '0')}-${String(i % 100).padStart(2, '0')}`;
    out.push({
      id: `f${String(i).padStart(4, '0')}`,
      domain: d.key,
      title: `${d.area} case ${n}: ${subject} in the ${component}`,
      summary:
        `Case ${n} in the ${d.area} area. The reported problem was ${subject}, traced to the ` +
        `${component} and its interaction with the ${other}. We ${action} and verified the ` +
        `result on the ${d.area} test bench.`,
      outcome: `${outcome} (case ${n}).`,
      learned: `${lesson} Recorded from ${d.area} case ${n}.`,
      concepts: [d.area, component, other, subject],
      files: d.files,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 词面规则检查（判据 §3.4 修订 B1）
// ---------------------------------------------------------------------------

function checkLexicalRule(
  records: FillerRecord[],
  banned: { distinctive: string[]; fileBasenames: string[] },
): string[] {
  const violations: string[] = [];
  const terms = [
    ...banned.distinctive.map((t) => ({ term: t, kind: 'concept' })),
    ...banned.fileBasenames.map((t) => ({ term: t, kind: 'file' })),
  ];
  for (const r of records) {
    const text = [r.title, r.summary, r.outcome, r.learned, ...r.concepts, ...r.files]
      .join('\n')
      .toLowerCase();
    for (const { term, kind } of terms) {
      if (text.includes(term.toLowerCase())) {
        violations.push(`${r.id}: 命中禁用${kind === 'concept' ? '独特词' : '文件基名'}「${term}」`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

const banned = bannedTerms();
console.log(
  `[3b] 禁用词表：独特 concept ${banned.distinctive.length} 条，文件基名 ${banned.fileBasenames.length} 条`,
);

if (stage === 'filler' || stage === 'full') {
  if (existsSync(META_FILE)) {
    const meta = JSON.parse(readFileSync(META_FILE, 'utf-8')) as { frozen?: boolean };
    if (meta.frozen) {
      console.error(
        '[3b] 装置已冻结（phase3b-fixture-meta.json frozen=true）。' +
          '重新生成会让已发布读数失去对应的输入——先显式删除 meta 文件再跑。',
      );
      process.exit(2);
    }
  }

  const filler = generateFiller(FILLER_COUNT, FILLER_SEED);
  const violations = checkLexicalRule(filler, banned);
  if (violations.length) {
    console.error(`[3b] 词面规则不通过，${violations.length} 处：`);
    for (const v of violations.slice(0, 20)) console.error(`  ${v}`);
    // 生成规则违反判据时不落盘。落盘再修等于让"先冻结规则"这句话失效。
    process.exit(2);
  }
  const titles = new Set(filler.map((f) => f.title));
  if (titles.size !== filler.length) {
    console.error(`[3b] 标题不唯一：${filler.length} 条里只有 ${titles.size} 个不同标题`);
    process.exit(2);
  }
  writeFileSync(FILLER_FILE, `${JSON.stringify(filler, null, 2)}\n`);
  console.log(`[3b] 填充语料已写出：${filler.length} 条，${DOMAINS.length} 个主题域，词面规则 0 违反`);
}

/**
 * 候选池轮次的性能补证装置（判据 §12.2，裁定要求）。
 *
 * 沿用**同一个** `generateFiller` 与 `checkLexicalRule`——这是"同一套规则"唯一站得住的
 * 实现方式，复制一份生成器会立刻变成第二个真相源。只改 `count` 与 seed，写到独立文件，
 * 不触碰 3B 已冻结的 `phase3b-filler.json`。
 */
if (stage === 'filler10k') {
  const COUNT = Number(arg('count') ?? 10000);
  const OUT = join(DATASET_DIR, 'pool-policy-filler-10k.json');
  const META_OUT = join(DATASET_DIR, 'pool-policy-filler-10k-meta.json');
  if (existsSync(META_OUT)) {
    const m = JSON.parse(readFileSync(META_OUT, 'utf-8')) as { frozen?: boolean };
    if (m.frozen) {
      console.error('[3b] 补证装置已冻结，重新生成会让已发布读数失去对应输入——先显式删除 meta 再跑。');
      process.exit(2);
    }
  }
  // seed 与 3B 的 filler seed 不同：两份语料必须可区分，否则前 1,970 条会逐字相同，
  // "10,000 条各不相同的真实向量"这句话就要打折。
  const filler = generateFiller(COUNT, FILLER_SEED + 0x10000);
  const violations = checkLexicalRule(filler, banned);
  if (violations.length) {
    console.error(`[3b] 词面规则不通过，${violations.length} 处：`);
    for (const v of violations.slice(0, 20)) console.error(`  ${v}`);
    process.exit(2);
  }
  const titles = new Set(filler.map((f) => f.title));
  if (titles.size !== filler.length) {
    console.error(`[3b] 标题不唯一：${filler.length} 条里只有 ${titles.size} 个不同标题`);
    process.exit(2);
  }
  const raw = `${JSON.stringify(filler, null, 2)}\n`;
  writeFileSync(OUT, raw);
  writeFileSync(
    META_OUT,
    `${JSON.stringify(
      {
        frozen: true,
        frozenAt: new Date().toISOString(),
        criteria: 'benchmark/reports/pool-policy-criteria.md §12（B2）',
        purpose: '性能门补证：真实 cosine 分布 + 确定性回放到 50,000 候选',
        count: filler.length,
        seed: FILLER_SEED + 0x10000,
        domains: DOMAINS.length,
        rulesSameAs: 'phase3b-criteria.md §3.4（B1）：78 独特 concept + 33 文件基名禁用表',
        lexicalViolations: 0,
        uniqueTitles: titles.size,
        builderScriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
        fillerSha256: sha16(raw),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `[3b] 补证填充已写出并冻结：${filler.length} 条，${DOMAINS.length} 个主题域，` +
      `词面规则 0 违反，标题全唯一，sha16=${sha16(raw)}`,
  );
}

if (stage === 'freeze' || stage === 'full') {
  const fillerRaw = readFileSync(FILLER_FILE, 'utf-8');
  const filler = JSON.parse(fillerRaw) as FillerRecord[];
  const byDomain: Record<string, number> = {};
  for (const f of filler) byDomain[f.domain] = (byDomain[f.domain] ?? 0) + 1;

  const meta = {
    frozen: true,
    frozenAt: new Date().toISOString(),
    criteria: 'benchmark/reports/phase3b-criteria.md (A0 + B1)',
    builderScriptSha256: sha16(readFileSync(import.meta.path, 'utf-8')),
    recallScale: {
      totalRecords: 30 + filler.length,
      targets: {
        count: 30,
        source: 'benchmark/dataset/turns.json + mirror-en-acp-records.json（既有真实记录，不重译）',
        note: '目标置于时间轴最老端；填充全部更新',
      },
      filler: {
        count: filler.length,
        file: 'benchmark/dataset/phase3b-filler.json',
        sha256: sha16(fillerRaw),
        seed: FILLER_SEED,
        prng: 'mulberry32',
        domains: DOMAINS.length,
        byDomain,
      },
      lexicalRule: {
        rule: 'B1：禁独特 concept + 禁文件基名；通用单词有意放过',
        bannedDistinctive: banned.distinctive.length,
        bannedFileBasenames: banned.fileBasenames.length,
        violations: 0,
      },
    },
    performanceScale: {
      sizes: [10000, 50000],
      vectors: 'random unit vectors, 384 dims, L2 normalized',
      prng: 'mulberry32',
      seed: 0x3b1000,
      note: '不落盘：种子 + 规则可逐位复现 73MB 二进制不可复核',
    },
  };
  writeFileSync(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`[3b] 装置已冻结：filler sha256=${meta.recallScale.filler.sha256}`);
  console.log(`[3b] meta: ${META_FILE}`);

  // 判据 §3.4 的禁用词表也落一份档，否则"0 违反"这个读数没有对应的输入。
  writeFileSync(
    join(REPORTS_DIR, 'phase3b-banned-terms.json'),
    `${JSON.stringify(banned, null, 2)}\n`,
  );
}
