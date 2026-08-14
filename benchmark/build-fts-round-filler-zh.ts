#!/usr/bin/env bun
/**
 * FTS 安全策略轮次 F1：**中文词面 filler 语料**生成器。
 *
 * 判据：`benchmark/reports/fts-round/f1-criteria.md`（r2）§3.1 / §3.1.1
 *
 * 为什么必须有它：F0-1 实测 P3 装置的 filler **含中文 0 / 10,000**，中文 query 的词面竞争池
 * 只有 66 行，所以 df / bm25 / 截断三类读数在那个装置上都不是生产规模读数。
 * 没有这份语料，V1 / V2 扫出来的任何取值都不可外推。
 *
 * 三条形状约束（判据 §3.1）：
 *
 *  1. **中文正文进 FTS**，同一套模板的**英文面**进 `semantic-en-v1` 向量空间——
 *     与生产同构（中文 Observation + 英文 semantic text），且**不调 ACP**：它是 filler 不是 gold；
 *  2. **功能词占比预登记**（§3.1.1 的 8 个词），实测偏差由 S3 逐词核对，
 *     防的是"语料被网格刻度反向塑造"；
 *  3. **禁用表**沿用 `phase3b-criteria.md` §3.4：不得与 gold 记录共享标识性 concept /
 *     文件基名。检查在本脚本内跑一次（对当前可见的 gold），冻结与 F2 再跑一次全量。
 *
 * 用法：
 *   bun run benchmark/build-fts-round-filler-zh.ts               # 生成 + 自检
 *   bun run benchmark/build-fts-round-filler-zh.ts --check       # 只对已存在的语料跑自检
 *   bun run benchmark/build-fts-round-filler-zh.ts --gold=<path> # 追加一份 gold 参与禁用表检查
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATASET_DIR = join(import.meta.dir, 'dataset');
const CORPUS_FILE = join(DATASET_DIR, 'fts-round-filler-zh-10k.json');
const META_FILE = join(DATASET_DIR, 'fts-round-filler-zh-10k-meta.json');

const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const has = (n: string): boolean => process.argv.includes(`--${n}`);
const die = (m: string): never => { console.error(`[filler-zh] ✗ ${m}`); process.exit(1); };
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// 0. 规模与随机源
// ---------------------------------------------------------------------------
const COUNT = 10_000;
/** 单一 seed，写进 meta 并随语料冻结。逐位可复现是自证的前提。 */
const SEED = 0xf1_2026;

