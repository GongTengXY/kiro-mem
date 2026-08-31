/**
 * Pure scope resolution for the MCP `search` tool (design §10.2).
 * Separate from the MCP server module so it has no import side effects (that
 * module builds a DB singleton on import) and can be unit-tested with an
 * injected repo detector.
 *
 * Scope rule: explicit `repo`/`cwd` filter, or else the active Kiro session's
 * recorded workspace. Missing scope fails closed — only `all_scopes: true`
 * opts into a global browse.
 */

import { computeScopeKey, detectRepo } from '../db/scope';

// Re-exported so callers keep one import site; implementation is in src/db/scope.ts.
export { detectRepo };

export interface ScopeArgs {
  repo?: string;
  cwd?: string;
  all_scopes?: boolean;
}

export interface ResolveScopeDeps {
  /** Injectable for tests; defaults to git detection. */
  detectRepo?: (cwd: string) => string | null;
  /**
   * Scope key of the active Kiro session: `KIRO_SESSION_ID` (injected into MCP
   * server processes) looked up in `session_refs`, which the userPromptSubmit
   * hook records from Kiro's real cwd. Authoritative because the MCP process
   * cwd is not necessarily the workspace. Undefined when no session is known.
   */
  sessionScope?: () => string | undefined;
}

export class MissingSearchScopeError extends Error {
  constructor() {
    super('Search requires the current workspace. Pass repo/cwd, or set all_scopes=true explicitly.');
    this.name = 'MissingSearchScopeError';
  }
}

/**
 * Hard scope filter for a `search` call. `undefined` means "no scope filter" and
 * is reserved for the explicit all-scopes browse; a missing default scope throws
 * rather than guessing from the MCP process working directory.
 */
export function resolveScopeKey(args: ScopeArgs, deps?: ResolveScopeDeps): string | undefined {
  if (args.all_scopes) return undefined;

  if (args.repo) {
    return computeScopeKey(args.repo, args.cwd ?? null);
  }

  if (args.cwd) {
    const detect = deps?.detectRepo ?? detectRepo;
    return computeScopeKey(detect(args.cwd), args.cwd);
  }

  const fromSession = deps?.sessionScope?.();
  if (fromSession) return fromSession;

  throw new MissingSearchScopeError();
}
