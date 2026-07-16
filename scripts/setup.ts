#!/usr/bin/env bun
/**
 * kiro-mem CLI: install, uninstall, config, status, start, stop, diagnose.
 *
 * v2.2.0 highlights:
 * - ACP-native: no LLM provider / API key prompts. Compression is handled by
 *   `kiro-cli acp` against an isolated KIRO_HOME.
 * - Embedding model ships with the npm package and is copied (not downloaded)
 *   into `~/.kiro-mem/models/` during install.
 * - i18n preserved (zh/en) for all user-visible CLI output and the compressor
 *   prompt that is written into the kiro-runtime layout.
 */
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
} from 'fs';
import { dirname, join, resolve } from 'path';
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
import { checkRuntimeHome } from '../src/acp/integrity';
import { MemoryDB } from '../src/db';

const HOME = process.env.HOME || '~';
const DATA_DIR = join(HOME, '.kiro-mem');
const KIRO_HOME = process.env.KIRO_HOME || join(HOME, '.kiro');
const AGENT_DIR = join(KIRO_HOME, 'agents');

const PKG_ROOT = resolve(import.meta.dir, '..');
const SRC_DIR = join(PKG_ROOT, 'src');
const MODELS_DIR = join(PKG_ROOT, 'models');

/**
 * Single source of truth for the package version. Reads the main
 * `package.json` at install time and is written into the runtime
 * `~/.kiro-mem/package.json` so the MCP server's `serverInfo.version`
 * (a required field in the MCP protocol) is always populated.
 */
const PKG_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PKG_ROOT, 'package.json'), 'utf-8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const RUNTIME_DIR = join(DATA_DIR, 'kiro-runtime');
const RUNTIME_AGENT_DIR = join(RUNTIME_DIR, 'agents');
const COMPRESSOR_AGENT_NAME = 'kiro-mem-compressor';

const MODEL_NAME = 'all-MiniLM-L6-v2';
const MODEL_DEST_DIR = join(DATA_DIR, 'models', MODEL_NAME);
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
] as const;

// --- Resolve language from existing config (or default) ---

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

interface BootstrapConfig {
  language: Language;
  worker: { port: number; host: string; logLevel: string };
  compression: { concurrency: number; timeoutMs: number; maxRetries: number };
  context: {
    maxOutputBytes: number;
  };
  filter: { skipTools: string[] };
  runtime: { kiroHome: string };
}

function defaultConfig(language: Language): BootstrapConfig {
  return {
    language,
    worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
    compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 },
    context: {
      maxOutputBytes: 8192,
    },
    filter: { skipTools: ['introspect', 'todo_list', '@kiro-mem/*'] },
    runtime: { kiroHome: RUNTIME_DIR },
  };
}

async function collectCompressionConfig(
  rl: readline.Interface,
  language: Language,
): Promise<BootstrapConfig> {
  const cm = t(language);
  const concurrencyRaw = parseInt(await ask(rl, cm.compressionConcurrency, '3'));
  const concurrency = Math.min(
    10,
    Math.max(1, isNaN(concurrencyRaw) ? 3 : concurrencyRaw),
  );
  const timeoutRaw = parseInt(await ask(rl, cm.compressionTimeoutMs, '30000'));
  const timeoutMs = Math.min(
    60000,
    Math.max(5000, isNaN(timeoutRaw) ? 30000 : timeoutRaw),
  );
  const retriesRaw = parseInt(await ask(rl, cm.compressionMaxRetries, '2'));
  const maxRetries = Math.min(
    5,
    Math.max(2, isNaN(retriesRaw) ? 2 : retriesRaw),
  );

  const cfg = defaultConfig(language);
  cfg.compression = { concurrency, timeoutMs, maxRetries };
  return cfg;
}

// --- Commands ---

