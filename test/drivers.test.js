// dsh-plugin-subagents — lib/drivers/types.js 契约层测试（T07）。
//
// 用例矩阵覆盖 DESIGN §3.5 能力矩阵全部行：
//   - NATIVE_CAPS / BRIDGE_CAPS 与 DESIGN §3.4 逐字段一致；
//   - native 全参数（model/provider/persona/toolFilter/cwd/maxDepth）通过；
//   - bridge 只收 model/permission_mode/reasoning_effort；
//   - native+permission_mode / inner reasoning_effort throw；
//   - bridge+provider/persona/toolFilter/cwd/maxDepth 各 throw 且消息含参数名；
//   - 空 params 恒通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NATIVE_CAPS,
  BRIDGE_CAPS,
  assertParamsSupported,
  backendKind,
} from '../lib/drivers/types.js'

// ---- §3.4 能力常量逐字段一致性 ----

test('NATIVE_CAPS matches DESIGN §3.4 native capability set', () => {
  assert.deepEqual(NATIVE_CAPS, {
    cwd: true,
    persona: true,
    toolFilter: true,
    llmRoute: true,
    maxDepth: true,
    continuable: true,
    backgroundJob: true,
    durableResume: true,
    permissionMode: false,
    reasoningEffort: false,
    promptInjectionGuard: false,
  })
})

test('BRIDGE_CAPS matches DESIGN §3.4 bridge capability set', () => {
  assert.deepEqual(BRIDGE_CAPS, {
    cwd: false,
    persona: false,
    toolFilter: false,
    llmRoute: false,
    maxDepth: false,
    continuable: true,
    backgroundJob: false,
    durableResume: true,
    permissionMode: true,
    reasoningEffort: true,
    promptInjectionGuard: true,
  })
})

test('capability constants are frozen', () => {
  assert.ok(Object.isFrozen(NATIVE_CAPS))
  assert.ok(Object.isFrozen(BRIDGE_CAPS))
})

// ---- §3.5：native 后端 — 支持的参数全部通过 ----

test('native accepts all §3.5 native params', () => {
  assert.doesNotThrow(() =>
    assertParamsSupported(NATIVE_CAPS, {
      model: 'glm-5.3',
      provider: 'spawn',
      persona: '@preset:standard',
      toolFilter: { allow: ['read'] },
      cwd: '/tmp/work',
      maxDepth: 2,
    }),
  )
})

test('native accepts continuity-related params (run_in_background is route-level, not validated)', () => {
  // run_in_background 属路由决策（§3.5 行），不在归一参数矩阵内 → 未知键忽略不报错。
  assert.doesNotThrow(() =>
    assertParamsSupported(NATIVE_CAPS, {
      model: 'x',
      provider: 'fork',
      run_in_background: true,
    }),
  )
})

// ---- §3.5：native 后端 — bridge 专属参数 loud error ----

test('native + permission_mode throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(NATIVE_CAPS, { permission_mode: 'default' }),
    /permission_mode/,
  )
})

test('native + reasoning_effort throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(NATIVE_CAPS, { reasoning_effort: 'high' }),
    /reasoning_effort/,
  )
})

test('native + permission_mode throws a real Error with backend hint', () => {
  try {
    assertParamsSupported(NATIVE_CAPS, { permission_mode: 'full' })
    assert.fail('should have thrown')
  } catch (err) {
    assert.ok(err instanceof Error)
    assert.match(err.message, /subagent: parameter "permission_mode"/)
    assert.match(err.message, /\(native\)/)
  }
})

// ---- §3.5：bridge 后端 — 支持参数通过 ----

test('bridge accepts model + permission_mode + reasoning_effort', () => {
  assert.doesNotThrow(() =>
    assertParamsSupported(BRIDGE_CAPS, {
      model: 'claude-3-5-sonnet',
      permission_mode: 'readonly',
      reasoning_effort: 'medium',
    }),
  )
})

// ---- §3.5：bridge 后端 — native 专属参数各 loud error，且消息含参数名 ----

test('bridge + provider throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(BRIDGE_CAPS, { provider: 'spawn' }),
    /provider/,
  )
})

test('bridge + persona throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(BRIDGE_CAPS, { persona: '@preset:x' }),
    /persona/,
  )
})

test('bridge + toolFilter throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(BRIDGE_CAPS, { toolFilter: { allow: ['read'] } }),
    /toolFilter/,
  )
})

test('bridge + cwd throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(BRIDGE_CAPS, { cwd: '/tmp' }),
    /cwd/,
  )
})

test('bridge + maxDepth throws, message contains param name', () => {
  assert.throws(
    () => assertParamsSupported(BRIDGE_CAPS, { maxDepth: 1 }),
    /maxDepth/,
  )
})

// ---- §3.5：bridge + personas 错误消息格式（含参数名与后端能力提示） ----

test('bridge + persona error mentions param name, backend id and kind', () => {
  try {
    assertParamsSupported(BRIDGE_CAPS, { persona: '@preset:standard' })
    assert.fail('should have thrown')
  } catch (err) {
    assert.match(err.message, /"persona"/)
    assert.match(err.message, /\(bridge\)/)
  }
})

test('bridge + persona error uses explicit backendId when supplied', () => {
  try {
    assertParamsSupported(BRIDGE_CAPS, { persona: '@preset:standard' }, 'codex')
    assert.fail('should have thrown')
  } catch (err) {
    assert.match(err.message, /backend "codex" \(bridge\)/)
  }
})

// ---- §3.5：空 params 恒通过 ----

test('empty params always pass for both backends', () => {
  assert.doesNotThrow(() => assertParamsSupported(NATIVE_CAPS, {}))
  assert.doesNotThrow(() => assertParamsSupported(BRIDGE_CAPS, {}))
  assert.doesNotThrow(() => assertParamsSupported(NATIVE_CAPS, undefined))
  assert.doesNotThrow(() => assertParamsSupported(BRIDGE_CAPS, null))
  assert.doesNotThrow(() => assertParamsSupported(NATIVE_CAPS, {}))
  assert.doesNotThrow(() => assertParamsSupported(BRIDGE_CAPS, {}))
})

// ---- model 两后端都收，不校验 ----

test('model is accepted by both backends (not validated)', () => {
  assert.doesNotThrow(() => assertParamsSupported(NATIVE_CAPS, { model: 'glm' }))
  assert.doesNotThrow(() => assertParamsSupported(BRIDGE_CAPS, { model: 'claude' }))
})

// ---- backendKind 派生（错误提示可读性）----

test('backendKind derives native / bridge / unknown', () => {
  assert.equal(backendKind(NATIVE_CAPS), 'native')
  assert.equal(backendKind(BRIDGE_CAPS), 'bridge')
  // 只有 continuable/durableResume 两态而无 bridge/native 专属字段 → 无法判定 → unknown
  assert.equal(backendKind({ continuable: true, durableResume: true }), 'unknown')
  assert.equal(backendKind(undefined), 'unknown')
  assert.equal(backendKind(null), 'unknown')
})
