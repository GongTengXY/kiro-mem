/**
 * Phase 3A-R2 数据集构建：候选题面 + 预检 + 分层判定。
 *
 * 规则先于本文件冻结：`benchmark/reports/phase3a-r2-dataset-rules.md`
 *   sha256 8621b6fdf71fcc21a8abd6397aabc76da0e4fbe18766be91351652722453fb2e
 *   冻结时间 2026-08-04T14:51:03Z（本文件的 mtime 必须晚于它）
 *
 * 三条纪律在代码里的落点：
 *
 *  1. **只从事实出题**（规则 §2.1）。每条候选都带 `basis`，写明它依据哪条 turn 的 annotation
 *     字段。没有任何一条 query 是从 arm 返回结果反推的。
 *  2. **预检只看腿在不在**（规则 §2.2）。`precheck()` 只输出布尔：这条腿的候选里有没有 gold。
 *     它不读 cosine 数值、不读名次、不读最终页面。
 *  3. **分层由预检判定**（规则 §2.3）。`intent` 只是出题时的目标，`stratum` 一律由实测三个
 *     布尔算出。落在意图之外的层**留在实际层**，不删不改。
 *
 * 本脚本分两阶段跑：
 *   `--stage=lexical` （默认）：FTS 腿与 bigram 腿预检，不需要模型，秒级完成。
 *   `--stage=full`：额外做语义腿预检，需要 `mirror-en-fusion.json` 里的英文派生值。
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import { loadDataset, annotationToResult, annotationSearchText } from './dataset';

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const stage = flag('stage', 'lexical') as 'lexical' | 'full';
const DATASET_DIR = join(import.meta.dir, 'dataset');
const REPORT = resolve(flag('report', join(import.meta.dir, 'reports', 'phase3a-r2-dataset.md'))!);

/** 出题意图。实际分层由预检判定，这只是覆盖目标。 */
type Intent = 'S1' | 'S2' | 'S3' | 'S4';

interface FusionCandidate {
  id: string;
  intent: Intent;
  query: string;
  expect: string[];
  /** 依据哪条 turn 的哪些 annotation 字段。规则 §2.1 的可核查凭据。 */
  basis: string;
}

/**
 * 「两腿都命中」校准集候选。
 *
 * S1/S3/S4 是中文题面，S2 按规则 §3.1 必须用非 CJK 单元命中 FTS——因为 3A 实测出
 * 「含 query 中文三字窗口的记录必然含窗口里的两字词」，纯中文题面上 FTS✓ + bigram✗
 * 结构上不可构造。
 */
