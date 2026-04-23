import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const ansi = {
  ok: (s: string) => `\x1b[32m${s}\x1b[0m`,
  err: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const HOME = process.env.HOME || '~';
const DATA_DIR = join(HOME, '.kiro-mem');

// --- Platform detection ---

type Platform = 'macos' | 'linux';

function getPlatform(): Platform {
  return process.platform === 'darwin' ? 'macos' : 'linux';
}

function getBunPath(): string {
  const r = spawnSync('which', ['bun']);
  return r.status === 0 ? r.stdout.toString().trim() : 'bun';
}

// --- macOS launchd ---

const PLIST_LABEL = 'com.kiro-mem.worker';
const PLIST_DIR = join(HOME, 'Library', 'LaunchAgents');
const PLIST_PATH = join(PLIST_DIR, `${PLIST_LABEL}.plist`);

function generatePlist(): string {
  const bunPath = getBunPath();
  const workerPath = join(DATA_DIR, 'src', 'server', 'worker.ts');
  const stdoutLog = join(DATA_DIR, 'logs', 'worker-stdout.log');
  const stderrLog = join(DATA_DIR, 'logs', 'worker-stderr.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${workerPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${DATA_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KIRO_MEMORY_DATA_DIR</key>
    <string>${DATA_DIR}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${stdoutLog}</string>
  <key>StandardErrorPath</key>
  <string>${stderrLog}</string>
</dict>
</plist>`;
}

// --- Linux systemd ---

const SYSTEMD_DIR = join(HOME, '.config', 'systemd', 'user');
const SERVICE_NAME = 'kiro-mem.service';
const SERVICE_PATH = join(SYSTEMD_DIR, SERVICE_NAME);

function generateService(): string {
  const bunPath = getBunPath();
  const workerPath = join(DATA_DIR, 'src', 'server', 'worker.ts');
  return `[Unit]
Description=kiro-mem Worker Service
After=network.target

[Service]
Type=simple
ExecStart=${bunPath} run ${workerPath}
WorkingDirectory=${DATA_DIR}
Environment=KIRO_MEMORY_DATA_DIR=${DATA_DIR}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target`;
}

// --- Public API ---

export function registerService(): string {
  const platform = getPlatform();
  if (platform === 'macos') {
    mkdirSync(PLIST_DIR, { recursive: true });
    writeFileSync(PLIST_PATH, generatePlist());
    return 'launchd service registered (auto-restart on crash, start on login)';
  }
  mkdirSync(SYSTEMD_DIR, { recursive: true });
  writeFileSync(SERVICE_PATH, generateService());
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  spawnSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'pipe' });
  return 'systemd service registered (auto-restart on crash, start on boot)';
}

export function removeService() {
  const platform = getPlatform();
  if (platform === 'macos') {
    spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' });
    if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH);
  } else {
    spawnSync('systemctl', ['--user', 'disable', '--now', SERVICE_NAME], { stdio: 'pipe' });
    if (existsSync(SERVICE_PATH)) rmSync(SERVICE_PATH);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
  }
}

export function start() {
  const pidFile = join(DATA_DIR, '.worker.pid');
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf-8').trim();
    const check = spawnSync('kill', ['-0', pid]);
    if (check.status === 0) {
      console.log(`${ansi.ok('✓')} Worker already running ${ansi.dim(`(PID: ${pid})`)}`);
      return;
    }
  }
  const worker = join(DATA_DIR, 'src', 'server', 'worker.ts');
  if (!existsSync(worker)) {
    console.error(`${ansi.err('✗')} Worker not found. Run ${ansi.cyan('kiro-mem install')} first.`);
    return;
  }

  const platform = getPlatform();
  if (platform === 'macos') {
    if (!existsSync(PLIST_PATH)) registerService();
    spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' });
    const r = spawnSync('launchctl', ['load', PLIST_PATH], { stdio: 'pipe' });
    if (r.status === 0) console.log(`${ansi.ok('✓')} Worker started ${ansi.dim('(launchd)')}`);
    else console.error(`${ansi.err('✗')} launchctl load failed`);
  } else {
    if (!existsSync(SERVICE_PATH)) registerService();
    const r = spawnSync('systemctl', ['--user', 'start', SERVICE_NAME], { stdio: 'pipe' });
    if (r.status === 0) console.log(`${ansi.ok('✓')} Worker started ${ansi.dim('(systemd)')}`);
    else console.error(`${ansi.err('✗')} systemctl start failed`);
  }
}

export function stop() {
  const platform = getPlatform();
  if (platform === 'macos') {
    if (existsSync(PLIST_PATH)) {
      spawnSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' });
    }
  } else {
    spawnSync('systemctl', ['--user', 'stop', SERVICE_NAME], { stdio: 'pipe' });
  }

  const pidFile = join(DATA_DIR, '.worker.pid');
  const portFile = join(DATA_DIR, '.worker.port');
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf-8').trim();
    spawnSync('kill', [pid], { stdio: 'pipe' });
  }
  rmSync(pidFile, { force: true });
  rmSync(portFile, { force: true });
  console.log(`${ansi.ok('✓')} Worker stopped`);
}

export function status() {
  const pidFile = join(DATA_DIR, '.worker.pid');
  const portFile = join(DATA_DIR, '.worker.port');
  const platform = getPlatform();

  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf-8').trim();
    const check = spawnSync('kill', ['-0', pid]);
    if (check.status === 0) {
      const port = existsSync(portFile) ? readFileSync(portFile, 'utf-8').trim() : '?';
      const managed = platform === 'macos' ? existsSync(PLIST_PATH) : existsSync(SERVICE_PATH);
      const svc = managed ? ansi.dim(` [${platform === 'macos' ? 'launchd' : 'systemd'} managed]`) : '';
      console.log(`${ansi.ok('▶')} Worker running ${ansi.dim(`(PID: ${pid}, port: ${port})`)}${svc}`);
      return;
    }
    rmSync(pidFile);
  }

  if (platform === 'macos' && existsSync(PLIST_PATH)) {
    console.log(`${ansi.warn('⏹')} Worker not running ${ansi.dim('(launchd registered, try: kiro-mem start)')}`);
  } else if (platform === 'linux' && existsSync(SERVICE_PATH)) {
    console.log(`${ansi.warn('⏹')} Worker not running ${ansi.dim('(systemd registered, try: kiro-mem start)')}`);
  } else {
    console.log(`${ansi.err('⏹')} Worker not running`);
  }
}
