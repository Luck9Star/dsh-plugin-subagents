// dsh-plugin-subagents — lib/drivers/bridge.js 测试（T09）。
//
// 覆盖（TASKS T09 验收 + T09 简报明细）：
//   - sync 路径：create→submit→dispose 顺序断言 + settings 透传 + 失败也 dispose；
//   - continuable 路径：startContinuable 收到 persona（含 subagent_submit）/toolFilter
//     白名单（allowDelegation true 含 'subagent'，false 不含）；persistRemote 写入
//     registry（含 settings.permissionMode）；并发槽占用与 endedAt 防重复；
//   - job 路由 throw（BRIDGE_CAPS.backgroundJob=false）；
//   - idle 释放：scheduleDispose 触发 → bridge.dispose 且 registry 条目保留；
//     cancelDispose 取消；idleTimeoutMs<=0 禁用；
//   - pending-start guard：armStartGuard 超时清理（小超时注入）；subagent/start
//     事件取消 guard；
//   - createBridgeProviders：start() 一次性路径完整；prepareContinuable 建
//     binding + registry + seed []；
//   - attachBridgeLifecycle：fakeCtx 事件触发槽位配对；disposeAll 清理；
//   - driver 契约面：id/kind/capabilities/available、followup、progress、dispose。
//
// 权限天花板（assertWithinCeiling）在工具层（T11），本文件不测。
// 全部 fake：fakeBridge 记录调用序、fakeCtx 记录 startContinuable 入参、
// tmp registry —— 无真实 CLI、无密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRegistry } from '../lib/registry.js'
import {
  createBridgeState,
  createBridgeProviders,
  attachBridgeLifecycle,
  createBridgeDriver,
  PENDING_START_GUARD_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
} from '../lib/drivers/bridge.js'
import { BRIDGE_CAPS } from '../lib/drivers/types.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const parent = { session: { id: 'parent-1', header: { cwd: '/w' } } }
const PROVIDER_DEFS = { fake: { name: 'fake', type: 'acp', command: 'fake' } }

/** Bridge double recording the call sequence (op + args) in order. */
function fakeBridge({ failSubmit = false } = {}) {
  const calls = []
  return {
    calls,
    async create(cwd, signal) { calls.push({ op: 'create', cwd }); return { kind: 'fake', sessionId: `s-${calls.length}` } },
    async submit(remote, task, signal, cwd, settings) {
      calls.push({ op: 'submit', task, settings })
      if (failSubmit) throw new Error('submit boom')
      return { text: `echo:${task}`, stopReason: 'completed' }
    },
    async reconnect(sessionId, cwd, signal) { calls.push({ op: 'reconnect', sessionId, cwd }); return { kind: 'fake', sessionId } },
    async dispose(remote) { calls.push({ op: 'dispose' }) },
  }
}

/** Minimal Cordis-like ctx: event listeners, effects, subagents seam. */
function fakeCtx({ startContinuable } = {}) {
  const listeners = new Map()
  const effects = []
  return {
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    // Cordis semantics: ctx.effect(fn) invokes fn immediately and keeps the
    // RETURNED disposer for teardown.
    effect: (fn) => { effects.push(fn()) },
    get: () => undefined,
    dispatch: (name, info) => { for (const fn of listeners.get(name) || []) fn(info) },
    async teardown() { for (const disposer of effects) await disposer() },
    subagents: {
      startContinuable: startContinuable || (async () => { throw new Error('unexpected startContinuable') }),
      listChildren: async () => [],
    },
  }
}

