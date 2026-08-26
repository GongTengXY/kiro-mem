#!/usr/bin/env bun
/**
 * kiro-mem CLI: install, uninstall, config, status, start, stop, diagnose.
 *
 * V3 highlights:
 * - Atomic Observations with read-time organization and no V2 data migration.
 * - ACP-native compression through an isolated KIRO_HOME.
 * - Bundled local embedding model copied into `~/.kiro-mem/models/`.
 * - Local Worker requests authenticated by an installer-generated token.
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
 * Where this installation's state lives.
 *
 * `KIRO_MEMORY_DATA_DIR` first, matching `getDataDir()` in `src/config.ts` —
 * the Worker, the MCP server and every hook resolve it that way. This file used
 * to look only at `HOME`, so the override silently isolated two of the three
 * entry points: a command run with `KIRO_MEMORY_DATA_DIR=<tmp> kiro-mem repair`
 * looked isolated and actually read, migrated and enqueued jobs into the
 * developer's real database. Tests isolate by overriding `HOME`, so nothing
 * caught it.
 */
const DATA_DIR = process.env.KIRO_MEMORY_DATA_DIR || join(HOME, '.kiro-mem');
const KIRO_HOME = process.env.KIRO_HOME || join(HOME, '.kiro');
const AGENT_DIR = join(KIRO_HOME, 'agents');

const PKG_ROOT = resolve(import.meta.dir, '..');
const SRC_DIR = join(PKG_ROOT, 'src');
const MODELS_DIR = join(PKG_ROOT, 'models');

/**
 * Where the compressor runtime actually lives for THIS installation.
 *
 * Read from config so install / config / diagnose / smoke all inspect the same
 * directory the Worker will use. Previously these were three independent
 * expressions, so a custom `runtime.kiroHome` produced a runtime that worked but
 * that `diagnose` reported as broken, and a re-install silently discarded the
 * setting.
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

/**
 * Web Viewer bundle. Built by `bun run build:ui` into `dist/ui` and published in
 * the npm `files` list, so an installed package carries it without needing the
 * source repository to still exist.
 */