/** 确定性 PRNG（mulberry32），与英文 filler 同一实现，不用 Math.random。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 1. 功能词与预登记占比（判据 §3.1.1，冻结后不得反向塑造）
// ---------------------------------------------------------------------------
//
// 注入方式是"恰好 N 条"而不是"按概率投硬币"：概率注入的实测占比每次都不一样，
// S3 的 ±20% 核对就变成了在核对随机波动。目标条数 = round(share × COUNT)。
//
// **每个词给三个变体**，理由是 df 预演暴露出来的保真度问题：单一固定片段会让片段内所有
// 3 字窗口的 df **完全相同**（`能不能` / `不能不` / `能不动` / `解决掉` 全是 1000），
// 因为它们永远同时出现。那会让 V2 看起来比现实干净——丢掉一个高 df 单元等于丢掉一整个
// 完全相关的块。三变体把周边窗口的 df 摊成约 1/3，而**词本身的计数仍然精确**。
const FUNCTION_WORDS: { word: string; share: number; fragments: string[]; enFragments: string[] }[] = [
  {
    word: '能不能', share: 0.10,
    fragments: [
      '当时先问的是能不能不动硬件就把这件事压下去。',
      '现场问过一句：能不能先按老办法顶两天。',
      '争论点是能不能只改一处就够。',
    ],
    enFragments: [
      'The first question was whether this could be solved without touching the hardware.',
      'Someone on site asked whether the old procedure could hold for two more days.',
      'The argument was whether changing one place would be enough.',
    ],
  },
  {
    word: '有没有', share: 0.10,
    fragments: [
      '复盘时排查了有没有别的班次也受同样影响。',
      '顺手查了有没有类似记录被漏掉。',
      '先看有没有更早的告警被当成噪声。',
    ],
    enFragments: [
      'The review checked whether other shifts were affected the same way.',
      'We also checked whether similar records had been missed.',
      'We first looked for earlier alarms dismissed as noise.',
    ],
  },
  {
    word: '是不是', share: 0.08,
    fragments: [
      '先确认了是不是同一批设备都有这个表现。',
      '需要判断是不是天气造成的偶发。',
      '核对了是不是上一版参数没同步。',
    ],
    enFragments: [
      'We first confirmed whether the whole device batch behaved this way.',
      'We had to judge whether the weather made it a one-off.',
      'We checked whether the previous parameter set had not been synced.',
    ],
  },
  {
    word: '为什么', share: 0.08,
    fragments: [
      '记录了为什么最后选了这套做法而不是更省事的那套。',
      '补了一段为什么之前的判据不适用。',
      '写清为什么这次没有沿用去年的方案。',
    ],
    enFragments: [
      'We recorded why this approach was chosen over the cheaper one.',
      'We added a note on why the earlier criterion did not apply.',
      "We wrote down why last year's plan was not reused.",
    ],
  },
  {
    word: '的时候', share: 0.25,
    fragments: [
      '交接班的时候最容易漏掉这一步。',
      '雨季来的时候这套参数要重调。',
      '人手最紧的时候这条流程最先崩。',
    ],
    enFragments: [
      'This step is most often missed during shift handover.',
      'These parameters need retuning when the rainy season arrives.',
      'This procedure breaks first when staffing is tightest.',
    ],
  },
  {
    word: '的模型', share: 0.05,
    fragments: [
      '预测用的模型换过一次参数，口径随之更新。',
      '排产用的模型只按历史均值走，遇到突发就偏。',
      '估算用的模型没考虑季节项。',
    ],
    enFragments: [
      'The forecasting model had its parameters changed once, and the metric definition followed.',
      'The scheduling model follows historical averages only and drifts under sudden load.',
      'The estimation model left out the seasonal term.',
    ],
  },
  {
    word: '会不会', share: 0.06,
    fragments: [
      '上线前评估过会不会影响夜间作业。',
      '担心的是会不会把问题推到下游。',
      '算过一遍会不会超出现有产能。',
    ],
    enFragments: [
      'Before rollout we assessed whether night operations would be affected.',
      'The worry was whether it pushed the problem downstream.',
      'We worked out whether it would exceed current capacity.',
    ],
  },
  {
    word: '什么时候', share: 0.05,
    fragments: [
      '补了一条什么时候该人工介入的判断标准。',
      '写明什么时候可以跳过复核。',
      '定了什么时候必须停线检查。',
    ],
    enFragments: [
      'We added a rule for when a human should step in.',
      'We spelled out when the review can be skipped.',
      'We set when the line must stop for inspection.',
    ],
  },
];

// ---------------------------------------------------------------------------
// 2. 领域表：题材必须与本项目（记忆 / 检索 / 向量 / 压缩）不相交
// ---------------------------------------------------------------------------
//
// 每个域自带词库，不共用——共用会让 10,000 条在向量空间里挤成一团，
// 于是"语料里最高 cosine 是多少"这个读数被人为压低（与英文 filler 同一条理由）。
//
// 中文面进 FTS，英文面进向量空间，两面**同一条模板**，因此镜像不需要 ACP。
interface Domain {
  key: string;
  area: string; areaEn: string;
  components: string[]; componentsEn: string[];
  subjects: string[]; subjectsEn: string[];
  actions: string[]; actionsEn: string[];
  outcomes: string[]; outcomesEn: string[];
  lessons: string[]; lessonsEn: string[];
  files: string[];
}

const DOMAINS: Domain[] = [
  {
    key: 'irrigation', area: '农田灌溉', areaEn: 'Farm irrigation',
    components: ['干管阀组', '土壤湿度探头', '首部过滤器', '轮灌轮次表', '田间气象站'],
    componentsEn: ['main valve group', 'soil moisture probe', 'head filter', 'rotation table', 'field weather station'],
    subjects: ['末端压力不足', '探头读数漂移', '过滤器堵塞频繁', '轮次冲突', '雨后误启动'],
    subjectsEn: ['insufficient tail pressure', 'probe reading drift', 'frequent filter clogging', 'rotation conflicts', 'false start after rain'],
    actions: ['把轮次表按地块高差重排了一遍', '给探头加了两点标定', '把反冲洗周期改成按压差触发', '在首部加了旁通', '把雨量判据从日累计改成小时累计'],
    actionsEn: ['reordered the rotation table by plot elevation', 'added two-point calibration to the probe', 'switched backwash to differential-pressure triggering', 'added a bypass at the head', 'changed the rain criterion from daily to hourly'],
    outcomes: ['末端压力从 0.12 兆帕回到 0.19 兆帕', '同一地块两次读数差降到 2% 以内', '反冲洗次数每天从 9 次降到 3 次', '轮次冲突当季清零'],
    outcomesEn: ['tail pressure recovered from 0.12 MPa to 0.19 MPa', 'the gap between two readings on the same plot fell under 2%', 'daily backwash count dropped from 9 to 3', 'rotation conflicts fell to zero for the season'],
    lessons: ['地块高差比管径更能解释末端压力', '探头标定必须两点，单点标定掩盖零漂'],
    lessonsEn: ['plot elevation explains tail pressure better than pipe diameter', 'probes need two-point calibration; one point hides zero drift'],
    files: ['irrigation-rotation.csv', 'valve-group.yaml'],
  },
  {
    key: 'hospital-shift', area: '医院排班', areaEn: 'Hospital rostering',
    components: ['夜班组', '值班表模板', '换班申请单', '科室人力池', '加班台账'],
    componentsEn: ['night shift group', 'roster template', 'swap request form', 'department staffing pool', 'overtime ledger'],
    subjects: ['连班超时', '换班链断裂', '人力池调用越界', '节假日缺口', '台账与打卡不符'],
    subjectsEn: ['back-to-back shift overrun', 'broken swap chain', 'out-of-scope pool borrowing', 'holiday shortfall', 'ledger and clock-in mismatch'],
    actions: ['把连班上限写进模板校验', '给换班链加了闭环检查', '把人力池按科室分层', '把节假日缺口提前四周预警', '让台账以打卡为准'],
    actionsEn: ['moved the back-to-back cap into template validation', 'added a closed-loop check to swap chains', 'tiered the staffing pool by department', 'raised holiday shortfall alerts four weeks ahead', 'made clock-in authoritative for the ledger'],
    outcomes: ['连班超时当月从 14 例降到 0 例', '断裂换班链不再进入正式表', '节假日缺口提前四周暴露'],
    outcomesEn: ['monthly back-to-back overruns fell from 14 to 0', 'broken swap chains no longer reach the published roster', 'holiday shortfalls surface four weeks early'],
    lessons: ['换班必须闭环校验，单向审批一定漏', '台账与打卡只能有一个权威来源'],
    lessonsEn: ['swaps need closed-loop validation; one-way approval always leaks', 'the ledger and clock-in cannot both be authoritative'],
    files: ['roster-template.xlsx', 'shift-swap.log'],
  },
  {
    key: 'metro-dispatch', area: '地铁调度', areaEn: 'Metro dispatching',
    components: ['站台屏蔽门', '折返线', '列车间隔表', '客流闸机', '早高峰加开车'],
    componentsEn: ['platform screen door', 'turnback track', 'headway table', 'passenger gate', 'peak extra train'],
    subjects: ['折返效率下降', '间隔波动', '闸机限流不及时', '加开车占用冲突', '开门时间超标'],
    subjectsEn: ['turnback efficiency drop', 'headway jitter', 'late gate throttling', 'extra-train occupancy conflict', 'door dwell overrun'],
    actions: ['把折返作业拆成两段并行', '按站间实际运行时分重算间隔表', '让闸机限流跟着站台密度走', '给加开车固定了占用窗口'],
    actionsEn: ['split the turnback into two parallel phases', 'recomputed the headway table from measured section times', 'tied gate throttling to platform density', 'fixed an occupancy window for extra trains'],
    outcomes: ['折返作业时间从 142 秒压到 118 秒', '早高峰间隔波动从 ±35 秒收到 ±12 秒', '开门时间超标当周清零'],
    outcomesEn: ['turnback time fell from 142 s to 118 s', 'peak headway jitter narrowed from ±35 s to ±12 s', 'door dwell overruns fell to zero that week'],
    lessons: ['间隔表用计划运行时分算就一定偏乐观', '限流要跟站台密度，不能跟进站人数'],
    lessonsEn: ['headway tables built on planned section times are always optimistic', 'throttling must follow platform density, not entry counts'],
    files: ['headway-table.json', 'turnback-plan.md'],
  },
  {
    key: 'cold-chain', area: '冷链物流', areaEn: 'Cold chain logistics',
    components: ['冷藏箱体', '温度记录仪', '装卸月台', '预冷间', '干冰配额表'],
    componentsEn: ['refrigerated container', 'temperature logger', 'loading dock', 'pre-cooling room', 'dry ice quota table'],
    subjects: ['月台温升', '记录仪掉点', '预冷不足', '干冰配额不够', '箱门密封失效'],
    subjectsEn: ['dock temperature rise', 'logger data gaps', 'insufficient pre-cooling', 'dry ice quota shortfall', 'door seal failure'],
    actions: ['给月台加了风幕并改了作业顺序', '把记录仪采样从 5 分钟改成 1 分钟', '把预冷时长按品类分档', '按里程与季节重算干冰配额'],
    actionsEn: ['added an air curtain and reordered dock operations', 'changed logger sampling from 5 minutes to 1 minute', 'tiered pre-cooling time by product category', 'recomputed dry ice quota by distance and season'],
    outcomes: ['月台温升从 6.5 摄氏度降到 2.1 摄氏度', '记录仪掉点率从 3.4% 降到 0.2%', '到货温度超标批次当季从 11 批降到 1 批'],
    outcomesEn: ['dock temperature rise fell from 6.5 °C to 2.1 °C', 'logger gap rate fell from 3.4% to 0.2%', 'out-of-spec arrival batches fell from 11 to 1 for the season'],
    lessons: ['温升多半发生在月台，不在路上', '采样间隔决定短时温升是否可见'],
    lessonsEn: ['most temperature rise happens at the dock, not in transit', 'sampling interval decides whether short spikes are visible at all'],
    files: ['cold-chain-log.csv', 'precool-matrix.yaml'],
  },
  {
    key: 'parcel-sorting', area: '快递分拣', areaEn: 'Parcel sorting',
    components: ['交叉带分拣机', '格口分配表', '面单识别相机', '异形件通道', '返流皮带'],
    componentsEn: ['cross-belt sorter', 'chute allocation table', 'label camera', 'irregular-item lane', 'recirculation belt'],
    subjects: ['格口爆仓', '面单识别率下降', '异形件误入主线', '返流比例升高', '交叉带打滑'],
    subjectsEn: ['chute overflow', 'label recognition drop', 'irregular items entering the main line', 'rising recirculation ratio', 'cross-belt slippage'],
    actions: ['按流向重排格口分配表', '把相机曝光改成按面单反光自适应', '在入口加了异形件预分流', '把返流皮带速度与主线解耦'],
    actionsEn: ['reordered chute allocation by destination flow', 'made camera exposure adaptive to label glare', 'added irregular-item pre-diversion at the inlet', 'decoupled recirculation belt speed from the main line'],
    outcomes: ['格口爆仓每班从 7 次降到 1 次', '面单识别率从 93.5% 回到 99.1%', '返流比例从 8.2% 降到 2.6%'],
    outcomesEn: ['chute overflows per shift fell from 7 to 1', 'label recognition recovered from 93.5% to 99.1%', 'recirculation ratio fell from 8.2% to 2.6%'],
    lessons: ['爆仓是分配表问题，不是产能问题', '识别率下降先查反光，再查镜头'],
    lessonsEn: ['overflow is an allocation-table problem, not a throughput one', 'when recognition drops, check glare before the lens'],
    files: ['chute-allocation.csv', 'sorter-tuning.md'],
  },
  {
    key: 'pv-plant', area: '光伏运维', areaEn: 'PV plant operations',
    components: ['组串逆变器', '汇流箱', '清洗机器人', '倾角支架', '发电量日报'],
    componentsEn: ['string inverter', 'combiner box', 'cleaning robot', 'tilt mount', 'daily generation report'],
    subjects: ['组串失配', '汇流箱温升', '清洗周期不合理', '倾角季节性偏差', '日报口径不一致'],
    subjectsEn: ['string mismatch', 'combiner box temperature rise', 'unsuitable cleaning cycle', 'seasonal tilt deviation', 'inconsistent report definitions'],
    actions: ['按组串电流分布重新分组', '把汇流箱巡检改成红外筛查', '让清洗周期跟着积灰速率走', '按季节调了两次倾角'],
    actionsEn: ['regrouped strings by current distribution', 'switched combiner inspection to infrared screening', 'tied the cleaning cycle to dust accumulation rate', 'adjusted tilt twice by season'],
    outcomes: ['组串失配损失从 4.1% 降到 1.3%', '汇流箱高温告警当月从 23 条降到 2 条', '同口径发电量差异从 6% 收到 1%'],
    outcomesEn: ['mismatch loss fell from 4.1% to 1.3%', 'combiner high-temperature alarms fell from 23 to 2 that month', 'same-definition generation gap narrowed from 6% to 1%'],
    lessons: ['清洗按固定周期一定浪费一半人力', '日报口径不统一，任何对比都不成立'],
    lessonsEn: ['fixed cleaning cycles always waste half the labour', 'with inconsistent report definitions no comparison holds'],
    files: ['pv-string-map.csv', 'cleaning-cycle.yaml'],
  },
  {
    key: 'library', area: '图书借阅', areaEn: 'Library lending',
    components: ['自助借还机', '书目索书号', '预约队列', '逾期通知', '密集书库'],
    componentsEn: ['self-service kiosk', 'call number', 'reservation queue', 'overdue notice', 'compact stacks'],
    subjects: ['索书号错架', '预约队列超长', '逾期通知漏发', '密集书库取书慢', '借还机识别失败'],
    subjectsEn: ['misshelved call numbers', 'over-long reservation queue', 'missed overdue notices', 'slow retrieval from compact stacks', 'kiosk read failures'],
    actions: ['按楼层重排索书号巡架顺序', '给预约队列加了到馆时限', '把逾期通知改成三段提醒', '把密集书库取书按区块批量化'],
    actionsEn: ['reordered shelf-reading by floor', 'added a pickup deadline to the reservation queue', 'split overdue notices into three stages', 'batched compact-stack retrieval by block'],
    outcomes: ['错架率从 2.8% 降到 0.6%', '预约平均等待从 11 天降到 4 天', '逾期通知送达率从 82% 升到 99%'],
    outcomesEn: ['misshelving fell from 2.8% to 0.6%', 'average reservation wait fell from 11 days to 4', 'overdue notice delivery rose from 82% to 99%'],
    lessons: ['错架靠巡架顺序解决，不靠加人', '预约队列没有时限就会被占住'],
    lessonsEn: ['misshelving is fixed by shelf-reading order, not headcount', 'a reservation queue without deadlines gets squatted'],
    files: ['call-number-map.csv', 'overdue-notice.md'],
  },
  {
    key: 'aquaculture', area: '水产养殖', areaEn: 'Aquaculture',
    components: ['增氧机', '投饵机', '水质探头', '循环水滤床', '分池网箱'],
    componentsEn: ['aerator', 'feeder', 'water quality probe', 'recirculating filter bed', 'partition net cage'],
    subjects: ['溶氧夜间跌落', '投饵过量', '氨氮升高', '滤床短路流', '分池应激'],
    subjectsEn: ['night dissolved-oxygen drop', 'overfeeding', 'rising ammonia nitrogen', 'filter bed short-circuiting', 'partitioning stress'],
    actions: ['把增氧机改成按溶氧闭环启停', '按体重重算投饵率', '给滤床加了布水板', '把分池操作挪到清晨低温时段'],
    actionsEn: ['switched aerators to closed-loop dissolved-oxygen control', 'recomputed feeding rate by body weight', 'added a distribution plate to the filter bed', 'moved partitioning to the cool early morning'],
    outcomes: ['夜间最低溶氧从 2.1 毫克每升升到 4.3 毫克每升', '饵料系数从 1.62 降到 1.28', '分池后三日死亡率从 4.5% 降到 0.9%'],
    outcomesEn: ['night minimum dissolved oxygen rose from 2.1 mg/L to 4.3 mg/L', 'feed coefficient fell from 1.62 to 1.28', 'three-day mortality after partitioning fell from 4.5% to 0.9%'],
    lessons: ['定时增氧一定既费电又缺氧', '投饵率按尾数算永远偏高'],
    lessonsEn: ['timer-based aeration both wastes power and still runs short', 'feeding rate computed per head is always too high'],
    files: ['oxygen-curve.csv', 'feeding-rate.yaml'],
  },
  {
    key: 'parking', area: '城市停车', areaEn: 'Urban parking',
    components: ['道闸', '车位诱导屏', '高位视频桩', '包月名单', '错峰共享车位'],
    componentsEn: ['barrier gate', 'guidance screen', 'overhead video pole', 'monthly pass list', 'off-peak shared bay'],
    subjects: ['车牌识别错配', '诱导屏数据滞后', '包月名单过期', '共享车位被长期占用', '出场排队'],
    subjectsEn: ['plate mismatch', 'stale guidance data', 'expired pass list', 'shared bays held long-term', 'exit queueing'],
    actions: ['把识别结果加了二次比对', '把诱导屏刷新从 5 分钟改成 30 秒', '让包月名单按天同步', '给共享车位加了时段锁'],
    actionsEn: ['added a second comparison to plate results', 'changed guidance refresh from 5 minutes to 30 seconds', 'synced the pass list daily', 'added time-window locks to shared bays'],
    outcomes: ['识别错配从每天 26 起降到 3 起', '出场平均排队从 92 秒降到 31 秒', '共享车位周转率提高一倍'],
    outcomesEn: ['plate mismatches fell from 26 per day to 3', 'average exit queueing fell from 92 s to 31 s', 'shared bay turnover doubled'],
    lessons: ['识别单靠一次比对，错配就一定进账单', '诱导屏滞后五分钟等于没有诱导'],
    lessonsEn: ['with a single comparison, mismatches always reach the bill', 'guidance five minutes stale is no guidance'],
    files: ['plate-recheck.log', 'bay-schedule.csv'],
  },
  {
    key: 'catering', area: '餐饮出餐', areaEn: 'Restaurant service',
    components: ['出餐口', '备餐台', '叫号屏', '外卖打包区', '高峰配菜表'],
    componentsEn: ['service window', 'prep counter', 'number screen', 'takeaway packing area', 'peak prep sheet'],
    subjects: ['出餐乱序', '备餐台拥堵', '叫号漏叫', '外卖与堂食抢产能', '配菜表与实际不符'],
    subjectsEn: ['out-of-order service', 'prep counter congestion', 'missed calls', 'takeaway competing with dine-in', 'prep sheet mismatch'],
    actions: ['把出餐改成按下单时间强排序', '把备餐台按冷热分区', '给叫号屏加了重复提醒', '把外卖产能单独留了两个灶口'],
    actionsEn: ['forced service order by order time', 'split the prep counter into hot and cold zones', 'added repeat prompts to the number screen', 'reserved two burners for takeaway capacity'],
    outcomes: ['出餐乱序投诉当月从 31 条降到 4 条', '高峰平均等餐从 18 分钟降到 9 分钟', '漏叫率从 5.1% 降到 0.4%'],
    outcomesEn: ['out-of-order complaints fell from 31 to 4 that month', 'peak average wait fell from 18 minutes to 9', 'missed-call rate fell from 5.1% to 0.4%'],
    lessons: ['乱序不是厨房慢，是没有强排序', '外卖不单独留产能就一定挤堂食'],
    lessonsEn: ['out-of-order service is a missing sort, not a slow kitchen', 'without reserved capacity, takeaway always squeezes dine-in'],
    files: ['service-order.log', 'peak-prep.csv'],
  },
];

// ---------------------------------------------------------------------------
// 3. 禁用表（判据 §3.1「词面纪律」）
// ---------------------------------------------------------------------------
//
// 与英文 filler 同一条规则，但**中文侧要连中文 concept 一起禁**：本项目的 concept 里
// 既有 `FTS5` / `RRF` 这类拉丁串，也有「全文搜索」「特殊字符转义」这类中文短语，
// 而词面匹配是子串语义，两类都会造成语料泄漏。
//
// gold 目前只有旧 26 条可见（40 条新记录还没撰写），因此本脚本的检查是**第一道**；
// 冻结与 F2 的 S3 会在全量 gold（含新 40 条）上再跑一次同一条规则。
function bannedTerms(goldPaths: string[]): { terms: string[]; fileBasenames: string[]; sources: string[] } {
  const terms = new Set<string>();
  const basenames = new Set<string>();
  const sources: string[] = [];
  for (const p of goldPaths) {
    if (!existsSync(p)) continue;
    sources.push(p);
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
    const rows: any[] = Array.isArray(raw) ? raw : ((raw as any).records ?? []);
    for (const row of rows) {
      const a = row.annotation ?? row;
      for (const c of a.concepts ?? []) {
        // 标识性判据：含空格 / 大写 / 数字 / 连字符的拉丁串，或长度 ≥ 3 的中文短语。
        const distinctive = /\s|[A-Z]|[_\-0-9]/.test(c) || /[\u4e00-\u9fff]{3,}/.test(c);
        if (distinctive && c.length >= 3) terms.add(c);
      }
      for (const f of a.key_files ?? a.files_touched ?? []) {
        const base = String(f).split('/').pop();
        if (base && base.length >= 4) basenames.add(base);
      }
    }
  }
  return { terms: [...terms].sort(), fileBasenames: [...basenames].sort(), sources };
}

// ---------------------------------------------------------------------------
// 4. 生成
// ---------------------------------------------------------------------------
interface FillerZh {
  id: string;
  domain: string;
  title: string;
  summary: string;
  outcome: string;
  learned: string;
  concepts: string[];
  files: string[];
  /** 英文面：进 `semantic-en-v1` 向量空间，与中文正文同一条模板。 */
  en: { title: string; summary: string; outcome: string; learned: string; concepts: string[] };
  /** 本条注入了哪些功能词（自证用，S3 会核对总数）。 */
  functionWords: string[];
}

