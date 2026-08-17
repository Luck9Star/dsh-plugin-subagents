// dsh-plugin-subagents — 引擎级 dispatch 缝测试（T22，docs/dispatch-seam.md §6.2）。
//
// 覆盖矩阵（设计 §6.2，逐条落）：
//   1. settings 穿透：fake bridge 记录 submit 第五参，断言 settings 逐字段
//      到达；permissionMode 三档解析链（显式 > role > 'default'）；model /
//      reasoningEffort 直通；
//   2. ceiling 拒绝：parent 命中 binding（readonly）请求 full → throw；命中
//      registry（冷恢复）同理；root parent 不受限；callerMode 未知 → fail
//      closed（ceiling.test.js 随迁语义的 seam 版）；
//   3. config cap：maxDispatchPermissionMode 越界 → loud；两道闸独立触发、
//      文案可区分（ceiling 文案含 "escalation blocked"，cap 文案含
//      "maxDispatchPermissionMode"）；
//   4. registry 零写入：dispatch 前后 registry.size 不变；bindings 无新键；
//   5. 并发槽：in-flight 期间 liveChildren 含 dispatch:* 合成键、settle 后
//      释放；预占满 cap → loud；与真实 continuable 子代理 id 共用同一 cap；
//   6. backend 校验：未知名 loud 报列表；'native'/'spawn'/'fork' → 重定向
//      文案 throw（含 ctx.subagents.start 字样）；
//   7. role：未知 loud 报列表；instructions 前缀进 task；role.backend 锁定
//      与显式 backend 冲突 → throw（subagent-tool.test.js ③⑤ 的 seam 版）；
//   8. cwd：显式 cwd 到达 bridge.create 第一参；非法（相对路径/不存在）→
//      assertCwd 文案 throw；省略 → parentCwd(parent)；
//   9. signal/失败路径：signal 贯穿（fake bridge 记录 signal）；submit
//      throw → dispatch reject 同错误 + 槽已释放 + dispose 被调过；
//      stopReason/text/label 回显映射；
//  10. 参数白名单：persona / toolFilter / maxDepth / provider / outputSchema /
//      maxTokens 任一出现 → throw 含参数名；未知键同理；
//  11. enum 加固：permissionMode / reasoningEffort 非法值 → loud。
//
// 全部 fake：fakeBridge（真实 bridge 契约形状，经真实 createBridgeDriver 的
// sync 路由）、tmp registry、fakeCtx —— 无真实 CLI、无密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRegistry } from '../lib/registry.js'
import { createBridgeState, createBridgeDriver } from '../lib/drivers/bridge.js'
import { assertWithinCeiling } from '../lib/ceiling.js'
import { createDispatchSeam } from '../lib/dispatch.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** tmp dir + cleanup. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-seam-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** tmp registry file (removed in t.after). */
function tmpRegistry(t) {
  const path = join(tempDir(t), 'registry.json')
  return createRegistry(path)
}

/**
 * Bridge double recording every call (op + args) in order. `pendingSubmit`
 * resolves the submit promise on demand so tests can observe the in-flight
 * concurrency slot; `failSubmit` makes submit throw (failure-path group).
 */
function fakeBridge({ failSubmit = false, pendingSubmit } = {}) {
  const calls = []
  return {
    calls,
    async create(cwd) { calls.push({ op: 'create', cwd }); return { kind: 'fake', sessionId: `s-${calls.length}` } },
    async submit(remote, task, signal, cwd, settings) {
      calls.push({ op: 'submit', task, signal, cwd, settings })
      if (failSubmit) throw new Error('submit boom')
      if (pendingSubmit) await pendingSubmit
      return { text: `echo:${task}`, stopReason: 'completed' }
    },
    async reconnect(sessionId, cwd) { calls.push({ op: 'reconnect', sessionId, cwd }); return { kind: 'fake', sessionId } },
    async dispose(remote) { calls.push({ op: 'dispose' }) },
  }
}

/**
 * Full harness-shaped assembly for the seam: a real createBridgeState (tmp
 * registry) + a real createBridgeDriver (fake bridge) + the seam itself.
 * `config` reaches the seam exactly as apply() would pass it.
 */
