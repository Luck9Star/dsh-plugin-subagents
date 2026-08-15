// dsh-plugin-subagents — tool-output lossless-JSON sanitizer (E3).
//
// WHY THIS EXISTS
//   dsh-tools validates every tool's returned value by snapshotting it with
//   @deepseek-ai/dsh-session's `snapshotJsonValue` — the boundary that threw
//   `tool "subagent_progress" returned invalid output: value is not lossless
//   JSON` on every call during the 2026-08-15 real-machine smoke run. That
//   snapshotter REJECTS (returns undefined → ToolOutputError) any value with:
//     • an own enumerable property whose value is `undefined` — the killer:
//       the observability tools built returns like
//       `mode: listStatus ? listStatus.mode : undefined`, which is undefined
//       on every common path, so the whole object was rejected;
//     • non-plain objects (class instances, Dates, Maps, Sets, Errors…),
//       Symbol keys, functions/bigints/Symbols as values;
//     • sparse arrays / arrays with extra own properties, non-finite numbers,
//       -0, and cyclic references.
//
//   `toLosslessJson` deep-sanitizes a value into what that boundary accepts:
//     undefined-valued keys are dropped (array holes become null),
//     Date → ISO string, Map → entries array, Set → value array,
//     Error → { name, message }, bigint → decimal string,
//     NaN/±Infinity → null, -0 → 0, functions/Symbol values dropped
//     (null inside arrays), cyclic references → '[Circular]', class
//     instances and cross-realm objects → fresh plain-object copies of their
//     own enumerable string-keyed properties, sparse arrays → dense arrays.
//   Already-lossless values come back structurally identical (fresh plain
//   containers, same leaves), so applying it at a tool exit never changes
//   what a model or renderer sees for clean data.
//
//   Applied at the observability tool exits (subagent_progress /
//   subagent_wait / subagent_roles / subagent_agents) — the surfaces that
//   fold RAW session events, binding records, and listChildren rows, i.e.
//   exactly where non-JSON shapes realistically enter. The delegation tools
//   build their returns with conditional spreads (no unconditional keys), so
//   they are lossless by construction — pinned by test/json-safe.test.js
//   rather than wrapped here (migrated code stays line-for-line equivalent
//   where nothing is broken). The test asserts stringify→parse round-trips
//   (lossless) on the `subagent` three outcome states (foreground with stop
//   reason / foreground without / continuable) and the `subagent_fork`
//   foreground outcome; `subagent_submit` / the `product_delegate` alias are
//   pure conditional-spread constructions and are NOT individually pinned.
//
//   Loud-error contract unchanged: driver-side seam exceptions stay caught in
//   the tools (observability must not explode on a seam error); this module
//   does not throw on ordinary objects/arrays/common built-ins — two known
//   leaks are deliberately out of scope: an array-indexed throwing getter
//   (the `value[i]` read in the dense-array copy is not guarded) and a
//   Proxy whose `ownKeys` behaves non-standardly (the `Object.keys` walk would
//   then observe whatever the trap reports). Production return payloads never
//   carry those shapes, so neither is defended.
//
//   Known limitation: a cross-realm built-in (e.g. a Date/Map from another vm
//   context) is not recognised by `instanceof` and is copied as a plain object,
//   losing its type marker — it comes out as a `{}`-shaped plain copy.

/** Marker string replacing a cyclic reference (JSON cannot represent it). */
const CIRCULAR = '[Circular]'

/**
 * Deep-sanitize one value into lossless JSON data (see the module header for
 * the exact conversion table). Does not throw on ordinary objects/arrays/
 * common built-ins; out of scope (defense-wise): an array-indexed throwing
 * getter and a Proxy with custom ownKeys behavior — production payloads never
 * carry those shapes, so they are not guarded.
 *
 * @param {unknown} value   the candidate tool-output value
 * @param {WeakMap<object, string>} [seen]  internal: cycle detection chain
 * @returns {unknown} a value `snapshotJsonValue` accepts (fresh containers;
 *          scalars returned as-is except the documented conversions)
 */
export function toLosslessJson(value, seen = new WeakMap()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) return null // NaN / ±Infinity → JSON null
    return Object.is(value, -0) ? 0 : value // snapshotJsonValue rejects -0
  }
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    // Callers drop object keys holding these; array slots become null so
    // positions survive (JSON.stringify's own array behavior).
    return null
  }
  if (type === 'bigint') return String(value) // JSON.stringify would throw
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : value.toISOString()
  }
  if (value instanceof Error) {
    // name/message only (per the E3 spec): stacks carry paths and noise.
    return { name: value.name, message: value.message }
  }
  if (value instanceof Map) {
    return toLosslessJson([...value.entries()], seen)
  }
  if (value instanceof Set) {
    return toLosslessJson([...value], seen)
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR
    seen.set(value, CIRCULAR)
    // index-based copy densifies holes (holes → null) and drops extra own
    // properties (length-only arrays are the snapshotter's requirement)
    const out = []
    for (let i = 0; i < value.length; i += 1) out.push(toLosslessJson(value[i], seen))
    seen.delete(value)
    return out
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return CIRCULAR
    seen.set(value, CIRCULAR)
    const out = {}
    for (const key of Object.keys(value)) {
      // Object.keys: own enumerable STRING keys only — Symbol keys are
      // dropped, matching what lossless JSON can carry. A throwing getter
      // must not kill the whole tool result: the key is skipped.
      let item
      try {
        item = value[key]
      } catch {
        continue
      }
      // undefined / function / Symbol values are DROPPED as object keys
      // (their information is not representable; a null placeholder would
      // lie about the field being present-but-empty).
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = toLosslessJson(item, seen)
    }
    seen.delete(value)
    return out
  }
  // Any other exotic typeof cannot occur in practice; fail soft to null.
  return null
}
