#!/usr/bin/env bun
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import * as readline from 'readline';
import {
  registerService,
  removeService,
  start,
  stop,
  status,
  ansi,
} from './service';
import type { Language } from '../src/config';
import { t } from '../src/i18n';

const HOME = process.env.HOME || '~';
const DATA_DIR = join(HOME, '.kiro-mem');
const AGENT_DIR = join(HOME, '.kiro', 'agents');
const SRC_DIR = resolve(import.meta.dir, '../src');

// --- Resolve language from existing config or default ---

function resolveLanguage(): Language {
  try {
    const raw = JSON.parse(
      readFileSync(join(DATA_DIR, 'config.json'), 'utf-8'),
    );
    if (raw.language === 'en') return 'en';
  } catch {}
  return 'zh';
}

let lang: Language = resolveLanguage();
let m = t(lang);

const command = process.argv[2] || 'help';
const EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const HF_REMOTE_HOST = 'https://huggingface.co/';
const HF_MIRROR_REMOTE_HOST = 'https://hf-mirror.com/';

switch (command) {
  case 'install':
    await install();
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'config':
    await configCmd();
    break;
  case 'status':
    status(lang);
    break;
  case 'start':
    start(lang);
    break;
  case 'stop':
    stop(lang);
    break;
  case 'diagnose':
    diagnose();
    break;
  default:
    help();
}

// --- Interactive prompts ---

function createRL(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(
  rl: readline.Interface,
  question: string,
  defaultVal?: string,
): Promise<string> {
  const suffix = defaultVal ? ` (${m.default} ${defaultVal})` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function askRequired(
  rl: readline.Interface,
  question: string,
  defaultVal?: string,
): Promise<string> {
  const suffix = defaultVal ? ` (${m.default} ${defaultVal})` : '';
  return new Promise((resolve) => {
    const doAsk = () => {
      rl.question(`${question}${suffix}: `, (answer) => {
        const val = answer.trim() || defaultVal || '';
        if (!val) {
          console.log(`  ${m.required}`);
          doAsk();
          return;
        }
        resolve(val);
      });
    };
    doAsk();
  });
}

function askChoice(
  rl: readline.Interface,
  question: string,
  choices: string[],
): Promise<number> {
  return new Promise((resolve) => {
    console.log(`\n? ${question}`);
    choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    rl.question('> ', (answer) => {
      const idx = parseInt(answer.trim()) - 1;
      resolve(idx >= 0 && idx < choices.length ? idx : 0);
    });
  });
}

async function collectConfig(rl: readline.Interface, language: Language) {
  const cm = t(language);
  const providers = [
    {
      name: 'Anthropic (Claude)',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
    },
    { name: 'OpenAI (GPT)', provider: 'openai', defaultModel: 'gpt-5.4' },
    {
      name: cm.providerOllama,
      provider: 'ollama',
      defaultModel: 'qwen2.5:14b',
    },
    { name: cm.providerCustom, provider: 'custom', defaultModel: '' },
  ];

  const choice = await askChoice(
    rl,
    cm.chooseProvider,
    providers.map((p) => p.name),
  );
  const selected = providers[choice] ?? providers[0]!;

  const model = await askRequired(rl, cm.modelName, selected.defaultModel);

  let apiKey = '';
  if (selected.provider !== 'ollama') {
    apiKey = await askRequired(rl, cm.apiKey);
  }

  let baseUrl: string | null = null;
  if (selected.provider === 'custom') {
    baseUrl = await askRequired(rl, cm.baseUrlCustom);
  } else if (selected.provider === 'ollama') {
    baseUrl = await askRequired(
      rl,
      cm.baseUrlOllama,
      'http://localhost:11434/v1',
    );
    apiKey = 'ollama';
  }

  const concurrencyInput = parseInt(await ask(rl, cm.concurrency, '6'));
  const concurrency = Math.min(
    10,
    Math.max(5, isNaN(concurrencyInput) ? 6 : concurrencyInput),
  );

  return {
    language,
    worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
    compression: {
      provider: selected.provider,
      model,
      apiKey,
      baseUrl,
      maxTokens: 800,
      temperature: 0.1,
      concurrency,
    },
    context: {
      maxMemories: 50,
      maxOutputBytes: 8192,
      includePinned: true,
      includeSummary: false,
    },
    filter: {
      skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
    },
  };
}

// --- Config validation ---

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidProvider(provider: string): boolean {
  return ['anthropic', 'openai', 'ollama', 'custom'].includes(provider);
}

function buildEmbeddingPrefetchScript(remoteHost: string): string {
  return `
    import { env, pipeline } from '@huggingface/transformers';

    env.allowRemoteModels = true;
    env.remoteHost = ${JSON.stringify(remoteHost)};
    env.remotePathTemplate = '{model}/resolve/{revision}/';

    await pipeline('feature-extraction', ${JSON.stringify(EMBEDDING_MODEL_ID)}, {
      dtype: 'fp32',
    });
  `;
}

function formatSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  const parts: string[] = [];
  if (typeof result.status === 'number') parts.push(`exit=${result.status}`);
  if (result.signal) parts.push(`signal=${result.signal}`);

  const stderr = result.stderr?.toString().trim();
  if (stderr) {
    const compact = stderr.split('\n').slice(-3).join(' | ');
    parts.push(`stderr=${compact}`);
  }

  const stdout = result.stdout?.toString().trim();
  if (!stderr && stdout) {
    const compact = stdout.split('\n').slice(-3).join(' | ');
    parts.push(`stdout=${compact}`);
  }

  return parts.join(', ') || 'unknown error';
}

function getDefaultConfig(compression: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string | null;
  concurrency?: number;
}) {
  return {
    language: 'zh' as Language,
    worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
    compression: {
      provider: compression.provider,
      model: compression.model,
      apiKey: compression.apiKey || '',
      baseUrl: compression.baseUrl ?? null,
      maxTokens: 800,
      temperature: 0.1,
      concurrency: Math.min(
        10,
        Math.max(5, Number(compression.concurrency) || 6),
      ),
    },
    context: {
      maxMemories: 50,
      maxOutputBytes: 8192,
      includePinned: true,
      includeSummary: false,
    },
    filter: {
      skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
    },
  };
}