function makeSeam(t, { bridge = fakeBridge(), bridgeConfig = {}, config = {}, roles } = {}) {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  const driver = createBridgeDriver({
    name: 'fake',
    bridge,
    providers: { fake: { name: 'fake', type: 'acp', command: 'fake' } },
    state,
    availability: () => (bridgeConfig.unavailable
      ? { registered: false, reason: 'fake CLI not found on PATH' }
      : { registered: true, reason: 'fake CLI detected' }),
  })
  const assembled = {
    bridges: new Map(bridgeConfig.absent ? [] : [['fake', driver]]),
    state,
  }
  const logs = { info: [], warn: [] }
  const ctx = { logger: { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m) } }
  const seam = createDispatchSeam({
    ctx,
    assembled,
    roles: roles ?? fakeRoles({}),
    config,
  })
  return { bridge, driver, state, registry, assembled, seam, ctx, logs }
}

/** 假角色库（createRoleLibrary 产物形状：list()/get()）。 */
function fakeRoles(map) {
  return {
    list: () => Object.values(map),
    get: (id) => map[id] || null,
  }
}

const GENERAL = { id: 'general', description: 'g', backend: '', permissionMode: 'full', allowDelegation: true, instructions: '', overrides: {} }
const REVIEWER = { id: 'reviewer', description: 'r', backend: '', permissionMode: 'readonly', allowDelegation: false, instructions: 'Review only; never edit files.', overrides: {} }
const PINNED = { id: 'pinned-fake', description: 'p', backend: 'fake', permissionMode: 'default', allowDelegation: true, instructions: '', overrides: {} }

/** root parent（binding ∪ registry 均未命中 —— ceiling 主体不受限）。 */
const rootParent = { session: { id: 'root-1', header: { cwd: '/w' } } }

/** 最小合法请求（各组测试按需覆盖字段）。 */
const baseRequest = { backend: 'fake', task: 'Do the work.', parent: rootParent }

// ── 1. settings 穿透 ─────────────────────────────────────────────────────────

test('1. settings reach bridge.submit verbatim (model / reasoningEffort passthrough, explicit permissionMode)', async (t) => {
  const { bridge, seam } = makeSeam(t)
  const out = await seam.dispatchAgentTask({
    ...baseRequest,
    label: 'tuned run',
    settings: { permissionMode: 'readonly', model: 'gpt-5-codex', reasoningEffort: 'high' },
  })
  const submit = bridge.calls.find((c) => c.op === 'submit')
  assert.deepEqual(submit.settings, {
    permissionMode: 'readonly',
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
  }, 'every settings field reaches the bridge verbatim')
  // outcome echo mapping (§2.3): backend / runId / label / text / stopReason
  assert.equal(out.backend, 'fake')
  assert.equal(out.label, 'tuned run')
  assert.equal(out.text, `echo:${baseRequest.task}`)
  assert.equal(out.stopReason, 'completed')
  assert.match(out.runId, /^fake-/)
})

/** The most recent submit call recorded by the fake bridge. */
const lastSubmit = (bridge) => bridge.calls.filter((c) => c.op === 'submit').pop()

test('1. permissionMode resolution chain: explicit > role.permissionMode > "default"', async (t) => {
  // (a) omitted role + omitted settings → 'default'（程序化缺省取保守档）
  let s = makeSeam(t)
  await s.seam.dispatchAgentTask(baseRequest)
  assert.equal(lastSubmit(s.bridge).settings.permissionMode, 'default')

  // (b) role.permissionMode（readonly）+ omitted settings → role 档
  s = makeSeam(t, { roles: fakeRoles({ reviewer: REVIEWER }) })
  await s.seam.dispatchAgentTask({ ...baseRequest, role: 'reviewer' })
  assert.equal(lastSubmit(s.bridge).settings.permissionMode, 'readonly')

  // (c) explicit settings > role.permissionMode
  await s.seam.dispatchAgentTask({ ...baseRequest, role: 'reviewer', settings: { permissionMode: 'default' } })
  assert.equal(lastSubmit(s.bridge).settings.permissionMode, 'default')

  // (d) role omitted settings keys never leak undefined into settings
  s = makeSeam(t)
  await s.seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'full' } })
  assert.deepEqual(
    lastSubmit(s.bridge).settings,
    { permissionMode: 'full' },
    'omitted model / reasoningEffort never appear as keys',
  )
})