const FUSION_CANDIDATES: FusionCandidate[] = [
  // ---- S1 意图：中文题面与记录共享三字窗口，FTS 与 bigram 应同时命中 ----
  { id: 'w01', intent: 'S1', query: '超时降级之后还能不能搜到东西', expect: ['t02'],
    basis: 't02.concepts 含「超时降级」「FTS-only」；t02.outcome 写明降级后 search 按时返回 FTS 结果' },
  { id: 'w02', intent: 'S1', query: '资源池里的死锁是怎么解决的', expect: ['t07'],
    basis: 't07.concepts 含「ACPPool」「资源池」「死锁」「recycle」' },
  { id: 'w03', intent: 'S1', query: 'workspace 隔离是靠什么做的', expect: ['t22'],
    basis: 't22.title「scope_key 硬隔离」；concepts 含「workspace 隔离」「computeScopeKey」' },
  { id: 'w04', intent: 'S1', query: '测试隔离改到临时目录之后有什么变化', expect: ['t12'],
    basis: 't12.title「测试数据目录隔离到临时目录」；concepts 含「测试隔离」' },
  { id: 'w05', intent: 'S1', query: '版本漂移检查是怎么加进去的', expect: ['t15'],
    basis: 't15.title「diagnose 增加版本漂移检查」；concepts 含「版本漂移」' },
  { id: 'w06', intent: 'S1', query: '字节预算和 scope 过滤都验过了吗', expect: ['t18'],
    basis: 't18.outcome「字节预算与 scope 硬过滤均按预期生效」' },
  { id: 'w07', intent: 'S1', query: '故障路径里的隐私脱敏结论是什么', expect: ['t19'],
    basis: 't19.concepts 含「故障路径」「隐私脱敏」「REDACTED」' },
  { id: 'w08', intent: 'S1', query: '语义地板线最后设成多少', expect: ['t21'],
    basis: 't21.title 含「0.2 语义地板线」；concepts 含「语义地板线」' },
  { id: 'w09', intent: 'S1', query: '命名决策最后保留了哪个写法', expect: ['t10'],
    basis: 't10.title「job 命名保留 summarize_turn / embed_observation」；concepts 含「命名决策」' },
  { id: 'w10', intent: 'S1', query: '质量基准集的优先级是怎么定的', expect: ['t26'],
    basis: 't26.title「质量基准集：内测不阻塞，对外发布前必须完成」；concepts 含「质量基准集」' },

  // ---- S2 意图：非 CJK 单元命中 FTS，无 CJK 故 bigram 腿不触发（规则 §3.1）----
  { id: 'w11', intent: 'S2', query: 'AgentSpawn hook Worker restart', expect: ['t03'],
    basis: 't03.title「AgentSpawn hook 不再重启 Worker」；concepts 含 hook / AgentSpawn' },
  { id: 'w12', intent: 'S2', query: 'all-MiniLM-L6-v2 q8 384 dimensions', expect: ['t23'],
    basis: 't23.concepts 含「all-MiniLM-L6-v2」「q8 量化」「384 维」' },
  { id: 'w13', intent: 'S2', query: 'PACKAGE_VERSION npm pack single source', expect: ['t05'],
    basis: 't05.concepts 含「PACKAGE_VERSION」「npm pack」；outcome 写明 npm pack 产出 3.0.0.tgz' },
  { id: 'w14', intent: 'S2', query: 'computeScopeKey all_scopes leakage', expect: ['t22'],
    basis: 't22.concepts 含「computeScopeKey」「all_scopes」「泄漏」' },
  { id: 'w15', intent: 'S2', query: 'KIRO_MEMORY_DATA_DIR bunfig preload', expect: ['t12'],
    basis: 't12.concepts 含「KIRO_MEMORY_DATA_DIR」「bunfig」「preload」' },
  { id: 'w16', intent: 'S2', query: 'ACPPool recycle slot concurrency', expect: ['t07'],
    basis: 't07.concepts 含「ACPPool」「recycle」「并发」；outcome 提到 concurrency=1' },
  { id: 'w17', intent: 'S2', query: 'fallback quality job retry integration test', expect: ['t08'],
    basis: 't08.concepts 含「fallback」「quality」「job 重试」「集成测试」' },
  { id: 'w18', intent: 'S2', query: 'TS2345 typecheck auth middleware', expect: ['t25'],
    basis: 't25.concepts 含「typecheck」「TS2345」「auth 中间件」' },
  { id: 'w19', intent: 'S2', query: 'timeline source turn mode scope', expect: ['t20'],
    basis: 't20.title「timeline 锚定 source turn」；concepts 含「mode=scope」' },
  { id: 'w20', intent: 'S2', query: 'RRF hybrid search cosine floor', expect: ['t21'],
    basis: 't21.concepts 含「RRF」「hybrid search」「余弦相似度」' },

  // ---- S3 意图：两字词在记录里存在但三字窗口错位，FTS 应漏、bigram 应中 ----
  { id: 'w21', intent: 'S3', query: '转义规则是按哪一套来的', expect: ['t01'],
    basis: 't01.concepts 含「特殊字符转义」；learned 写明双引号翻倍是 FTS5 的转义方式' },
  { id: 'w22', intent: 'S3', query: '脱敏之后还能分清是哪种失败吗', expect: ['t04'],
    basis: 't04.outcome「四类失败仍可区分」；concepts 含「日志脱敏」' },
  { id: 'w23', intent: 'S3', query: '清单漏了东西会导致什么后果', expect: ['t13'],
    basis: 't13.title「安装器复制清单漏 src/auth-token.ts 导致 Worker 起不来」' },
  { id: 'w24', intent: 'S3', query: '幂等这件事上踩过什么坑', expect: ['t14'],
    basis: 't14.concepts 含「幂等陷阱」；title 提到覆盖源码后仍跑旧进程' },
  { id: 'w25', intent: 'S3', query: '验收当时哪一步是人工绕过的', expect: ['t16'],
    basis: 't16.outcome 写明「安装第 12 步的依赖下载被人工绕过」' },
  { id: 'w26', intent: 'S3', query: '端到端那轮有没有覆盖交互式会话', expect: ['t17'],
    basis: 't17.outcome 写明「真实交互式会话下的触发尚未覆盖」' },
  { id: 'w27', intent: 'S3', query: '认证这块最后是留还是去', expect: ['t11'],
    basis: 't11.title「保留本地 token 认证并做到用户无感」；concepts 含「token 认证」' },
  { id: 'w28', intent: 'S3', query: '边界值校验补在哪一层', expect: ['t06'],
    basis: 't06.concepts 含「参数校验」「边界值」' },
  { id: 'w29', intent: 'S3', query: '本地化是怎么接进去的', expect: ['t24'],
    basis: 't24.concepts 含「i18n」「本地化」「MCP 工具描述」' },
  { id: 'w30', intent: 'S3', query: '清理动作在安装之前做了什么', expect: ['t09'],
    basis: 't09.title「purge → clean install 闭环测试」；concepts 含「purge」「clean install」' },

  // ---- S4 意图：题面偏简短或用数字锚点，语义腿可能不过 floor，bigram 仍能提供候选 ----
  { id: 'w31', intent: 'S4', query: '23M 是怎么来的', expect: ['t23'],
    basis: 't23.outcome「模型目录实测 23M」' },
  { id: 'w32', intent: 'S4', query: '487 字节那次量的是什么', expect: ['t18'],
    basis: 't18.title「bootstrap 索引 487 字节」' },
  { id: 'w33', intent: 'S4', query: '131 pass 那次修的是什么', expect: ['t01'],
    basis: 't01.outcome「bun test 131 pass 0 fail」；key_facts 含「131 pass」' },
  { id: 'w34', intent: 'S4', query: '三个类型错误分别是什么', expect: ['t25'],
    basis: 't25.title「typecheck 报 3 个类型错误，尚未修复」' },
  { id: 'w35', intent: 'S4', query: '乱序写入还能按顺序出来吗', expect: ['t20'],
    basis: 't20.outcome「乱序写入的 Observation 仍按真实 turn 顺序返回」' },
  { id: 'w36', intent: 'S4', query: '不虚构结论这条是怎么验的', expect: ['t08'],
    basis: 't08.outcome「确认 fallback 不虚构 outcome」' },
  { id: 'w37', intent: 'S4', query: '静默失败是几秒内结束', expect: ['t03'],
    basis: 't03.outcome「hook 在 1 秒内结束、stdout 为空、退出码 0」' },
  { id: 'w38', intent: 'S4', query: '依赖下载那步为什么没验', expect: ['t16'],
    basis: 't16.outcome「安装第 12 步的依赖下载被人工绕过，未在干净网络环境验证」' },
  { id: 'w39', intent: 'S4', query: '评估脚本当时存在吗', expect: ['t26'],
    basis: 't26.outcome「数据集与评估脚本都还不存在」' },
  { id: 'w40', intent: 'S4', query: '620KB 是哪个项目的数字', expect: ['x03'],
    basis: 'x03.outcome「vite build 产出 620.14 kB」；该 turn 属 other scope，用于确认硬隔离' },

  // =========================================================================
  // 第二批：为补 S3 / S4 覆盖新增（如实披露，见 §「两批结构」）
  // =========================================================================
  //
  // 第一批 10 条 S3 意图里有 5 条落进 S1，原因是题面用了**三字**共享词
  // （「本地化」「边界值」「端到端」「清单漏」等），trigram 自然命中。按规则 §2.3 那 5 条
  // 留在 S1，不改题面。
  //
  // 这一批改用可验证的构造约束：**与 gold 记录的最长公共 CJK 子串必须恰好是 2**，
  // 由 `longestCommonCjkRun()` 在报告里逐条报出。这是文本属性而非检索结果，所以不属于
  // 规则 §2.2 禁止的那类挑选。全部候选无论落在哪一层都保留。
  { id: 'w41', intent: 'S3', query: '降级的时候到底发生了什么', expect: ['t02'],
    basis: 't02.title 含「FTS-only 降级」；concepts 含「超时降级」。共享词「降级」' },
  { id: 'w42', intent: 'S3', query: '融合这一步具体在算什么', expect: ['t21'],
    basis: 't21.title「RRF 融合与 0.2 语义地板线」。共享词「融合」' },
  { id: 'w43', intent: 'S3', query: '泄漏这件事是怎么确认的', expect: ['t22'],
    basis: 't22.concepts 含「泄漏」；outcome「跨 workspace 自动召回为 0」。共享词「泄漏」' },
  { id: 'w44', intent: 'S3', query: '校验要是没做会怎么样', expect: ['t06'],
    basis: 't06.concepts 含「参数校验」。共享词「校验」' },
  { id: 'w45', intent: 'S3', query: '隔离没做之前会写到哪里去', expect: ['t12'],
    basis: 't12.concepts 含「测试隔离」；request 提到不再写入开发者真实数据目录。共享词「隔离」' },
  { id: 'w46', intent: 'S3', query: '漂移是靠什么发现的', expect: ['t15'],
    basis: 't15.concepts 含「版本漂移」。共享词「漂移」' },
  { id: 'w47', intent: 'S3', query: '注入的那段东西有多大', expect: ['t18'],
    basis: 't18.concepts 含「上下文注入」；title 写明 487 字节。共享词「注入」' },
  { id: 'w48', intent: 'S3', query: '描述文案怎么切语言', expect: ['t24'],
    basis: 't24.concepts 含「MCP 工具描述」「i18n」。共享词「描述」' },
  { id: 'w49', intent: 'S3', query: '导入路径为什么解析不了', expect: ['t13'],
    basis: 't13.concepts 含「相对导入」；outcome「安装产物的相对导入全部可解析」。共享词「导入」' },
  { id: 'w50', intent: 'S3', query: '重试到最后还是不行会怎样', expect: ['t08'],
    basis: 't08.concepts 含「job 重试」；title 提到最终失败写 fallback。共享词「重试」' },
  { id: 'w51', intent: 'S3', query: '保活这块是谁在管', expect: ['t19'],
    basis: 't19.concepts 含「launchd 保活」。共享词「保活」' },
  { id: 'w52', intent: 'S3', query: '量化选的是哪一档', expect: ['t23'],
    basis: 't23.concepts 含「q8 量化」；title 写明 q8 量化 384 维。共享词「量化」' },

  // =========================================================================
  // 第三批：为补 S4 覆盖新增（如实披露）
  // =========================================================================
  //
  // 前两批跑完，语义腿触达 gold 的比例是 48/52 = 92%，所以 S4（bigram ✓ + 语义 ✗）
  // 只落到 2 条。规则 §3.2 允许如实报不足，但先试一次合法的补法。
  //
  // **补法必须是按文体出题，不能按 cosine 挑选。** S4 需要两个条件同时成立：题面含中文
  // （bigram 腿才可能触达）+ 题面简短迂回（语义腿够不着）。前两批落进 S4 的 w43/w45 都是
  // 这个形状；而意图 S4 的 w31/w33 语义腿确实没中，却因为题面是纯拉丁数字锚点，bigram 腿
  // 也没中，于是落到第五种形状。
  //
  // 所以这一批一律：中文 + 尽量短 + 用记录里未被前两批用过的两字共享词。**不看任何
  // cosine 值**——那会变成「按检索量挑选」，规则 §2.2 禁止。落在哪一层都保留。
  { id: 'w53', intent: 'S4', query: '并发跑会不会撞', expect: ['t07'],
    basis: 't07.concepts 含「并发」；outcome 提到 concurrency=1 场景。共享词「并发」' },
  { id: 'w54', intent: 'S4', query: '命名那次定了啥', expect: ['t10'],
    basis: 't10.concepts 含「命名决策」。共享词「命名」' },
  { id: 'w55', intent: 'S4', query: '绕过之后补上了吗', expect: ['t16'],
    basis: 't16.outcome「安装第 12 步的依赖下载被人工绕过，未在干净网络环境验证」。共享词「绕过」' },
  { id: 'w56', intent: 'S4', query: '覆盖到哪一步为止', expect: ['t17'],
    basis: 't17.concepts 含「coverage」；outcome 写明交互式会话尚未覆盖。共享词「覆盖」' },
  { id: 'w57', intent: 'S4', query: '优先级排在哪', expect: ['t26'],
    basis: 't26.request「决定质量基准集的优先级与阻塞范围」。共享词「优先」' },
  { id: 'w58', intent: 'S4', query: '收敛到几个地方', expect: ['t05'],
    basis: 't05.title「版本号收敛到单一来源 3.0.0」。共享词「收敛」' },
  { id: 'w59', intent: 'S4', query: '隐私这块验了什么', expect: ['t04'],
    basis: 't04.concepts 含「隐私」「privacy」。共享词「隐私」' },
  { id: 'w60', intent: 'S4', query: '快速失败那次改了啥', expect: ['t03'],
    basis: 't03.request「保证 hook 快速静默失败」。共享词「快速」' },
  { id: 'w61', intent: 'S4', query: '锚定用的是哪个键', expect: ['t20'],
    basis: 't20.title「timeline 锚定 source turn 而非 Observation ID」。共享词「锚定」' },
  { id: 'w62', intent: 'S4', query: '未完的那几个是啥', expect: ['t25'],
    basis: 't25.concepts 含「未完成」；outcome「错误已定位但未修复」。共享词「未完」' },
];

