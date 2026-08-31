#!/usr/bin/env bun
/** kiro-mem CLI: install, uninstall, config, status, start, stop, diagnose, repair, viewer. */
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
  restart,
  status,
  ansi,
} from './service';
import type { Language } from '../src/config';
import { t } from '../src/i18n';
import { checkRuntimeHome } from '../src/acp/integrity';
import { MemoryDB } from '../src/db';
import { ensureLocalAuthToken, inspectLocalAuthToken, readLocalAuthToken } from '../src/auth-token';
import { readCaptureMisses } from '../src/hooks/capture-log';
import { resolveRuntimeHome } from '../src/config';
import { PACKAGE_VERSION } from '../src/version';

const HOME = process.env.HOME || '~';
/**
 * `KIRO_MEMORY_DATA_DIR` first, matching `getDataDir()` in `src/config.ts` — the
 * Worker, the MCP server and every hook resolve it that way. Reading only `HOME`
 * here once made `KIRO_MEMORY_DATA_DIR=<tmp> kiro-mem repair` look isolated while
 * it wrote to the developer's real database; tests isolate by overriding `HOME`,
 * so nothing caught it.
 */
const DATA_DIR = process.env.KIRO_MEMORY_DATA_DIR || join(HOME, '.kiro-mem');
const KIRO_HOME = process.env.KIRO_HOME || join(HOME, '.kiro');
const AGENT_DIR = join(KIRO_HOME, 'agents');

const PKG_ROOT = resolve(import.meta.dir, '..');
const SRC_DIR = join(PKG_ROOT, 'src');
const MODELS_DIR = join(PKG_ROOT, 'models');

/**
 * Read from config so install / config / diagnose / smoke all inspect the same
 * directory the Worker will use. As three independent expressions, a custom
 * `runtime.kiroHome` gave a working runtime that `diagnose` reported as broken.
 */
function runtimeHomeFromDisk(): string {
  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf-8'));
    return resolveRuntimeHome(raw?.runtime?.kiroHome, DATA_DIR);
  } catch {
    return resolveRuntimeHome(undefined, DATA_DIR);
  }
}

const RUNTIME_DIR = runtimeHomeFromDisk();
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

/** Built by `bun run build:ui`; in the npm `files` list so an installed package carries it. */
const VIEWER_SRC_DIR = join(PKG_ROOT, 'dist', 'ui');
const VIEWER_DEST_DIR = join(DATA_DIR, 'ui');
const VIEWER_FILES = ['viewer.html', 'viewer.js', 'styles.css'] as const;

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
    await diagnose();
    break;
  case 'repair':
    await repair();
    break;
  case 'viewer':
    await viewer();
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

async function chooseInstallLanguage(): Promise<Language> {
  const fromEnv = process.env.KIRO_MEMORY_LANGUAGE;
  if (fromEnv === 'en' || fromEnv === 'zh') return fromEnv;
  const rl = createRL();
  const choice = await askChoice(rl, t('en').chooseLanguageBootstrap, [
    t('en').langEn,
    t('zh').langZh,
  ]);
  rl.close();
  return choice === 0 ? 'en' : 'zh';
}

interface BootstrapConfig {
  language: Language;
  worker: { port: number; host: string; logLevel: string };
  compression: {
    concurrency: number;
    minWarmRuntimes: number;
    idleTtlMs: number;
    timeoutMs: number;
    maxRetries: number;
  };
  context: {
    maxOutputBytes: number;
  };
  filter: { skipTools: string[] };
  retrieval: { semanticDiscovery: boolean };
  runtime: { kiroHome: string };
}