// ── 2. ceiling 拒绝（parent-based，gate 1）────────────────────────────────────

test('2. a readonly bridge-child parent cannot dispatch full (binding hit; registry hit; root unrestricted; unknown mode fails closed)', async (t) => {
  const { seam, state, registry, bridge } = makeSeam(t)

  // 活 binding 命中：readonly 子代理借插件之手 spawn full → 堵死（§3.1）
  state.bindings.set('child-1', { product: 'fake', remote: {}, settings: { permissionMode: 'readonly' } })
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: { session: { id: 'child-1', header: { cwd: '/w' } } }, settings: { permissionMode: 'full' } }),
    (err) => err.message.includes('permission escalation blocked')
      && err.message.includes('"readonly"')
      && err.message.includes('"full"'),
  )
  state.bindings.delete('child-1')

  // binding 已失（idle 释放/重启）→ durable registry 兜底，天花板不解除
  registry.set('child-2', { backend: 'fake', remoteId: 'r-9', settings: { permissionMode: 'readonly' } })
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: { session: { id: 'child-2', header: { cwd: '/w' } } }, settings: { permissionMode: 'full' } }),
    /permission escalation blocked/,
  )
  registry.remove('child-2')

  // root parent（binding ∪ registry 均未命中）不受限 —— full 放行
  await seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'full' } })
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 1, 'the root dispatch went through')

  // callerMode 未知（binding settings 无 permissionMode）→ fail closed 到 readonly
  state.bindings.set('child-3', { product: 'fake', remote: {}, settings: {} })
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: { session: { id: 'child-3', header: { cwd: '/w' } } }, settings: { permissionMode: 'default' } }),
    (err) => err.message.includes('permission escalation blocked')
      && err.message.includes('unknown (treated as readonly)'),
  )
  // 同档 readonly 请求 → 放行（天花板允许不越级）
  await seam.dispatchAgentTask({ ...baseRequest, parent: { session: { id: 'child-3', header: { cwd: '/w' } } }, settings: { permissionMode: 'readonly' } })
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 2)
})

// ── 3. config cap（gate 2）与两道闸独立性 ────────────────────────────────────

test('3. maxDispatchPermissionMode cap rejects over-cap requests with actionable wording', async (t) => {
  const { seam, bridge } = makeSeam(t, { config: { maxDispatchPermissionMode: 'readonly' } })
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'default' } }),
    (err) => err.message.includes('maxDispatchPermissionMode')
      && err.message.includes('"readonly"')
      && err.message.includes('"default"'),
  )
  assert.equal(bridge.calls.length, 0, 'over-cap call never reaches the bridge')
  // cap 内（readonly 请求）放行
  await seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'readonly' } })
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 1)
})

test('3. the two gates fire independently with distinguishable wording', async (t) => {
  // gate 1 only: cap=full（缺省）+ parent readonly 请求 full → ceiling 拒
  const a = makeSeam(t)
  a.state.bindings.set('child-1', { product: 'fake', remote: {}, settings: { permissionMode: 'readonly' } })
  await assert.rejects(
    () => a.seam.dispatchAgentTask({
      ...baseRequest,
      parent: { session: { id: 'child-1', header: { cwd: '/w' } } },
      settings: { permissionMode: 'full' },
    }),
    (err) => err.message.includes('escalation blocked') && !err.message.includes('maxDispatchPermissionMode'),
  )

  // gate 2 only: cap=readonly + root parent 请求 default → cap 拒
  const b = makeSeam(t, { config: { maxDispatchPermissionMode: 'readonly' } })
  await assert.rejects(
    () => b.seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'default' } }),
    (err) => err.message.includes('maxDispatchPermissionMode') && !err.message.includes('escalation blocked'),
  )
})

// ── 4. registry / binding 零写入（§3.3）─────────────────────────────────────

test('4. a one-shot dispatch writes nothing to the registry and adds no binding', async (t) => {
  const { seam, state, registry } = makeSeam(t)
  registry.set('pre-existing', { backend: 'fake', remoteId: 'r-0', cwd: '/w' })
  const registrySize = registry.size
  const bindingKeys = [...state.bindings.keys()]
  await seam.dispatchAgentTask(baseRequest)
  await seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'full' } })
  assert.equal(registry.size, registrySize, 'no registry entry for a disposed one-shot remote (no false recovery promise)')
  assert.deepEqual([...state.bindings.keys()], bindingKeys, 'no binding key was created')
})

