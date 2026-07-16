/**
 * Pure scope resolution for the MCP `search` tool (design §10.2).
 *
 * Pulled out of the MCP server module so it has NO import side effects (the
 * server constructs a DB singleton on import) and can be unit-tested with an
 * injected cwd / repo detector.
 *
 * Scope rule (design §10.2):
 *   MCP search accepts `repo` or `cwd` as an explicit filter. If NEITHER is
 *   given, the active Kiro session must resolve to a recorded workspace.
 *   Missing authoritative scope fails closed; only an explicit
 *   `all_scopes: true` opts out into a global browse.
 */

import { computeScopeKey } from '../db/scope';

/** Detect the enclosing git repo root for a directory, or null. */
export function detectRepo(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd });
    if (proc.exitCode === 0) return proc.stdout.toString().trim();
  } catch {
    // git missing / not a repo — fall through to cwd-based scope.
  }
  return null;
}

export interface ScopeArgs {
  repo?: string;
  cwd?: string;
  all_scopes?: boolean;
}

export interface ResolveScopeDeps {
  /** Injectable for tests; defaults to git detection. */
  detectRepo?: (cwd: string) => string | null;
  /**
   * Resolve the scope key from the active Kiro session. Kiro injects
   * `KIRO_SESSION_ID` into MCP server processes, and the worker records each
   * session's real workspace (cwd/repo) in `session_refs` from the
   * userPromptSubmit hook. Looking that up is authoritative — it ties the
   * default scope to the session the Agent is actually running in, rather than
   * assuming the MCP process cwd equals the workspace. Returns undefined when
   * no session is known (no KIRO_SESSION_ID, or no session_ref yet).
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
 * Compute the hard scope filter for a `search` call.
 *
 * - `all_scopes: true`            -> undefined (global browse, explicit opt-out)
 * - explicit `repo` and/or `cwd`  -> scope key from those args (cwd detects git root)
 * - neither given                 -> the active session's recorded workspace
 *                                    (KIRO_SESSION_ID -> session_refs)
 *
 * Returning `undefined` means "no scope filter" and is reserved exclusively for
 * the explicit all-scopes browse. A missing default scope throws instead of
 * guessing from the MCP process working directory.
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

  // Prefer the active session's recorded workspace (authoritative). This is set
  // by the userPromptSubmit hook from Kiro's real cwd, so it does not depend on
  // where the MCP server process happened to be launched.
  const fromSession = deps?.sessionScope?.();
  if (fromSession) return fromSession;

  throw new MissingSearchScopeError();
}
