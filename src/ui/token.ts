/**
 * Viewer credential handover (plan §6.1).
 *
 * The token arrives in the URL fragment, not the query string: a fragment is
 * never sent to the server, so it stays out of access logs and the Referer. The
 * page reads it once, rewrites the URL so a copied link carries no credential,
 * and keeps it in `sessionStorage`, not `localStorage` — closing the tab must end
 * access, and a surviving token would be readable by any later page on 127.0.0.1,
 * including one served by an unrelated dev server on the same port.
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

/** Resolve this tab's session: fragment first (a fresh launch), then stored (a reload). */
export function bootstrapSession(location: Location, history: History, storage: Storage): ViewerSession {
  const fromFragment = parseLaunchFragment(location.hash || '');
  if (fromFragment.token) {
    storage.setItem(TOKEN_KEY, fromFragment.token);
    // The fragment's scope wins over stale tab state; a fresh launch defaults to all workspaces.
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