/**
 * 功能词的注入名单：每个词**恰好** `round(share × COUNT)` 条，用 seed 打乱后的排列取前 N 条。
 *
 * 每个词各自独立取一个排列，因此一条记录可以同时被多个词选中——这是有意的：
 * 真实语料里一段话同时含「的时候」和「能不能」很常见，强行互斥会造出人工的负相关。
 */
function assignFunctionWords(rnd: () => number): { plan: Map<number, string[]>; targets: Map<string, number> } {
  const plan = new Map<number, string[]>();
  const targets = new Map<string, number>();
  for (const fw of FUNCTION_WORDS) {
    const target = Math.round(fw.share * COUNT);
    targets.set(fw.word, target);
    const order = Array.from({ length: COUNT }, (_, i) => i);
    // Fisher–Yates，随机源是同一个 seed 流，因此整份名单逐位可复现。
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const idx of order.slice(0, target)) {
      plan.set(idx, [...(plan.get(idx) ?? []), fw.word]);
    }
  }
  return { plan, targets };
}

function generate(): { records: FillerZh[]; targets: Map<string, number> } {
  const rnd = mulberry32(SEED);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const { plan, targets } = assignFunctionWords(mulberry32(SEED ^ 0x5a5a));
  const byWord = new Map(FUNCTION_WORDS.map((f) => [f.word, f]));
  const out: FillerZh[] = [];

  for (let i = 0; i < COUNT; i++) {
    const d = DOMAINS[i % DOMAINS.length]!;
    const ci = Math.floor(rnd() * d.components.length);
    const si = Math.floor(rnd() * d.subjects.length);
    const ai = Math.floor(rnd() * d.actions.length);
    const oi = Math.floor(rnd() * d.outcomes.length);
    const li = Math.floor(rnd() * d.lessons.length);
    const oj = (ci + 1) % d.components.length; // 另一个部件，避免与 component 相同
    // 序号进标题：10,000 条必须条条不同，否则重复文本共享向量，
    // "语料里有多少条可比向量"就不再等于"有多少条记录"。
    // 数字断开成 `12-34`：连续四位数字会与本项目 concept 里的 `0600` / `401` 撞成子串。
    const n = `${String(Math.floor(i / 100)).padStart(2, '0')}-${String(i % 100).padStart(2, '0')}`;
    const words = plan.get(i) ?? [];
    // 变体按同一条 seed 流选，因此整份语料仍逐位可复现。
    const variantOf = (w: string): number => Math.floor(rnd() * byWord.get(w)!.fragments.length);
    const chosen = words.map((w) => ({ w, v: variantOf(w) }));
    const zhFrag = chosen.map(({ w, v }) => byWord.get(w)!.fragments[v]!).join('');
    const enFrag = chosen.map(({ w, v }) => byWord.get(w)!.enFragments[v]!).join(' ');

    out.push({
      id: `zh${String(i).padStart(5, '0')}`,
      domain: d.key,
      title: `${d.area}案例 ${n}：${d.components[ci]}的${d.subjects[si]}`,
      summary:
        `${d.area}第 ${n} 号案例。现场反馈的是${d.subjects[si]}，排查后定位到${d.components[ci]}`
        + `与${d.components[oj]}的配合方式。处理办法是${d.actions[ai]}，并在同一地点复测确认。${zhFrag}`,
      outcome: `${d.outcomes[oi]}（案例 ${n}）。`,
      learned: `${d.lessons[li]}记录自${d.area}案例 ${n}。`,
      concepts: [d.area, d.components[ci]!, d.components[oj]!, d.subjects[si]!],
      files: d.files,
      en: {
        title: `${d.areaEn} case ${n}: ${d.subjectsEn[si]} on the ${d.componentsEn[ci]}`,
        summary:
          `Case ${n} in ${d.areaEn}. The reported problem was ${d.subjectsEn[si]}, traced to how the `
          + `${d.componentsEn[ci]} interacts with the ${d.componentsEn[oj]}. We ${d.actionsEn[ai]} and `
          + `re-measured at the same site. ${enFrag}`.trim(),
        outcome: `${d.outcomesEn[oi]} (case ${n}).`,
        learned: `${d.lessonsEn[li]} Recorded from ${d.areaEn} case ${n}.`,
        concepts: [d.areaEn, d.componentsEn[ci]!, d.componentsEn[oj]!, d.subjectsEn[si]!],
      },
      functionWords: words,
    });
  }
  return { records: out, targets };
}

