#!/usr/bin/env bun
/**
 * Build the Web Viewer bundle (plan §5.2).
 *
 * Preact is a devDependency compiled into one IIFE, so the installed Worker gains
 * no runtime dependency. `styles.css` is copied rather than bundled: an inline
 * <style> would force `style-src 'unsafe-inline'` into the CSP.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const ROOT = resolve(import.meta.dir, '..');
const SRC = join(ROOT, 'src', 'ui');
const OUT = join(ROOT, 'dist', 'ui');

/** Anything that would make the page depend on the network fails the build. */
const FORBIDDEN_REMOTE = /(https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+\.[a-z]{2,}/i;

function main(): void {
  // Rebuilt from scratch, so a renamed source file cannot leave a stale asset.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const result = Bun.spawnSync([
    process.execPath,
    'build',
    join(SRC, 'index.tsx'),
    '--outfile',
    join(OUT, 'viewer.js'),
    '--target',
    'browser',
    '--format',
    'iife',
    '--minify',
    '--define',
    'process.env.NODE_ENV="production"',
  ], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });

  if (result.exitCode !== 0) {
    console.error(result.stderr.toString() || result.stdout.toString());
    console.error('[kiro-mem] viewer bundle build failed');
    process.exit(1);
  }

  const bundlePath = join(OUT, 'viewer.js');
  if (!existsSync(bundlePath)) {
    console.error('[kiro-mem] viewer bundle produced no output');
    process.exit(1);
  }

  writeFileSync(join(OUT, 'styles.css'), readFileSync(join(SRC, 'styles.css')));
  writeFileSync(join(OUT, 'viewer.html'), readFileSync(join(SRC, 'viewer.html')));

  for (const file of ['viewer.js', 'viewer.html', 'styles.css']) {
    const text = readFileSync(join(OUT, file), 'utf-8');
    const match = FORBIDDEN_REMOTE.exec(text);
    if (match) {
      console.error(`[kiro-mem] ${file} references a remote origin (${match[0]}); the Viewer must be offline-only`);
      process.exit(1);
    }
  }

  const bytes = readFileSync(bundlePath).byteLength;
  console.log(`[kiro-mem] viewer bundle: ${(bytes / 1024).toFixed(1)} KB -> dist/ui/`);
}

main();