// ── 5. 并发槽（§3.4：seam 占槽，合成键 dispatch:*，finally 释放）────────────

test('5. an in-flight dispatch holds a dispatch:* slot; the slot is released on settle', async (t) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { seam, state } = makeSeam(t, { bridge: fakeBridge({ pendingSubmit: gate }) })

  const inFlight = seam.dispatchAgentTask(baseRequest)
  await sleep(10) // let the dispatch reach bridge.submit
  const held = [...state.liveChildren].filter((id) => id.startsWith('dispatch:'))
  assert.equal(held.length, 1, 'exactly one synthetic dispatch:* key is held in flight')

  release()
  await inFlight
  assert.equal([...state.liveChildren].filter((id) => id.startsWith('dispatch:')).length, 0, 'the slot is released on settle')
})

test('5. a full cap rejects the next dispatch loudly; the slot count is shared with real continuable children', async (t) => {
  // config.maxConcurrentChildren=1，先放一个真实 continuable 子代理 id 占槽
  // —— seam 与工具层共用同一只 liveChildren（红线 10）。
  const { seam, state } = makeSeam(t, { config: { maxConcurrentChildren: 1 } })
  state.liveChildren.add('real-child-uuid-1')
  await assert.rejects(
    () => seam.dispatchAgentTask(baseRequest),
    (err) => err.message.includes('concurrency limit reached')
      && err.message.includes('1 bridge children')
      && err.message.includes('maxConcurrentChildren'),
  )
  state.liveChildren.delete('real-child-uuid-1')

  // 槽空后放行；再以一个 in-flight dispatch 占满（cap=1）→ 下一个 loud
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pending = makeSeam(t, { config: { maxConcurrentChildren: 1 }, bridge: fakeBridge({ pendingSubmit: gate }) })
  const inFlight = pending.seam.dispatchAgentTask(baseRequest)
  await sleep(10)
  assert.equal(pending.state.liveChildren.size, 1, 'the in-flight dispatch holds the single slot')
  await assert.rejects(
    () => pending.seam.dispatchAgentTask(baseRequest),
    (err) => err.message.includes('concurrency limit reached'),
  )
  release()
  await inFlight
  assert.equal(pending.state.liveChildren.size, 0)
})

// ── 6. backend 校验（§5 桥专精）─────────────────────────────────────────────

test('6. unknown backend lists the assembled bridges; native names redirect to the official channel', async (t) => {
  const { seam, bridge } = makeSeam(t)
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, backend: 'nope' }),
    (err) => err.message.includes('unknown backend "nope"') && err.message.includes('available: fake'),
  )
  for (const name of ['native', 'spawn', 'fork']) {
    await assert.rejects(
      () => seam.dispatchAgentTask({ ...baseRequest, backend: name }),
      (err) => err.message.includes(`backend "${name}" is not served by this seam`)
        && err.message.includes('ctx.subagents.start'),
    )
  }
  assert.equal(bridge.calls.length, 0)
})

test('6. an assembled-but-unavailable backend throws with its reason', async (t) => {
  const { seam, bridge } = makeSeam(t, { bridgeConfig: { unavailable: true } })
  await assert.rejects(
    () => seam.dispatchAgentTask(baseRequest),
    (err) => err.message.includes('backend "fake" is not available')
      && err.message.includes('fake CLI not found on PATH'),
  )
  assert.equal(bridge.calls.length, 0)
})

// ── 7. role 解析（语义与工具层逐字相同）─────────────────────────────────────