async function install() {
  console.log(`${ansi.bold('[kiro-mem]')} ${m.installing}\n`);

  // 1. Check Bun
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

  // 2. Check Kiro CLI
  const kiroCheck = spawnSync('kiro-cli', ['--version'], { stdio: 'pipe' });
  if (kiroCheck.status !== 0) {
    console.error(
      `${ansi.err('✗')} ${m.kiroCliRequired} ${ansi.cyan('https://kiro.dev')}`,
    );
    process.exit(1);
  }
  console.log(
    `${ansi.ok('✓')} Kiro CLI ${ansi.cyan(kiroCheck.stdout.toString().trim())}`,
  );

  // 2b. ACP availability
  const acpCheck = spawnSync('kiro-cli', ['acp', '--help'], {
    stdio: 'pipe',
    timeout: 10000,
  });
  if (acpCheck.status !== 0) {
    console.error(`${ansi.err('✗')} ${m.acpUnavailable}`);
    process.exit(1);
  }
  console.log(`${ansi.ok('✓')} ${m.kiroCliCheckOk}`);

  // 3. Resolve language + collect config
  //
  // Install is intentionally non-interactive beyond the language choice. ACP
  // compression knobs (concurrency / timeoutMs / maxRetries) all default to
  // values that work well for the typical local Kiro CLI runtime; users who
  // want to tune them run `kiro-mem config` after install.
  const configPath = join(DATA_DIR, 'config.json');
  let config: BootstrapConfig;
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, 'utf-8'));
      lang = existing.language === 'en' ? 'en' : 'zh';
      m = t(lang);
      console.log(`${ansi.ok('✓')} ${m.reusingConfig} ${ansi.dim(m.reusing)}`);
      config = {
        ...defaultConfig(lang),
        ...existing,
        compression: {
          ...defaultConfig(lang).compression,
          ...(existing.compression || {}),
        },
        runtime: { kiroHome: RUNTIME_DIR },
      };
    } catch {
      // Existing config unparseable — fall back to a fresh language choice.
      const rl = createRL();
      const langChoice = await askChoice(rl, t('en').chooseLanguageBootstrap, [
        t('en').langEn,
        t('zh').langZh,
      ]);
      lang = langChoice === 0 ? 'en' : 'zh';
      m = t(lang);
      rl.close();
      config = defaultConfig(lang);
    }
  } else {
    const rl = createRL();
    const langChoice = await askChoice(rl, t('en').chooseLanguageBootstrap, [
      t('en').langEn,
      t('zh').langZh,
    ]);
    lang = langChoice === 0 ? 'en' : 'zh';
    m = t(lang);
    rl.close();
    config = defaultConfig(lang);
  }

  // 4. Create directories
  for (const dir of [
    DATA_DIR,
    join(DATA_DIR, 'hooks'),
    join(DATA_DIR, 'logs'),
    RUNTIME_DIR,
    RUNTIME_AGENT_DIR,
    join(RUNTIME_DIR, 'sessions'),
    AGENT_DIR,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  console.log(`\n${ansi.ok('✓')} ${m.created} ${ansi.dim(DATA_DIR)}`);

  // 5. Save config
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`${ansi.ok('✓')} ${m.configSaved}`);

  // 6. Copy hooks
  for (const hook of [
    'context.ts',
    'prompt-save.ts',
    'observation.ts',
    'stop.ts',
    'session.ts',
  ]) {
    copyFileSync(join(SRC_DIR, 'hooks', hook), join(DATA_DIR, 'hooks', hook));
    chmodSync(join(DATA_DIR, 'hooks', hook), 0o755);
  }
  console.log(`${ansi.ok('✓')} ${m.hooksInstalled}`);

  // 7. Copy server & source files
  mkdirSync(join(DATA_DIR, 'src', 'server'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'src', 'db'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'src', 'jobs'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'src', 'acp'), { recursive: true });
  mkdirSync(join(DATA_DIR, 'src', 'types'), { recursive: true });

  for (const file of ['worker.ts', 'mcp-server.ts', 'mcp-scope.ts', 'observation-search.ts']) {
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
    'client.ts',
    'runtime.ts',
    'pool.ts',
    'compressor.ts',
    'integrity.ts',
    'types.ts',
    'index.ts',
  ]) {
    copyFileSync(
      join(SRC_DIR, 'acp', file),
      join(DATA_DIR, 'src', 'acp', file),
    );
  }
  copyFileSync(
    join(SRC_DIR, 'types', 'huggingface-transformers.d.ts'),
    join(DATA_DIR, 'src', 'types', 'huggingface-transformers.d.ts'),
  );
  for (const file of [
    'compressor.ts',
    'embedding.ts',
    'bootstrap-context.ts',
    'config.ts',
    'logger.ts',
    'i18n.ts',
  ]) {
    copyFileSync(join(SRC_DIR, file), join(DATA_DIR, 'src', file));
  }
  console.log(`${ansi.ok('✓')} ${m.serverFilesInstalled}`);

  // 8. Copy embedding model from package payload
  if (!isModelComplete(MODELS_DIR, MODEL_NAME)) {
    console.error(
      `${ansi.err('✗')} ${m.embModelMissing} ${ansi.dim(MODELS_DIR)}`,
    );
    process.exit(1);
  }
  copyEmbeddingModel();
  console.log(`${ansi.ok('✓')} ${m.modelsCopied}`);

  // 9. Copy main agent prompt
  copyFileSync(
    join(SRC_DIR, 'agent', 'prompt.md'),
    join(DATA_DIR, 'prompt.md'),
  );
  console.log(`${ansi.ok('✓')} ${m.promptInstalled}`);

  // 10. Install main agent JSON
  const mainAgentTpl = readFileSync(
    join(SRC_DIR, 'agent', 'kiro-mem.json'),
    'utf-8',
  );
  writeFileSync(
    join(AGENT_DIR, 'kiro-mem.json'),
    mainAgentTpl.replaceAll('__KIRO_MEMORY_DIR__', DATA_DIR),
  );
  console.log(`${ansi.ok('✓')} ${m.agentConfigInstalled}`);

  // 11. Install internal compressor sub-agent into kiro-runtime
  const compressorAgentTpl = readFileSync(
    join(SRC_DIR, 'agent', `${COMPRESSOR_AGENT_NAME}.json`),
    'utf-8',
  );
  writeFileSync(
    join(RUNTIME_AGENT_DIR, `${COMPRESSOR_AGENT_NAME}.json`),
    compressorAgentTpl.replaceAll('__KIRO_MEMORY_DIR__', DATA_DIR),
  );
  // Prompt: pick the language-matched body and write under runtime root.
  const promptSrc = join(
    SRC_DIR,
    'acp',
    lang === 'en' ? 'compressor-prompt.en.md' : 'compressor-prompt.zh.md',
  );
  copyFileSync(
    promptSrc,
    join(RUNTIME_DIR, `${COMPRESSOR_AGENT_NAME}-prompt.md`),
  );
  console.log(`${ansi.ok('✓')} ${m.compressorAgentInstalled}`);

  // 12. Install runtime dependencies
  const runtimePkg = join(DATA_DIR, 'package.json');
  if (!existsSync(runtimePkg)) {
    writeFileSync(
      runtimePkg,
      JSON.stringify(
        {
          name: 'kiro-mem-server',
          version: PKG_VERSION,
          private: true,
          type: 'module',
          dependencies: {
            hono: '^4.12.0',
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
  if (r.status === 0) {
    console.log(`${ansi.ok('✓')} ${m.depsInstalled}`);
  } else {
    console.log(
      `${ansi.err('✗')} ${m.depsFailed} ${ansi.cyan('cd ~/.kiro-mem && bun install')}`,
    );
    process.exit(1);
  }

  // 13. Register system service & start worker
  const msg = registerService(lang);
  console.log(`${ansi.ok('✓')} ${msg}`);
  start(lang);

  console.log(`\n${ansi.ok('✅')} ${ansi.bold(m.installed)}`);
  console.log(
    `   ${m.setDefault} ${ansi.cyan('kiro-cli settings chat.defaultAgent kiro-mem')}`,
  );
  console.log(`   ${m.orSwitch} ${ansi.cyan('/agent kiro-mem')}`);
}

function isModelComplete(root: string, modelName: string): boolean {
  const dir = join(root, modelName);
  return MODEL_FILES.every((file) => {
    const p = join(dir, file);
    return existsSync(p) && statSync(p).size > 0;
  });
}

function copyEmbeddingModel() {
  const src = join(MODELS_DIR, MODEL_NAME);
  for (const file of MODEL_FILES) {
    const dest = join(MODEL_DEST_DIR, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(src, file), dest);
  }
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
    return;
  }

  // Non-purge: drop runtime artefacts but keep DB + config + models
  for (const dir of [
    'hooks',
    'src',
    'server',
    'node_modules',
    'logs',
    'kiro-runtime',
  ]) {
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

async function configCmd() {
  const configPath = join(DATA_DIR, 'config.json');
  const showOnly = process.argv[3] === '--show';

  if (!existsSync(configPath)) {
    console.log(
      `${ansi.err('✗')} ${m.notInstalled} ${ansi.cyan('kiro-mem install')}`,
    );
    return;
  }

  const current = JSON.parse(readFileSync(configPath, 'utf-8'));
  const c = current.compression || {};
  const r = current.runtime || {};

  if (showOnly) {
    console.log(ansi.bold(m.currentConfig));
    console.log(`  ${m.language}              ${ansi.cyan(current.language || 'zh')}`);
    console.log(`  ${m.concurrencyLabel}        ${ansi.cyan(String(c.concurrency ?? 3))}`);
    console.log(
      `  ${m.timeoutLabel}    ${ansi.cyan(String(c.timeoutMs ?? 30000))}`,
    );
    console.log(`  ${m.maxRetriesLabel}     ${ansi.cyan(String(c.maxRetries ?? 2))}`);
    console.log(
      `  ${m.runtimeHomeLabel}      ${ansi.cyan(r.kiroHome || RUNTIME_DIR)}`,
    );
    return;
  }

  console.log(`${m.modifyConfig}\n`);
  const rl = createRL();
  const langChoice = await askChoice(rl, m.chooseLanguage, [
    m.langZh,
    m.langEn,
  ]);
  const newLang: Language = langChoice === 1 ? 'en' : 'zh';
  lang = newLang;
  m = t(lang);
  const newCfg = await collectCompressionConfig(rl, newLang);
  rl.close();

  const merged = {
    ...current,
    language: newLang,
    compression: newCfg.compression,
    runtime: { kiroHome: r.kiroHome || RUNTIME_DIR },
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  console.log(`\n${ansi.ok('✓')} ${m.configUpdated}`);

  // If language changed, refresh the compressor prompt that the runtime uses.
  const promptSrc = join(
    SRC_DIR,
    'acp',
    newLang === 'en' ? 'compressor-prompt.en.md' : 'compressor-prompt.zh.md',
  );
  const promptDest = join(RUNTIME_DIR, `${COMPRESSOR_AGENT_NAME}-prompt.md`);
  if (existsSync(promptSrc) && existsSync(RUNTIME_DIR)) {
    copyFileSync(promptSrc, promptDest);
  }

  stop(lang);
  start(lang);
  console.log(`${ansi.ok('✓')} ${m.workerRestarted}`);
}

function diagnose() {
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

  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../package.json'), 'utf-8'),
    );
    console.log(`  version: ${ansi.cyan(pkg.version || '?')}`);
  } catch {}

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

  // 4. ACP runtime
  console.log(
    `\n${ansi.bold(`── ${m.diagACP} ──────────────────────────────`)}`,
  );
  const kiroCheck = spawnSync('kiro-cli', ['--version'], { stdio: 'pipe' });
  if (kiroCheck.status === 0) {
    console.log(
      `  ${ansi.ok('✓')} ${padLabel('Kiro CLI', 14)}${ansi.cyan(kiroCheck.stdout.toString().trim())}`,
    );
  } else {
    console.log(
      `  ${ansi.err('✗')} ${padLabel('Kiro CLI', 14)}${m.diagNotFound}`,
    );
  }

  const acpHelpCheck = spawnSync('kiro-cli', ['acp', '--help'], {
    stdio: 'pipe',
    timeout: 10000,
  });
  if (acpHelpCheck.status === 0) {
    console.log(
      `  ${ansi.ok('✓')} ${padLabel('ACP command', 14)}${ansi.cyan('available')}`,
    );
  } else {
    console.log(
      `  ${ansi.err('✗')} ${padLabel('ACP command', 14)}${m.acpUnavailable}`,
    );
  }

  // Runtime home integrity
  const homeIssues = checkRuntimeHome(RUNTIME_DIR, COMPRESSOR_AGENT_NAME);
  const homeErrors = homeIssues.filter((i) => i.severity === 'error');
  if (homeErrors.length === 0) {
    console.log(
      `  ${ansi.ok('✓')} ${padLabel(m.diagACPRuntime, 14)}${ansi.cyan(m.runtimeHomeOk)}`,
    );
  } else {
    console.log(
      `  ${ansi.err('✗')} ${padLabel(m.diagACPRuntime, 14)}${m.runtimeHomeMissing}`,
    );
    for (const issue of homeErrors) {
      console.log(`      ${ansi.err('-')} ${issue.message}`);
    }
  }

  // Embedding model presence
  const modelOk = isModelComplete(join(DATA_DIR, 'models'), MODEL_NAME);
  console.log(
    modelOk
      ? `  ${ansi.ok('✓')} ${padLabel(m.diagEmbedding, 14)}${ansi.cyan(m.embModelReady)}`
      : `  ${ansi.err('✗')} ${padLabel(m.diagEmbedding, 14)}${m.embModelMissing} ${ansi.dim(MODEL_DEST_DIR)}`,
  );

  // ACP smoke test
  if (
    kiroCheck.status === 0 &&
    acpHelpCheck.status === 0 &&
    homeErrors.length === 0
  ) {
    process.stdout.write(`  ⏳ ${m.diagACPSmoke}...`);
    const runtimePath = resolve(SRC_DIR, 'acp/runtime.ts');
    const smokeScript = `
import { ACPRuntime } from ${JSON.stringify(runtimePath)};
const rt = new ACPRuntime({
  kiroCliPath: 'kiro-cli',
  kiroHome: ${JSON.stringify(RUNTIME_DIR)},
  agentName: ${JSON.stringify(COMPRESSOR_AGENT_NAME)},
  timeoutMs: 30000,
  maxOutputBytes: 1024,
});
try {
  await rt.start();
  await rt.createSession();
  const r = await rt.prompt('Return ONLY this exact JSON, do not call any tools, do not add any other text: {"ok":true,"agent":${JSON.stringify(COMPRESSOR_AGENT_NAME)}}');
  let parsed;
  try { parsed = JSON.parse(r.text.trim()); }
  catch (e) { console.log('SMOKE_FAIL:non-JSON: ' + r.text.slice(0, 200)); process.exit(0); }
  if (parsed && parsed.ok === true && parsed.agent === ${JSON.stringify(COMPRESSOR_AGENT_NAME)}) {
    console.log('SMOKE_OK');
  } else {
    console.log('SMOKE_FAIL:identity mismatch: ' + JSON.stringify(parsed));
  }
} catch (e) {
  if (e && e.name === 'ACPContaminationError') {
    console.log('SMOKE_FAIL:tool contamination: ' + e.message);
  } else {
    console.log('SMOKE_FAIL:' + (e instanceof Error ? e.message : String(e)));
  }
} finally {
  await rt.close();
}
`;
    const smokeResult = spawnSync('bun', ['-e', smokeScript], {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 45000,
      env: {
        ...process.env,
        KIRO_MEMORY_DISABLE_HOOKS: '1',
        KIRO_MEMORY_INTERNAL: '1',
      },
    });
    const smokeOut = smokeResult.stdout?.toString().trim() || '';
    process.stdout.write('\r\x1b[2K');
    if (smokeOut.includes('SMOKE_OK')) {
      console.log(
        `  ${ansi.ok('✓')} ${padLabel(m.diagACPSmoke, 14)}${ansi.cyan(m.acpSmokeOk)}`,
      );
    } else {
      const reason = smokeOut.replace('SMOKE_FAIL:', '') || 'unknown';
      console.log(
        `  ${ansi.err('✗')} ${padLabel(m.diagACPSmoke, 14)}${m.acpSmokeFail} ${ansi.dim(reason)}`,
      );
    }
  }

  // 5. Config
  console.log(
    `\n${ansi.bold(`── ${m.diagConfig} ──────────────────────────────`)}`,
  );
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      const cc = cfg.compression || {};
      const rr = cfg.runtime || {};
      console.log(
        `  ${padLabel(m.language, 14)}${ansi.cyan(cfg.language || 'zh')}`,
      );
      console.log(
        `  ${padLabel(m.concurrencyLabel, 14)}${ansi.cyan(String(cc.concurrency ?? 3))}`,
      );
      console.log(
        `  ${padLabel(m.timeoutLabel, 14)}${ansi.cyan(String(cc.timeoutMs ?? 30000))}`,
      );
      console.log(
        `  ${padLabel(m.maxRetriesLabel, 14)}${ansi.cyan(String(cc.maxRetries ?? 2))}`,
      );
      console.log(
        `  ${padLabel(m.runtimeHomeLabel, 14)}${ansi.cyan(rr.kiroHome || RUNTIME_DIR)}`,
      );
    } catch {
      console.log(`  ${ansi.err('✗')} ${m.diagParseError}`);
    }
  } else {
    console.log(
      `  ${ansi.err('✗')} ${m.diagNotFound} ${ansi.dim('(run: kiro-mem install)')}`,
    );
  }

  // 6. Database stats
  console.log(
    `\n${ansi.bold(`── ${m.diagDatabase} ────────────────────────────`)}`,
  );
  if (existsSync(dbPath)) {
    try {
      // Open through MemoryDB so the query logic is shared with /health and the
      // metric_events table is created if an older DB predates it (idempotent).
      const mdb = new MemoryDB(dbPath);
      const turns =
        (mdb.raw.query('SELECT COUNT(*) AS c FROM turns').get() as { c: number } | null)?.c ?? 0;
      const s = mdb.getObservabilityStats();
      const pct = (n: number) => `${Math.round(n * 100)}%`;

      console.log(`  ${padLabel(m.diagTurns, 14)}${ansi.cyan(String(turns))}`);
      console.log(
        `  ${padLabel(m.diagObservations, 14)}${ansi.cyan(String(s.observations.total))} ${ansi.dim(`(${s.observations.normal} ${m.diagReady} / ${s.observations.fallback} ${m.diagFallback} / ${s.observations.pinned} ${m.diagPinned})`)}`,
      );
      console.log(
        `  ${padLabel(m.diagEmbedded, 14)}${ansi.cyan(`${s.embeddings.ready}/${s.observations.total}`)} ${ansi.dim(`(${pct(s.embeddings.coverage)} ${m.diagCoverage})`)}`,
      );
      console.log(
        `  ${padLabel(m.diagJobsLabel, 14)}${ansi.cyan(String(s.jobs.pending))} ${m.diagJobsPending} / ${ansi.cyan(String(s.jobs.leased))} ${m.diagJobsLeased} / ${ansi.cyan(String(s.jobs.dead))} ${m.diagJobsDead}`,
      );
      console.log(
        `  ${padLabel(m.diagSearch, 14)}${ansi.cyan(String(s.search24h.requests))} / ${ansi.cyan(pct(s.search24h.degradeRate))} ${m.diagDegrade} / p95 ${ansi.cyan(`${s.search24h.latencyMsP95}ms`)}`,
      );
      console.log(
        `  ${padLabel(m.diagAcpWindow, 14)}${m.diagRepairs}: ${ansi.cyan(String(s.acp24h.repairs))} / ${m.diagContam}: ${ansi.cyan(String(s.acp24h.contaminations))}`,
      );
      const stat = Bun.file(dbPath);
      console.log(
        `  ${padLabel(m.diagSize, 14)}${ansi.cyan((stat.size / 1024 / 1024).toFixed(1) + ' MB')}`,
      );
      mdb.close();
    } catch (e) {
      console.log(
        `  ${ansi.err('✗')} Error: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else {
    console.log(`  ${ansi.warn('⚠')} ${m.diagNotCreated}`);
  }

  // 7. Recent errors
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