/** tmp registry file, removed in t.after. */
function tmpRegistry(t) {
  const path = join(tmpdir(), `bridge-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { rmSync(path, { force: true }); rmSync(`${path}.tmp`, { force: true }) })
  return createRegistry(path)
}

/**
 * Full assembly: state + provider objects + harness-like fakeCtx whose
 * startContinuable actually invokes the provider's prepareContinuable (as the
 * real continuation manager would) under the given childId.
 */
function makeDriver(t, { bridge = fakeBridge(), childId = 'c-1', stateOpts = {} } = {}) {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry, ...stateOpts })
  const providerObjs = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  const recorded = []
  const ctx = fakeCtx({
    startContinuable: async (args) => {
      recorded.push(args)
      const provider = providerObjs.find((p) => p.name === args.provider)
      if (!provider) throw new Error(`unknown provider ${args.provider}`)
      await provider.prepareContinuable({ sessionId: childId, parent: args.request.parent })
      return { childId, messageId: 'm-1' }
    },
  })
  const driver = createBridgeDriver({
    name: 'fake', bridge, providers: PROVIDER_DEFS, state, ctx,
    parentCwdFn: (p) => (p && p.session && p.session.header ? p.session.header.cwd : '/w'),
  })
  return { bridge, registry, state, providerObjs, ctx, recorded, driver }
}

// ── createBridgeState：治理内核 ───────────────────────────────────────────────

test('createBridgeState requires a registry (fail loud)', () => {
  assert.throws(() => createBridgeState({}), /registry is required/)
})

test('createBridgeState exposes defaults 600000 idle / 60000 guard', (t) => {
  const state = createBridgeState({ registry: tmpRegistry(t) })
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 600000)
  assert.equal(PENDING_START_GUARD_MS, 60000)
  assert.ok(state.bindings instanceof Map)
  assert.ok(state.liveChildren instanceof Set)
  assert.ok(state.endedAt instanceof Map)
  assert.ok(state.pendingStarts instanceof Map)
  assert.ok(state.disposeTimers instanceof Map)
})

test('taskText joins prompt text blocks with newline; tolerates missing prompts', () => {
  const state = createBridgeState({ registry: { set() {} } })
  const joined = state.taskText({ prompt: [{ type: 'text', text: 'a' }, { type: 'image', url: 'x' }, { type: 'text', text: 'b' }] })
  assert.equal(joined, 'a\nb')
  assert.equal(state.taskText(undefined), '')
  assert.equal(state.taskText({}), '')
  assert.equal(state.taskText({ prompt: 'plain' }), '')
})

test('nextSeq returns an increasing counter', () => {
  const state = createBridgeState({ registry: { set() {} } })
  assert.equal(state.nextSeq(), 1)
  assert.equal(state.nextSeq(), 2)
  assert.equal(state.nextSeq(), 3)
})

test('persistRemote maps remoteId from sessionId || threadId || pendingSessionId and persists settings', (t) => {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  state.persistRemote('c-1', { product: 'fake', remote: { sessionId: 's1', threadId: 't1' } }, '/w')
  assert.equal(registry.get('c-1').remoteId, 's1', 'sessionId wins')
  state.persistRemote('c-2', { product: 'fake', remote: { threadId: 't2' } }, '/w')
  assert.equal(registry.get('c-2').remoteId, 't2')
  state.persistRemote('c-3', { product: 'fake', remote: { pendingSessionId: 'p3' } }, '/w')
  assert.equal(registry.get('c-3').remoteId, 'p3', 'claude preallocated pendingSessionId counts')
  state.persistRemote('c-4', { product: 'fake', remote: {}, settings: { permissionMode: 'readonly' } }, '/w')
  const entry = registry.get('c-4')
  assert.equal(entry.remoteId, undefined, 'no remoteId key when unknown — still authorizes fresh-session recovery')
  assert.equal(entry.settings.permissionMode, 'readonly')
  state.persistRemote('c-5', undefined, '/w')
  assert.equal(registry.get('c-5'), undefined, 'no record → no write')
})

test('persistRemote writes the backend field (T03 rename), not product', (t) => {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  state.persistRemote('c-1', { product: 'codex', remote: { threadId: 't' } }, '/w')
  assert.equal(registry.get('c-1').backend, 'codex')
  assert.equal(registry.get('c-1').product, undefined)
})

test('markEnded prunes stale entries lazily beyond 128', () => {
  const state = createBridgeState({ registry: { set() {} } })
  const stale = Date.now() - 120000
  for (let i = 0; i < 130; i += 1) state.endedAt.set(`old-${i}`, stale)
  state.markEnded('fresh')
  assert.ok(state.endedAt.has('fresh'))
  assert.ok(!state.endedAt.has('old-0'), 'entries older than the 60s cutoff are pruned')
  assert.equal(state.endedAt.size, 1)
})

// ── createBridgeState：idle 释放（红线 6：registry 条目保留） ────────────────

test('scheduleDispose fires after the idle timeout: bridge disposed, binding dropped, registry entry KEPT', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, idleTimeoutMs: 20 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await provider.prepareContinuable({ sessionId: 'c-9', parent })
  assert.ok(registry.get('c-9'), 'registry entry written at prepare time')

  state.scheduleDispose('c-9')
  assert.ok(state.disposeTimers.has('c-9'), 'timer armed')
  await sleep(80)

  assert.ok(bridge.calls.some((c) => c.op === 'dispose'), 'remote disposed after idle')
  assert.ok(!state.bindings.has('c-9'), 'binding dropped')
  assert.ok(registry.get('c-9'), 'registry entry KEPT — the registry is the only recovery source')
  assert.ok(!state.disposeTimers.has('c-9'), 'timer removed after firing')
})

test('cancelDispose cancels a pending idle release', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, idleTimeoutMs: 20 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await provider.prepareContinuable({ sessionId: 'c-1', parent })

  state.scheduleDispose('c-1')
  state.cancelDispose('c-1')
  assert.ok(!state.disposeTimers.has('c-1'), 'timer cancelled synchronously')
  await sleep(80)
  assert.ok(state.bindings.has('c-1'), 'binding survives')
  assert.ok(!bridge.calls.some((c) => c.op === 'dispose'), 'no dispose happened')
})

test('idleTimeoutMs <= 0 disables auto-disposal', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, idleTimeoutMs: 0 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await provider.prepareContinuable({ sessionId: 'c-1', parent })

  state.scheduleDispose('c-1')
  await sleep(60)
  assert.ok(state.bindings.has('c-1'), 'binding survives — idle disposal disabled')
  assert.ok(!bridge.calls.some((c) => c.op === 'dispose'))
})

// ── createBridgeState：pending-start guard（孤儿清理） ────────────────────────

test('armStartGuard times out and disposes the orphaned remote (registry entry kept)', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, pendingStartGuardMs: 20 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await provider.prepareContinuable({ sessionId: 'orphan-1', parent })
  assert.ok(state.pendingStarts.has('orphan-1'), 'guard armed at prepare')

  await sleep(80)
  assert.ok(!state.pendingStarts.has('orphan-1'), 'guard timer consumed')
  assert.ok(!state.bindings.has('orphan-1'), 'orphaned binding dropped')
  assert.ok(bridge.calls.some((c) => c.op === 'dispose'), 'orphaned remote disposed')
  assert.ok(registry.get('orphan-1'), 'registry entry kept')
})

test('armStartGuard skips disposal when the child already holds a concurrency slot', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, pendingStartGuardMs: 20 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await provider.prepareContinuable({ sessionId: 'c-live', parent })
  // simulate a started child (subagent/start also cancels the guard, but the
  // liveChildren check is the belt-and-suspenders branch)
  state.liveChildren.add('c-live')

  await sleep(80)
  assert.ok(state.bindings.has('c-live'), 'started child is not an orphan')
  assert.ok(!bridge.calls.some((c) => c.op === 'dispose'))
})

// ── createBridgeProviders ────────────────────────────────────────────────────

test('provider.start(): one-shot create→submit (no dispose until run.dispose), multi-block task joined', async () => {
  const bridge = fakeBridge()
  const state = createBridgeState({ registry: { set() {} } })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })

  const run = await provider.start({
    prompt: [{ type: 'text', text: 'part one' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: 'part two' }],
    parent,
    signal: undefined,
  })
  assert.match(run.id, /^fake-/, 'run id carries the provider name')
  assert.equal(run.localAgent, undefined)
  assert.deepEqual(
    bridge.calls.map((c) => c.op),
    ['create', 'submit'],
    'dispose is deferred to run.dispose() on the happy path',
  )
  assert.equal(bridge.calls[0].cwd, '/w')
  assert.equal(bridge.calls[1].task, 'part one\npart two')

  const result = await run.result
  assert.deepEqual(result.output, [{ type: 'text', text: 'echo:part one\npart two' }])
  assert.equal(result.stopReason, 'completed')

  await run.dispose()
  assert.deepEqual(
    bridge.calls.map((c) => c.op),
    ['create', 'submit', 'dispose'],
  )
})

test('provider.start(): failure disposes the remote then rethrows', async () => {
  const bridge = fakeBridge({ failSubmit: true })
  const state = createBridgeState({ registry: { set() {} } })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await assert.rejects(
    provider.start({ prompt: [{ type: 'text', text: 'boom' }], parent }),
    /submit boom/,
  )
  assert.deepEqual(
    bridge.calls.map((c) => c.op),
    ['create', 'submit', 'dispose'],
  )
})

test('provider.prepareContinuable(): binding + registry + armed guard + seed []', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })

  const seed = await provider.prepareContinuable({ sessionId: 'c-7', parent })
  assert.deepEqual(seed, { seed: [] }, 'provider only supplies { seed: [] } — the manager owns the child')

  const record = state.bindings.get('c-7')
  assert.equal(record.product, 'fake')
  assert.equal(record.bridge, bridge)
  assert.equal(record.remote.kind, 'fake')
  assert.equal(record.settings, undefined, 'settings unknown until the delegating call records them')

  const entry = registry.get('c-7')
  assert.equal(entry.backend, 'fake')
  assert.equal(entry.remoteId, 's-1')
  assert.equal(entry.cwd, '/w')
  assert.equal(entry.settings, undefined, 'no settings key before the first delegation')
  assert.ok(state.pendingStarts.has('c-7'), 'guard armed')
})

test('createBridgeProviders returns objects shaped for registerProvider (no registration inside)', async () => {
  const state = createBridgeState({ registry: { set() {} } })
  const providers = createBridgeProviders({
    bridges: { codex: fakeBridge(), grok: fakeBridge() },
    providers: PROVIDER_DEFS,
    state,
  })
  assert.deepEqual(providers.map((p) => p.name), ['codex', 'grok'])
  for (const p of providers) {
    assert.equal(p.inheritsParentContext, false)
    assert.deepEqual(p.capabilities, { persona: true, toolFilter: true })
    assert.equal(typeof p.start, 'function')
    assert.equal(typeof p.prepareContinuable, 'function')
  }
  // one provider per bridge entry, generated not registered — the caller
  // (apply layer) owns ctx.subagents.registerProvider
  assert.equal(providers.length, 2)
})

// ── createBridgeDriver：契约面 ───────────────────────────────────────────────

test('driver exposes id/kind/capabilities per types.js contract and injectable availability', async (t) => {
  const { driver } = makeDriver(t)
  assert.equal(driver.id, 'fake')
  assert.equal(driver.kind, 'bridge')
  assert.equal(driver.inheritsParentContext, false)
  assert.equal(driver.capabilities, BRIDGE_CAPS)
  assert.equal(driver.capabilities.backgroundJob, false)
  assert.deepEqual(driver.available(), { registered: true, reason: 'bridge provider "fake" is registered' })

  const offline = createBridgeDriver({
    name: 'grok', bridge: fakeBridge(), providers: {}, state: createBridgeState({ registry: tmpRegistry(t) }),
    availability: () => ({ registered: false, reason: 'CLI not found on PATH' }),
  })
  assert.deepEqual(offline.available(), { registered: false, reason: 'CLI not found on PATH' })
})

// ── driver.start：sync 路由 ──────────────────────────────────────────────────

test('sync route: create → submit → dispose in order, settings passed through, foreground outcome', async (t) => {
  const { bridge, driver } = makeDriver(t)
  const settings = { permissionMode: 'readonly', model: 'm1', reasoningEffort: 'high' }
  const outcome = await driver.start({
    route: 'sync',
    label: 'sync job',
    task: 'task text',
    parent,
    signal: undefined,
    bridge: { provider: 'fake', settings },
  })
  assert.deepEqual(
    bridge.calls.map((c) => c.op),
    ['create', 'submit', 'dispose'],
  )
  assert.equal(bridge.calls[0].cwd, '/w', 'cwd from injectable parentCwdFn')
  assert.deepEqual(bridge.calls[1].settings, settings, 'settings forwarded to bridge.submit verbatim')
  assert.equal(bridge.calls[1].task, 'task text')
  assert.equal(outcome.kind, 'foreground')
  assert.match(outcome.runId, /^fake-/)
  assert.deepEqual(outcome.output, [{ type: 'text', text: 'echo:task text' }])
  assert.equal(outcome.stopReason, 'completed')
})

test('sync route: submit failure still disposes the remote and rethrows', async (t) => {
  const bridge = fakeBridge({ failSubmit: true })
  const { driver } = makeDriver(t, { bridge })
  await assert.rejects(
    driver.start({
      route: 'sync', task: 'x', parent,
      bridge: { provider: 'fake', settings: { permissionMode: 'full' } },
    }),
    /submit boom/,
  )
  assert.deepEqual(
    bridge.calls.map((c) => c.op),
    ['create', 'submit', 'dispose'],
  )
})

// ── driver.start：continuable 路由（红线 1：relay 只读白名单） ───────────────

test('continuable route: startContinuable receives relay persona (subagent_submit) and subagent+delegation allowlist', async (t) => {
  const { registry, state, recorded, driver } = makeDriver(t)
  const outcome = await driver.start({
    route: 'continuable',
    label: 'codex full: do the thing',
    task: 'do it',
    parent,
    signal: undefined,
    allowDelegation: true,
    bridge: { provider: 'fake', settings: { permissionMode: 'default', model: 'm2' } },
  })

  assert.equal(recorded.length, 1)
  const call = recorded[0]
  assert.equal(call.provider, 'fake')
  assert.equal(call.label, 'codex full: do the thing')
  assert.equal(call.signal, undefined)
  assert.deepEqual(call.request.prompt, [{ type: 'text', text: 'do it' }])
  assert.equal(call.request.parent, parent)
  assert.match(call.request.persona, /subagent_submit/, 'relay persona names the pipe tool')
  assert.ok(!call.request.persona.includes('product_submit'), 'no legacy product_submit wording')
  assert.match(call.request.persona, /You MAY delegate/, 'delegation sentence appended when allowed')
  // red line 1: the relay is a read-only pipe — allowlist exactly the two names
  assert.deepEqual(call.request.toolFilter.allow, ['subagent_submit', 'subagent'])

  assert.equal(outcome.kind, 'continuable')
  assert.equal(outcome.childId, 'c-1')
  assert.equal(outcome.backend, 'fake')
  assert.equal(outcome.permissionMode, 'default')

  // binding + registry now carry the delegation settings (ceiling restore)
  assert.equal(state.bindings.get('c-1').settings.permissionMode, 'default')
  const entry = registry.get('c-1')
  assert.equal(entry.backend, 'fake')
  assert.equal(entry.remoteId, 's-1')
  assert.equal(entry.cwd, '/w')
  assert.equal(entry.settings.permissionMode, 'default')
  assert.equal(entry.settings.model, 'm2')
  // concurrency slot reserved (endedAt miss)
  assert.ok(state.liveChildren.has('c-1'))
})

test('continuable route: allowDelegation false → allowlist is exactly [subagent_submit]', async (t) => {
  const { recorded, driver } = makeDriver(t)
  await driver.start({
    route: 'continuable', label: 'readonly probe', task: 'look', parent,
    allowDelegation: false,
    bridge: { provider: 'fake', settings: { permissionMode: 'readonly' } },
  })
  const allow = recorded[0].request.toolFilter.allow
  assert.deepEqual(allow, ['subagent_submit'])
  assert.ok(!allow.includes('subagent'), 'no delegation tool when the role bans it')
  assert.ok(!recorded[0].request.persona.includes('You MAY delegate'))
})

test('continuable route: endedAt hit does not re-reserve the concurrency slot', async (t) => {
  const { state, driver } = makeDriver(t, { childId: 'c-fast' })
  // the child's first epoch settled before the delegating call returned
  state.endedAt.set('c-fast', Date.now())
  const outcome = await driver.start({
    route: 'continuable', label: 'fast', task: 't', parent,
    bridge: { provider: 'fake', settings: { permissionMode: 'full' } },
  })
  assert.equal(outcome.childId, 'c-fast')
  assert.ok(!state.liveChildren.has('c-fast'), 'no duplicate slot reservation')
})

test('continuable route: missing ctx fails loud', async (t) => {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  const driver = createBridgeDriver({ name: 'fake', bridge: fakeBridge(), providers: PROVIDER_DEFS, state })
  await assert.rejects(
    driver.start({ route: 'continuable', label: 'x', task: 't', parent }),
    /startContinuable/,
  )
})

// ── driver.start：job 路由 ───────────────────────────────────────────────────

test('job route throws: bridge backends are continuable-only', async (t) => {
  const { bridge, driver } = makeDriver(t)
  await assert.rejects(
    driver.start({ route: 'job', label: 'x', task: 't', parent, bridge: { provider: 'fake' } }),
    /bridge backends run continuable — route "job" is native-only/,
  )
  assert.deepEqual(bridge.calls, [], 'no bridge calls on a rejected route')
})

// ── driver：followup / progress / dispose ────────────────────────────────────

test('followup: no live binding throws; live binding resolves (submit tool layer owns the rest)', async (t) => {
  const { state, driver } = makeDriver(t)
  await assert.rejects(driver.followup('ghost'), /no live binding/)
  state.bindings.set('c-1', { product: 'fake', bridge: fakeBridge(), remote: { sessionId: 's' } })
  await driver.followup('c-1', 'more work', { signal: undefined })
})

test('progress: unknown for unbound child; snapshot for bound child (pinnedProduct/remoteSessionId)', async (t) => {
  const { state, driver } = makeDriver(t)
  assert.deepEqual(await driver.progress('ghost'), { childId: 'ghost', status: 'unknown' })

  state.bindings.set('c-1', {
    product: 'fake', bridge: fakeBridge(), remote: { sessionId: 's-42' },
    settings: { model: 'm9', reasoningEffort: 'high', permissionMode: 'default' },
  })
  let snap = await driver.progress('c-1')
  assert.equal(snap.status, 'inactive', 'binding without an in-flight turn is inactive')
  assert.equal(snap.pinnedProduct, 'fake')
  assert.equal(snap.remoteSessionId, 's-42')
  assert.equal(snap.model, 'm9')
  assert.equal(snap.reasoningEffort, 'high')

  state.liveChildren.add('c-1')
  snap = await driver.progress('c-1')
  assert.equal(snap.status, 'running', 'a child holding a concurrency slot is running')
})

test('driver.dispose: explicit release cancels idle timer, drops binding, disposes remote once', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, idleTimeoutMs: 2000 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  await provider.prepareContinuable({ sessionId: 'c-1', parent })
  state.scheduleDispose('c-1')

  const driver = createBridgeDriver({ name: 'fake', bridge, providers: PROVIDER_DEFS, state })
  await driver.dispose('c-1')

  assert.ok(!state.bindings.has('c-1'))
  assert.ok(!state.disposeTimers.has('c-1'), 'idle timer cancelled by the explicit release')
  assert.equal(bridge.calls.filter((c) => c.op === 'dispose').length, 1)
  await sleep(60)
  assert.equal(bridge.calls.filter((c) => c.op === 'dispose').length, 1, 'cancelled timer never fires a second dispose')
  await driver.dispose('c-1') // idempotent on a missing binding
})

// ── attachBridgeLifecycle：槽位配对与 teardown ───────────────────────────────

test('attachBridgeLifecycle: start/end events pair the slot; end schedules idle release', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, idleTimeoutMs: 20, pendingStartGuardMs: 60000 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  const ctx = fakeCtx()
  attachBridgeLifecycle(ctx, state)

  await provider.prepareContinuable({ sessionId: 'c-1', parent })
  assert.ok(state.pendingStarts.has('c-1'))

  ctx.dispatch('subagent/start', { id: 'c-1' })
  assert.ok(state.liveChildren.has('c-1'), 'slot acquired on start')
  assert.ok(!state.pendingStarts.has('c-1'), 'start cancels the pending-start guard')

  ctx.dispatch('subagent/start', { id: 'someone-else' })
  assert.ok(!state.liveChildren.has('someone-else'), 'ids without a binding never take a slot')

  ctx.dispatch('subagent/end', { id: 'c-1' })
  assert.ok(!state.liveChildren.has('c-1'), 'slot released on end')
  assert.ok(state.endedAt.has('c-1'), 'end timestamp recorded (no re-reserve)')
  await sleep(80)
  assert.ok(bridge.calls.some((c) => c.op === 'dispose'), 'end scheduled the idle release')
  assert.ok(!state.bindings.has('c-1'))
  assert.ok(registry.get('c-1'), 'registry entry survives the idle release')

  ctx.dispatch('subagent/end', { id: 'unknown' }) // markEnded only, no dispose scheduled
  assert.ok(state.endedAt.has('unknown'))
  ctx.dispatch('subagent/end', undefined) // tolerated
})

test('attachBridgeLifecycle: subagent/start event cancels the pending-start guard', async (t) => {
  const registry = tmpRegistry(t)
  const bridge = fakeBridge()
  const state = createBridgeState({ registry, pendingStartGuardMs: 20 })
  const [provider] = createBridgeProviders({ bridges: { fake: bridge }, providers: PROVIDER_DEFS, state })
  const ctx = fakeCtx()
  attachBridgeLifecycle(ctx, state)

  await provider.prepareContinuable({ sessionId: 'c-1', parent })
  ctx.dispatch('subagent/start', { id: 'c-1' })
  await sleep(80)
  assert.ok(state.bindings.has('c-1'), 'started child survives the guard timeout')
  assert.ok(!bridge.calls.some((c) => c.op === 'dispose'))
})

test('ctx.effect teardown (disposeAll) clears timers and disposes every binding', async (t) => {
  const registry = tmpRegistry(t)
  const bridgeA = fakeBridge()
  const bridgeB = fakeBridge()
  const state = createBridgeState({ registry, idleTimeoutMs: 2000, pendingStartGuardMs: 2000 })
  const providers = createBridgeProviders({
    bridges: { fake: bridgeA, other: bridgeB },
    providers: PROVIDER_DEFS,
    state,
  })
  const ctx = fakeCtx()
  attachBridgeLifecycle(ctx, state)
  await providers[0].prepareContinuable({ sessionId: 'c-1', parent })
  await providers[1].prepareContinuable({ sessionId: 'c-2', parent })
  state.scheduleDispose('c-1')
  state.liveChildren.add('c-1')

  await ctx.teardown()

  assert.equal(bridgeA.calls.filter((c) => c.op === 'dispose').length, 1)
  assert.equal(bridgeB.calls.filter((c) => c.op === 'dispose').length, 1)
  assert.equal(state.bindings.size, 0)
  assert.equal(state.disposeTimers.size, 0)
  assert.equal(state.pendingStarts.size, 0)
  assert.equal(state.liveChildren.size, 0)
  assert.ok(registry.get('c-1') && registry.get('c-2'), 'registry survives teardown')

  await sleep(60)
  assert.equal(bridgeA.calls.filter((c) => c.op === 'dispose').length, 1, 'cleared timers never fire')
})