test('7. unknown role lists available ids; instructions are prefixed with a blank line; a pinned role conflicts loudly', async (t) => {
  const { seam, bridge } = makeSeam(t, { roles: fakeRoles({ reviewer: REVIEWER, pinned: PINNED }) })

  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, role: 'typo' }),
    (err) => err.message.includes('unknown role "typo"') && err.message.includes('available: reviewer, pinned'),
  )

  // instructions 前缀进 task（前缀 + '\n\n' + 原文）
  await seam.dispatchAgentTask({ ...baseRequest, role: 'reviewer', task: 'Review PR 7.' })
  assert.equal(
    bridge.calls.find((c) => c.op === 'submit').task,
    'Review only; never edit files.\n\nReview PR 7.',
  )

  // role.backend 锁定（'fake'）与显式 backend 不同 → loud
  const { seam: s2 } = makeSeam(t, { roles: fakeRoles({ pinned: PINNED }) })
  // seams 本组装只有 'fake' 一个 backend —— 用一个“另一个已装配名”验证冲突：
  // 直接给 pinned role + 一个不存在的显式 backend 会先撞 unknown backend。
  // 所以用未装配名 'other' 会走 unknown backend 分支 —— 冲突校验在 backend
  // 存在性之后（§2.2 表序），构造双 bridge 装配来验证。
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  const driverA = createBridgeDriver({ name: 'fake', bridge: fakeBridge(), state })
  const driverB = createBridgeDriver({ name: 'other', bridge: fakeBridge(), state })
  const assembled = { bridges: new Map([['fake', driverA], ['other', driverB]]), state }
  const seam2 = createDispatchSeam({ assembled, roles: fakeRoles({ pinned: PINNED }), config: {} })
  await assert.rejects(
    () => seam2.dispatchAgentTask({ ...baseRequest, backend: 'other', role: 'pinned' }),
    (err) => err.message.includes('role "pinned-fake" pins backend "fake"')
      && err.message.includes('backend "other" was passed'),
  )
  // 一致的显式 backend → 合法（不误伤）
  await seam2.dispatchAgentTask({ ...baseRequest, backend: 'fake', role: 'pinned' })
})

// ── 8. cwd 解析（§2.2：本缝唯一的 deliberate 扩展）─────────────────────────

test('8. an explicit cwd reaches bridge.create; an invalid one throws assertCwd wording; omission uses parentCwd', async (t) => {
  const dir = tempDir(t)
  const { seam, bridge } = makeSeam(t)

  // 显式 cwd → bridge.create 第一参（经 driver sync 路由透传）
  await seam.dispatchAgentTask({ ...baseRequest, cwd: dir })
  assert.equal(bridge.calls.find((c) => c.op === 'create').cwd, dir)

  // 相对路径 → assertCwd 文案
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, cwd: 'relative/path' }),
    (err) => err.message.includes('cwd must be an absolute path'),
  )
  // 不存在 → assertCwd 文案
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, cwd: join(dir, 'absent') }),
    (err) => err.message.includes('cwd is not an accessible directory'),
  )

  // 省略 → parentCwd(parent)（parent.session.header.cwd）
  const s2 = makeSeam(t)
  await s2.seam.dispatchAgentTask({
    ...baseRequest,
    parent: { session: { id: 'root-2', header: { cwd: '/w/parent' } } },
  })
  assert.equal(s2.bridge.calls.find((c) => c.op === 'create').cwd, '/w/parent')
})

// ── 9. signal / 失败路径 / 回显映射 ────────────────────────────────────────

test('9. signal is threaded through to bridge.submit', async (t) => {
  const { seam, bridge } = makeSeam(t)
  const controller = new AbortController()
  await seam.dispatchAgentTask({ ...baseRequest, signal: controller.signal })
  assert.equal(bridge.calls.find((c) => c.op === 'submit').signal, controller.signal)
})

test('9. a submit failure rejects with the same error, releases the slot, and dispose was called', async (t) => {
  const { seam, state, bridge } = makeSeam(t, { bridge: fakeBridge({ failSubmit: true }) })
  await assert.rejects(
    () => seam.dispatchAgentTask(baseRequest),
    /submit boom/,
  )
  assert.equal(state.liveChildren.size, 0, 'the slot is released on throw (finally)')
  assert.ok(bridge.calls.some((c) => c.op === 'dispose'), 'the driver sync route disposed the remote before rethrowing')
})

