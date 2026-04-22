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

const HOME = process.env.HOME || '~';
const DATA_DIR = join(HOME, '.kiro-memory');
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
      skipTools: ['introspect', 'todo_list', '@kiro-memory/*'],
      skipSmallReads: true,
      smallReadThreshold: 100,
    },
  };
}

// --- Commands ---

async function install() {
  console.log('[kiro-memory] Installing...\n');

  // 1. Check bun
  const bunCheck = spawnSync('bun', ['--version']);
  if (bunCheck.status !== 0) {
    console.error('❌ Bun is required. Install: https://bun.sh');
    process.exit(1);
  }
  console.log(`✓ Bun ${bunCheck.stdout.toString().trim()}`);

  // 2. Interactive config
  const rl = createRL();
  const config = await collectConfig(rl);
  rl.close();

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
  console.log(`\n✓ Created ${DATA_DIR}`);

  // 4. Save config
  writeFileSync(join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
  console.log('✓ Config saved');

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
  console.log('✓ Hooks installed');

  // 6. Copy server files (保持 src/ 和 src/server/ 的目录结构)
  mkdirSync(join(DATA_DIR, 'src', 'server'), { recursive: true });
  for (const file of ['worker.ts', 'mcp-server.ts']) {
    copyFileSync(join(SRC_DIR, 'server', file), join(DATA_DIR, 'src', 'server', file));
  }
  for (const file of [
    'db.ts',
    'compressor.ts',
    'queue.ts',
    'context-builder.ts',
    'config.ts',
  ]) {
    copyFileSync(join(SRC_DIR, file), join(DATA_DIR, 'src', file));
  }
  console.log('✓ Server files installed');

  // 7. Copy prompt
  copyFileSync(
    join(SRC_DIR, 'agent', 'prompt.md'),
    join(DATA_DIR, 'prompt.md'),
  );
  console.log('✓ Prompt installed');

  // 8. Install agent config (替换路径占位符为绝对路径)
  const agentTemplate = readFileSync(join(SRC_DIR, 'agent', 'kiro-memory.json'), 'utf-8');
  const agentConfig = agentTemplate.replaceAll('__KIRO_MEMORY_DIR__', DATA_DIR);
  writeFileSync(join(AGENT_DIR, 'kiro-memory.json'), agentConfig);
  console.log('✓ Agent config installed');

  // 9. Install dependencies
  const pkgPath = join(DATA_DIR, 'package.json');
  if (!existsSync(pkgPath)) {
    writeFileSync(
      pkgPath,
      JSON.stringify(
        {
          name: 'kiro-memory-server',
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
  if (r.status === 0) console.log('✓ Dependencies installed');
  else
    console.log(
      '⚠ Dependencies install failed, run: cd ~/.kiro-memory && bun install',
    );

  // 10. Start worker
  start();

  console.log('\n✅ kiro-memory installed!');
  console.log(
    '   设为默认 Agent: kiro-cli settings chat.defaultAgent kiro-memory',
  );
  console.log('   或手动切换: /agent kiro-memory');
}

function uninstall() {
  const purge = process.argv[3] === '--purge';
  stop();

  const agentPath = join(AGENT_DIR, 'kiro-memory.json');
  if (existsSync(agentPath)) rmSync(agentPath);

  if (purge) {
    if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true });
    console.log('✅ kiro-memory completely removed (all data deleted)');
  } else {
    for (const dir of ['hooks', 'src', 'server', 'node_modules', 'logs']) {
      const p = join(DATA_DIR, dir);
      if (existsSync(p)) rmSync(p, { recursive: true });
    }
    for (const f of ['prompt.md', 'package.json', 'bun.lock', '.worker.pid', '.worker.port']) {
      const p = join(DATA_DIR, f);
      if (existsSync(p)) rmSync(p);
    }
    console.log('✅ kiro-memory uninstalled (database & config preserved at ~/.kiro-memory/)');
    console.log('   彻底删除所有数据: kiro-memory uninstall --purge');
  }
}

function status() {
  const pidFile = join(DATA_DIR, '.worker.pid');
  if (!existsSync(pidFile)) {
    console.log('⏹ Worker not running');
    return;
  }
  const pid = readFileSync(pidFile, 'utf-8').trim();
  const check = spawnSync('kill', ['-0', pid]);
  if (check.status === 0) {
    const portFile = join(DATA_DIR, '.worker.port');
    const port = existsSync(portFile)
      ? readFileSync(portFile, 'utf-8').trim()
      : '?';
    console.log(`▶ Worker running (PID: ${pid}, port: ${port})`);
  } else {
    console.log('⏹ Worker not running (stale PID file)');
    rmSync(pidFile);
  }
}

function start() {
  const pidFile = join(DATA_DIR, '.worker.pid');
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf-8').trim();
    const check = spawnSync('kill', ['-0', pid]);
    if (check.status === 0) {
      console.log(`✓ Worker already running (PID: ${pid})`);
      return;
    }
  }
  const worker = join(DATA_DIR, 'src', 'server', 'worker.ts');
  if (!existsSync(worker)) {
    console.error('❌ Worker not found. Run install first.');
    return;
  }
  const proc = Bun.spawn(['bun', 'run', worker], {
    cwd: DATA_DIR,
    env: { ...process.env, KIRO_MEMORY_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  proc.unref();
  console.log(`✓ Worker started (PID: ${proc.pid})`);
}

function stop() {
  const pidFile = join(DATA_DIR, '.worker.pid');
  const portFile = join(DATA_DIR, '.worker.port');
  if (!existsSync(pidFile)) return;
  const pid = readFileSync(pidFile, 'utf-8').trim();
  spawnSync('kill', [pid]);
  rmSync(pidFile, { force: true });
  rmSync(portFile, { force: true });
  console.log('✓ Worker stopped');
}

async function configCmd() {
  const configPath = join(DATA_DIR, 'config.json');
  const showOnly = process.argv[3] === '--show';

  if (!existsSync(configPath)) {
    console.log('❌ 未安装，请先运行 install');
    return;
  }

  if (showOnly) {
    const current = JSON.parse(readFileSync(configPath, 'utf-8'));
    const c = current.compression || {};
    console.log('当前配置:');
    console.log(`  提供商:   ${c.provider || 'anthropic'}`);
    console.log(`  模型:     ${c.model || '未设置'}`);
    console.log(`  API Key:  ${c.apiKey ? c.apiKey.slice(0, 8) + '...' : '未设置'}`);
    console.log(`  Base URL: ${c.baseUrl || '默认'}`);
    console.log(`  并发数:   ${c.concurrency || 6}`);
    return;
  }

  console.log('[kiro-memory] 修改压缩模型配置\n');
  const rl = createRL();
  const newConfig = await collectConfig(rl);
  rl.close();

  // 保留非 compression 的配置
  const current = JSON.parse(readFileSync(configPath, 'utf-8'));
  const merged = { ...current, compression: newConfig.compression };
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  console.log('\n✓ Config updated');

  // 重启 Worker 使配置生效
  stop();
  start();
  console.log('✓ Worker restarted');
}

function help() {
  console.log(`kiro-memory setup <command>

Commands:
  install              安装 kiro-memory（交互式配置）
  uninstall            卸载（保留数据库和配置）
  uninstall --purge    彻底卸载（删除所有数据）
  config               修改压缩模型配置
  config --show        查看当前配置
  status               查看 Worker 状态
  start                启动 Worker
  stop                 停止 Worker`);
}
