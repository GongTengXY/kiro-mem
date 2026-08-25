/**
 * Viewer credential handover (plan §6.1).
 *
 * `kiro-mem viewer` puts the token in the URL FRAGMENT, not the query string: a
 * fragment is never sent to the server, so it cannot land in an access log, and
 * it is not part of the Referer. The page reads it once, moves it into
 * `sessionStorage` for this tab only, and rewrites the URL so a copied link
 * carries no credential.
 *
 * `sessionStorage` rather than `localStorage` on purpose: closing the tab must
 * end the Viewer's access. A token that survives in `localStorage` would give
 * every later page on 127.0.0.1 — including one served by an unrelated dev
 * server on the same port — a stored credential to find.
 */

const TOKEN_KEY = 'kiro-mem.viewer.token';
const SCOPE_KEY = 'kiro-mem.viewer.scope';

export interface ViewerSession {
  token: string;
  /** null is the explicit all-workspaces selection. */
  scopeKey: string | null;
}

/** Parse `#token=...&scope=...`. Exported for tests; does no I/O. */
export function parseLaunchFragment(fragment: string): { token: string; scopeKey: string | null } {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  const params = new URLSearchParams(raw);
  const token = (params.get('token') ?? '').trim();
  const scope = (params.get('scope') ?? '').trim();
  return { token, scopeKey: scope || null };
}

/**
 * Resolve the session for this tab: fragment first (a fresh launch), then
 * whatever this tab already holds (a reload).
 */
export function bootstrapSession(location: Location, history: History, storage: Storage): ViewerSession {
  const fromFragment = parseLaunchFragment(location.hash || '');
  if (fromFragment.token) {
    storage.setItem(TOKEN_KEY, fromFragment.token);
    // A fresh CLI launch defaults to all workspaces. A scoped fragment remains
    // supported for old bookmarks/tests, but stale tab state must not override
    // the new global default.
    rememberScope(storage, fromFragment.scopeKey);
    // Drop the credential from the address bar, history entry and any Referer.
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return { token: fromFragment.token, scopeKey: fromFragment.scopeKey };
  }
  return {
    token: storage.getItem(TOKEN_KEY) ?? '',
    scopeKey: storage.getItem(SCOPE_KEY),
  };
}

export function rememberScope(storage: Storage, scopeKey: string | null): void {
  if (scopeKey) storage.setItem(SCOPE_KEY, scopeKey);
  else storage.removeItem(SCOPE_KEY);
}

/** Forget the credential for this tab (401, or an explicit sign-out). */
export function clearSession(storage: Storage): void {
  storage.removeItem(TOKEN_KEY);
}
