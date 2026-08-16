// dsh-plugin-subagents — `subagent_submit` 工具测试（T12）。
//
// 自前身 legacy-bridges-plugin `test/tools.test.js` 的 product_submit 用例迁移
// （断言不削弱），工具名断言改 subagent_submit，并按 T12 验收补全：
//   - 恢复矩阵四态：
//     ① live binding → 直接用（无 reconnect/create，settings 驱动远端权限）；
//     ② binding 失 + registry 含 remoteId → bridge.reconnect + settings 还原；
//     ③ binding 失 + registry 无 remoteId（首次提交前）→ 全新会话 + settings 还原；
//     ④ 无 binding 无 registry → 拒绝（marker 绝非鉴权源；backend 不可用同拒）；
//   - 并发串行化：活 binding 与恢复路径双双经 per-child tail 队列
//     （start:A end:A start:B end:B；恢复路径恰一次 reconnect）；
//   - marker：`PRODUCT_SESSION:<backend>:<remoteId>` 追加进答案；远端尚无
//     session/thread id（仅 pendingSessionId）时不追加；
//   - idle 取消：submit 复用即 cancelDispose（快速续作不付重连成本）；
//   - 持久化：finally 的 persistRemote 把 remoteId（含 claude 预分配
//     pendingSessionId）与 settings 写回 durable registry；
//   - deps 装配校验（state 四件 / providerBridges 缺一即 loud）。
//
// 与 PS 的差异仅在接线：不再手工 mirror persistRemote —— 走真实
// createBridgeState 治理内核 + 真 registry（tmp 文件），恢复语义按真实产物
// 验证。全部 fake：fakeBridge 记录调用序 —— 无真实 CLI、无密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MARKER } from '../lib/bindings.js'
import { createRegistry } from '../lib/registry.js'
import { createBridgeState } from '../lib/drivers/bridge.js'
import { registerSubagentSubmit } from '../lib/tools/subagent-submit.js'

// ---- fixtures ----

/** Bridge double recording the call sequence (op + args) in order. */
function fakeBridge({ latencyMs = 0 } = {}) {
  const calls = []
  return {
    calls,
    async create(cwd, signal) { calls.push({ op: 'create', cwd }); return { kind: 'fake', sessionId: `s-${calls.length}` } },
    async submit(remote, task, signal, cwd, settings) {
      calls.push({ op: 'submit', task, settings })
      if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs))
      return { text: `echo:${task}`, stopReason: 'completed' }
    },
    async reconnect(sessionId, cwd, signal) { calls.push({ op: 'reconnect', sessionId, cwd }); return { kind: 'fake', sessionId } },
    async dispose(remote) { calls.push({ op: 'dispose' }) },
  }
}

