/**
 * Ensure a hook payload has the session ID the Worker requires. `KIRO_SESSION_ID`
 * is a fallback for legacy/headless paths that omit it; a payload ID is
 * authoritative and is never overwritten by the environment.
 */
export function injectSessionId(
  raw: string,
  sessionId: string | undefined = process.env.KIRO_SESSION_ID,
): string {
  if (!sessionId) return raw;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if (!Object.hasOwn(obj, 'session_id')) obj.session_id = sessionId;
      return JSON.stringify(obj);
    }
  } catch {
    // Not JSON — forward unchanged.
  }
  return raw;
}