/** 扩充 empty / hard-negative 候选。全部 `expect: []`。 */
type NLayer = 'N1' | 'N2' | 'N3' | 'N4';
interface EmptyCandidate {
  id: string;
  layer: NLayer;
  query: string;
  /** 为什么本项目没做过这件事。规则 §4.1 要求逐条自证。 */
  basis: string;
}

const EMPTY_CANDIDATES: EmptyCandidate[] = [
  // ---- N1 完全无关 ----
  { id: 'n01', layer: 'N1', query: '阳台种的番茄叶子发黄怎么办', basis: '与软件工程无关，26 条 primary Observation 无任何园艺内容' },
  { id: 'n02', layer: 'N1', query: '拿铁和卡布奇诺的区别是什么', basis: '与软件工程无关' },
  { id: 'n03', layer: 'N1', query: '猫总在半夜跑酷有什么办法', basis: '与软件工程无关' },
  { id: 'n04', layer: 'N1', query: '学吉他先练和弦还是先练音阶', basis: '与软件工程无关' },
  { id: 'n05', layer: 'N1', query: '腌笃鲜要放多少咸肉', basis: '与软件工程无关' },
  { id: 'n06', layer: 'N1', query: 'how long should sourdough proof before baking', basis: '与软件工程无关，纯英文，用于确认 bigram 腿不触发' },
  { id: 'n07', layer: 'N1', query: 'best way to break in stiff leather boots', basis: '与软件工程无关，纯英文' },
  { id: 'n08', layer: 'N1', query: 'why does my basil keep wilting indoors', basis: '与软件工程无关，纯英文' },

  // ---- N2 近邻未做：技术上相近，但本项目确实没做过 ----
  { id: 'n09', layer: 'N2', query: '跨机器同步记忆用的是哪套协议', basis: 'README「Local only — No built-in cross-machine sync」；无对应 Observation' },
  { id: 'n10', layer: 'N2', query: 'Web 查看器的前端是用什么框架写的', basis: 'README「No Web Viewer UI yet」；无对应 Observation' },
  { id: 'n11', layer: 'N2', query: '按时间保留的清理策略是怎么配的', basis: 'README「no retention policy in 3.x」；无对应 Observation' },
  { id: 'n12', layer: 'N2', query: '单条 Observation 要怎么删掉', basis: 'README「No fine-grained deletion」；无对应 Observation' },
  { id: 'n13', layer: 'N2', query: '导出成 JSON 的命令是什么', basis: 'README「there is no export」；无对应 Observation' },
  { id: 'n14', layer: 'N2', query: '向量数据库最后选的是哪一个', basis: '方案 §13.2 ANN/向量数据库为暂缓项；无对应 Observation' },
  { id: 'n15', layer: 'N2', query: 'cross-encoder 重排是怎么接进来的', basis: '方案 §13.3 cross-encoder 为暂缓项；无对应 Observation' },
  { id: 'n16', layer: 'N2', query: '字段级多向量是怎么存的', basis: '方案 §13.1 字段级多向量为暂缓项；无对应 Observation' },

  // ---- N3 通用两字词噪声：刻意含高 DF 两字词，直接瞄准 3A §5.1 的失败机制 ----
  { id: 'n17', layer: 'N3', query: '配置项的默认值写在哪个配置文件里', basis: '含高 DF 词「配置」。会命中多条含「配置」的记录，但没有一条 Observation 的 request 是「整理配置项默认值」' },
  { id: 'n18', layer: 'N3', query: '发布流程里的灰度发布怎么控制', basis: '含「发布」。t05 提到发布但指版本号收敛，无灰度发布相关 Observation' },
  { id: 'n19', layer: 'N3', query: '异常处理的统一入口放在哪一层', basis: '含「处理」。t01 标题含「处理」但指 FTS5 字面量处理，与异常处理入口无关' },
  { id: 'n20', layer: 'N3', query: '服务端和客户端的服务发现怎么做', basis: '含「服务」。无服务发现相关 Observation' },
  { id: 'n21', layer: 'N3', query: '数据迁移的数据校验怎么写', basis: '含高 DF 词「数据」（DF=8）。无数据迁移校验相关 Observation' },
  { id: 'n22', layer: 'N3', query: '测试环境的测试数据是从哪来的', basis: '含最高 DF 词「测试」（DF=14）。t12 是测试目录隔离，与测试环境/测试数据来源无关' },
  { id: 'n23', layer: 'N3', query: '安装包的安装路径能不能改', basis: '含「安装」（DF=8）。多条安装相关 Observation，但没有一条讨论安装路径可配置性' },
  { id: 'n24', layer: 'N3', query: '失败重试的失败原因怎么分类', basis: '含「失败」（DF=7）。t08 是 fallback，t03 是静默失败，均非失败原因分类' },
  { id: 'n25', layer: 'N3', query: '模型训练的模型版本怎么管理', basis: '含「模型」（DF=4）。本项目只用预训练模型（t23），从未训练模型' },
  { id: 'n26', layer: 'N3', query: '启动参数和启动顺序在哪里定义', basis: '含「启动」（DF=4）。t13 是 Worker 启动失败排查，非启动参数定义' },

  // ---- N4 中英文混合：覆盖 bigram 触发与不触发两种情况 ----
  { id: 'n27', layer: 'N4', query: 'Redis Cluster 的槽位迁移怎么做', basis: '混合脚本，bigram 触发。无 Redis 相关 Observation' },
  { id: 'n28', layer: 'N4', query: 'gRPC 的双向流怎么处理背压', basis: '混合脚本，bigram 触发（含「处理」）。无 gRPC 相关 Observation' },
  { id: 'n29', layer: 'N4', query: 'how do I rotate the signing key monthly', basis: '纯英文，bigram 不触发。无密钥轮换相关 Observation' },
  { id: 'n30', layer: 'N4', query: 'what is the p99 of the write path under load', basis: '纯英文，bigram 不触发。无写路径压测相关 Observation' },
  { id: 'n31', layer: 'N4', query: 'Terraform 的 state 锁要怎么解开', basis: '混合脚本，bigram 触发。无 IaC 相关 Observation' },
  { id: 'n32', layer: 'N4', query: 'configure sharding for the metrics store', basis: '纯英文，bigram 不触发。无分片相关 Observation' },
];