function loadExistingConfig(
  configPath: string,
): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    if (!isRecord(raw)) return null;
    const compression = isRecord(raw.compression) ? raw.compression : null;
    if (!compression) return null;
    const provider = compression.provider;
    const model = compression.model;
    const apiKey = compression.apiKey;
    const baseUrl = compression.baseUrl;
    const concurrency = compression.concurrency;
    if (typeof provider !== 'string' || !isValidProvider(provider)) return null;
    if (typeof model !== 'string' || !model.trim()) return null;
    switch (provider) {
      case 'anthropic':
      case 'openai':
        if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
        break;
      case 'custom':
        if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
        if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
        break;
      case 'ollama':
        if (typeof baseUrl !== 'string' || !baseUrl.trim()) return null;
        break;
    }
    const defaults = getDefaultConfig({
      provider,
      model,
      apiKey: typeof apiKey === 'string' ? apiKey : '',
      baseUrl: typeof baseUrl === 'string' ? baseUrl : null,
      concurrency:
        typeof concurrency === 'number' ? concurrency : Number(concurrency),
    });
    return {
      ...defaults,
      language: raw.language === 'en' ? 'en' : 'zh',
      compression: {
        ...defaults.compression,
        ...(isRecord(raw.compression) ? raw.compression : {}),
      },
      context: {
        ...defaults.context,
        ...(isRecord(raw.context) ? raw.context : {}),
      },
      filter: {
        ...defaults.filter,
        ...(isRecord(raw.filter) ? raw.filter : {}),
      },
    };
  } catch {
    return null;
  }
}