const VIEWER_SRC_DIR = join(PKG_ROOT, 'dist', 'ui');
const VIEWER_DEST_DIR = join(DATA_DIR, 'ui');
const VIEWER_FILES = ['viewer.html', 'viewer.js', 'styles.css'] as const;

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
  compression: { concurrency: number; timeoutMs: number; maxRetries: number };
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
    compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 },
    context: {
      maxOutputBytes: 8192,
    },
    filter: { skipTools: ['introspect', 'todo_list', '@kiro-mem/*'] },
    // Written explicitly rather than left to the loader default so the rollback
    // switch is discoverable in the file the user actually opens.
    retrieval: { semanticDiscovery: true },
    // Empty means "use the default under dataDir" (see resolveRuntimeHome).
    // Writing the resolved absolute path here instead would freeze the data dir
    // into the config file and make the setting look user-chosen when it isn't.
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
        // Preserve a user-chosen runtime home. Overwriting it here meant a
        // re-install silently moved the compressor runtime back to the default
        // directory while the user's config still said otherwise.
        runtime: { kiroHome: existing.runtime?.kiroHome ?? '' },
      };
    } catch {
      // Existing config unparseable — fall back to a fresh language choice.
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

  // Requests from Hooks to the loopback Worker use a local bearer token.
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

  // The installed layout puts hooks at <dataDir>/hooks but server code at
  // <dataDir>/src/server, so no single relative path reaches capture-log from
  // both. Ship the same source file to both trees rather than forking it: the
  // hooks append misses, the Worker's /health reads them back.
  copyFileSync(
    join(SRC_DIR, 'hooks', 'capture-log.ts'),
    join(DATA_DIR, 'src', 'hooks', 'capture-log.ts'),
  );

  for (const file of [
    'worker.ts',
    'mcp-server.ts',
    'mcp-scope.ts',
    'observation-search.ts',
    // Viewer server surface. The Worker imports these directly, so a missing
    // file here breaks the installed runtime while the in-tree build stays green
    // — the case `missingInstalledImports` in setup.test.ts guards against.
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
    // Split out of embedding.ts so the MCP server can resolve the vector-space
    // identity without pulling the inference runtime into every session.
    'embedding-space.ts',
    'semantic-en.ts',
    'worker-embedder.ts',
    // Subtree RSS sampling for /health. The Worker imports it, so omitting it
    // here would break the installed runtime while the in-tree build stayed
    // green — which is exactly what `missingInstalledImports` guards against.
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

  // 8b. Copy the Web Viewer bundle to <dataDir>/ui
  //
  // The Worker resolves the bundle from the INSTALLED directory first, because a
  // real installation has no repository to fall back to. A missing bundle is not
  // fatal — memory capture, compression and MCP all work without it, and `/ui`
  // then answers with a build hint instead of the Worker refusing to start.
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

  // 13. Register system service & (re)start worker
  //
  // restart(), not start(): step 7 just overwrote the runtime source, and a
  // Worker left running from before the copy would keep serving the old build.
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
 * Copy `dist/ui` into `<dataDir>/ui`. Returns false when the package carries no
 * built bundle (a source checkout that has not run `bun run build:ui`).
 *
 * All three files or none: a directory with `viewer.html` but no `viewer.js`
 * would serve a blank page with no diagnosable error, which is worse than the
 * "bundle not found" hint the Worker shows for an absent directory.
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
    // The Viewer bundle is a build artefact of the installed package, not user
    // data — it is reinstalled by `kiro-mem install`, so keeping it would leave a
    // stale UI able to talk to a newer Worker.
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
    compression: newCfg.compression,
    // Kept verbatim: `kiro-mem config` edits language and compression only, so
    // it must not turn an unset (default) runtime home into a hard-coded path.
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
        // The running Worker holds the code it loaded at boot. If it predates
        // the installed files, everything else here still looks healthy while
        // the deployed fix is not actually live.
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

        // --- Runtime footprint ---
        //
        // Only reachable from a live /health: RSS is per-process state that no
        // amount of reading the database can reconstruct. Printed here rather
        // than in the database section for that reason.
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
          // A failed `ps` makes every byte count above meaningless. Say so
          // instead of letting the reader treat '?' as "small".
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

  // 2b. Local auth token + Hook -> Worker auth chain
  //
  // A rejected Hook request is invisible during normal use (Hooks are
  // fire-and-forget), so diagnose is where a broken credential must surface.
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
    // Probe a read-only authenticated route the same way a Hook would. Sent via
    // fetch, not curl, so the token never lands in the process list.
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
      // Nothing prunes either of these: `turn_events` gains a row per tool call
      // and `succeeded` jobs are only ever marked, never deleted. Both are
      // monotonic, so they belong next to the jobs line rather than in a
      // "current state" group.
      console.log(
        `  ${padLabel(m.diagTurnEvents, 14)}${ansi.cyan(String(s.storage.turnEventsApprox))} ${ansi.dim(`· ${m.diagJobsSucceeded} ${s.storage.jobsSucceeded} ${m.diagJobsSucceededHint}`)}`,
      );
      console.log(
        `  ${padLabel(m.diagSearch, 14)}${ansi.cyan(String(s.search24h.requests))} / ${ansi.cyan(pct(s.search24h.degradeRate))} ${m.diagDegrade} / p50 ${ansi.cyan(`${s.search24h.latencyMsP50}ms`)} / p95 ${ansi.cyan(`${s.search24h.latencyMsP95}ms`)}`,
      );
      // Independent semantic recall (phase 2C) only works in the English vector
      // space, so its coverage is the number that decides whether the feature is
      // actually reachable in this install — not the offline benchmark.
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
      // scope 内向量数（方案 §8.2）：语义召回在这个 workspace 上到底有没有可能。
      // 只在测量过的请求上报，`emptyScopeRequests` 非 0 时升级成告警——那批请求的
      // 语义腿是结构性不可能，不是"没有相关记录"。
      if (s.search24h.scopeVectorsMeasured > 0) {
        const empty = s.search24h.emptyScopeRequests;
        console.log(
          `  ${empty > 0 ? `${ansi.warn('⚠')} ` : ''}${padLabel(m.diagScopeVectors, empty > 0 ? 12 : 14)} ${ansi.cyan(String(s.search24h.scopeVectorsAvg))} ${ansi.dim(`· min ${s.search24h.scopeVectorsMin} · ${m.diagEmptyScope} ${empty}/${s.search24h.scopeVectorsMeasured}`)}`,
        );
      }
      // Only when something was actually refused or omitted: a healthy install
      // where the agent always passes the English form should stay quiet.
      const issues = Object.entries(s.search24h.semanticQueryIssues);
      if (issues.length > 0) {
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagSemanticQueryIssues, 12)} ${ansi.dim(issues.map(([r, c]) => `${r}:${c}`).join(' '))}`,
        );
      }
      console.log(
        `  ${padLabel(m.diagAcpWindow, 14)}${m.diagRepairs}: ${ansi.cyan(String(s.acp24h.repairs))} / ${m.diagContam}: ${ansi.cyan(String(s.acp24h.contaminations))}`,
      );
      // Only surfaced when non-zero: a silent Hook rejection is worth a line,
      // a healthy install should stay quiet.
      if (s.auth24h.unauthorized > 0) {
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagAuthRejected, 12)}${ansi.cyan(String(s.auth24h.unauthorized))} ${m.diagAuthRejectedHint}`,
        );
      }
      // Capture is best-effort: a dropped raw event is unrecoverable, so make
      // the gap visible instead of letting it look like an idle period.
      const misses = readCaptureMisses(DATA_DIR);
      if (misses.total > 0) {
        const detail = Object.entries(misses.byReason)
          .map(([reason, count]) => `${reason}:${count}`)
          .join(' ');
        console.log(
          `  ${ansi.warn('⚠')} ${padLabel(m.diagCaptureMissed, 12)}${ansi.cyan(String(misses.total))} ${ansi.dim(detail)} ${m.diagCaptureMissedHint}`,
        );
      }
      // Size comes from the stats read above, not a second `Bun.file()` stat, so
      // this line and `/health` can never disagree. WAL is reported beside it
      // because a WAL several times the main database is a checkpoint-starvation
      // signal — a different defect, with a different fix, than "the corpus grew".
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

