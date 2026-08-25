/**
 * Viewer API client.
 *
 * Everything goes through `fetch` with an `Authorization` header — including the
 * SSE stream, which is why `EventSource` is not used anywhere in this bundle
 * (it cannot set headers, and the alternative is a token in the URL).
 */

import type {
  ViewerBootstrap,
  ViewerContextPreview,
  ViewerDeleteResponse,
  ViewerEventsResponse,
  ViewerListResponse,
  ViewerLogsResponse,
  ViewerObservationDetail,
  ViewerRetrievalHealth,
  ViewerSearchResponse,
} from '../server/viewer-types';

/** Carries the HTTP status so the UI can tell 401 from 409 from a network drop. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status}:${code}`);
    this.name = 'ApiError';
  }
}

export interface ScopeSelection {
  scopeKey: string | null;
  allScopes: boolean;
}

/** Only `allScopes: true` lifts the filter, mirroring the server's rule. */
function scopeBody(scope: ScopeSelection): Record<string, unknown> {
  return scope.allScopes ? { allScopes: true } : { scopeKey: scope.scopeKey };
}

export class ViewerApi {
  constructor(private token: string) {}

  setToken(token: string): void {
    this.token = token;
  }

  private headers(json = true): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async parse<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let code = String(res.status);
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) code = body.error;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    return this.parse<T>(res);
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(path, { headers: this.headers(false) });
    return this.parse<T>(res);
  }

  bootstrap(): Promise<ViewerBootstrap> {
    return this.get<ViewerBootstrap>('/api/viewer/bootstrap');
  }

  list(scope: ScopeSelection, cursor?: string | null, limit?: number): Promise<ViewerListResponse> {
    return this.post<ViewerListResponse>('/api/viewer/observations/list', {
      ...scopeBody(scope),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  detail(scope: ScopeSelection, id: number): Promise<ViewerObservationDetail> {
    return this.post<ViewerObservationDetail>('/api/viewer/observations/detail', { ...scopeBody(scope), id });
  }

  events(scope: ScopeSelection, id: number, cursor?: string | null): Promise<ViewerEventsResponse> {
    return this.post<ViewerEventsResponse>('/api/viewer/observations/events', {
      ...scopeBody(scope),
      id,
      ...(cursor ? { cursor } : {}),
    });
  }

  search(scope: ScopeSelection, q: string, opts?: { type?: string; days?: number }): Promise<ViewerSearchResponse> {
    return this.post<ViewerSearchResponse>('/api/viewer/search', {
      ...scopeBody(scope),
      q,
      ...(opts?.type ? { type: opts.type } : {}),
      ...(opts?.days ? { days: opts.days } : {}),
    });
  }

  contextPreview(scopeKey: string, maxOutputBytes?: number): Promise<ViewerContextPreview> {
    return this.post<ViewerContextPreview>('/api/viewer/context-preview', {
      scopeKey,
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    });
  }

  pin(scope: ScopeSelection, id: number, pinned: boolean): Promise<{ ok: true; id: number; pinned: boolean }> {
    return this.post('/api/viewer/observations/pin', { ...scopeBody(scope), id, pinned });
  }

  /**
   * Permanent deletion. One id, no options: the server deletes the Observation
   * and the turn truth together, and there is deliberately no flag here that
   * could express anything else.
   */
  async remove(scope: ScopeSelection, id: number): Promise<ViewerDeleteResponse> {
    const res = await fetch(`/api/viewer/observations/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify(scopeBody(scope)),
    });
    return this.parse<ViewerDeleteResponse>(res);
  }

  retrievalHealth(): Promise<ViewerRetrievalHealth> {
    return this.get<ViewerRetrievalHealth>('/api/viewer/retrieval-health');
  }

  logs(cursor?: string | null, component?: string): Promise<ViewerLogsResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (component) params.set('component', component);
    const query = params.toString();
    return this.get<ViewerLogsResponse>(`/api/viewer/logs${query ? `?${query}` : ''}`);
  }

  /** Raw stream response; the caller owns the reader loop. */
  stream(scope: ScopeSelection, signal: AbortSignal): Promise<Response> {
    return fetch('/api/viewer/stream', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(scopeBody(scope)),
      signal,
    });
  }
}