/** tmp registry file, removed in t.after. */
function tmpRegistry(t) {
  const path = join(tmpdir(), `submit-reg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { rmSync(path, { force: true }); rmSync(`${path}.tmp`, { force: true }) })
  return createRegistry(path)
}

/**
 * 真实接线：createBridgeState 治理内核（真 persistRemote / cancelDispose /
 * registry）+ providerBridges 表 + 已注册工具的 ctx。idleTimeoutMs 默认 0
 * （禁自动释放，按用例显式 arm）。
 */
function makeDeps(t, { bridge = fakeBridge(), stateOpts = {} } = {}) {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry, ...stateOpts })
  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    tool: (name) => tools.get(name),
  }
  const assembled = { state, providerBridges: { fake: bridge } }
  registerSubagentSubmit(ctx, { assembled, config: {} })
  return { bridge, registry, state, assembled, ctx }
}

const execFor = (sessionId, cwd = '/tmp') => ({ agent: { session: { id: sessionId, header: { cwd } } }, signal: undefined })

// ---- 注册面 ----

test('registers as subagent_submit with a single task parameter and a text output', (t) => {
  const { ctx } = makeDeps(t)
  const tool = ctx.tool('subagent_submit')
  assert.ok(tool, 'tool registered under the unified subagent_* name')
  assert.deepEqual(Object.keys(tool.parameters.properties), ['task'])
  assert.equal(tool.parameters.properties.task.type, 'string')
  assert.ok(tool.parameters.required.includes('task'), 'task is a required parameter')
})

// ---- 恢复矩阵 ④：无记录 → 拒绝（marker 绝非鉴权源） ----

test('refuses sessions without binding or registry entry (the marker is not authorization)', async (t) => {
  const { bridge, ctx } = makeDeps(t)
  // the caller's own log contains a marker (e.g. it relayed a child answer)
  const exec = execFor('root-1')
  exec.agent.session.events = [{ payload: { text: `${MARKER}fake:hijack-target` } }]
  await assert.rejects(ctx.tool('subagent_submit').execute({ task: 'x' }, exec), /bound to this agent/)
  assert.equal(bridge.calls.length, 0, 'no reconnect attempted')
})

test('a registry entry whose backend has no bridge on this deployment is refused too', async (t) => {
  const { bridge, ctx, registry } = makeDeps(t)
  // e.g. the provider CLI vanished between runs — providerBridges has no entry
  registry.set('child-gone', { backend: 'codex', remoteId: 'r', cwd: '/tmp', updatedAt: 1 })
  await assert.rejects(
    ctx.tool('subagent_submit').execute({ task: 'x' }, execFor('child-gone')),
    /bound to this agent/,
  )
  assert.equal(bridge.calls.length, 0)
})

// ---- 恢复矩阵 ①：live binding → 直接用 ----

test('a live binding is used directly: submit only, settings drive the remote permissions', async (t) => {
  const { bridge, registry, state, ctx } = makeDeps(t)
  state.bindings.set('child-1', {
    product: 'fake',
    bridge,
    remote: { kind: 'fake', sessionId: 's-live' },
    settings: { permissionMode: 'readonly' },
  })
  const out = await ctx.tool('subagent_submit').execute({ task: 'hi' }, execFor('child-1'))
  assert.match(out.text, /echo:hi/)
  assert.deepEqual(
    bridge.calls.map((c) => c.op),
    ['submit'],
    'no reconnect/create on a live binding',
  )
  assert.deepEqual(bridge.calls[0].settings, { permissionMode: 'readonly' }, 'binding settings drive the remote permissions')
  // finally 持久化：remoteId + settings 写回 registry（下次 idle/重启恢复源）
  const persisted = registry.get('child-1')
  assert.equal(persisted.backend, 'fake')
  assert.equal(persisted.remoteId, 's-live')
  assert.equal(persisted.cwd, '/tmp')
  assert.deepEqual(persisted.settings, { permissionMode: 'readonly' })
})

// ---- 恢复矩阵 ②：registry 含 remoteId → reconnect + settings 还原 ----

test('recovers from the registry and restores settings (remoteId → reconnect)', async (t) => {
  const { bridge, ctx, registry } = makeDeps(t)
  registry.set('child-1', {
    backend: 'fake',
    remoteId: 'known-session',
    cwd: '/w',
    settings: { permissionMode: 'readonly' },
  })
  const out = await ctx.tool('subagent_submit').execute({ task: 'hi' }, execFor('child-1'))
  assert.match(out.text, /echo:hi/)
  assert.match(out.text, new RegExp(`${MARKER}fake:known-session`))
  assert.equal(bridge.calls.find((c) => c.op === 'reconnect').sessionId, 'known-session')
  assert.deepEqual(
    bridge.calls.find((c) => c.op === 'submit').settings,
    { permissionMode: 'readonly' },
    'recovered settings drive the remote permissions',
  )
})

// ---- 恢复矩阵 ③：registry 无 remoteId → 全新会话 + settings 还原 ----

test('a registry entry without remoteId authorizes a FRESH session with restored settings', async (t) => {
  const { bridge, ctx, registry } = makeDeps(t)
  // pre-first-submission entry (claude/codex before their first turn)
  registry.set('child-4', { backend: 'fake', cwd: '/w', settings: { permissionMode: 'readonly' } })
  const out = await ctx.tool('subagent_submit').execute({ task: 'hi' }, execFor('child-4'))
  assert.match(out.text, /echo:hi/)
  assert.equal(bridge.calls.filter((c) => c.op === 'reconnect').length, 0, 'no reconnect without a remote id')
  assert.ok(bridge.calls.find((c) => c.op === 'create'), 'fresh create instead')
  assert.equal(bridge.calls.find((c) => c.op === 'create').cwd, '/w', 'recorded cwd drives the fresh session')
  assert.deepEqual(bridge.calls.find((c) => c.op === 'submit').settings, { permissionMode: 'readonly' })
})

// ---- 并发串行化：per-child tail 队列 ----

test('serializes concurrent submissions per child (live binding)', async (t) => {
  const bridge = fakeBridge({ latencyMs: 30 })
  const { state, ctx } = makeDeps(t, { bridge })
  state.bindings.set('child-2', { product: 'fake', bridge, remote: { kind: 'fake', sessionId: 's' }, settings: undefined })
  const order = []
  const origSubmit = bridge.submit.bind(bridge)
  bridge.submit = async (...a) => {
    order.push(`start:${a[1]}`)
    const result = await origSubmit(...a)
    order.push(`end:${a[1]}`)
    return result
  }
  await Promise.all([
    ctx.tool('subagent_submit').execute({ task: 'A' }, execFor('child-2')),
    ctx.tool('subagent_submit').execute({ task: 'B' }, execFor('child-2')),
  ])
  assert.deepEqual(order, ['start:A', 'end:A', 'start:B', 'end:B'], 'B only starts after A finished')
})

test('serializes the RECOVERY path too (no double reconnect)', async (t) => {
  const bridge = fakeBridge({ latencyMs: 20 })
  const { ctx, registry } = makeDeps(t, { bridge })
  // binding lost; registry drives recovery — two concurrent submits must not
  // both reconnect
  registry.set('child-3', { backend: 'fake', remoteId: 'r3', cwd: '/tmp', settings: { permissionMode: 'readonly' } })
  const [a, b] = await Promise.all([
    ctx.tool('subagent_submit').execute({ task: 'A' }, execFor('child-3')),
    ctx.tool('subagent_submit').execute({ task: 'B' }, execFor('child-3')),
  ])
  assert.match(a.text, /echo:A/)
  assert.match(b.text, /echo:B/)
  assert.equal(bridge.calls.filter((c) => c.op === 'reconnect').length, 1, 'exactly one reconnect')
  assert.deepEqual(bridge.calls.filter((c) => c.op === 'submit').map((c) => c.task), ['A', 'B'])
})

// ---- marker ----

test('marker is appended as PRODUCT_SESSION:<backend>:<remoteId>; omitted before the remote id is known', async (t) => {
  const { bridge, registry, state, ctx } = makeDeps(t)
  // claude-style remote BEFORE the first submission: no sessionId yet, only
  // the preallocated pendingSessionId — no marker in the answer …
  state.bindings.set('child-5', { product: 'fake', bridge, remote: { pendingSessionId: 'pre-1' }, settings: undefined })
  const out = await ctx.tool('subagent_submit').execute({ task: 'hi' }, execFor('child-5'))
  assert.equal(out.text.includes(MARKER), false, 'no marker before a session/thread id exists')
  // … but persistRemote still records the pendingSessionId as the remote id
  assert.equal(registry.get('child-5').remoteId, 'pre-1', 'claude pendingSessionId counts as the remote id')
})

// ---- idle 取消（cancelDispose） ----

test('a submit cancels the pending idle release (fast continuation pays no reconnect)', async (t) => {
  const { bridge, state, ctx } = makeDeps(t, { stateOpts: { idleTimeoutMs: 2000 } })
  state.bindings.set('child-6', { product: 'fake', bridge, remote: { sessionId: 's-6' }, settings: undefined })
  state.scheduleDispose('child-6')
  assert.ok(state.disposeTimers.has('child-6'), 'idle timer armed before the submit')

  const out = await ctx.tool('subagent_submit').execute({ task: 'again' }, execFor('child-6'))
  assert.match(out.text, /echo:again/)
  assert.ok(!state.disposeTimers.has('child-6'), 'the submit cancelled the pending disposal')
  assert.ok(state.bindings.has('child-6'), 'binding survives — the child was reused')
})

// ---- deps 装配校验（fail closed） ----

test('registerSubagentSubmit validates the deps wiring loudly', () => {
  const ctx = () => {
    const tools = new Map()
    return { tools: { register: (tool) => tools.set(tool.name, tool) } }
  }
  const state = { bindings: new Map(), registry: { get: () => undefined }, persistRemote: () => {}, cancelDispose: () => {} }
  assert.throws(
    () => registerSubagentSubmit(ctx(), { assembled: { state }, config: {} }),
    /providerBridges/,
    'missing providerBridges fails loudly',
  )
  assert.throws(
    () => registerSubagentSubmit(ctx(), { assembled: { state: { bindings: new Map() } }, config: {} }),
    /assembled\.state to expose/,
    'incomplete state kernel fails loudly (no silent binding-only degradation)',
  )
  assert.throws(
    () => registerSubagentSubmit(ctx(), { config: {} }),
    /assembled\.state to expose/,
  )
})

// ---- D2b relay epoch 计数（noteRelaySubmit 在 execute 入口自增） ----

test('D2b: every submit counts the epoch (execute entrance, not forward success)', async (t) => {
  const { state, ctx } = makeDeps(t)
  state.noteRelayEpochStart?.('child-1')
  state.bindings.set('child-1', {
    product: 'fake',
    bridge: { submit: async () => ({ text: 'ok', stopReason: 'completed' }) },
    remote: { sessionId: 's-live' },
    settings: undefined,
  })
  await ctx.tool('subagent_submit').execute({ task: 'a' }, execFor('child-1'))
  await ctx.tool('subagent_submit').execute({ task: 'b' }, execFor('child-1'))
  assert.equal(state.relayEpochs.get('child-1').submits, 2, 'each execute counts, whatever the forward outcome')
})

test('D2b: a FAILED submit still counts (reporting the error is a legal closure)', async (t) => {
  const bridge = fakeBridge()
  bridge.submit = async () => { throw new Error('submit boom') }
  const { state, ctx } = makeDeps(t, { bridge })
  state.noteRelayEpochStart?.('child-f')
  state.bindings.set('child-f', {
    product: 'fake',
    bridge,
    remote: { sessionId: 's-f' },
    settings: undefined,
  })
  await assert.rejects(ctx.tool('subagent_submit').execute({ task: 'x' }, execFor('child-f')), /submit boom/)
  assert.equal(state.relayEpochs.get('child-f').submits, 1, 'counted at the entrance — the relay did try to forward')
})

test('D2b: the legacy product_submit alias counts through the same execute', async (t) => {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  const tools = new Map()
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    tool: (name) => tools.get(name),
  }
  const bridge = fakeBridge()
  const assembled = { state, providerBridges: { fake: bridge } }
  registerSubagentSubmit(ctx, { assembled, config: {}, toolName: 'product_submit' })
  registry.set('legacy-child', { backend: 'fake', remoteId: 'r1', cwd: '/tmp', settings: { permissionMode: 'readonly' } })
  await ctx.tool('product_submit').execute({ task: 'old vocab' }, execFor('legacy-child'))
  assert.equal(state.relayEpochs.get('legacy-child').submits, 1, 'the alias lazily creates the counter entry (cold-resume first turn)')
})
