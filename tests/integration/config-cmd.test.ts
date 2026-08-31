/**
 * `kiro-mem config` write-back.
 *
 * The interactive form rebuilds the `compression` block from its own answers, so
 * before this round it REPLACED the block wholesale. That is a silent data-loss
 * path: someone who hand-edited a field the form does not ask about lost it the
 * next time they changed only the language, and the Worker then came back up on
 * a setting nobody chose.
 *
 * The second case is `idleTtlMs = 0`. Every other numeric answer goes through a
 * shared `Math.min/Math.max` clamp; 0 must not, because it is a legal answer
 * meaning "never retire on idle" and clamping raises it to the floor — turning
 * "leave my processes alone" into "recycle continuously".
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const ROOT = resolve(import.meta.dir, '../..');
const SETUP = join(ROOT, 'scripts/setup.ts');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedHome(config: Record<string, unknown>) {
  const home = mkdtempSync(join(tmpdir(), 'kiro-mem-cfg-'));
  dirs.push(home);
  const dataDir = join(home, '.kiro-mem');
  const binDir = join(home, 'bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify(config, null, 2));
  // `config` restarts the Worker at the end. Stubs keep that from touching the
  // developer's real launchd/systemd.
  for (const name of ['kiro-cli', 'bun', 'launchctl', 'systemctl']) {
    const path = join(binDir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
  }
  return { home, dataDir, binDir };
}

/**
 * Drives the interactive prompts. Answer order: language choice, then
 * concurrency, timeout, retries, minWarmRuntimes, idleTtlMs.
 *
 * Answers are written one at a time on a pipe that stays OPEN. Handing the whole
 * script over as a single closed stdin does not work: readline consumes the first
 * line, stdin hits EOF, and every later `question()` callback is simply never
 * called — the child then blocks forever on the second prompt. That is a property
 * of the interactive CLI (a human always has a TTY), not of this test.
 */
async function runConfig(home: string, answers: string[], args: string[] = ['config']) {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    KIRO_HOME: join(home, 'kiro-home'),
    PATH: `${join(home, 'bin')}:${process.env.PATH}`,
  };
  delete childEnv.KIRO_MEMORY_DATA_DIR;
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', SETUP, ...args],
    cwd: ROOT,
    env: childEnv,
    // Always a pipe, even for `--show` which never reads it: a literal keeps
    // `proc.stdin` typed as a writable, and an unread open pipe does not delay
    // the child's exit.
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdin = proc.stdin;

  if (answers.length > 0) {
    void (async () => {
      for (const answer of answers) {
        await Bun.sleep(250);
        try {
          stdin.write(`${answer}\n`);
          stdin.flush();
        } catch {
          break; // child already exited
        }
      }
    })();
  }

  const stdoutText = new Response(proc.stdout).text();
  const outcome = await Promise.race([
    proc.exited,
    Bun.sleep(15_000).then(() => 'timeout' as const),
  ]);
  if (outcome === 'timeout') {
    proc.kill();
    // Fail loudly rather than hanging the suite: the usual cause is a prompt
    // being added to the form without a matching answer here.
    throw new Error(`kiro-mem ${args.join(' ')} never finished — prompt count may have changed`);
  }
  const stdout = (await stdoutText).replace(/\x1b\[[0-9;]*m/g, '');
  return { stdout, exitCode: outcome };
}

function readConfig(dataDir: string) {
  return JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf-8'));
}

describe('kiro-mem config write-back', () => {
  test('preserves a compression field the interactive form does not ask about', async () => {
    const { home, dataDir } = isolatedHome({
      language: 'zh',
      compression: {
        concurrency: 3,
        timeoutMs: 30000,
        maxRetries: 2,
        // Documented as an internal pool parameter, but nothing stops a user
        // from setting it by hand — and the form has no question for it.
        maxJobsPerProcess: 20,
      },
      runtime: { kiroHome: '' },
    });

    // English, then every field answered explicitly. Empty-line "accept the
    // default" is avoided on purpose — it makes the assertion depend on the
    // prompt's default rather than on what was written.
    const run = await runConfig(home, ['2', '3', '30000', '2', '1', '600000']);
    expect(run.exitCode).toBe(0);

    const cfg = readConfig(dataDir);
    expect(cfg.compression.maxJobsPerProcess).toBe(20);
    // …and the fields the form does own were still written.
    expect(cfg.language).toBe('en');
    expect(cfg.compression.minWarmRuntimes).toBe(1);
    expect(cfg.compression.idleTtlMs).toBe(600000);
  }, 20_000);

  test('an explicit idleTtlMs of 0 is written as 0, not raised to the floor', async () => {
    const { home, dataDir } = isolatedHome({
      language: 'en',
      compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 },
      runtime: { kiroHome: '' },
    });

    const run = await runConfig(home, ['2', '3', '30000', '2', '1', '0']);
    expect(run.exitCode).toBe(0);

    const cfg = readConfig(dataDir);
    // 1000 here would mean the shared clamp swallowed the answer.
    expect(cfg.compression.idleTtlMs).toBe(0);
    expect(cfg.compression.minWarmRuntimes).toBe(1);
  }, 20_000);

  test('a value under the floor is raised, so 0 is the only way to switch reclaim off', async () => {
    const { home, dataDir } = isolatedHome({
      language: 'en',
      compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 },
      runtime: { kiroHome: '' },
    });

    const run = await runConfig(home, ['2', '3', '30000', '2', '1', '250']);
    expect(run.exitCode).toBe(0);
    expect(readConfig(dataDir).compression.idleTtlMs).toBe(1000);
  }, 20_000);

  test('the warm floor cannot exceed the concurrency answered alongside it', async () => {
    const { home, dataDir } = isolatedHome({
      language: 'en',
      compression: { concurrency: 3, timeoutMs: 30000, maxRetries: 2 },
      runtime: { kiroHome: '' },
    });

    // concurrency 1, then ask for 5 warm runtimes.
    const run = await runConfig(home, ['2', '1', '30000', '2', '5', '600000']);
    expect(run.exitCode).toBe(0);
    const cfg = readConfig(dataDir);
    expect(cfg.compression.concurrency).toBe(1);
    expect(cfg.compression.minWarmRuntimes).toBe(1);
  }, 20_000);
});

describe('kiro-mem config --show', () => {
  test('shows both idle governance settings', async () => {
    const { home } = isolatedHome({
      language: 'en',
      compression: {
        concurrency: 2, timeoutMs: 30000, maxRetries: 2,
        minWarmRuntimes: 2, idleTtlMs: 120000,
      },
      runtime: { kiroHome: '' },
    });
    const show = await runConfig(home, [], ['config', '--show']);
    expect(show.stdout).toContain('Warm runtimes:');
    expect(show.stdout).toContain('2');
    expect(show.stdout).toContain('Idle retire (ms):');
    expect(show.stdout).toContain('120000');
  }, 20_000);

  test('reports a disabled reclaim as off rather than as the number 0', async () => {
    const { home } = isolatedHome({
      language: 'en',
      compression: {
        concurrency: 2, timeoutMs: 30000, maxRetries: 2,
        minWarmRuntimes: 1, idleTtlMs: 0,
      },
      runtime: { kiroHome: '' },
    });
    const show = await runConfig(home, [], ['config', '--show']);
    // "0" would read as a value; the operator needs to see that idle reclaim is
    // switched off entirely.
    expect(show.stdout).toContain('Idle retire (ms):');
    expect(show.stdout).toContain('off');
  }, 20_000);
});