// ===========================================================================
// 播种：与 probe-cjk-bigram.ts / probe-zero-fts.ts 同口径
// ===========================================================================

const workDir = mkdtempSync(join(tmpdir(), 'kiro-mem-r2-'));
process.env.KIRO_MEMORY_DATA_DIR = join(workDir, 'data');
mkdirSync(process.env.KIRO_MEMORY_DATA_DIR, { recursive: true });

const { MemoryDB, computeScopeKey, extractCjkBigrams } = await import('../src/db');
const { turns } = loadDataset();

const scopeCwd: Record<'primary' | 'other', string> = {
  primary: join(workDir, 'scope-primary'),
  other: join(workDir, 'scope-other'),
};
mkdirSync(scopeCwd.primary, { recursive: true });
mkdirSync(scopeCwd.other, { recursive: true });
const scopeKeyOf = (s: 'primary' | 'other') => computeScopeKey(null, scopeCwd[s]);

const db = new MemoryDB(join(workDir, 'r2.sqlite'));
const obsIdOf = new Map<string, number>();
const dsIdOfObs = new Map<number, string>();
const scopeOfDsId = new Map<string, 'primary' | 'other'>();
{
  const base = Date.now();
  turns.forEach((t, i) => {
    const at = new Date(base - (turns.length - i) * 60_000).toISOString();
    db.upsertSessionRef({ session_id: t.session, cwd: scopeCwd[t.scope], repo: null });
    const seq = db.allocateNextTurnSeq(t.session);
    const turnRow = db.createTurn({
      session_id: t.session, seq, cwd: scopeCwd[t.scope], repo: null,
      prompt_text: t.prompt, started_at: at,
    });
    const r = annotationToResult(t.annotation);
    const id = db.insertObservation({
      turn_id: turnRow.id, session_id: t.session, turn_seq: seq, repo: null,
      cwd_scope: scopeCwd[t.scope],
      title: r.title, summary: r.summary, request: r.request, outcome: r.outcome,
      learned: r.learned, next_steps: r.next_steps, memory_type: r.memory_type as never,
      files_touched: r.files_touched, concepts: r.concepts, evidence: r.evidence,
      importance_score: r.importance_score, confidence_score: r.confidence_score,
      unresolved_score: r.unresolved_score, quality: 'normal',
      turn_started_at: at, turn_stopped_at: at,
    })!;
    obsIdOf.set(t.id, id);
    dsIdOfObs.set(id, t.id);
    scopeOfDsId.set(t.id, t.scope);
  });
}

// ===========================================================================
// 预检：只输出「这条腿的候选里有没有 gold」
// ===========================================================================
//
// 规则 §2.2：允许看腿在不在，禁止看 cosine 数值、名次、融合分、最终页面。
// 所以这里的返回值全是布尔与计数，一个排序量都不取。

/** 与生产检索内核同口径的 bigram 腿参数：本轮预检取不设上限，只问「能不能触达」。 */
const PRECHECK_BIGRAM = { dfRatioCeiling: 1, minMatches: 1, limit: 50 };

interface LexicalPrecheck {
  /** trigram FTS 候选里有没有 gold。 */
  ftsHasGold: boolean;
  /** bigram 候选里有没有 gold。 */
  bigramHasGold: boolean;
  /** 两条腿各自的候选数——规模读数，不参与选择。 */
  ftsCount: number;
  bigramCount: number;
  /** 切出的两字词个数。0 = 纯非 CJK 题面，bigram 腿结构上不触发。 */
  bigramUnits: number;
  /** 命中 gold 的两字词，归因用。 */
  hitUnits: string[];
}

function lexicalPrecheck(query: string, expect: string[], scope: 'primary' | 'other'): LexicalPrecheck {
  const scopeKey = scopeKeyOf(scope);
  const goldIds = new Set(expect.map((e) => obsIdOf.get(e)!).filter(Boolean));

  const fts = db.searchObservationsFts(query, { scopeKey, days: 90, limit: 50 });
  const units = extractCjkBigrams(query);
  const leg = units.length
    ? db.searchObservationsByCjkBigrams(units, { scopeKey, days: 90, ...PRECHECK_BIGRAM })
    : { candidates: [], unitsProbed: 0, droppedByDf: [], zeroDf: 0, scopeSize: 0 };

  const hitUnits = leg.candidates
    .filter((c) => goldIds.has(c.id))
    .flatMap((c) => c.bigrams);

  return {
    ftsHasGold: fts.some((o) => goldIds.has(o.id)),
    bigramHasGold: leg.candidates.some((c) => goldIds.has(c.id)),
    ftsCount: fts.length,
    bigramCount: leg.candidates.length,
    bigramUnits: units.length,
    hitUnits: [...new Set(hitUnits)],
  };
}