// --- Commands ---

async function install() {
  const configPath = join(DATA_DIR, 'config.json');
  const existing = loadExistingConfig(configPath);
  const installText = existing
    ? t((existing.language === 'en' ? 'en' : 'zh') as Language).installing
    : 'Installing...';
  console.log(`${ansi.bold('[kiro-mem]')} ${installText}\n`);

  // 1. Check bun
  const bunCheck = spawnSync('bun', ['--version']);
  if (bunCheck.status !== 0) {
    console.error(
      `${ansi.err('✗')} ${m.bunRequired} ${ansi.cyan('https://bun.sh')}`,
    );
    process.exit(1);
  }
  console.log(
    `${ansi.ok('✓')} Bun ${ansi.cyan(bunCheck.stdout.toString().trim())}`,
  );

  // 2. Config — reuse existing if valid, otherwise interactive
  let config: Awaited<ReturnType<typeof collectConfig>>;
  if (existing) {
    const cp = (
      existing as { compression: { provider: string; model: string } }
    ).compression;
    lang = (existing.language === 'en' ? 'en' : 'zh') as Language;
    m = t(lang);
    console.log(`${ansi.ok('✓')} ${m.reusingConfig} ${ansi.dim(m.reusing)}`);
    console.log(
      `  ${m.provider} ${ansi.cyan(cp.provider)}, ${m.model} ${ansi.cyan(cp.model)}`,
    );
    config = existing as typeof config;
  } else {
    const rl = createRL();
    // Ask language first
    const langChoice = await askChoice(rl, t('en').chooseLanguageBootstrap, [
      t('en').langEn,
      t('zh').langZh,
    ]);
    lang = langChoice === 0 ? 'en' : 'zh';
    m = t(lang);
    config = await collectConfig(rl, lang);
    rl.close();
  }

  // 3. Create directories
  for (const dir of [
    DATA_DIR,
    join(DATA_DIR, 'hooks'),
    join(DATA_DIR, 'server'),
    join(DATA_DIR, 'logs'),
    AGENT_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log(`\n${ansi.ok('✓')} ${m.created} ${ansi.dim(DATA_DIR)}`);

  // 4. Save config
  writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`${ansi.ok('✓')} ${m.configSaved}`);

  // 5. Copy hooks
  for (const hook of [
    'context.ts',
    'prompt-save.ts',
    'observation.ts',
    'stop.ts',
  ]) {
    copyFileSync(join(SRC_DIR, 'hooks', hook), join(DATA_DIR, 'hooks', hook));
    chmodSync(join(DATA_DIR, 'hooks', hook), 0o755);
  }
  console.log(`${ansi.ok('✓')} ${m.hooksInstalled}`);

  // 6. Copy server & source files
  mkdirSync(join(DATA_DIR, 'src', 'server'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'src', 'db'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'src', 'jobs'), { recursive: true });
  for (const file of ['worker.ts', 'mcp-server.ts']) {
    copyFileSync(
      join(SRC_DIR, 'server', file),
      join(DATA_DIR, 'src', 'server', file),
    );
  }
  for (const file of ['schema.ts', 'types.ts', 'index.ts', 'scope.ts']) {
    copyFileSync(join(SRC_DIR, 'db', file), join(DATA_DIR, 'src', 'db', file));
  }
  for (const file of ['runner.ts', 'artifacts.ts', 'index.ts']) {
    copyFileSync(
      join(SRC_DIR, 'jobs', file),
      join(DATA_DIR, 'src', 'jobs', file),
    );
  }
  for (const file of [
    'compressor.ts',
    'embedding.ts',
    'context-builder.ts',
    'config.ts',
    'logger.ts',
    'i18n.ts',
  ]) {
    copyFileSync(join(SRC_DIR, file), join(DATA_DIR, 'src', file));
  }
  console.log(`${ansi.ok('✓')} ${m.serverFilesInstalled}`);

  // 7. Copy prompt
  copyFileSync(
    join(SRC_DIR, 'agent', 'prompt.md'),
    join(DATA_DIR, 'prompt.md'),
  );
  console.log(`${ansi.ok('✓')} ${m.promptInstalled}`);

  // 8. Install agent config
  const agentTemplate = readFileSync(
    join(SRC_DIR, 'agent', 'kiro-mem.json'),
    'utf-8',
  );
  writeFileSync(
    join(AGENT_DIR, 'kiro-mem.json'),
    agentTemplate.replaceAll('__KIRO_MEMORY_DIR__', DATA_DIR),
  );
  console.log(`${ansi.ok('✓')} ${m.agentConfigInstalled}`);

  // 9. Install dependencies
  const pkgPath = join(DATA_DIR, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: 'kiro-mem-server',
          private: true,
          type: 'module',
          dependencies: {
            hono: '^4.12.0',
            '@anthropic-ai/sdk': '^0.90.0',
            '@huggingface/transformers': '^4.2.0',
            '@modelcontextprotocol/sdk': '^1.29.0',
          },
        },
        null,
        2,
      ),
    );
  }
  const r = spawnSync('bun', ['install'], { cwd: DATA_DIR, stdio: 'pipe' });
  if (r.status === 0) console.log(`${ansi.ok('✓')} ${m.depsInstalled}`);
  else {
    console.log(
      `${ansi.err('✗')} ${m.depsFailed} ${ansi.cyan('cd ~/.kiro-mem && bun install')}`,
    );
    process.exit(1);
  }

  // 10. Pre-download embedding model (required)
  console.log(
    `  ⏳ ${m.embDownloading}`,
  );
  const directScript = buildEmbeddingPrefetchScript(HF_REMOTE_HOST);
  const mirrorScript = buildEmbeddingPrefetchScript(HF_MIRROR_REMOTE_HOST);

  let embOk = false;
  let directFailure = '';
  let mirrorFailure = '';
  // 尝试 1：直连（或继承用户的代理环境变量）
  const try1 = spawnSync('bun', ['-e', directScript], {
    cwd: DATA_DIR,
    stdio: 'pipe',
    timeout: 120000,
  });
  if (try1.status === 0) {
    embOk = true;
  } else {
    directFailure = formatSpawnFailure(try1);
    // 尝试 2：使用国内镜像
    const try2 = spawnSync('bun', ['-e', mirrorScript], {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 120000,
    });
    if (try2.status === 0) {
      embOk = true;
    } else {
      mirrorFailure = formatSpawnFailure(try2);
    }
  }

  if (embOk) {
    console.log(
      `${ansi.ok('✓')} ${m.embCached}`,
    );
  } else {
    console.error(
      `${ansi.err('✗')} ${m.embFailed}`,
    );
    if (directFailure) {
      console.error(
        `  ${m.embDirectFailure} ${ansi.dim(directFailure)}`,
      );
    }
    if (mirrorFailure) {
      console.error(
        `  ${m.embMirrorFailure} ${ansi.dim(mirrorFailure)}`,
      );
    }
    console.error(
      `  ${m.embRetryHint} ${ansi.cyan('bun run scripts/setup.ts install')}`,
    );
    process.exit(1);
  }

  // 11. Register system service & start worker
  const msg = registerService(lang);
  console.log(`${ansi.ok('✓')} ${msg}`);
  start(lang);

  console.log(`\n${ansi.ok('✅')} ${ansi.bold(m.installed)}`);
  console.log(
    `   ${m.setDefault} ${ansi.cyan('kiro-cli settings chat.defaultAgent kiro-mem')}`,
  );
  console.log(`   ${m.orSwitch} ${ansi.cyan('/agent kiro-mem')}`);
}

