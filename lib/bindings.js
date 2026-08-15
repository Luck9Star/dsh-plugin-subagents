/**
 * childSessionId -> { product, bridge, remote }
 *
 * The binding connects one continuable child (keyed by its durable harness
 * session id) to its live remote product session. It lives in memory, so a
 * process restart loses it; recovery then uses the durable registry file.
 * (The `PRODUCT_SESSION:` log marker is DISPLAY-ONLY metadata — see
 * recoverRemoteSessionId: it is never an authorization source, because any
 * session that merely relayed a marker-bearing answer could otherwise claim
 * the remote session.)
 *
 * The map is created per `apply()` (createBindings) — never a module-level
 * singleton — so two plugin instances (tests, hot reload) cannot dispose each
 * other's remote sessions.
 *
 * Note: the MARKER name (`PRODUCT_SESSION:`) is kept for historical session
 * compatibility; the new tool face is called `subagent_submit`.
 */
export const MARKER = 'PRODUCT_SESSION:'

export function createBindings() {
  return new Map()
}

/**
 * Scan the tail of a session's durable events for the most recent
 * `PRODUCT_SESSION:<product>:<id>` marker. Returns { product, sessionId } or
 * undefined. The walk is bounded: only string leaves are matched, scanning
 * from the newest event backwards, stopping at the first hit. Used for
 * progress display (product/remoteSessionId), NOT for authorization.
 */
export function recoverRemoteSessionId(session) {
  const events = session && session.events
  if (!Array.isArray(events)) return undefined
  const start = Math.max(0, events.length - 80)
  for (let i = events.length - 1; i >= start; i -= 1) {
    const event = events[i]
    const payload = event && (event.payload !== undefined ? event.payload : event.body)
    if (payload === undefined) continue
    const found = scanForMarker(payload)
    if (found) return found
  }
  return undefined
}

function scanForMarker(value) {
  if (typeof value === 'string') {
    const index = value.indexOf(MARKER)
    if (index >= 0) {
      const rest = value.slice(index + MARKER.length)
      // provider names come from config and may contain letters, digits,
      // `_` and `-` (e.g. `claude-code`, `my_agent`)
      const match = rest.match(/^([A-Za-z0-9_-]+):([A-Za-z0-9._:-]{6,})/)
      if (match) return { product: match[1], sessionId: match[2] }
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string' || (child && typeof child === 'object')) {
      const found = scanForMarker(child)
      if (found) return found
    }
  }
  return undefined
}