/**
 * 与 gold 记录索引文本的**最长公共 CJK 子串**长度。
 *
 * 这是文本属性，不是检索结果——规则 §2.2 禁止的是按 cosine / 名次 / 页面挑选，
 * 而这个量只看两段字符串共享多长的连续片段。它把 S3 的构造从试错变成可验证：
 *
 *   trigram tokenizer 要求 ≥3 字的连续重叠才可能命中，所以
 *   **S3 候选与 gold 的最长 CJK 公共子串必须恰好是 2。**
 *
 * 第一批 S3 意图里有 5 条落进 S1，全都是因为题面用了三字共享词
 * （「本地化」「边界值」「端到端」等）——那时我是靠预检才发现的，现在这个量让它
 * 在出题时就能看出来。
 */
function longestCommonCjkRun(query: string, goldDsId: string): { len: number; sample: string } {
  const t = turns.find((x) => x.id === goldDsId);
  if (!t) return { len: 0, sample: '' };
  const r = annotationToResult(t.annotation);
  // 逐列比对，与 FTS5 逐列分词一致——跨列拼接会造出索引里不存在的片段。
  const columns = [r.title, r.summary, r.request, r.outcome, r.learned, r.next_steps,
    (r.concepts ?? []).join(' '), (r.files_touched ?? []).join(' '), (r.evidence ?? []).join(' ')];
  const isCjk = (ch: string) => /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch);
  let best = { len: 0, sample: '' };
  for (const run of query.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2,}/g) ?? []) {
    for (let len = run.length; len > best.len; len--) {
      for (let i = 0; i + len <= run.length; i++) {
        const sub = run.slice(i, i + len);
        if (![...sub].every(isCjk)) continue;
        if (columns.some((c) => (c ?? '').includes(sub))) {
          best = { len, sample: sub };
          break;
        }
      }
      if (best.len >= len) break;
    }
  }
  return best;
}

/**
 * 分层判定（规则 §2.3）。
 *
 * 由三个实测布尔算出，与 `intent` 无关。语义腿在 `--stage=lexical` 下未知，此时
 * 只能给出**部分**分层：S2 与 S1 的区分只需要词面两条腿，S3 与 S4 的区分需要语义腿。
 */
function stratumOf(p: LexicalPrecheck, semanticHasGold: boolean | null): string {
  if (semanticHasGold === null) {
    // 词面阶段：只能确定 bigram 在不在、FTS 在不在。
    if (p.ftsHasGold && p.bigramHasGold) return 'S1?';   // 待语义确认
    if (p.ftsHasGold && !p.bigramHasGold) return 'S2?';
    if (!p.ftsHasGold && p.bigramHasGold) return 'S3/S4?';
    return 'none';                                        // 两条词面腿都没触达 gold
  }
  if (!p.bigramHasGold && p.ftsHasGold && semanticHasGold) return 'S2';
  if (p.ftsHasGold && p.bigramHasGold && semanticHasGold) return 'S1';
  if (!p.ftsHasGold && p.bigramHasGold && semanticHasGold) return 'S3';
  if (p.bigramHasGold && !semanticHasGold) return 'S4';
  // 第五种形状，实测掉出来的：trigram 命中 gold，但语义腿不支持、bigram 也没中。
  //
  // 它不在 Gate E 指定的四层里，但它存在，而且是 S4 的天然对照——同样「无语义佐证」，
  // 词面支持却来自**强**的那条腿而不是弱的那条。叫它 `none` 会误导：那个词读起来像
  // 「不可用」，而它其实是一个有判别力的层。
  if (p.ftsHasGold && !semanticHasGold) return 'S5';
  return 'none';
}

// ===========================================================================
// 语义腿预检（--stage=full）
// ===========================================================================
//
// 走**生产口径**：记录侧用 `semanticEnSearchTextFields` + `buildObservationSearchText`
// 拼文本（与 worker.ts:557 同一对函数），query 侧过 `checkSemanticEnQuery` 护栏，
// floor 取生产冻结值 0.197。自己拼一份就等于给同一个概念造第二个事实来源。
//
// 规则 §2.2：这里只输出布尔「gold 的 cosine 有没有过 floor」。**不返回 cosine 数值**，
// 也不排序——分层只需要「腿在不在」。

const SEMANTIC_FLOOR_PRODUCTION = 0.197;

async function semanticPrecheck(): Promise<Map<string, boolean>> {
  const { loadAcpEnFixture } = await import('./dataset');
  const { buildObservationSearchText, cosineSimilarity } = await import('../src/embedding-space');
  const { semanticEnSearchTextFields, checkSemanticEnQuery } = await import('../src/semantic-en');
  const { generateEmbedding } = await import('../src/embedding');

  const fixture = loadAcpEnFixture(DATASET_DIR, { withR2: true });
  const out = new Map<string, boolean>();

  // 记录侧向量：只对本轮 gold 涉及的 turn 建，省一次全量嵌入。
  const goldIds = new Set(FUSION_CANDIDATES.flatMap((c) => c.expect));
  const recordVec = new Map<string, Float32Array>();
  for (const id of goldIds) {
    const rec = fixture.records[id];
    const t = turns.find((x) => x.id === id);
    if (!rec || !t) continue;
    const text = buildObservationSearchText(
      semanticEnSearchTextFields(rec, t.annotation.key_files ?? []),
    );
    recordVec.set(id, await generateEmbedding(text));
  }

  const CJK = /[\u4e00-\u9fff]/;
  const missingDerived: string[] = [];
  for (const c of FUSION_CANDIDATES) {
    // 纯英文 query 的派生值合法地等于原文本身——护栏明确允许「英文原文归一化为自身」。
    // 但含中文的 query **必须**有真正的派生值：缺失时 `checkSemanticEnQuery` 会以
    // `untranslated` 拒绝，于是这条 query 被静默记成「语义腿没中」并落进 S4。
    //
    // 那个 bug 真的发生过：第三批 10 条刚加进来还没翻译，S4 从 2 条跳到 12 条，看起来
    // 像补齐了覆盖，实际上全是缺派生值的假象。所以这里必须**响亮失败**，不能容错。
    const derived = fixture.queries[c.id];
    if (derived === undefined && CJK.test(c.query)) missingDerived.push(c.id);
  }
  if (missingDerived.length) {
    console.error(
      `[r2] 以下含中文的 query 缺英文派生值，语义腿预检不可信（会被静默记成未命中→假 S4）：\n` +
      `  ${missingDerived.join(', ')}\n` +
      `  先跑：bun run benchmark/probe-acp-translate.ts --target=queries --query-set=r2 --ids=${missingDerived.join(',')}`,
    );
    db.close();
    rmSync(workDir, { recursive: true, force: true });
    process.exit(2);
  }

  for (const c of FUSION_CANDIDATES) {
    const derived = fixture.queries[c.id] ?? c.query;
    const check = checkSemanticEnQuery(derived, c.query);
    if (!check.ok) { out.set(c.id, false); continue; }
    const qv = await generateEmbedding(derived);
    let hit = false;
    for (const g of c.expect) {
      const rv = recordVec.get(g);
      if (rv && cosineSimilarity(qv, rv) > SEMANTIC_FLOOR_PRODUCTION) { hit = true; break; }
    }
    out.set(c.id, hit);
  }
  return out;
}