// ---------------------------------------------------------------------------
// 5. 自证
// ---------------------------------------------------------------------------
const zhText = (r: FillerZh): string => [r.title, r.summary, r.outcome, r.learned, ...r.concepts].join('\n');

interface Check { name: string; pass: boolean; detail: string }

function selfChecks(records: FillerZh[], targets: Map<string, number>, goldPaths: string[]): {
  checks: Check[];
  wordCounts: { word: string; target: number; actual: number; share: number; actualShare: number }[];
  banned: ReturnType<typeof bannedTerms>;
} {
  const checks: Check[] = [];
  const push = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail }); };

  push('规模', records.length === COUNT, `${records.length} / ${COUNT}`);
  push('标题唯一', new Set(records.map((r) => r.title)).size === records.length,
    `${new Set(records.map((r) => r.title)).size} 个唯一标题`);
  const noZh = records.filter((r) => !/[\u4e00-\u9fff]/.test(zhText(r))).length;
  push('每条都含中文', noZh === 0, `不含中文的行 ${noZh}`);
  const noEn = records.filter((r) => /[\u4e00-\u9fff]/.test(Object.values(r.en).flat().join(' '))).length;
  push('英文面不含中文', noEn === 0, `英文面含中文的行 ${noEn}`);

  // 功能词：实测计数必须**等于**目标计数。用的是"恰好 N 条"注入，所以这里要求相等而不是近似。
  const wordCounts = FUNCTION_WORDS.map((fw) => {
    const actual = records.filter((r) => zhText(r).includes(fw.word)).length;
    return {
      word: fw.word, target: targets.get(fw.word)!, actual,
      share: fw.share, actualShare: Number((actual / COUNT).toFixed(4)),
    };
  });
  for (const w of wordCounts) {
    push(`功能词 ${w.word} 计数`, w.actual === w.target, `实测 ${w.actual} / 目标 ${w.target}（占比 ${w.actualShare}）`);
  }
  // 基座模板不得自带功能词：否则实测占比会漂出注入名单，S3 的核对就在核对模板噪声。
  const leaked = FUNCTION_WORDS.filter((fw) => records.some(
    (r) => !r.functionWords.includes(fw.word) && zhText(r).includes(fw.word),
  )).map((f) => f.word);
  push('基座模板不含功能词', leaked.length === 0, leaked.length ? `泄漏：${leaked.join(' / ')}` : '无泄漏');

  // 禁用表：与 gold 不得共享标识性 concept / 文件基名（子串语义）。
  const banned = bannedTerms(goldPaths);
  const violations: string[] = [];
  for (const r of records.slice(0, COUNT)) {
    const hay = `${zhText(r)}\n${r.files.join('\n')}\n${Object.values(r.en).flat().join('\n')}`;
    for (const t of banned.terms) if (hay.includes(t)) violations.push(`${r.id} ⊃ concept「${t}」`);
    for (const b of banned.fileBasenames) if (hay.includes(b)) violations.push(`${r.id} ⊃ 文件「${b}」`);
  }
  push('禁用表违规 = 0', violations.length === 0,
    violations.length ? `${violations.length} 处，例：${violations.slice(0, 5).join('；')}` : `0（禁用表 ${banned.terms.length} concept + ${banned.fileBasenames.length} 文件基名，来源 ${banned.sources.length} 份）`);

  return { checks, wordCounts, banned };
}

