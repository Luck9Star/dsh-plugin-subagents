import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertWithinCeiling, PERM_RANK } from '../lib/ceiling.js'

/**
 * The delegation permission ceiling — tested against the REAL implementation
 * (assertWithinCeiling), not a copy of its logic. A child may not spawn a
 * descendant with a HIGHER permission rank. readonly(0) < default(1) <
 * full(2). The root (not a product child) has no ceiling. A product child
 * whose permissionMode is unknown (legacy registry entry) fails CLOSED to
 * readonly.
 */
test('root (not a product child) has no ceiling', () => {
  assertWithinCeiling({ callerSettings: undefined, callerIsProductChild: false, requestedMode: 'full' })
})

test('default child cannot spawn full', () => {
  assert.throws(() => assertWithinCeiling({ callerSettings: { permissionMode: 'default' }, callerIsProductChild: true, requestedMode: 'full' }), /escalation blocked/)
  assert.throws(() => assertWithinCeiling({ callerSettings: undefined, callerIsProductChild: true, requestedMode: 'full' }), /escalation blocked/)
})

test('readonly child can only spawn readonly', () => {
  assert.throws(() => assertWithinCeiling({ callerSettings: { permissionMode: 'readonly' }, callerIsProductChild: true, requestedMode: 'full' }), /escalation blocked/)
  assert.throws(() => assertWithinCeiling({ callerSettings: { permissionMode: 'readonly' }, callerIsProductChild: true, requestedMode: 'default' }), /escalation blocked/)
  assertWithinCeiling({ callerSettings: { permissionMode: 'readonly' }, callerIsProductChild: true, requestedMode: 'readonly' })
})

test('legacy product child without stored settings fails closed to readonly', () => {
  // unknown mode must never be treated as `default` (rank 1)
  assert.throws(() => assertWithinCeiling({ callerSettings: undefined, callerIsProductChild: true, requestedMode: 'default' }), /treated as readonly/)
  assert.throws(() => assertWithinCeiling({ callerSettings: { permissionMode: 'banana' }, callerIsProductChild: true, requestedMode: 'default' }), /escalation blocked/)
  assertWithinCeiling({ callerSettings: undefined, callerIsProductChild: true, requestedMode: 'readonly' })
})

test('full child may spawn anything', () => {
  assertWithinCeiling({ callerSettings: { permissionMode: 'full' }, callerIsProductChild: true, requestedMode: 'full' })
  assertWithinCeiling({ callerSettings: { permissionMode: 'full' }, callerIsProductChild: true, requestedMode: 'readonly' })
  assertWithinCeiling({ callerSettings: { permissionMode: 'full' }, callerIsProductChild: true, requestedMode: 'default' })
})

test('PERM_RANK ordering', () => {
  assert.ok(PERM_RANK.readonly < PERM_RANK.default && PERM_RANK.default < PERM_RANK.full)
})

test('error message uses subagent: prefix', () => {
  assert.throws(
    () => assertWithinCeiling({ callerSettings: { permissionMode: 'default' }, callerIsProductChild: true, requestedMode: 'full' }),
    (err) => err.message.startsWith('subagent: permission escalation blocked'),
  )
})