function defaultConfig(language: Language): BootstrapConfig {
  return {
    language,
    worker: { port: 37778, host: '127.0.0.1', logLevel: 'info' },
    compression: {
      concurrency: 3,
      // Written explicitly so the knobs deciding how many `kiro-cli acp`
      // processes stay resident are discoverable in the file users actually open.
      minWarmRuntimes: 1,
      idleTtlMs: 600000,
      timeoutMs: 30000,
      maxRetries: 2,
    },
    context: {
      maxOutputBytes: 8192,
    },
    filter: { skipTools: ['introspect', 'todo_list', '@kiro-mem/*'] },
    // Explicit, not left to the loader default, so the rollback switch is visible.
    retrieval: { semanticDiscovery: true },
    // Empty = "default under dataDir" (resolveRuntimeHome). Writing the resolved
    // path would freeze the data dir in and make the setting look user-chosen.
    runtime: { kiroHome: '' },
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
  const warmRaw = parseInt(await ask(rl, cm.compressionMinWarmRuntimes, '1'));
  // Bounded by the concurrency just chosen: a higher floor would pin runtimes
  // that can never exist.
  const minWarmRuntimes = Math.min(
    concurrency,
    Math.max(0, isNaN(warmRaw) ? 1 : warmRaw),
  );
  const idleRaw = parseInt(await ask(rl, cm.compressionIdleTtlMs, '600000'));
  // Must not be clamped like the values above: 0 is a legal answer meaning "never
  // retire on idle", and raising it to the floor would give continuous recycling
  // to someone who asked for none.
  const idleTtlMs = idleRaw === 0
    ? 0
    : Math.min(86400000, Math.max(1000, isNaN(idleRaw) ? 600000 : idleRaw));

  const cfg = defaultConfig(language);
  cfg.compression = { concurrency, minWarmRuntimes, idleTtlMs, timeoutMs, maxRetries };
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

  // 3. Resolve language + collect config. Non-interactive beyond the language
  // choice; compression knobs are tuned later via `kiro-mem config`.
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
        // Preserve a user-chosen runtime home: overwriting it made a re-install
        // silently move the compressor runtime back to the default directory.
        runtime: { kiroHome: existing.runtime?.kiroHome ?? '' },
      };
    } catch {
      lang = await chooseInstallLanguage();
      m = t(lang);
      config = defaultConfig(lang);
    }
  } else {
    lang = await chooseInstallLanguage();
    m = t(lang);
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

  // Hook -> loopback Worker auth. Written 0600 (owner-only); diagnose reports
  // any looser mode as `insecure`.
  ensureLocalAuthToken(DATA_DIR);

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
    'capture-log.ts',
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
  mkdirSync(join(DATA_DIR, 'src', 'hooks'), { recursive: true });

  // Hooks live at <dataDir>/hooks, server code at <dataDir>/src/server, so no one
  // relative path reaches capture-log from both. Same source shipped to both trees.
  copyFileSync(
    join(SRC_DIR, 'hooks', 'capture-log.ts'),
    join(DATA_DIR, 'src', 'hooks', 'capture-log.ts'),
  );

  for (const file of [
    'worker.ts',
    'mcp-server.ts',
    'mcp-scope.ts',
    'observation-search.ts',
    // The Worker imports these directly: a missing file breaks the installed
    // runtime while the in-tree build stays green — `missingInstalledImports` in
    // setup.test.ts guards this whole list.
    'viewer-routes.ts',
    'viewer-stream.ts',
    'viewer-types.ts',
  ]) {
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
    // Split from embedding.ts so MCP can resolve the vector-space identity without
    // pulling the inference runtime into every session.
    'embedding-space.ts',
    'semantic-en.ts',
    'worker-embedder.ts',
    // Subtree RSS sampling for /health; same install-only import risk as above.
    'process-rss.ts',
    'bootstrap-context.ts',
    'config.ts',
    'auth-token.ts',
    'logger.ts',
    'i18n.ts',
    'version.ts',
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

  // 8b. Copy the Web Viewer bundle to <dataDir>/ui. The Worker resolves it from the
  // installed directory first. A missing bundle is not fatal: capture, compression
  // and MCP work without it, and `/ui` answers with a build hint.
  if (copyViewerBundle()) {
    console.log(`${ansi.ok('✓')} ${m.viewerInstalled}`);
  } else {
    console.log(`${ansi.warn('!')} ${m.viewerMissing} ${ansi.cyan('bun run build:ui')}`);
  }

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
  writeFileSync(
    runtimePkg,
    JSON.stringify(
      {
        name: 'kiro-mem-server',
        version: PACKAGE_VERSION,
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
  const r = spawnSync('bun', ['install'], { cwd: DATA_DIR, stdio: 'pipe' });
  if (r.status === 0) {
    console.log(`${ansi.ok('✓')} ${m.depsInstalled}`);
  } else {
    console.log(
      `${ansi.err('✗')} ${m.depsFailed} ${ansi.cyan('cd ~/.kiro-mem && bun install')}`,
    );
    process.exit(1);
  }

  // 13. Register system service & (re)start worker. restart(), not start(): step 7
  // overwrote the runtime source under a possibly-running Worker.
  const msg = registerService(lang);
  console.log(`${ansi.ok('✓')} ${msg}`);
  restart(lang);

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

/**
 * Returns false when the package carries no built bundle (a source checkout that
 * has not run `bun run build:ui`). All three files or none: `viewer.html` without
 * `viewer.js` serves a blank page with no diagnosable error.
 */
function copyViewerBundle(): boolean {
  const present = VIEWER_FILES.every((f) => existsSync(join(VIEWER_SRC_DIR, f)));
  if (!present) return false;
  mkdirSync(VIEWER_DEST_DIR, { recursive: true });
  for (const file of VIEWER_FILES) {
    copyFileSync(join(VIEWER_SRC_DIR, file), join(VIEWER_DEST_DIR, file));
  }
  return true;
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
    // Build artefact, not user data: keeping it would leave a stale UI talking to
    // a newer Worker.
    'ui',
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
      `  ${m.minWarmLabel}      ${ansi.cyan(String(c.minWarmRuntimes ?? 1))}`,
    );
    console.log(
      `  ${m.idleTtlLabel}    ${
        (c.idleTtlMs ?? 600000) === 0
          ? ansi.warn(m.idleTtlOff)
          : ansi.cyan(String(c.idleTtlMs ?? 600000))
      }`,
    );
    console.log(
      `  ${m.runtimeHomeLabel}      ${ansi.cyan(resolveRuntimeHome(r.kiroHome, DATA_DIR))}`,
    );
    console.log(
      `  ${m.discoveryLabel}  ${current.retrieval?.semanticDiscovery === false ? ansi.warn('off (rollback)') : ansi.cyan('on')}`,
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
    // Merged, not replaced: a field this form does not ask about must survive
    // `kiro-mem config`. Replacing the block is how a hand-edited `idleTtlMs`
    // silently reverts when someone changes only the language.
    compression: { ...c, ...newCfg.compression },
    // Verbatim: must not turn an unset (default) runtime home into a hard path.
    runtime: { kiroHome: r.kiroHome ?? '' },
  };
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  console.log(`\n${ansi.ok('✓')} ${m.configUpdated}`);

  // If language changed, refresh the compressor prompt that the runtime uses.
  const promptSrc = join(
    SRC_DIR,
    'acp',
    newLang === 'en' ? 'compressor-prompt.en.md' : 'compressor-prompt.zh.md',
  );
  const runtimeHome = resolveRuntimeHome(r.kiroHome, DATA_DIR);
  const promptDest = join(runtimeHome, `${COMPRESSOR_AGENT_NAME}-prompt.md`);
  if (existsSync(promptSrc) && existsSync(runtimeHome)) {
    copyFileSync(promptSrc, promptDest);
  }

  stop(lang);
  start(lang);
  console.log(`${ansi.ok('✓')} ${m.workerRestarted}`);
}

async function diagnose() {
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

  console.log(`  version: ${ansi.cyan(PACKAGE_VERSION)}`);

  const pidFile = join(DATA_DIR, '.worker.pid');
  const portFile = join(DATA_DIR, '.worker.port');
  const configPath = join(DATA_DIR, 'config.json');
  const dbPath = join(DATA_DIR, 'kiro-mem.db');

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
        // The running Worker holds the code it loaded at boot: a stale process
        // looks healthy here while the deployed fix is not actually live.
        let installedVersion = '';
        try {
          installedVersion = JSON.parse(
            readFileSync(join(DATA_DIR, 'package.json'), 'utf-8'),
          ).version;
        } catch {}
        if (installedVersion && h.version && h.version !== installedVersion) {
          console.log(
            `  ${ansi.err('✗')} ${padLabel(m.diagVersionMatch, 10)}${m.versionMismatch} ${ansi.dim(`(worker v${h.version} / installed v${installedVersion})`)}`,
          );
        }

        // --- Runtime footprint --- RSS is live per-process state the database
        // cannot reconstruct, which is why it prints here and not under Database.
        const mb = (bytes: number | null | undefined) =>
          typeof bytes === 'number' && bytes >= 0
            ? `${(bytes / 1048576).toFixed(1)}MB`
            : '?';
        const mem = h.memory;
        if (mem) {
          console.log(
            `\n${ansi.bold(`── ${m.diagRuntimeSection} ──────────────────────`)}`,
          );
          console.log(
            `  ${padLabel(m.diagWorkerRss, 14)}${ansi.cyan(mb(mem.workerSelfRssBytes))}`,
          );
          const slots: any[] = Array.isArray(mem.acpSlots) ? mem.acpSlots : [];
          if (slots.length === 0) {
            console.log(`  ${padLabel(m.diagAcpPool, 14)}${ansi.dim('0')}`);
          } else {
            console.log(
              `  ${padLabel(m.diagAcpPool, 14)}${ansi.cyan(mb(mem.acpAttributedSubtreeRssBytes))} ${ansi.dim(`(${slots.length} ${m.diagAcpSlot})`)}`,
            );
            for (const s of slots) {
              const state = s.busy
                ? m.diagAcpBusy
                : `${m.diagAcpIdle} ${Math.round((s.idleMs ?? 0) / 1000)}s`;
              console.log(
                `    ${ansi.dim(`pid ${s.pid ?? '?'} · ${mb(s.rssBytes)} · ${s.jobCount} ${m.diagAcpJobs} · ${state}`)}`,
              );
            }
          }
          // Idle governance from the live pool: whether idle ACP processes are
          // actually being released, and under which settings.
          const acp = h.acp;
          if (acp && acp.config) {
            const ttl = acp.config.idleTtlMs;
            const ttlText = ttl === 0
              ? m.idleTtlOff
              : `${Math.round(ttl / 1000)}s`;
            console.log(
              `  ${padLabel(m.diagAcpIdleRecycle, 14)}${ansi.cyan(String(acp.idleRecycles ?? 0))} ${
                ansi.dim(`· ${m.diagAcpTtl} ${ttlText} · ${m.diagAcpWarm} ${acp.config.minWarmRuntimes}`)
              }`,
            );
          }
          const clients: any[] = Array.isArray(mem.mcpClientsSeen) ? mem.mcpClientsSeen : [];
          if (clients.length > 0) {
            const total = clients.reduce(
              (sum, x) => sum + (typeof x.rssBytes === 'number' ? x.rssBytes : 0),
              0,
            );
            console.log(
              `  ${padLabel(m.diagMcpClients, 14)}${ansi.cyan(String(clients.length))} ${ansi.dim(`· ${mb(total)} ${m.diagTotal}`)}`,
            );
          }
          // A failed `ps` makes every byte count above meaningless — don't let '?' read as "small".
          if (mem.rssMeasured === false) {
            console.log(`  ${ansi.warn('⚠')} ${ansi.dim(m.diagRssUnmeasured)}`);
          } else if (mem.rssSampleAt === null && (slots.some((s) => s.pid != null) || clients.length > 0)) {
            console.log(`  ${ansi.warn('⚠')} ${ansi.dim(m.diagRssPending)}`);
          } else if (typeof mem.rssSampleAgeMs === 'number' && mem.rssSampleAgeMs > 5000) {
            console.log(`  ${ansi.warn('⚠')} ${ansi.dim(`${m.diagRssStale} ${Math.round(mem.rssSampleAgeMs / 1000)}s`)}`);
          }
          const ing = h.ingest_runtime;
          if (ing && ing.samples > 0) {
            const slow = (ing.latencyMsP95 ?? 0) >= 500;
            console.log(
              `  ${slow ? `${ansi.warn('⚠')} ` : ''}${padLabel(m.diagIngestLatency, slow ? 12 : 14)}p50 ${ansi.cyan(`${ing.latencyMsP50}ms`)} / p95 ${ansi.cyan(`${ing.latencyMsP95}ms`)} / max ${ansi.cyan(`${ing.latencyMsMax}ms`)}`,
            );
            if (slow) console.log(`    ${ansi.dim(m.diagIngestHint)}`);
          }
          const emb = h.embedding_runtime;
          if (emb && emb.samples > 0) {
            console.log(
              `  ${padLabel(m.diagEmbedLatency, 14)}p50 ${ansi.cyan(`${emb.latencyMsP50}ms`)} / p95 ${ansi.cyan(`${emb.latencyMsP95}ms`)} / max ${ansi.cyan(`${emb.latencyMsMax}ms`)} ${ansi.dim(`· ${emb.rejected} ${m.diagEmbedRejected}`)}`,
            );
          }
          if (h.runtime) {
            console.log(
              `  ${padLabel(m.diagRuntimeAge, 14)}${ansi.dim(`${Math.round((h.runtime.uptimeMs ?? 0) / 3600000)}h`)}`,
            );
          }
          if (h.jobs && (h.jobs.oldestPendingMs > 0 || h.jobs.oldestLeasedMs > 0)) {
            console.log(
              `  ${padLabel(m.diagJobAge, 14)}${m.diagJobPendingAge} ${ansi.cyan(`${Math.round((h.jobs.oldestPendingMs ?? 0) / 1000)}s`)} / ${m.diagJobLeasedAge} ${ansi.cyan(`${Math.round((h.jobs.oldestLeasedMs ?? 0) / 1000)}s`)}`,
            );
          }
        }
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

  // 2b. Local auth token + Hook -> Worker auth chain. Hooks are fire-and-forget,
  // so a rejected request is invisible in normal use — diagnose must surface it.
  const tokenInfo = inspectLocalAuthToken(DATA_DIR);
  const tokenProblem: Record<string, string> = {
    missing: m.authTokenMissing,
    empty: m.authTokenEmpty,
    weak: m.authTokenWeak,
    insecure: m.authTokenInsecure,
  };
  console.log(
    tokenInfo.ok
      ? `  ${ansi.ok('✓')} ${padLabel(m.diagAuth, 10)}${ansi.cyan(m.authTokenOk)}`
      : `  ${ansi.err('✗')} ${padLabel(m.diagAuth, 10)}${tokenProblem[tokenInfo.state] ?? tokenInfo.state}`,
  );

  if (workerOk && tokenInfo.state !== 'missing') {
    // Probes a read-only route the way a Hook would. fetch, not curl, so the token
    // never lands in the process list.
    const probeUrl = `http://127.0.0.1:${port}/context/bootstrap?cwd=${encodeURIComponent(process.cwd())}`;
    let probeStatus = 0;
    try {
      const res = await fetch(probeUrl, {
        headers: { Authorization: `Bearer ${readLocalAuthToken(DATA_DIR)}` },
        signal: AbortSignal.timeout(2000),
      });
      probeStatus = res.status;
    } catch {
      probeStatus = 0;
    }
    if (probeStatus === 200) {
      console.log(
        `  ${ansi.ok('✓')} ${padLabel(m.diagAuthChain, 10)}${ansi.cyan(m.authChainOk)}`,
      );
    } else if (probeStatus === 401) {
      console.log(
        `  ${ansi.err('✗')} ${padLabel(m.diagAuthChain, 10)}${m.authChainRejected}`,
      );
    } else {
      console.log(
        `  ${ansi.warn('⚠')} ${padLabel(m.diagAuthChain, 10)}${m.authChainUnreachable}`,
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
        `  ${padLabel(m.runtimeHomeLabel, 14)}${ansi.cyan(resolveRuntimeHome(rr.kiroHome, DATA_DIR))}`,
      );
    } catch {
      console.log(`  ${ansi.err('✗')} ${m.diagParseError}`);
    }
  } else {
    console.log(
      `  ${ansi.err('✗')} ${m.diagNotFound} ${ansi.dim('(run: kiro-mem install)')}`,
    );
  }

  console.log(
    `\n${ansi.bold(`── ${m.diagDatabase} ────────────────────────────`)}`,
  );
  if (existsSync(dbPath)) {
    try {
      // Via MemoryDB so query logic is shared with /health, and metric_events is
      // created if an older DB predates it (idempotent).
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
      // Nothing prunes either: `turn_events` gains a row per tool call, `succeeded`
      // jobs are only marked, never deleted. Both monotonic.
      console.log(
        `  ${padLabel(m.diagTurnEvents, 14)}${ansi.cyan(String(s.storage.turnEventsApprox))} ${ansi.dim(`· ${m.diagJobsSucceeded} ${s.storage.jobsSucceeded} ${m.diagJobsSucceededHint}`)}`,
      );
      console.log(
        `  ${padLabel(m.diagSearch, 14)}${ansi.cyan(String(s.search24h.requests))} / ${ansi.cyan(pct(s.search24h.degradeRate))} ${m.diagDegrade} / p50 ${ansi.cyan(`${s.search24h.latencyMsP50}ms`)} / p95 ${ansi.cyan(`${s.search24h.latencyMsP95}ms`)}`,
      );
      // Independent semantic recall (phase 2C) works only in the English vector
      // space, so this coverage — not the offline benchmark — decides reachability.
      const cfgRetrieval = (() => {
        try {
          const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
          return raw?.retrieval?.semanticDiscovery !== false;
        } catch {
          return true;
        }
      })();
      console.log(
        `  ${padLabel(m.diagDiscovery, 14)}${cfgRetrieval ? ansi.cyan('on') : ansi.warn('off (rollback)')} ${ansi.dim(`· ${m.diagSemanticEn} ${pct(s.search24h.semanticEnRate)} (${s.search24h.protocolSemanticEn}/${s.search24h.requests})`)}`,
      );
      if (s.search24h.zeroFts > 0 || s.search24h.semanticOnlyTotal > 0) {
        console.log(
          `  ${padLabel(m.diagZeroFts, 14)}${ansi.cyan(`${s.search24h.zeroFtsRecalled}/${s.search24h.zeroFts}`)} ${ansi.dim(`· ${m.diagSemanticOnly} ${s.search24h.semanticOnlyPerRequest} ${m.diagPerRequest} / max ${s.search24h.semanticOnlyMax}`)}`,
        );
      }
      // scope 内向量数（方案 §8.2）：`emptyScopeRequests` 非 0 时升级成告警——那批
      // 请求的语义腿是结构性不可能，不是"没有相关记录"。
      if (s.search24h.scopeVectorsMeasured > 0) {
        const empty = s.search24h.emptyScopeRequests;
        console.log(
          `  ${empty > 0 ? `${ansi.warn('⚠')} ` : ''}${padLabel(m.diagScopeVectors, empty > 0 ? 12 : 14)} ${ansi.cyan(String(s.search24h.scopeVectorsAvg))} ${ansi.dim(`· min ${s.search24h.scopeVectorsMin} · ${m.diagEmptyScope} ${empty}/${s.search24h.scopeVectorsMeasured}`)}`,
        );
      }
      // Quiet on a healthy install; prints only when something was refused or omitted.
      const issues = Object.entries(s.search24h.semanticQueryIssues);
      if (issues.length > 0) {
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagSemanticQueryIssues, 12)} ${ansi.dim(issues.map(([r, c]) => `${r}:${c}`).join(' '))}`,
        );
      }
      console.log(
        `  ${padLabel(m.diagAcpWindow, 14)}${m.diagRepairs}: ${ansi.cyan(String(s.acp24h.repairs))} / ${m.diagContam}: ${ansi.cyan(String(s.acp24h.contaminations))}`,
      );
      // Non-zero only: a silent Hook rejection is worth a line.
      if (s.auth24h.unauthorized > 0) {
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagAuthRejected, 12)}${ansi.cyan(String(s.auth24h.unauthorized))} ${m.diagAuthRejectedHint}`,
        );
      }
      // Capture is best-effort and a dropped raw event is unrecoverable — make the
      // gap visible instead of letting it look like an idle period.
      const misses = readCaptureMisses(DATA_DIR);
      if (misses.total > 0) {
        const detail = Object.entries(misses.byReason)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(' ');
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagCaptureMissed, 12)}${ansi.cyan(String(misses.total))} ${ansi.dim(detail)} ${m.diagCaptureMissedHint}`,
        );
      }
      // Size from the stats read above, not a second `Bun.file()` stat, so this line
      // and `/health` can never disagree. WAL beside it because a WAL several times
      // the main DB is checkpoint starvation — a different defect from "corpus grew".
      const sizeMb = (bytes: number) =>
        bytes >= 0 ? `${(bytes / 1048576).toFixed(1)} MB` : m.diagStorageUnavailable;
      console.log(
        `  ${padLabel(m.diagSize, 14)}${ansi.cyan(sizeMb(s.storage.dbBytes))} ${ansi.dim(`· ${m.diagWalSize} ${sizeMb(s.storage.walBytes)}`)}`,
      );
      if (s.storage.dbBytes > 0 && s.storage.walBytes > s.storage.dbBytes * 2) {
        console.log(`  ${ansi.warn('⚠')} ${ansi.dim(m.diagWalHint)}`);
      }
      mdb.close();
    } catch (e) {
      console.log(
        `  ${ansi.err('✗')} Error: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else {
    console.log(`  ${ansi.warn('⚠')} ${m.diagNotCreated}`);
  }

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

/**
 * Reconcile the Truth Layer against its projections (P0-5). A dropped raw event is
 * gone for good, but a missing projection is recoverable: the turn and its events
 * are still there.
 *
 * Never deletes a terminal job row — the original `last_error` is the only record
 * of why the projection failed, and repair must not destroy evidence.
 */
async function repair() {
  const dbPath = join(DATA_DIR, 'kiro-mem.db');
  if (!existsSync(dbPath)) {
    console.error(`${ansi.err('✗')} ${m.repairNoDb} ${ansi.dim(dbPath)}`);
    process.exit(1);
  }

  const mdb = new MemoryDB(dbPath);
  try {
    // 动态引入：`src/embedding.ts` 会静态拉入 transformers，其它 CLI 子命令不该付这个启动成本。
    const { DIMENSIONS } = await import('../src/embedding-space');
    const { embeddingSpaceKey, RAW_PROTOCOL, SEMANTIC_EN_PROTOCOL } = await import('../src/semantic-en');
    // 向量孤儿只认 raw-v1：本地可重算、不需要 ACP 翻译。semantic-en-v1 依赖英文派生值先
    // ready，所以下面单独排 renormalize_observation，补完后那条 job 自己会排 embed。
    const vector = {
      embeddingModel: embeddingSpaceKey(RAW_PROTOCOL),
      embeddingDimensions: DIMENSIONS,
    };
    const found = mdb.findOrphans(vector);
    const turns = found.turnsWithoutObservation.length;
    const observations = found.observationsWithoutEmbedding.length;
    const missingSemantic = mdb.findObservationsMissingSemanticText({
      protocol: SEMANTIC_EN_PROTOCOL,
    }).length;
    // `failed` 不进重建队列（护栏两次拒绝过同一份内容），但必须显示——否则是无人知晓的黑洞。
    const semanticStatus = mdb.countObservationSemanticTexts(SEMANTIC_EN_PROTOCOL);

    if (turns === 0 && observations === 0 && missingSemantic === 0) {
      console.log(`${ansi.ok('✓')} ${m.repairNothing}`);
      if (semanticStatus.failed > 0) {
        console.log(
          `  ${ansi.dim(`${m.repairSemanticFailed} ${semanticStatus.failed}`)}`,
        );
      }
      return;
    }

    console.log(`${m.repairFound}`);
    const pad = (s: string) => s.padEnd(30, ' ');
    if (turns > 0) console.log(`  ${pad(m.repairTurns)}${ansi.cyan(String(turns))}`);
    if (observations > 0) console.log(`  ${pad(m.repairEmbeddings)}${ansi.cyan(String(observations))}`);
    if (missingSemantic > 0) console.log(`  ${pad(m.repairSemanticTexts)}${ansi.cyan(String(missingSemantic))}`);

    const queued = mdb.requeueOrphans(vector);
    const queuedSemantic = mdb.requeueSemanticTextRebuild({ protocol: SEMANTIC_EN_PROTOCOL });
    console.log(
      `${ansi.ok('✓')} ${m.repairQueued} ${ansi.cyan(String(queued.summarize))} summarize_turn / ${ansi.cyan(String(queued.embed))} embed_observation / ${ansi.cyan(String(queuedSemantic))} renormalize_observation`,
    );
    if (semanticStatus.failed > 0) {
      console.log(`  ${ansi.dim(`${m.repairSemanticFailed} ${semanticStatus.failed}`)}`);
    }
    console.log(`  ${ansi.dim(m.repairHint)}`);
  } finally {
    mdb.close();
  }
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
  diagnose             ${m.helpDiagnose}
  repair               ${m.helpRepair}
  viewer               ${m.helpViewer}`);
}

/**
 * Open the Web Viewer in the default browser (plan §6.1).
 *
 * The token travels in the URL fragment, which is never sent to the server: it
 * stays out of the Worker's access log and out of any Referer, and the page moves
 * it into that tab's `sessionStorage`. A query parameter would put a live
 * credential into browser history.
 */
async function viewer() {
  if (!existsSync(join(DATA_DIR, 'config.json'))) {
    console.log(`${ansi.err('✗')} ${m.notInstalled} ${ansi.cyan('kiro-mem install')}`);
    return;
  }

  const token = readLocalAuthToken(DATA_DIR);
  if (!token) {
    console.log(`${ansi.err('✗')} ${m.viewerNoToken} ${ansi.cyan('kiro-mem install')}`);
    return;
  }

  // The running Worker's port, not the configured one: they differ while a config
  // edit waits for a restart, and the Viewer has to reach the live process.
  const portFile = join(DATA_DIR, '.worker.port');
  let port = 37778;
  try {
    const fromConfig = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf-8'))?.worker?.port;
    if (Number.isInteger(fromConfig)) port = fromConfig;
  } catch {}
  if (existsSync(portFile)) {
    const fromDisk = Number(readFileSync(portFile, 'utf-8').trim());
    if (Number.isInteger(fromDisk) && fromDisk > 0) port = fromDisk;
  }

  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!health.ok) throw new Error(String(health.status));
  } catch {
    console.log(`${ansi.err('✗')} ${m.viewerWorkerDown} ${ansi.cyan('kiro-mem start')}`);
    return;
  }

  const url = `${base}/ui#token=${encodeURIComponent(token)}`;

  console.log(`${ansi.ok('✓')} ${m.viewerOpening}`);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const opened = spawnSync(opener, [url], { stdio: 'ignore' });
  if (opened.status !== 0) {
    // No desktop session (SSH, headless): print the URL rather than fail. It carries
    // a live token, so say so instead of printing it silently.
    console.log(`${ansi.warn('!')} ${m.viewerOpenManually}`);
    console.log(`   ${ansi.cyan(url)}`);
  }
}