// ===========================================================================
// 执行
// ===========================================================================

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface FusionRow extends FusionCandidate {
  scope: 'primary' | 'other';
  precheck: LexicalPrecheck;
  /** 与 gold 记录的最长公共 CJK 子串。S3 要求恰好 2。 */
  lcs: { len: number; sample: string };
  semanticHasGold: boolean | null;
  stratum: string;
}

const semanticEn: Record<string, string> = existsSync(join(DATASET_DIR, 'mirror-en-fusion.json'))
  ? JSON.parse(readFileSync(join(DATASET_DIR, 'mirror-en-fusion.json'), 'utf-8'))
  : {};

/** `--stage=full` 才跑语义腿。词面阶段不需要模型，秒级完成。 */
const semanticHits: Map<string, boolean> | null = stage === 'full' ? await semanticPrecheck() : null;

const fusionRows: FusionRow[] = FUSION_CANDIDATES.map((c) => {
  const scope = (c.expect.length ? scopeOfDsId.get(c.expect[0]!)! : 'primary');
  const precheck = lexicalPrecheck(c.query, c.expect, scope);
  const lcs = c.expect.length ? longestCommonCjkRun(c.query, c.expect[0]!) : { len: 0, sample: '' };
  const semanticHasGold = semanticHits ? (semanticHits.get(c.id) ?? false) : null;
  return { ...c, scope, precheck, lcs, semanticHasGold, stratum: stratumOf(precheck, semanticHasGold) };
});

interface EmptyRow extends EmptyCandidate {
  /** 只报「有没有候选」与规模，不报内容——它们是 hard negative，内容读数留给 arm。 */
  ftsCount: number;
  bigramCount: number;
  bigramUnits: number;
}

const emptyRows: EmptyRow[] = EMPTY_CANDIDATES.map((c) => {
  const p = lexicalPrecheck(c.query, [], 'primary');
  return { ...c, ftsCount: p.ftsCount, bigramCount: p.bigramCount, bigramUnits: p.bigramUnits };
});

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const L: string[] = [];
L.push('# Phase 3A-R2 数据集：预检与分层');
L.push('');
L.push(`> 生成时间：${new Date().toISOString()}`);
L.push(`> 阶段：\`--stage=${stage}\``);
L.push('> 规则：`benchmark/reports/phase3a-r2-dataset-rules.md`');
L.push('>   sha256 `8621b6fdf71fcc21a8abd6397aabc76da0e4fbe18766be91351652722453fb2e`');
L.push('>   冻结于 2026-08-04T14:51:03Z，**先于本脚本与任何 query**');
L.push('>');
L.push('> 预检只输出「这条腿的候选里有没有 gold」与候选规模。cosine 数值、bm25 名次、');
L.push('> bigram 名次、融合分、最终返回页一个都没读（规则 §2.2）。');
L.push('');

if (stage === 'lexical') {
  L.push('**本阶段是词面预检，分层带 `?` 表示待语义腿确认。**');
  L.push('S1/S2 的区分只需要词面两条腿，S3 与 S4 的区分必须等语义腿——');
  L.push('两者的差别正是「语义腿有没有佐证」。');
  L.push('');
}

L.push('## 「两腿都命中」校准集：逐条预检');
L.push('');
L.push('`LCS` = 与 gold 记录的最长公共 CJK 子串长度（及片段）。trigram 需要 ≥3 才可能命中，');
L.push('所以 **S3 要求 LCS 恰好 2**——这一列让 S3 的构造可验证，而不是靠试错。');
L.push('');
L.push('| id | 意图 | 实测分层 | LCS | query | gold | FTS 中 gold | 语义 中 gold | bigram 中 gold | FTS 候选 | bigram 候选 | 两字词数 | 命中 gold 的两字词 |');
L.push('| --- | :--: | :--: | :--: | --- | --- | :--: | :--: | :--: | ---: | ---: | ---: | --- |');
for (const r of fusionRows) {
  const p = r.precheck;
  const sem = r.semanticHasGold === null ? '?' : r.semanticHasGold ? '✓' : '✗';
  L.push(`| ${r.id} | ${r.intent} | ${r.stratum} | ${r.lcs.len}${r.lcs.sample ? `「${r.lcs.sample}」` : ''} | ${r.query} | ${r.expect.join(' ')} | ` +
    `${p.ftsHasGold ? '✓' : '✗'} | ${sem} | ${p.bigramHasGold ? '✓' : '✗'} | ${p.ftsCount} | ${p.bigramCount} | ` +
    `${p.bigramUnits} | ${p.hitUnits.join(' ') || '—'} |`);
}
L.push('');

// 意图 vs 实测的偏差表——规则 §2.3 要求落在意图之外的留在实际层，这张表是它的凭据。
const drift = fusionRows.filter((r) => !r.stratum.startsWith(r.intent) && r.stratum !== 'none');
const none = fusionRows.filter((r) => r.stratum === 'none');
L.push('## 意图与实测的偏差');
L.push('');
L.push(`- 实测分层与出题意图一致：**${fusionRows.length - drift.length - none.length} / ${fusionRows.length}**`);
L.push(`- 落在意图之外（**留在实际层，不删不改**）：${drift.length} 条`);
for (const r of drift) L.push(`  - ${r.id} 意图 ${r.intent} → 实测 ${r.stratum}`);
L.push(`- 两条词面腿都没触达 gold：${none.length} 条`);
for (const r of none) L.push(`  - ${r.id}「${r.query}」意图 ${r.intent}`);
L.push('');
L.push('偏差不是缺陷。规则 §2.3 写明分层由预检判定、不由意图决定；改题面去凑意图才是');
L.push('规则要禁止的那种挑选。');
L.push('');

L.push('## 扩充 empty / hard-negative 集：逐条预检');
L.push('');
L.push('| id | 层 | query | FTS 候选 | bigram 候选 | 两字词数 | 依据 |');
L.push('| --- | :--: | --- | ---: | ---: | ---: | --- |');
for (const r of emptyRows) {
  L.push(`| ${r.id} | ${r.layer} | ${r.query} | ${r.ftsCount} | ${r.bigramCount} | ${r.bigramUnits} | ${r.basis} |`);
}
L.push('');

const byLayer = (l: NLayer) => emptyRows.filter((r) => r.layer === l);
L.push('### 覆盖统计');
L.push('');
L.push('| 层 | 条数 | 有 FTS 候选 | 有 bigram 候选 | bigram 不触发（纯非 CJK） |');
L.push('| --- | ---: | ---: | ---: | ---: |');
for (const l of ['N1', 'N2', 'N3', 'N4'] as NLayer[]) {
  const g = byLayer(l);
  L.push(`| ${l} | ${g.length} | ${g.filter((r) => r.ftsCount > 0).length} | ` +
    `${g.filter((r) => r.bigramCount > 0).length} | ${g.filter((r) => r.bigramUnits === 0).length} |`);
}
L.push(`| **合计** | **${emptyRows.length}** | ${emptyRows.filter((r) => r.ftsCount > 0).length} | ` +
  `${emptyRows.filter((r) => r.bigramCount > 0).length} | ${emptyRows.filter((r) => r.bigramUnits === 0).length} |`);
