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

const HOME = process.env.HOME || '~';
const DATA_DIR = join(HOME, '.kiro-mem');
const AGENT_DIR = join(HOME, '.kiro', 'agents');
const SRC_DIR = resolve(import.meta.dir, '../src');

const command = process.argv[2] || 'help';

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
    status();
    break;
  case 'start':
    start();
    break;
  case 'stop':
    stop();
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
  const suffix = defaultVal ? ` (默认 ${defaultVal})` : '';
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
  const suffix = defaultVal ? ` (默认 ${defaultVal})` : '';
  return new Promise((resolve) => {
    const doAsk = () => {
      rl.question(`${question}${suffix}: `, (answer) => {
        const val = answer.trim() || defaultVal || '';
        if (!val) {
          console.log('  ⚠ 此项为必填');
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

async function collectConfig(rl: readline.Interface) {
  const providers = [
    {
      name: 'Anthropic (Claude)',
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-6',
    },
    { name: 'OpenAI (GPT)', provider: 'openai', defaultModel: 'gpt-5.4' },
    {
      name: 'Ollama (本地模型)',
      provider: 'ollama',
      defaultModel: 'qwen2.5:14b',
    },
    { name: '自定义 (OpenAI 兼容 API)', provider: 'custom', defaultModel: '' },
  ];

  const choice = await askChoice(
    rl,
    '选择 AI 压缩模型提供商:',
    providers.map((p) => p.name),
  );
  const selected = providers[choice] ?? providers[0]!;

  const model = await askRequired(rl, '? 模型名称', selected.defaultModel);

  let apiKey = '';
  if (selected.provider !== 'ollama') {
    apiKey = await askRequired(rl, '? API Key');
  }

  let baseUrl: string | null = null;
  if (selected.provider === 'custom') {
    baseUrl = await askRequired(
      rl,
      '? Base URL (例: https://api.deepseek.com/v1)',
    );
  } else if (selected.provider === 'ollama') {
    baseUrl = await askRequired(
      rl,
      '? Ollama 地址',
      'http://localhost:11434/v1',
    );
    apiKey = 'ollama';
  }

  const concurrencyInput = parseInt(
    await ask(rl, '? 压缩并发数 (范围 5-10)', '6'),
  );
  const concurrency = Math.min(
    10,
    Math.max(5, isNaN(concurrencyInput) ? 6 : concurrencyInput),
  );

  return {
    worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
    compression: {
      provider: selected.provider,
      model,
      apiKey,
      baseUrl,
      maxTokens: 800,
      temperature: 0.1,
      concurrency,
      enabled: true,
    },
    context: { maxSessions: 10, maxOutputBytes: 8192, includePinned: true },
    session: { timeoutMinutes: 30, autoComplete: true },
    filter: {
      skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
      skipSmallReads: true,
      smallReadThreshold: 100,
    },
  };
}

// --- Commands ---

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidProvider(provider: string): boolean {
  return ['anthropic', 'openai', 'ollama', 'custom'].includes(provider);
}

function getDefaultConfig(compression: {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string | null;
  concurrency?: number;
}) {
  return {
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
      enabled: true,
    },
    context: {
      maxObservations: 50,
      maxSessions: 10,
      fullCount: 5,
      fullField: 'narrative',
      maxOutputBytes: 8192,
      includePinned: true,
      includeSummary: false,
    },
    session: { timeoutMinutes: 30, autoComplete: true },
    filter: {
      skipTools: ['introspect', 'todo_list', '@kiro-mem/*'],
      skipSmallReads: true,
      smallReadThreshold: 100,
    },
  };
}

function loadExistingConfig(configPath: string): Record<string, unknown> | null {
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

    if (typeof provider !== 'string' || !isValidProvider(provider)) {
      return null;
    }
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
      ...raw,
      compression: {
        ...defaults.compression,
        ...(isRecord(raw.compression) ? raw.compression : {}),
      },
      context: {
        ...defaults.context,
        ...(isRecord(raw.context) ? raw.context : {}),
      },
      session: {
        ...defaults.session,
        ...(isRecord(raw.session) ? raw.session : {}),
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

async function install() {
  console.log(`${ansi.bold('[kiro-mem]')} Installing...\n`);

  // 1. Check bun
  const bunCheck = spawnSync('bun', ['--version']);
  if (bunCheck.status !== 0) {
    console.error(
      `${ansi.err('✗')} Bun is required. Install: ${ansi.cyan('https://bun.sh')}`,
    );
    process.exit(1);
  }
  console.log(
    `${ansi.ok('✓')} Bun ${ansi.cyan(bunCheck.stdout.toString().trim())}`,
  );

  // 2. Config — reuse existing if valid, otherwise interactive
  const configPath = join(DATA_DIR, 'config.json');
  let config: Awaited<ReturnType<typeof collectConfig>>;
  const existing = loadExistingConfig(configPath);
  if (existing) {
    const cp = (
      existing as { compression: { provider: string; model: string } }
    ).compression;
    console.log(
      `${ansi.ok('✓')} Found existing config ${ansi.dim('(reusing)')}`,
    );
    console.log(
      `  Provider: ${ansi.cyan(cp.provider)}, Model: ${ansi.cyan(cp.model)}`,
    );
    config = existing as typeof config;
  } else {
    const rl = createRL();
    config = await collectConfig(rl);
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
  console.log(`\n${ansi.ok('✓')} Created ${ansi.dim(DATA_DIR)}`);

  // 4. Save config
  writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`${ansi.ok('✓')} Config saved`);

  // 5. Copy hooks
  for (const hook of [
    'context.sh',
    'prompt-save.sh',
    'observation.sh',
    'summary.sh',
  ]) {
    const src = join(SRC_DIR, 'hooks', hook);
    const dst = join(DATA_DIR, 'hooks', hook);
    copyFileSync(src, dst);
    chmodSync(dst, 0o755);
  }
  console.log(`${ansi.ok('✓')} Hooks installed`);

  // 6. Copy server files
  mkdirSync(join(DATA_DIR, 'src', 'server'), { recursive: true });
  for (const file of ['worker.ts', 'mcp-server.ts']) {
    copyFileSync(
      join(SRC_DIR, 'server', file),
      join(DATA_DIR, 'src', 'server', file),
    );
  }
  for (const file of [
    'db.ts',
    'compressor.ts',
    'queue.ts',
    'context-builder.ts',
    'config.ts',
    'logger.ts',
  ]) {
    copyFileSync(join(SRC_DIR, file), join(DATA_DIR, 'src', file));
  }
  console.log(`${ansi.ok('✓')} Server files installed`);

  // 7. Copy prompt
  copyFileSync(
    join(SRC_DIR, 'agent', 'prompt.md'),
    join(DATA_DIR, 'prompt.md'),
  );
  console.log(`${ansi.ok('✓')} Prompt installed`);

  // 8. Install agent config
  const agentTemplate = readFileSync(
    join(SRC_DIR, 'agent', 'kiro-mem.json'),
    'utf-8',
  );
  const agentConfig = agentTemplate.replaceAll('__KIRO_MEMORY_DIR__', DATA_DIR);
  writeFileSync(join(AGENT_DIR, 'kiro-mem.json'), agentConfig);
  console.log(`${ansi.ok('✓')} Agent config installed`);

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
            '@modelcontextprotocol/sdk': '^1.29.0',
          },
        },
        null,
        2,
      ),
    );
  }
  const r = spawnSync('bun', ['install'], {
    cwd: DATA_DIR,
    stdio: 'pipe',
  });
  if (r.status === 0) console.log(`${ansi.ok('✓')} Dependencies installed`);
  else
    console.log(
      `${ansi.warn('⚠')} Dependencies install failed, run: ${ansi.cyan('cd ~/.kiro-mem && bun install')}`,
    );

  // 10. Register system service & start worker
  const msg = registerService();
  console.log(`${ansi.ok('✓')} ${msg}`);
  start();

  console.log(`\n${ansi.ok('✅')} ${ansi.bold('kiro-mem installed!')}`);
  console.log(
    `   设为默认 Agent: ${ansi.cyan('kiro-cli settings chat.defaultAgent kiro-mem')}`,
  );
  console.log(`   或手动切换: ${ansi.cyan('/agent kiro-mem')}`);
}

function uninstall() {
  const purge = process.argv[3] === '--purge';

  removeService();
  stop();

  const agentPath = join(AGENT_DIR, 'kiro-mem.json');
  if (existsSync(agentPath)) rmSync(agentPath);

  if (purge) {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });
    console.log(
      `${ansi.ok('✅')} ${ansi.bold('kiro-mem completely removed')} ${ansi.dim('(all data deleted)')}`,
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
      `${ansi.ok('✅')} ${ansi.bold('kiro-mem uninstalled')} ${ansi.dim('(database & config preserved at ~/.kiro-mem/')}`,
    );
    console.log(
      `   彻底删除所有数据: ${ansi.cyan('kiro-mem uninstall --purge')}`,
    );
  }
}

