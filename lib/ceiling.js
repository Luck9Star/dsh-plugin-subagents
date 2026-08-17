/** Permission ordering for the delegation ceiling. */
export const PERM_RANK = { readonly: 0, default: 1, full: 2 }

/**
 * Delegation permission ceiling — exported for tests.
 *
 * Permissions inherit DOWN the delegation tree: a product child may never
 * grant a descendant MORE permission than it has itself (otherwise a
 * read-only child could escape its restriction by spawning a full-permission
 * grandchild). `readonly < default < full`.
 *
 * Fail-closed rules:
 *  - the caller is only "not a product child" (no ceiling) when we have
 *    NEITHER a live binding NOR a durable registry entry for it — a product
 *    child whose binding was idle-disposed or lost to a restart must not
 *    regain root privileges;
 *  - a product child with UNKNOWN permissionMode (legacy registry entry
 *    predating settings persistence) is treated as `readonly`, the lowest
 *    rank, never as `default`.
 */
export function assertWithinCeiling({ callerSettings, callerIsProductChild, requestedMode }) {
  if (!callerIsProductChild) return
  const callerMode = callerSettings && callerSettings.permissionMode
  // Prototype-key hardening: `PERM_RANK[mode]` on an INHERITED key
  // ('toString', 'constructor', …) yields a function, not undefined — the
  // `??` fallbacks would never fire, and a numeric comparison against a
  // function is NaN (always false), silently LIFTING the ceiling. Guard the
  // lookup with an own-key check: an inherited key is just an unknown mode
  // (caller side fails closed to rank 0; requested side keeps the
  // unknown-as-default rank 1). Legal values and unknown strings behave
  // exactly as before.
  const own = (mode) => Object.prototype.hasOwnProperty.call(PERM_RANK, mode)
  const callerRank = callerMode === undefined ? 0 : (own(callerMode) ? PERM_RANK[callerMode] : 0)
  const requestedRank = own(requestedMode) ? PERM_RANK[requestedMode] : 1
  if (requestedRank > callerRank) {
    throw new Error(
      `subagent: permission escalation blocked — this subagent's permissionMode is "${callerMode || 'unknown (treated as readonly)'}" and cannot spawn a "${requestedMode}" descendant. The delegating parent must grant the needed permission in the first place.`,
    )
  }
}