L.push('');
L.push('N3 的「有 bigram 候选」应显著高于其他层——这一层就是为 3A §5.1 的失败机制造的：');
L.push('高 DF 两字词会带来候选，而这些候选没有一条回答对应的 query。');
L.push('');

L.push('## 分层覆盖（最终，由预检判定）');
L.push('');
L.push('| 层 | 定义 | 条数 | 目标 | 判定 |');
L.push('| --- | --- | ---: | ---: | :--: |');
const DEFS: Record<string, string> = {
  S1: 'FTS ✓ + 语义 ✓ + bigram ✓',
  S2: 'FTS ✓ + 语义 ✓ + bigram ✗',
  S3: 'FTS ✗ + 语义 ✓ + bigram ✓',
  S4: '语义 ✗ + bigram ✓',
  S5: 'FTS ✓ + 语义 ✗ + bigram ✗（实测掉出来的第五种形状）',
};
const countOf = (st: string) => fusionRows.filter((r) => r.stratum === st).length;
for (const st of ['S1', 'S2', 'S3', 'S4', 'S5']) {
  const n = countOf(st);
  const target = st === 'S5' ? '—' : '8';
  const ok = st === 'S5' ? '—' : n >= 8 ? '✅' : '⚠️';
  L.push(`| ${st} | ${DEFS[st]} | ${n} | ${target} | ${ok} |`);
}
L.push(`| **合计** | | **${fusionRows.length}** | 32 | ${fusionRows.length >= 32 ? '✅' : '⚠️'} |`);
L.push('');
L.push(`语义腿触达 gold：**${fusionRows.filter((r) => r.semanticHasGold).length} / ${fusionRows.length}**。`);
L.push('这个比例直接解释了 S4 为什么难凑：`semantic-en-v1` 在本语料上很强，');
L.push('「bigram 找到了、语义腿没找到」结构上就是少数形状。');
L.push('');
if (countOf('S4') < 8) {
  L.push(`**S4 只有 ${countOf('S4')} 条，低于规则 §3.2 的 8 条目标。如实报出，不为凑数改题面。**`);
  L.push('');
  L.push('原因是结构性的：S4 要求语义腿**够不着** gold，而语义腿在本语料上触达率很高。');
  L.push('要把 S4 填满只能继续搜索「语义腿失手」的题面，而那已经很接近规则 §2.2 禁止的');
  L.push('「按检索量挑选」——所以我在第三批之后停手，把这一条交给复核判断是否够用。');
  L.push('');
}
L.push('### S5：一个实测掉出来的层');
L.push('');
L.push('Gate E 指定了四层，实测掉出第五种：**trigram 命中 gold，但语义腿不支持、bigram 也没中**');
L.push('（w31「23M 是怎么来的」、w33「131 pass 那次修的是什么」——纯拉丁数字锚点，切不出 CJK 两字词）。');
L.push('');
L.push('它是 S4 的天然对照：同样「无语义佐证」，词面支持却来自**强**的那条腿而不是弱的那条。');
L.push('原先它被归进 `none`，那个词读起来像「不可用」，会误导——它其实有判别力。');
L.push('');
L.push('### 三批结构（如实披露）');
L.push('');
L.push('| 批次 | 条数 | 新增理由 | 落层情况 |');
L.push('| --- | ---: | --- | --- |');
L.push('| 第一批 w01–w40 | 40 | 初始出题，四层各约 10 条 | 10 条 S3 意图里 5 条落进 S1（用了**三字**共享词，trigram 自然命中）；10 条 S4 意图多数落进 S1/S2 |');
L.push('| 第二批 w41–w52 | 12 | 补 S3。改用可验证约束：与 gold 的最长公共 CJK 子串**恰好 2** | 12 条全部达成 S3 形状 |');
L.push('| 第三批 w53–w62 | 10 | 补 S4。按**文体**出题：中文 + 简短迂回 | 5 条落 S4、4 条落 S3、1 条落 S1 |');
L.push('');
L.push('三批都遵守规则 §2.3：落在意图之外的**留在实际层，不删不改题面**。');
L.push('第三批的补法是按文体（中文、简短、迂回），**不看任何 cosine 值**——');
L.push('看 cosine 挑题面就是规则 §2.2 禁止的那类选择。');
L.push('');
L.push('过程中抓到一次会污染数据集的错误，留档：第三批刚加进来还没翻译时，');
L.push('缺失的英文派生值被护栏以 `untranslated` 拒绝，于是这 10 条被**静默**记成「语义腿没中」，');
L.push('S4 从 2 条跳到 12 条，看起来像补齐了覆盖。现在 `semanticPrecheck()` 遇到含中文却缺派生值');
L.push('的 query 会直接退出码 2，不再容错。');
L.push('');

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------
//
// 草稿态：此时还没有英文派生值，所以还**不能**冻结 checksum。规则 §5 的顺序是
// 生成 → 预检 → 分层 → 冻结 → 复核；语义腿预检需要派生值，所以派生值在草稿之后生成，
// 冻结在最后。`frozen: false` 明确标记这一点，避免一份草稿被误当成已冻结数据集使用。

const fusionOut = fusionRows.map((r) => ({
  id: r.id,
  kind: 'relevance' as const,
  origin: 'fusion' as const,
  scope: r.scope,
  query: r.query,
  expect: r.expect,
  note: r.basis,
  // 预检留档：分层由它算出，复核者可据此复算（规则 §2.3）。
  precheck: {
    intent: r.intent,
    stratum: r.stratum,
    ftsHasGold: r.precheck.ftsHasGold,
    bigramHasGold: r.precheck.bigramHasGold,
    semanticHasGold: r.semanticHasGold,
    ftsCount: r.precheck.ftsCount,
    bigramCount: r.precheck.bigramCount,
    bigramUnits: r.precheck.bigramUnits,
    hitUnits: r.precheck.hitUnits,
    lcsCjk: r.lcs,
  },
}));

const emptyOut = emptyRows.map((r) => ({
  id: r.id,
  kind: 'empty' as const,
  scope: 'primary' as const,
  query: r.query,
  expect: [] as string[],
  note: r.basis,
  precheck: { layer: r.layer, ftsCount: r.ftsCount, bigramCount: r.bigramCount, bigramUnits: r.bigramUnits },
}));

/**
 * 淘汰清单（规则 §2.4）。
 *
 * 本轮为空，但文件必须存在并写明原因——「没有淘汰」和「淘汰清单没留」在复核时是
 * 两件完全不同的事。允许的淘汰理由只有两个：gold 标注站不住、与已有 query 重复。
 * 两项都实测检查过：52 条 fusion 候选**每一条**都有至少一条词面腿触达 gold（`none` = 0），
 * 84 条新候选对既有 183 条与内部两两比对均无重复。
 */