async function configCmd() {
  const configPath = join(DATA_DIR, 'config.json');
  const showOnly = process.argv[3] === '--show';

  if (!existsSync(configPath)) {
    console.log(
      `${ansi.err('✗')} 未安装，请先运行 ${ansi.cyan('kiro-mem install')}`,
    );
    return;
  }

  if (showOnly) {
    const current = JSON.parse(readFileSync(configPath, 'utf-8'));
    const c = current.compression || {};
    console.log(ansi.bold('当前配置:'));
    console.log(`  提供商:   ${ansi.cyan(c.provider || 'anthropic')}`);
    console.log(`  模型:     ${ansi.cyan(c.model || '未设置')}`);
    console.log(
      `  API Key:  ${c.apiKey ? ansi.dim(c.apiKey.slice(0, 8) + '...') : ansi.err('未设置')}`,
    );
    console.log(`  Base URL: ${ansi.cyan(c.baseUrl || '默认')}`);
    console.log(`  并发数:   ${ansi.cyan(String(c.concurrency || 6))}`);
    return;
  }

  console.log('[kiro-mem] 修改压缩模型配置\n');
  const rl = createRL();
  const newConfig = await collectConfig(rl);
  rl.close();

  const current = JSON.parse(readFileSync(configPath, 'utf-8'));
  const merged = { ...current, compression: newConfig.compression };
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  console.log(`\n${ansi.ok('✓')} Config updated`);

  stop();
  start();
  console.log(`${ansi.ok('✓')} Worker restarted`);
}