/**
 * Reconcile the Truth Layer against its projections (P0-5).
 *
 * A dropped raw event is gone for good, but a MISSING PROJECTION is recoverable:
 * the turn and its events are still there. Before this command existed, a
 * summarize job that reached `dead` left that turn permanently without an
 * Observation, and the cross-state dedupe index made re-enqueueing silently
 * impossible — the memory gap had no repair path at all.
 *
 * This never deletes a terminal job row: the original `last_error` is the only
 * record of why the projection failed, and repair must not destroy evidence.
 */
async function repair() {
  const dbPath = join(DATA_DIR, 'kiro-mem.db');
  if (!existsSync(dbPath)) {
    console.error(`${ansi.err('✗')} ${m.repairNoDb} ${ansi.dim(dbPath)}`);
    process.exit(1);
  }

  const mdb = new MemoryDB(dbPath);
  try {
    // 动态引入：`src/embedding.ts` 会静态拉入 transformers，其它 CLI 子命令不该为它付启动成本。
    // `embedding-space.ts` / `semantic-en.ts` 本身不含推理运行时，但保持同一处引入更好读。
    const { DIMENSIONS } = await import('../src/embedding-space');
    const { embeddingSpaceKey, RAW_PROTOCOL, SEMANTIC_EN_PROTOCOL } = await import('../src/semantic-en');
    // 向量孤儿只认 raw-v1：它是本地可重算的那一腿（不需要 ACP 翻译）。
    // semantic-en-v1 的向量不靠这里补——它依赖英文派生值先 ready，所以下面单独找
    // "缺派生值"的 observation 并排 renormalize_observation，由 Worker 走 ACP 补译，
    // 补完后那条 job 自己会排 embed。
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
    // `failed` 不进重建队列（护栏两次拒绝过同一份内容），但必须显示出来，否则它就是
    // 一个永远不会自愈、也没人知道的黑洞。
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
 * The token travels in the URL FRAGMENT. A fragment is never sent to the server,
 * so it stays out of the Worker's access log and out of any Referer; the page then
 * moves it into that tab's `sessionStorage` and rewrites the URL. A query
 * parameter would have put a live credential into browser history.
 *
 * The Viewer opens on all workspaces by default. The user can narrow the feed
 * from the workspace selector after the page has authenticated.
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
  // edit is waiting for a restart, and the Viewer has to reach the live process.
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
    // No desktop session (SSH, headless): print the URL instead of failing. It
    // carries a live token, so say so rather than logging it silently.
    console.log(`${ansi.warn('!')} ${m.viewerOpenManually}`);
    console.log(`   ${ansi.cyan(url)}`);
  }
}