test('9. a non-text output maps to empty text defensively; label omitted → no label key', async (t) => {
  // 直接构造一个返回非单-text-block outcome 的 fake driver（防御分支）
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  const driver = {
    kind: 'bridge',
    capabilities: { permissionMode: true, reasoningEffort: true },
    available: () => ({ registered: true, reason: 'ok' }),
    async start() {
      return { kind: 'foreground', runId: 'r-1', output: [{ type: 'image', url: 'x' }], stopReason: 'completed' }
    },
  }
  const assembled = { bridges: new Map([['fake', driver]]), state }
  const seam = createDispatchSeam({ assembled, roles: fakeRoles({}), config: {} })
  const out = await seam.dispatchAgentTask(baseRequest)
  assert.equal(out.text, '', 'no text block → empty string, never undefined')
  assert.equal('label' in out, false, 'label key absent when not given')
  assert.equal(out.stopReason, 'completed')
})

// ── 10. 参数白名单（红线 8）────────────────────────────────────────────────

test('10. native-only and unknown parameters are rejected loudly by name', async (t) => {
  const { seam, bridge } = makeSeam(t)
  for (const key of ['persona', 'toolFilter', 'maxDepth', 'provider', 'outputSchema', 'maxTokens']) {
    await assert.rejects(
      () => seam.dispatchAgentTask({ ...baseRequest, [key]: 'x' }),
      (err) => err.message.includes(`parameter "${key}" is not supported`),
    )
  }
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, madeUp: 1 }),
    (err) => err.message.includes('unknown parameter "madeUp"'),
  )
  assert.equal(bridge.calls.length, 0)
})

test('10. symbol-keyed properties are rejected loudly, never silently ignored (red line 8; review F-8)', async (t) => {
  // Object.keys 只枚举字符串键 —— 符号键原本绕过白名单循环且解构读不到，
  // 属静默忽略形态；现经 getOwnPropertySymbols 检查 loud 拒绝。
  const { seam, bridge } = makeSeam(t)
  const req = { ...baseRequest, [Symbol('x')]: 1 }
  await assert.rejects(
    () => seam.dispatchAgentTask(req),
    (err) => err.message.includes('symbol-keyed properties')
      && err.message.includes('(1 found)')
      && err.message.includes('backend, task, parent, label, role, settings, cwd, signal'),
  )
  assert.equal(bridge.calls.length, 0, 'a symbol-carrying request never reaches the bridge')
})

test('10. an inherited unknown key (custom prototype) is rejected loudly — Object.keys never sees it (F-8, prototype face)', async (t) => {
  const { seam, bridge } = makeSeam(t)
  // Object.create({ persona }) 的继承键不进 Object.keys —— 原本被静默忽略。
  const req = Object.assign(Object.create({ persona: 'x' }), baseRequest)
  await assert.rejects(
    () => seam.dispatchAgentTask(req),
    (err) => err.message.includes('must be a plain object')
      && err.message.includes('inherited properties')
      && err.message.includes('red line 8'),
  )
  assert.equal(bridge.calls.length, 0, 'a prototype-carrying request never reaches the bridge')
})

test('10. an inherited LEGAL key is rejected the same way — the prototype face itself is refused (destructured reads would consume it)', async (t) => {
  const { seam, bridge } = makeSeam(t)
  // 解构沿原型链读取：继承的 settings 会被实际消费 —— 两种继承形态都拒。
  const req = Object.assign(
    Object.create({ settings: { permissionMode: 'readonly' } }),
    { backend: 'fake', task: 'Do the work.', parent: rootParent },
  )
  await assert.rejects(
    () => seam.dispatchAgentTask(req),
    (err) => err.message.includes('must be a plain object'),
  )
  assert.equal(bridge.calls.length, 0)
})

test('10. a null-prototype request with legal fields passes — no inherited keys, empty bypass face', async (t) => {
  const { seam, bridge } = makeSeam(t)
  const req = Object.assign(Object.create(null), baseRequest)
  const out = await seam.dispatchAgentTask(req)
  assert.equal(out.backend, 'fake', 'a null-prototype request is NOT refused for its prototype')
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 1, 'it reaches the bridge')
})