function uninstall() {
  const purge = process.argv[3] === '--purge';
  removeService();
  stop(lang);

  const agentPath = join(AGENT_DIR, 'kiro-mem.json');
  if (existsSync(agentPath)) rmSync(agentPath);

  if (purge) {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });
    console.log(
      `${ansi.ok('✅')} ${ansi.bold(m.removedAll)} ${ansi.dim(m.allDataDeleted)}`,
    );
  } else {
    for (const dir of ['hooks', 'src', 'server', 'node_modules', 'logs']) {
      const p = join(DATA_DIR, dir);
      if (existsSync(p)) rmSync(p, { recursive: true });
    }
    for (const f of [
      'prompt.md',
      'package.json',
      'bun.lock',
      '.worker.pid',
      '.worker.port',
    ]) {
      const p = join(DATA_DIR, f);
      if (existsSync(p)) rmSync(p);
    }
    console.log(
      `${ansi.ok('✅')} ${ansi.bold(m.uninstalled)} ${ansi.dim(m.dbPreserved)}`,
    );
    console.log(`   ${m.purgeHint} ${ansi.cyan('kiro-mem uninstall --purge')}`);
  }
}

async function configCmd() {
  const configPath = join(DATA_DIR, 'config.json');
  const showOnly = process.argv[3] === '--show';

  if (!existsSync(configPath)) {
    console.log(
      `${ansi.err('✗')} ${m.notInstalled} ${ansi.cyan('kiro-mem install')}`,
    );
    return;
  }

  if (showOnly) {
    const current = JSON.parse(readFileSync(configPath, 'utf-8'));
    const c = current.compression || {};
    console.log(ansi.bold(m.currentConfig));
    console.log(`  ${m.language}   ${ansi.cyan(current.language || 'zh')}`);
    console.log(`  ${m.provider}   ${ansi.cyan(c.provider || 'anthropic')}`);
    console.log(`  ${m.model}     ${ansi.cyan(c.model || m.notSet)}`);
    console.log(
      `  ${m.apiKeyLabel}  ${c.apiKey ? ansi.dim(c.apiKey.slice(0, 8) + '...') : ansi.err(m.notSet)}`,
    );
    console.log(`  ${m.baseUrl} ${ansi.cyan(c.baseUrl || m.defaultVal)}`);
    console.log(
      `  ${m.concurrencyLabel}   ${ansi.cyan(String(c.concurrency || 6))}`,
    );
    return;
  }

  console.log(`${m.modifyConfig}\n`);
  const rl = createRL();

  // Ask language
  const langChoice = await askChoice(rl, m.chooseLanguage, [
    m.langZh,
    m.langEn,
  ]);
  const newLang: Language = langChoice === 1 ? 'en' : 'zh';
  lang = newLang;
  m = t(lang);

  const newConfig = await collectConfig(rl, newLang);
  rl.close();

  const current = JSON.parse(readFileSync(configPath, 'utf-8'));
  const merged = {
    ...current,
    language: newLang,
    compression: newConfig.compression,
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  console.log(`\n${ansi.ok('✓')} ${m.configUpdated}`);

  stop(lang);
  start(lang);
  console.log(`${ansi.ok('✓')} ${m.workerRestarted}`);
}

function diagnose() {
  // 中文字符占 2 列宽度的 padEnd
  const cjkWidth = (s: string) =>
    [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x7f ? 2 : 1), 0);
  const padLabel = (s: string, width: number) =>
    s + ' '.repeat(Math.max(0, width - cjkWidth(s)));

  console.log('');
  const title = m.diagTitle;
  const boxW = 36;
  const titleW = cjkWidth(title);
  const padL = Math.floor((boxW - titleW) / 2);
  const padR = boxW - titleW - padL;
  console.log(ansi.bold(`┌${'─'.repeat(boxW + 2)}┐`));
  console.log(ansi.bold(`│ ${' '.repeat(padL)}${title}${' '.repeat(padR)} │`));
  console.log(ansi.bold(`└${'─'.repeat(boxW + 2)}┘`));

  const pidFile = join(DATA_DIR, '.worker.pid');
  const portFile = join(DATA_DIR, '.worker.port');
  const configPath = join(DATA_DIR, 'config.json');
  const dbPath = join(DATA_DIR, 'kiro-mem.db');

  // 1. Worker process
  console.log(
    `\n${ansi.bold(`── ${m.diagWorker} ──────────────────────────────`)}`,
  );
  let workerOk = false;
  let port = '37778';
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf-8').trim();
    const check = spawnSync('kill', ['-0', pid]);
    if (check.status === 0) {
      port = existsSync(portFile)
        ? readFileSync(portFile, 'utf-8').trim()
        : '?';
      console.log(
        `  ${ansi.ok('✓')} ${padLabel(m.diagProcess, 10)}PID ${ansi.cyan(pid)}, port ${ansi.cyan(port)}`,
      );
      workerOk = true;
    } else {
      console.log(
        `  ${ansi.err('✗')} ${padLabel(m.diagProcess, 10)}${m.diagNotRunning} ${ansi.dim(`(${m.diagStalePid} ${pid})`)}`,
      );
    }
  } else {
    console.log(
      `  ${ansi.err('✗')} ${padLabel(m.diagProcess, 10)}${m.diagNotRunning}`,
    );
  }

  // 2. Health check
  if (workerOk) {
    const r = spawnSync(
      'curl',
      ['-s', '--max-time', '2', `http://127.0.0.1:${port}/health`],
      { stdio: 'pipe' },
    );
    if (r.status === 0) {
      try {
        const h = JSON.parse(r.stdout.toString());
        const jobs = h.jobs || {};
        const jobsInfo = `${jobs.inflight || 0} ${m.diagJobsInflight} / ${jobs.pending || 0} ${m.diagJobsPending} / ${jobs.dead || 0} ${m.diagJobsDead}`;
        console.log(
          `  ${ansi.ok('✓')} ${padLabel(m.diagHealth, 10)}v${h.version || '?'}, ${m.diagJobsLabel}: ${jobsInfo}`,
        );
      } catch {
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagHealth, 10)}${m.diagUnparseable}`,
        );
      }
    } else {
      console.log(
        `  ${ansi.err('✗')} ${padLabel(m.diagHealth, 10)}${m.diagUnreachable}`,
      );
    }
  }

  // 3. Service registration
  const platform = process.platform === 'darwin' ? 'macos' : 'linux';
  const plistPath = join(
    HOME,
    'Library',
    'LaunchAgents',
    'com.kiro-mem.worker.plist',
  );
  const servicePath = join(
    HOME,
    '.config',
    'systemd',
    'user',
    'kiro-mem.service',
  );
  const svcName = platform === 'macos' ? 'launchd' : 'systemd';
  const svcExists =
    platform === 'macos' ? existsSync(plistPath) : existsSync(servicePath);
  console.log(
    svcExists
      ? `  ${ansi.ok('✓')} ${padLabel(m.diagService, 10)}${svcName} ${m.diagManaged} ${ansi.dim(m.diagAutoRestart)}`
      : `  ${ansi.err('✗')} ${padLabel(m.diagService, 10)}${svcName} ${m.diagNotRegistered}`,
  );

  // 4. Config
  console.log(
    `\n${ansi.bold(`── ${m.diagConfig} ──────────────────────────────`)}`,
  );
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      const cc = cfg.compression || {};
      console.log(
        `  ${padLabel(m.language, 12)}${ansi.cyan(cfg.language || 'zh')}`,
      );
      console.log(
        `  ${padLabel(m.provider, 12)}${ansi.cyan(cc.provider || m.notSet)}`,
      );
      console.log(
        `  ${padLabel(m.model, 12)}${ansi.cyan(cc.model || m.notSet)}`,
      );
      console.log(
        `  ${padLabel(m.apiKeyLabel, 12)}${cc.apiKey ? ansi.dim(cc.apiKey.slice(0, 8) + '...') : ansi.err(m.notSet)}`,
      );
      console.log(
        `  ${padLabel(m.concurrencyLabel, 12)}${ansi.cyan(String(cc.concurrency || 6))}`,
      );
    } catch {
      console.log(`  ${ansi.err('✗')} ${m.diagParseError}`);
    }
  } else {
    console.log(
      `  ${ansi.err('✗')} ${m.diagNotFound} ${ansi.dim('(run: kiro-mem install)')}`,
    );
  }

  // 5. Database stats
  console.log(
    `\n${ansi.bold(`── ${m.diagDatabase} ────────────────────────────`)}`,
  );
  if (existsSync(dbPath)) {
    try {
      const { Database } = require('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const turns = db.query('SELECT COUNT(*) as c FROM turns').get() as {
        c: number;
      };
      const memories = db.query('SELECT COUNT(*) as c FROM memories').get() as {
        c: number;
      };
      const pinned = db
        .query('SELECT COUNT(*) as c FROM memories WHERE is_pinned = 1')
        .get() as { c: number };
      const pendingJobs = db
        .query("SELECT COUNT(*) as c FROM jobs WHERE state = 'pending'")
        .get() as { c: number };
      const topics = db.query('SELECT COUNT(*) as c FROM topics').get() as {
        c: number;
      };
      console.log(
        `  ${padLabel(m.diagTurns, 12)}${ansi.cyan(String(turns.c))}`,
      );
      console.log(
        `  ${padLabel(m.diagMemories, 12)}${ansi.cyan(String(memories.c))} ${ansi.dim(`(${pinned.c} ${m.diagPinned})`)}`,
      );
      console.log(
        `  ${padLabel(m.diagTopics, 12)}${ansi.cyan(String(topics.c))}`,
      );
      console.log(
        `  ${padLabel(m.diagPendingJobs, 12)}${ansi.cyan(String(pendingJobs.c))}`,
      );
      const stat = Bun.file(dbPath);
      console.log(
        `  ${padLabel(m.diagSize, 12)}${ansi.cyan((stat.size / 1024 / 1024).toFixed(1) + ' MB')}`,
      );
      db.close();
    } catch (e) {
      console.log(
        `  ${ansi.err('✗')} Error: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else {
    console.log(`  ${ansi.warn('⚠')} ${m.diagNotCreated}`);
  }

  // 6. Recent errors
  console.log(
    `\n${ansi.bold(`── ${m.diagErrors} ──────────────────────────────`)}`,
  );
  const logsDir = join(DATA_DIR, 'logs');
  let hasErrors = false;
  if (existsSync(logsDir)) {
    const date = new Date().toISOString().slice(0, 10);
    const logFile = join(logsDir, `worker-${date}.log`);
    if (existsSync(logFile)) {
      const content = readFileSync(logFile, 'utf-8').trim();
      if (content) {
        const lines = content.split('\n').slice(-5);
        console.log(
          `  ${ansi.warn('⚠')} ${m.diagLast} ${lines.length} ${m.diagRecentErrors}`,
        );
        for (const line of lines)
          console.log(`  ${ansi.dim('│')} ${ansi.dim(line)}`);
        hasErrors = true;
      }
    }
  }
  if (!hasErrors) console.log(`  ${ansi.ok('✓')} ${m.diagNoErrors}`);
  console.log('');
}

function help() {
  console.log(`kiro-mem <command>

Commands:
  install              ${m.helpInstall}
  uninstall            ${m.helpUninstall}
  uninstall --purge    ${m.helpUninstallPurge}
  config               ${m.helpConfig}
  config --show        ${m.helpConfigShow}
  status               ${m.helpStatus}
  start                ${m.helpStart}
  stop                 ${m.helpStop}
  diagnose             ${m.helpDiagnose}`);
}
