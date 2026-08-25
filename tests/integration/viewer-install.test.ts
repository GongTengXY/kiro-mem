/**
 * Viewer build and installation (plan §5.2, test matrix §10.4).
 *
 * The claim under test is that a user who installs from npm gets a working Viewer
 * without the source repository: the bundle is in the published payload, the
 * installer copies it into the data dir, and the Worker serves it from there.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const ROOT = resolve(import.meta.dir, '../..');
const SETUP = join(ROOT, 'scripts/setup.ts');
const DIST_UI = join(ROOT, 'dist/ui');
const VIEWER_FILES = ['viewer.html', 'viewer.js', 'styles.css'] as const;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeCommand(dir: string, name: string, body = 'exit 0') {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function run(cmd: string[], env?: Record<string, string>) {
  const childEnv: Record<string, string | undefined> = { ...process.env, ...(env ?? {}) };
  if (env) delete childEnv.KIRO_MEMORY_DATA_DIR;
  const proc = Bun.spawn({ cmd, cwd: ROOT, env: childEnv, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('viewer bundle build', () => {
  test('build:ui is repeatable and produces a self-contained, CDN-free bundle', async () => {
    const first = await run([process.execPath, 'run', join(ROOT, 'scripts/build-viewer.ts')]);
    expect(first.exitCode).toBe(0);
    for (const file of VIEWER_FILES) expect(existsSync(join(DIST_UI, file))).toBe(true);
    const firstJs = readFileSync(join(DIST_UI, 'viewer.js'), 'utf-8');

    // A stale artefact must not survive a rebuild.
    writeFileSync(join(DIST_UI, 'stale.js'), 'stale');
    const second = await run([process.execPath, 'run', join(ROOT, 'scripts/build-viewer.ts')]);
    expect(second.exitCode).toBe(0);
    expect(existsSync(join(DIST_UI, 'stale.js'))).toBe(false);
    expect(readFileSync(join(DIST_UI, 'viewer.js'), 'utf-8')).toBe(firstJs);

    const html = readFileSync(join(DIST_UI, 'viewer.html'), 'utf-8');
    // Zero network beyond loopback: no remote origin in any shipped asset.
    for (const text of [html, firstJs, readFileSync(join(DIST_UI, 'styles.css'), 'utf-8')]) {
      expect(text).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+\.[a-z]{2,}/i);
    }
    expect(html).toContain('/ui/viewer.js');
    expect(html).toContain('/ui/styles.css');
    // Preact is bundled in rather than declared as a runtime dependency.
    expect(firstJs.length).toBeGreaterThan(10_000);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(Object.keys(pkg.dependencies)).not.toContain('preact');
    expect(Object.keys(pkg.devDependencies)).toContain('preact');
  }, 60_000);

  test('npm pack ships dist/ui', async () => {
    const packed = await run(['npm', 'pack', '--dry-run']);
    const output = `${packed.stdout}${packed.stderr}`;
    for (const file of VIEWER_FILES) expect(output).toContain(`dist/ui/${file}`);
  }, 60_000);
});

describe('viewer installation layout', () => {
  test('install copies the bundle to <dataDir>/ui and a non-purge uninstall removes it', async () => {
    // The bundle has to exist before install can copy it.
    expect((await run([process.execPath, 'run', join(ROOT, 'scripts/build-viewer.ts')])).exitCode).toBe(0);

    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-viewer-home-'));
    dirs.push(home);
    const dataDir = join(home, '.kiro-mem');
    const binDir = join(home, 'bin');
    mkdirSync(join(home, 'kiro-home', 'agents'), { recursive: true });
    mkdirSync(binDir);
    fakeCommand(binDir, 'launchctl');
    fakeCommand(binDir, 'systemctl');
    fakeCommand(binDir, 'kiro-cli', 'echo "kiro-cli 3.0.0"; exit 0');
    fakeCommand(binDir, 'bun', 'if [ "$1" = "--version" ]; then echo "1.2.20"; fi; exit 0');
    const env = {
      HOME: home,
      KIRO_HOME: join(home, 'kiro-home'),
      KIRO_MEMORY_LANGUAGE: 'en',
      PATH: `${binDir}:${process.env.PATH}`,
    };

    const install = await run([process.execPath, 'run', SETUP, 'install'], env);
    expect(install.exitCode).toBe(0);
    for (const file of VIEWER_FILES) {
      expect(existsSync(join(dataDir, 'ui', file))).toBe(true);
    }
    // The Worker's own modules for the Viewer must be in the installed tree too.
    for (const file of ['viewer-routes.ts', 'viewer-stream.ts', 'viewer-types.ts']) {
      expect(existsSync(join(dataDir, 'src', 'server', file))).toBe(true);
    }

    // A database file to prove uninstall keeps data while dropping the UI runtime.
    writeFileSync(join(dataDir, 'kiro-mem.db'), 'not-a-real-db');
    const uninstall = await run([process.execPath, 'run', SETUP, 'uninstall'], env);
    expect(uninstall.exitCode).toBe(0);
    expect(existsSync(join(dataDir, 'ui'))).toBe(false);
    expect(existsSync(join(dataDir, 'kiro-mem.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'config.json'))).toBe(true);
  }, 60_000);

  test('kiro-mem viewer refuses clearly when the Worker is not reachable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-viewer-cli-'));
    dirs.push(home);
    const dataDir = join(home, '.kiro-mem');
    mkdirSync(dataDir, { recursive: true });
    // An unused high port with nothing listening.
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ language: 'en', worker: { port: 44911 } }));
    writeFileSync(join(dataDir, '.token'), 'f'.repeat(64));
    chmodSync(join(dataDir, '.token'), 0o600);

    const res = await run([process.execPath, 'run', SETUP, 'viewer'], {
      HOME: home,
      KIRO_MEMORY_LANGUAGE: 'en',
      PATH: process.env.PATH ?? '',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('kiro-mem start');
    // The token must never be printed on a failure path.
    expect(`${res.stdout}${res.stderr}`).not.toContain('f'.repeat(64));
  }, 30_000);

  test('viewer prints the URL with the token in the FRAGMENT when it cannot open a browser', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kiro-mem-viewer-url-'));
    dirs.push(home);
    const dataDir = join(home, '.kiro-mem');
    const binDir = join(home, 'bin');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(binDir);
    // Both openers fail, so the command falls back to printing the URL.
    fakeCommand(binDir, 'open', 'exit 1');
    fakeCommand(binDir, 'xdg-open', 'exit 1');

    const token = 'a1b2c3'.repeat(10) + 'abcd';
    const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('{"status":"ok"}') });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ language: 'en', worker: { port: server.port } }));
    writeFileSync(join(dataDir, '.token'), token);
    chmodSync(join(dataDir, '.token'), 0o600);

    try {
      const res = await run([process.execPath, 'run', SETUP, 'viewer'], {
        HOME: home,
        KIRO_MEMORY_LANGUAGE: 'en',
        PATH: `${binDir}:${process.env.PATH}`,
      });
      expect(res.exitCode).toBe(0);
      const url = res.stdout.split('\n').map((l) => l.trim()).find((l) => l.includes('/ui#'));
      expect(url).toBeDefined();
      // Fragment, not query: a fragment is never sent to the server, so it cannot
      // reach an access log or a Referer header.
      expect(url).toContain(`/ui#token=${token}`);
      expect(url).not.toContain('&scope=');
      expect(url).not.toContain('?token=');
      expect(url).toContain(`127.0.0.1:${server.port}`);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});