test('10. a polluted Object.prototype fails closed: every dispatch rejects loudly naming the polluted key (F-8, pollution face)', async (t) => {
  const { seam, bridge } = makeSeam(t)
  // 赋值式污染产生可枚举键 —— 模拟缺陷 merge/deepClone 的常见后果。
  // 用例内临时污染 + finally 清理，避免波及其它用例。
  Object.prototype.persona = 'x'
  try {
    // plain-object 请求（原型是 Object.prototype）也会被拒 —— 污染键会
    // 绕过白名单枚举并被沿原型链的解构实际消费，fail-closed 拒一切。
    await assert.rejects(
      () => seam.dispatchAgentTask({ ...baseRequest }),
      (err) => err.message.includes('Object.prototype is polluted')
        && err.message.includes('persona')
        && err.message.includes('red line 8'),
    )
    assert.equal(bridge.calls.length, 0, 'no dispatch passes while the prototype is polluted')
  } finally {
    delete Object.prototype.persona
  }
  // 清理后同一 plain-object 请求正常走通到 bridge。
  const out = await seam.dispatchAgentTask({ ...baseRequest })
  assert.equal(out.backend, 'fake', 'the same request passes once the pollution is removed')
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 1)
})

test('10. pollution guard is scoped to enumerable keys — the guard itself adds zero overhead when clean', async (t) => {
  // 守卫生命周期回归：污染检测只看 Object.keys(Object.prototype)（可枚举键），
  // 干净进程下连续多次 dispatch 全部正常（与既有用例叠加验证零行为变化）。
  const { seam, bridge } = makeSeam(t)
  await seam.dispatchAgentTask(baseRequest)
  await seam.dispatchAgentTask(baseRequest)
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 2, 'clean-process dispatches are unaffected')
  assert.equal(Object.keys(Object.prototype).length, 0, 'test process leaves the prototype clean')
})

// ── 11. enum 加固（fail closed，比工具层 schema 更前置）─────────────────────

test('11. illegal permissionMode / reasoningEffort values throw', async (t) => {
  const { seam, bridge } = makeSeam(t)
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'sudo' } }),
    (err) => err.message.includes('permissionMode') && err.message.includes('"sudo"'),
  )
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, settings: { reasoningEffort: 'extreme' } }),
    (err) => err.message.includes('reasoningEffort') && err.message.includes('"extreme"'),
  )
  assert.equal(bridge.calls.length, 0)
})

// ── 附加：state 守卫（fail at create，§3.1）+ 形状 + 日志 ──────────────────

test('createDispatchSeam guards the assembled state at create time (fail loud, fail early)', (t) => {
  const registry = tmpRegistry(t)
  assert.throws(
    () => createDispatchSeam({ assembled: {}, roles: fakeRoles({}), config: {} }),
    /requires deps\.assembled with a bridges Map/,
  )
  assert.throws(
    () => createDispatchSeam({
      assembled: { bridges: new Map(), state: { bindings: new Map() } },
      roles: fakeRoles({}),
      config: {},
    }),
    /must expose both `bindings` and `registry`/,
  )
  // liveChildren / nextSeq 齐备性（并发槽守卫）
  assert.throws(
    () => createDispatchSeam({
      assembled: { bridges: new Map(), state: { bindings: new Map(), registry } },
      roles: fakeRoles({}),
      config: {},
    }),
    /must expose `liveChildren` and `nextSeq`/,
  )
  // roles 齐备性
  assert.throws(
    () => createDispatchSeam({
      assembled: { bridges: new Map(), state: createBridgeState({ registry }) },
      config: {},
    }),
    /requires deps\.roles/,
  )
  // 齐备装配 → 形状正确
  const seam = createDispatchSeam({
    assembled: { bridges: new Map(), state: createBridgeState({ registry }) },
    roles: fakeRoles({}),
    config: {},
  })
  assert.equal(typeof seam.dispatchAgentTask, 'function')
  assert.equal(typeof seam.backends, 'function')
  assert.equal(seam.available, false)
  assert.deepEqual(seam.backends(), [])
})

test('required fields are validated before anything else (backend / task / parent)', async (t) => {
  const { seam, bridge } = makeSeam(t)
  await assert.rejects(() => seam.dispatchAgentTask({ task: 'x', parent: rootParent }), /non-empty string `backend`/)
  await assert.rejects(() => seam.dispatchAgentTask({ backend: 'fake', parent: rootParent }), /non-empty string `task`/)
  await assert.rejects(() => seam.dispatchAgentTask({ backend: 'fake', task: 'x' }), /requires a `parent`/)
  await assert.rejects(() => seam.dispatchAgentTask(), /requires a request object/)
  assert.equal(bridge.calls.length, 0)
})