function diagnose() {
  console.log('');
  console.log(ansi.bold('╔══════════════════════════════════════╗'));
  console.log(ansi.bold('║        kiro-mem diagnostics          ║'));
  console.log(ansi.bold('╚══════════════════════════════════════╝'));

  const pidFile = join(DATA_DIR, '.worker.pid');
  const portFile = join(DATA_DIR, '.worker.port');
  const configPath = join(DATA_DIR, 'config.json');
  const dbPath = join(DATA_DIR, 'kiro-mem.db');

  // 1. Worker process
  console.log(`\n${ansi.bold('── Worker ──────────────────────────────')}`);
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
        `  ${ansi.ok('✓')} Process     PID ${ansi.cyan(pid)}, port ${ansi.cyan(port)}`,
      );
      workerOk = true;
    } else {
      console.log(
        `  ${ansi.err('✗')} Process     not running ${ansi.dim(`(stale PID: ${pid})`)}`,
      );
    }
  } else {
    console.log(`  ${ansi.err('✗')} Process     not running`);
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
        const uptime =
          h.uptime >= 3600
            ? `${Math.floor(h.uptime / 3600)}h ${Math.floor((h.uptime % 3600) / 60)}m`
            : h.uptime >= 60
              ? `${Math.floor(h.uptime / 60)}m ${h.uptime % 60}s`
              : `${h.uptime}s`;
        console.log(
          `  ${ansi.ok('✓')} Health      uptime ${ansi.cyan(uptime)}, queue ${h.queue_active}/${h.queue_size}`,
        );
      } catch {
        console.log(`  ${ansi.warn('⚠')} Health      response not parseable`);
      }
    } else {
      console.log(`  ${ansi.err('✗')} Health      endpoint unreachable`);
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
      ? `  ${ansi.ok('✓')} Service     ${svcName} managed ${ansi.dim('(auto-restart enabled)')}`
      : `  ${ansi.err('✗')} Service     ${svcName} not registered`,
  );

  // 4. Config
  console.log(`\n${ansi.bold('── Config ──────────────────────────────')}`);
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      const cc = cfg.compression || {};
      console.log(`  Provider      ${ansi.cyan(cc.provider || 'not set')}`);
      console.log(`  Model         ${ansi.cyan(cc.model || 'not set')}`);
      console.log(
        `  API Key       ${cc.apiKey ? ansi.dim(cc.apiKey.slice(0, 8) + '...') : ansi.err('not set')}`,
      );
      console.log(`  Concurrency   ${ansi.cyan(String(cc.concurrency || 6))}`);
    } catch {
      console.log(`  ${ansi.err('✗')} Config file parse error`);
    }
  } else {
    console.log(
      `  ${ansi.err('✗')} Not found ${ansi.dim('(run: kiro-mem install)')}`,
    );
  }

  // 5. Database stats
  console.log(`\n${ansi.bold('── Database ────────────────────────────')}`);
  if (existsSync(dbPath)) {
    try {
      const { Database } = require('bun:sqlite');
      const db = new Database(dbPath, { readonly: true });
      const obs = db.query('SELECT COUNT(*) as c FROM observations').get() as {
        c: number;
      };
      const sess = db.query('SELECT COUNT(*) as c FROM sessions').get() as {
        c: number;
      };
      const pinned = db
        .query('SELECT COUNT(*) as c FROM observations WHERE is_pinned = 1')
        .get() as { c: number };
      const pending = db
        .query('SELECT COUNT(*) as c FROM observations WHERE title IS NULL')
        .get() as { c: number };
      console.log(`  Sessions      ${ansi.cyan(String(sess.c))}`);
      console.log(
        `  Observations  ${ansi.cyan(String(obs.c))} ${ansi.dim(`(${pinned.c} pinned, ${pending.c} pending)`)}`,
      );

      const stat = Bun.file(dbPath);
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
      console.log(`  Size          ${ansi.cyan(sizeMB + ' MB')}`);
      db.close();
    } catch (e) {
      console.log(
        `  ${ansi.err('✗')} Error: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else {
    console.log(`  ${ansi.warn('⚠')} Not created yet`);
  }

  // 6. Recent errors
  console.log(`\n${ansi.bold('── Errors ──────────────────────────────')}`);
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
          `  ${ansi.warn('⚠')} Last ${lines.length} entries from today:`,
        );
        for (const line of lines)
          console.log(`  ${ansi.dim('│')} ${ansi.dim(line)}`);
        hasErrors = true;
      }
    }
  }
  if (!hasErrors) console.log(`  ${ansi.ok('✓')} No errors today`);

  console.log('');
}

function help() {
  console.log(`kiro-mem <command>

Commands:
  install              安装 kiro-mem（交互式配置）
  uninstall            卸载（保留数据库和配置）
  uninstall --purge    彻底卸载（删除所有数据）
  config               修改压缩模型配置
  config --show        查看当前配置
  status               查看 Worker 状态
  start                启动 Worker
  stop                 停止 Worker
  diagnose             输出完整诊断信息`);
}