// ---------------------------------------------------------------------------
// 6. 主流程
// ---------------------------------------------------------------------------
const goldPaths = [
  join(DATASET_DIR, 'turns.json'),
  ...(arg('gold') ? [arg('gold')!] : []),
];

let records: FillerZh[];
let targets: Map<string, number>;
if (has('check')) {
  if (!existsSync(CORPUS_FILE)) die(`语料不存在，先不带 --check 跑一次：${CORPUS_FILE}`);
  records = JSON.parse(readFileSync(CORPUS_FILE, 'utf-8')) as FillerZh[];
  targets = new Map(FUNCTION_WORDS.map((f) => [f.word, Math.round(f.share * COUNT)]));
} else {
  const g = generate();
  records = g.records;
  targets = g.targets;
}

const { checks, wordCounts, banned } = selfChecks(records, targets, goldPaths);
const failed = checks.filter((c) => !c.pass);

for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.detail}`);

if (failed.length) die(`${failed.length} 项自检失败，未写入语料`);

if (!has('check')) {
  const body = JSON.stringify(records, null, 2);
  writeFileSync(CORPUS_FILE, body);
  writeFileSync(META_FILE, `${JSON.stringify({
    purpose: 'FTS 安全策略轮次 F1 的中文词面 filler 语料（判据 §3.1 / §3.1.1）。',
    frozen: false,
    frozenNote: '冻结由 benchmark/freeze-util.ts 在 F1 一次性完成；本 meta 不写时间戳。',
    criteria: 'benchmark/reports/fts-round/f1-criteria.md',
    count: records.length,
    seed: SEED,
    domains: DOMAINS.length,
    domainKeys: DOMAINS.map((d) => d.key),
    functionWords: wordCounts,
    functionWordNote: '目标占比由判据 §3.1.1 预登记；注入方式是「恰好 N 条」，因此实测必须等于目标。S3 在装置上核对 df/N。',
    bannedTable: {
      sources: banned.sources,
      concepts: banned.terms.length,
      fileBasenames: banned.fileBasenames.length,
      note: 'gold 目前只有旧 26 条可见；40 条新记录撰写后必须用 --gold=<新记录> 重跑本检查，并在 F2 的 S3 再核一次。',
    },
    lexicalViolations: 0,
    uniqueTitles: new Set(records.map((r) => r.title)).size,
    builderSha256: sha16(readFileSync(join(import.meta.dir, 'build-fts-round-filler-zh.ts'), 'utf-8')),
    corpusSha256: sha16(body),
    mirrorNote: '英文面由同一套模板生成，不调 ACP（判据 §3.1「向量」行）；因此它比真实 ACP 译文更规整，见判据 §12 第 4 条。',
  }, null, 2)}\n`);
  console.log(`\n[filler-zh] → ${CORPUS_FILE}\n[filler-zh] → ${META_FILE}`);
}

// ---------------------------------------------------------------------------
// 7. `--df` 预演：只把中文语料播进临时库，量功能词的 df
// ---------------------------------------------------------------------------
//
// **这不是 S3。** S3 要在 F2 的完整装置（60,066 行）上量，分母有两个（中文记录数与
// scopeSize，判据 §7 S3 第 2/3 条）。这里只回答一个前置问题：3 字滑窗在这份语料上
// 到底成不成形——如果不成形，后面整轮都白做，所以值得在撰写 gold 之前先看一眼。
if (has('df')) {
  const { MemoryDB, computeScopeKey, extractFtsSearchUnits } = await import('../src/db');
  const dbPath = join(process.env.TMPDIR ?? '/tmp', 'fts-filler-zh-df.db');
  for (const s of ['', '-wal', '-shm']) if (existsSync(dbPath + s)) require('node:fs').rmSync(dbPath + s, { force: true });
  const db = new MemoryDB(dbPath);
  const CWD = '/fts-round/df-probe';
  const SCOPE = computeScopeKey(CWD, CWD);
  db.upsertSessionRef({ session_id: 'zh-filler', cwd: CWD, repo: CWD });
  const at = new Date().toISOString();
  for (const r of records) {
    const seq = db.allocateNextTurnSeq('zh-filler');
    const turn = db.createTurn({ session_id: 'zh-filler', seq, cwd: CWD, repo: CWD, prompt_text: r.title });
    db.markTurnClosed(turn.id, at);
    db.insertObservation({
      turn_id: turn.id, session_id: 'zh-filler', turn_seq: seq, repo: CWD, cwd_scope: CWD,
      title: r.title, summary: r.summary, outcome: r.outcome, learned: r.learned,
      memory_type: 'change', files_touched: r.files, concepts: r.concepts,
      quality: 'normal', turn_started_at: at, turn_stopped_at: at,
    });
  }
  const raw = (db as unknown as { db: { query: (s: string) => { all: (...p: unknown[]) => unknown[] } } }).db;
  const df = (unit: string): number => (raw.query(
    `SELECT count(*) AS n FROM observations_fts fts CROSS JOIN observations o
       ON fts.rowid = o.id WHERE observations_fts MATCH ? AND o.scope_key = ?`,
  ).all(`"${unit.replaceAll('"', '""')}"`, SCOPE) as { n: number }[])[0]!.n;

  console.log(`\n[filler-zh] df 预演（只播中文 ${records.length} 条，分母 = 中文记录数）`);
  for (const fw of FUNCTION_WORDS) {
    const d = df(fw.word);
    console.log(`  ${fw.word.padEnd(5)} df=${String(d).padStart(5)}  df/中文=${(d / records.length).toFixed(4)}  目标占比=${fw.share}`);
  }
  // 一条真实中文问句会被切成哪些单元、每个单元的 df 是多少——F0-3 说命中通常只由一个碎片造成，
  // 这里看的是那些碎片在有中文竞争之后还剩多少判别力。
  const sample = '交接班的时候能不能不动硬件就把末端压力不足解决掉';
  const units = extractFtsSearchUnits(sample);
  console.log(`\n[filler-zh] 样例 query 单元 df（${units.length} 个单元）`);
  console.log(`  ${units.map((u) => `${u}:${df(u)}`).join('  ')}`);
  db.close();
}