// ── 附加：原型键加固（评审 F-1：fail-open → fail-closed）────────────────────

test('F-1 cap: a prototype-key maxDispatchPermissionMode is rejected loudly, never silently ignored', async (t) => {
  // 直接把非法值塞进 config（绕过 zod —— seam 收的是已校验对象，这里模拟
  // 装配层缺陷/未来调用方误传），断言 cap 不再静默失效。
  const { seam, bridge } = makeSeam(t, { config: { maxDispatchPermissionMode: 'toString' } })
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, settings: { permissionMode: 'default' } }),
    (err) => err.message.includes('maxDispatchPermissionMode')
      && err.message.includes('"toString"'),
  )
  const { seam: s2, bridge: b2 } = makeSeam(t, { config: { maxDispatchPermissionMode: 'constructor' } })
  await assert.rejects(
    () => s2.dispatchAgentTask(baseRequest),
    (err) => err.message.includes('maxDispatchPermissionMode')
      && err.message.includes('"constructor"'),
  )
  assert.equal(bridge.calls.length, 0)
  assert.equal(b2.calls.length, 0)
})

test('F-1 ceiling: prototype-key caller/requested modes fail closed (own-key lookup)', () => {
  // callerMode 是原型键（'toString'）→ 查表得到继承函数而非 undefined →
  // 旧实现 NaN 比较恒 false 静默放行；加固后按未知档 fail closed 到
  // readonly（rank 0），消息回显原值。
  assert.throws(
    () => assertWithinCeiling({
      callerSettings: { permissionMode: 'toString' },
      callerIsProductChild: true,
      requestedMode: 'full',
    }),
    (err) => err.message.includes('escalation blocked')
      && err.message.includes('"toString"')
      && err.message.includes('"full"'),
  )
  // requestedMode 是原型键 → 归 1（unknown-as-default，现有语义）；caller 是
  // readonly(0) 时仍被拒 —— 不因函数值而绕过。
  assert.throws(
    () => assertWithinCeiling({
      callerSettings: { permissionMode: 'readonly' },
      callerIsProductChild: true,
      requestedMode: 'constructor',
    }),
    /escalation blocked/,
  )
  // caller full(2) ≥ requested 归 1 → 放行（与旧实现对未知串的语义一致）
  assertWithinCeiling({
    callerSettings: { permissionMode: 'full' },
    callerIsProductChild: true,
    requestedMode: 'toString',
  })
  // 合法值路径不受加固影响（回归快查；ceiling.test.js 是完整回归）
  assert.throws(
    () => assertWithinCeiling({
      callerSettings: { permissionMode: 'default' },
      callerIsProductChild: true,
      requestedMode: 'full',
    }),
    /escalation blocked/,
  )
})

// ── 附加：parent 形状前置校验（评审 NIT-1）──────────────────────────────────

test('NIT-1 parent shape: a parent without session.id throws with the live-Agent contract wording', async (t) => {
  const { seam, bridge } = makeSeam(t)
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: {} }),
    (err) => err.message.includes('parent.session.id'),
  )
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: { session: {} } }),
    (err) => err.message.includes('parent.session.id'),
  )
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: { session: { id: '' } } }),
    (err) => err.message.includes('parent.session.id'),
  )
  await assert.rejects(
    () => seam.dispatchAgentTask({ ...baseRequest, parent: { session: { id: 42 } } }),
    (err) => err.message.includes('parent.session.id'),
  )
  assert.equal(bridge.calls.length, 0, 'a malformed parent never reaches the bridge')
})

test('a settled dispatch logs one info line with backend / permissionMode / label / runId', async (t) => {
  const { seam, logs } = makeSeam(t)
  const out = await seam.dispatchAgentTask({ ...baseRequest, label: 'probe', settings: { permissionMode: 'readonly' } })
  assert.equal(logs.info.length, 1)
  const line = logs.info[0]
  assert.match(line, /backend=fake/)
  assert.match(line, /permissionMode=readonly/)
  assert.match(line, /label="probe"/)
  assert.ok(line.includes(`runId=${out.runId}`), `log line carries runId=${out.runId}`)
  assert.equal(logs.warn.length, 0)
})
