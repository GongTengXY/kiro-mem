import { readFileSync } from 'fs';
import { resolve } from 'path';

/** Package version shared by every protocol and runtime surface. */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../package.json'), 'utf-8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim()
      ? pkg.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
