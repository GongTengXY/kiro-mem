/**
 * Ensure a hook payload has the session ID required by the Worker.
 *
 * Current Kiro hook payloads officially include `session_id` on every event.
 * Some legacy/headless paths have omitted it, so `KIRO_SESSION_ID` remains a
 * compatibility fallback. An ID supplied in the payload is always authoritative
 * and is never overwritten by the environment.
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