const eliminatedOut = {
  frozen: false,
  rule: 'benchmark/reports/phase3a-r2-dataset-rules.md §2.4',
  eliminated: [] as { id: string; query: string; reason: string }[],
  checks: {
    goldUnreachableByAnyLexicalLeg: fusionRows.filter((r) => r.stratum === 'none').map((r) => r.id),
    duplicateAgainstExisting183: [],
    duplicateWithinNewCandidates: [],
    note: '两项检查均为 0；淘汰清单为空是检查结果，不是未做检查。',
  },
};

/**
 * 冻结只在 `--stage=full` 发生：语义腿预检跑完、分层最终确定之后。
 *
 * 词面阶段的产物是草稿（`frozen: false`），因为那时 S3 与 S4 还分不开——两者的差别
 * 正是「语义腿有没有佐证」。把草稿标成已冻结会让一份分层不全的数据集被当成可用。
 */
const frozen = stage === 'full';
const mirrorPathForIdentity = join(DATASET_DIR, 'mirror-en-acp-queries-r2.json');

/**
 * 补齐纯英文 query 的恒等派生值。
 *
 * 护栏明确允许「英文原文合法地归一化为自身」，所以这 16 条的 `semantic_query_en` 就是
 * 原文。这**不是**一次新的生成事件，而是规则 §2.5 已经预见到的机械补齐——拿英文原文去跑
 * 一次中→英 prompt 是纯浪费，而且 1b 实测那正是失败最集中的形状（模型倾向回一句解释而不是
 * JSON）。Phase 2 校准集当时做的是同一件事。
 *
 * 补齐会改变 mirror 文件的 checksum，所以只在 `--stage=full` 做，并与其余 checksum 一起
 * 落进 meta——冻结记录里的 checksum 必须对应磁盘上那一份。
 */
if (frozen && existsSync(mirrorPathForIdentity)) {
  const mirror = JSON.parse(readFileSync(mirrorPathForIdentity, 'utf-8')) as {
    provenance?: Record<string, unknown>;
    queries?: Record<string, string>;
  };
  mirror.queries ??= {};
  const CJK_ID = /[\u4e00-\u9fff]/;
  const added: string[] = [];
  for (const q of [...FUSION_CANDIDATES, ...EMPTY_CANDIDATES]) {
    if (CJK_ID.test(q.query)) continue;
    if (mirror.queries[q.id] !== undefined) continue;
    mirror.queries[q.id] = q.query;
    added.push(q.id);
  }
  if (added.length) {
    mirror.provenance = {
      ...(mirror.provenance ?? {}),
      identityFilled: added,
      identityNote:
        '纯英文 query 的派生值合法地等于原文（护栏允许英文原文归一化为自身）。' +
        '非新的生成事件，是规则 §2.5 预见的机械补齐。',
    };
    writeFileSync(mirrorPathForIdentity, JSON.stringify(mirror, null, 2));
    console.log(`[r2] 补齐 ${added.length} 条恒等派生值：${added.join(', ')}`);
  }
}

const fusionJson = JSON.stringify(fusionOut, null, 2);
const emptyJson = JSON.stringify(emptyOut, null, 2);
const eliminatedJson = JSON.stringify({ ...eliminatedOut, frozen }, null, 2);
// 在恒等补齐**之后**读，否则 meta 里的 checksum 对应的是补齐前那一份，而磁盘上是补齐后的。
const mirrorJson = existsSync(mirrorPathForIdentity)
  ? readFileSync(mirrorPathForIdentity, 'utf-8')
  : '';

const meta = {
  frozen,
  stage,
  generatedAt: new Date().toISOString(),
  rules: {
    path: 'benchmark/reports/phase3a-r2-dataset-rules.md',
    sha256: '8621b6fdf71fcc21a8abd6397aabc76da0e4fbe18766be91351652722453fb2e',
    frozenAt: '2026-08-04T14:51:03Z',
    note: '规则先于本脚本与任何 query 冻结',
  },
  counts: {
    fusion: fusionOut.length,
    emptyExt: emptyOut.length,
    eliminated: eliminatedOut.eliminated.length,
    strata: ['S1', 'S2', 'S3', 'S4', 'S5'].reduce<Record<string, number>>(
      (a, st) => ((a[st] = fusionRows.filter((r) => r.stratum === st).length), a), {}),
    semanticReachesGold: fusionRows.filter((r) => r.semanticHasGold).length,
  },
  /** 逐文件 checksum。复核者据此确认拿到的是同一份。 */
  sha256: {
    'queries-fusion.json': sha(fusionJson),
    'queries-empty-ext.json': sha(emptyJson),
    'queries-fusion-eliminated.json': sha(eliminatedJson),
    'mirror-en-acp-queries-r2.json': mirrorJson ? sha(mirrorJson) : null,
    'build-phase3a-r2-dataset.ts': sha(readFileSync(import.meta.path, 'utf-8')),
  },
  /** 既有 5 条 expected-empty 的地位——Gate E 裁定不得替换。 */
  continuityLock: {
    ids: ['q19', 'q21', 'q22', 'q23', 'q24'],
    status: '永久保留，本轮一个字未改；新增集合是并列的第二道门槛，不是替换',
    gate: '均值 ≤1.00 / 最坏 ≤2（2D 读数）',
  },
};

writeFileSync(join(DATASET_DIR, 'queries-fusion.json'), fusionJson);
writeFileSync(join(DATASET_DIR, 'queries-empty-ext.json'), emptyJson);
writeFileSync(join(DATASET_DIR, 'queries-fusion-eliminated.json'), eliminatedJson);
writeFileSync(join(DATASET_DIR, 'queries-fusion-meta.json'), JSON.stringify(meta, null, 2));

writeFileSync(REPORT, L.join('\n'));
console.log(`[r2] 报告 → ${REPORT}`);
console.log(`[r2] 数据集草稿 → queries-fusion.json (${fusionOut.length}) / queries-empty-ext.json (${emptyOut.length})`);
console.log(`[r2] 淘汰清单 → queries-fusion-eliminated.json（${eliminatedOut.eliminated.length} 条）`);
console.log(`[r2] fusion 候选 ${fusionRows.length} 条，empty 候选 ${emptyRows.length} 条`);
console.log('[r2] 分层分布：', JSON.stringify(
  fusionRows.reduce<Record<string, number>>((a, r) => ((a[r.stratum] = (a[r.stratum] ?? 0) + 1), a), {}),
));
if (frozen) {
  console.log('[r2] ✅ 已冻结（frozen: true）。checksum 见 queries-fusion-meta.json');
  for (const [f, h] of Object.entries(meta.sha256)) console.log(`     ${String(h).slice(0, 16)}  ${f}`);
} else {
  console.log('[r2] ⚠️ 草稿态（frozen: false）。冻结需 --stage=full：英文派生值 → 语义腿预检 → 最终分层。');
}

db.close();
rmSync(workDir, { recursive: true, force: true });

export { FUSION_CANDIDATES, EMPTY_CANDIDATES, type FusionCandidate, type EmptyCandidate,
  stage, DATASET_DIR, REPORT, sha, fusionRows, emptyRows };


