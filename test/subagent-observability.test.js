// dsh-plugin-subagents — 观测族四工具测试（T13）。
//
// 覆盖（TASKS T13 验收）：
//   - subagent_wait：自 PS wait.test.js 逐行随迁的竞态用例组 —— subscribe-first
//     （DURING listing settle 仍可观测）、AFTER listing settle、已 settle 立即
//     ready、timeout、unknown（无关 end 事件忽略）、并发 waiter 全 resolve，
//     外加「监听器在每条返回路径都被移除」断言；
//   - subagent_progress：bridge 路径（fake binding：pinnedProduct /
//     remoteSessionId / inFlight / settings.model / 'inherit (product default)'
//     / listChildren 状态优先 / session 折叠全字段）；native 路径（fake
//     driver progress 快照 + 工具层纯 session 折叠、listing label 优先、
//     bridge 字段整键省略）；listing 失败时 driver 快照兜底；listing 与
//     driver 双缺席但 session 存在 → 'running'（PS 语义随迁）；双缺席且无
//     session → 'unknown'；注册期 guard（缺 native.spawn / state.bindings）；
//   - subagent_roles：backend 列三态（'(caller chooses)' / 'native' / provider
//     名）+ 真实角色库（createRoleLibrary 缺目录兜底 general）集成；
//   - subagent_agents：bridge availability 三态（PATH 命中 / 未命中 / 命中但
//     鉴权产物缺失）+ native spawn/fork 两 provider 视图 + children 总览
//     （backend 列区分 bridge/native、busy 并发槽、model inherit）+
//     listing 失败降级 + 注册期 guard。
//
// 全部 fake：可控 subagent/end 发射器、可控 listChildren / sessions 服务、
// fake assembled（bindings / liveChildren / native driver）—— 无真实 CLI、
// 无密钥。折叠函数注入真实 lib/progress.js 实现（与 apply 层接线一致）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { registerSubagentWait } from '../lib/tools/subagent-wait.js'
import { registerSubagentProgress } from '../lib/tools/subagent-progress.js'
import { registerSubagentRoles } from '../lib/tools/subagent-roles.js'
import { registerSubagentAgents } from '../lib/tools/subagent-agents.js'
import { foldProgress, foldTrace, foldTokenUsage } from '../lib/progress.js'
import { createRoleLibrary } from '../lib/roles.js'

/** 与 apply 层一致的折叠函数接线（真实实现，非 fake）。 */
const realFolds = { foldProgress, foldTrace, foldTokenUsage }

/**
 * E3 门禁：dsh-tools 对每个工具返回值做 snapshotJsonValue 快照 —— 返回
 * undefined 即生产路径的 "value is not lossless JSON"（undefined 值键、
 * Date/Map、稀疏数组、循环引用等形状整体拒绝）。观测族工具出口必须过
 * 这道与生产完全相同的闸（全套定向用例见 test/json-safe.test.js）。
 */
function assertLosslessJsonValue(value) {
  assert.notEqual(
    snapshotJsonValue(value),
    undefined,
    'tool output must survive dsh-tools\' lossless-JSON snapshot (E3: value is not lossless JSON)',
  )
}

const exec = { agent: { session: { id: 'parent-1', header: { cwd: '/tmp' } } }, signal: undefined }

// ---- fixtures ----

/**
 * product_wait 随迁用例的 fake ctx（PS wait.test.js 原样）：可控 subagent/end
 * 发射器 + 可控 listChildren。sessions 服务恒返回「查无此会话」→ fold → null。
 */
function waitCtx({ children = [], listDelayMs = 0 } = {}) {
  const tools = new Map()
  const listeners = new Map()
  return {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    on: (name, fn) => {
      const list = listeners.get(name) || []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn))
      }
    },
    get: () => ({ get: () => undefined }), // sessions service: fold → null
    emit: (name, info) => {
      for (const fn of listeners.get(name) || []) fn(info)
    },
    listenerCount: (name) => (listeners.get(name) || []).length,
    subagents: {
      listChildren: async () => {
        if (listDelayMs) await new Promise((resolve) => setTimeout(resolve, listDelayMs))
        return children
      },
    },
    tool: (name) => tools.get(name),
  }
}

/**
 * progress / agents 共用的 fake ctx：工具注册捕获 + sessions 服务（可注入
 * 会话库）+ 可控 listChildren（可注入失败 / 延迟）。
 */
function observCtx({ children = [], listDelayMs = 0, listError, sessions } = {}) {
  const tools = new Map()
  const listeners = new Map()
  const sessionsSvc = sessions ? { get: (id) => sessions[id] } : undefined
  return {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    on: (name, fn) => {
      const list = listeners.get(name) || []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn))
      }
    },
    emit: (name, info) => {
      for (const fn of listeners.get(name) || []) fn(info)
    },
    listenerCount: (name) => (listeners.get(name) || []).length,
    get: (name) => (name === 'sessions' ? sessionsSvc : undefined),
    subagents: {
      listChildren: async () => {
        if (listDelayMs) await new Promise((resolve) => setTimeout(resolve, listDelayMs))
        if (listError) throw listError
        return children
      },
    },
    tool: (name) => tools.get(name),
  }
}

/** fake assembled（progress 用）：native driver 的 progress 可注入 + 调用记录（[childId, parentSessionId]）。 */
function progressAssembled({ snapshots = {}, bindings = new Map(), progressCalls } = {}) {
  const spawn = {
    id: 'native:spawn',
    kind: 'native',
    async progress(childId, parentSessionId) {
      if (progressCalls) progressCalls.push([childId, parentSessionId])
      return snapshots[childId] || { childId, status: 'unknown' }
    },
  }
  return {
    native: { spawn, fork: spawn },
    bridges: new Map(),
    availability: {},
    state: { bindings, registry: new Map(), liveChildren: new Set() },
  }
}

/** fake assembled（agents 用）：bridge availability + native available() 可注入。 */
function agentsAssembled({
  availability = {},
  nativeAvailability = {},
  bindings = new Map(),
  liveChildren = new Set(),
} = {}) {
  const mk = (kind) => ({
    id: `native:${kind}`,
    kind: 'native',
    available: () => nativeAvailability[kind]
      || { registered: true, reason: `native subagent provider "${kind}" is registered` },
  })
  return {
    native: { spawn: mk('spawn'), fork: mk('fork') },
    bridges: new Map(),
    availability,
    state: { bindings, registry: new Map(), liveChildren },
  }
}

/** 可折叠的子会话事件序列（真实 foldProgress/foldTrace/foldTokenUsage 的输入）。 */
const T0 = 1700000000000
const iso = (ms) => new Date(ms).toISOString()
function foldableSession() {
  return { events: [
    { seq: 1, type: 'turn/start', timestamp: T0, payload: { turn: 1 } },
    { seq: 2, type: 'step/start', timestamp: T0 + 1000, payload: { turn: 1, step: 1 } },
    { seq: 3, type: 'tool/call', timestamp: T0 + 2000, payload: { name: 'subagent_submit', args: { task: 'research the repo' } } },
    { seq: 4, type: 'assistant/message', timestamp: T0 + 3000, payload: { message: { content: [{ type: 'text', text: 'PARTIAL ANSWER' }], usage: { input_tokens: 10, output_tokens: 5 } } } },
    { seq: 5, type: 'turn/end', timestamp: T0 + 4000, payload: { turn: 1 } },
  ] }
}
const EXPECTED_TRACE = [
  { at: iso(T0), event: 'turn/start', brief: 'turn 1 start' },
  { at: iso(T0 + 1000), event: 'step/start', brief: 'step 1.1' },
  { at: iso(T0 + 2000), event: 'tool/call', brief: 'subagent_submit: research the repo' },
  { at: iso(T0 + 3000), event: 'assistant/message', brief: 'answer: PARTIAL ANSWER' },
  { at: iso(T0 + 4000), event: 'turn/end', brief: 'turn 1 end' },
]
const EXPECTED_USAGE = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0 }

// ---- subagent_wait：竞态用例组（PS wait.test.js 逐行随迁，仅改名） ----

const waitDeps = { foldProgress: () => null, foldTrace: () => [] }

test('wait: already-settled child returns ready immediately', async () => {
  const ctx = waitCtx({ children: [{ id: 'c1', activity: 'inactive' }] })
  registerSubagentWait(ctx, waitDeps)
  const out = await ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 1000 }, exec)
  assert.equal(out.status, 'ready')
  assert.equal(ctx.listenerCount('subagent/end'), 0, 'listener removed')
})

test('wait: live child settling DURING the listing is still observed (subscribe-first)', async () => {
  const ctx = waitCtx({ children: [{ id: 'c1', activity: 'active' }], listDelayMs: 20 })
  registerSubagentWait(ctx, waitDeps)
  const pending = ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 5000 }, exec)
  setTimeout(() => ctx.emit('subagent/end', { id: 'c1', stopReason: 'completed' }), 10)
  const out = await pending
  assert.equal(out.status, 'completed')
  assert.equal(out.stopReason, 'completed')
  assert.equal(ctx.listenerCount('subagent/end'), 0, 'listener removed')
})

test('wait: live child settling AFTER the listing is awaited', async () => {
  const ctx = waitCtx({ children: [{ id: 'c1', activity: 'active' }] })
  registerSubagentWait(ctx, waitDeps)
  const pending = ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 5000 }, exec)
  setTimeout(() => ctx.emit('subagent/end', { id: 'c1', stopReason: 'error' }), 30)
  const out = await pending
  assert.equal(out.status, 'completed')
  assert.equal(out.stopReason, 'error')
})

test('wait: timeout elapses when the child never settles', async () => {
  const ctx = waitCtx({ children: [{ id: 'c1', activity: 'active' }] })
  registerSubagentWait(ctx, waitDeps)
  const out = await ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 1000 }, exec)
  assert.equal(out.status, 'timeout')
  assert.equal(ctx.listenerCount('subagent/end'), 0, 'listener removed on timeout')
})

test('wait: unknown child reports unknown; unrelated end events ignored', async () => {
  const ctx = waitCtx({ children: [] })
  registerSubagentWait(ctx, waitDeps)
  ctx.emit('subagent/end', { id: 'someone-else', stopReason: 'completed' })
  const out = await ctx.tool('subagent_wait').execute({ subagent_id: 'nope', timeout_ms: 1000 }, exec)
  assert.equal(out.status, 'unknown')
  assert.equal(ctx.listenerCount('subagent/end'), 0)
})

test('wait: concurrent waiters on the same child all resolve once', async () => {
  const ctx = waitCtx({ children: [{ id: 'c1', activity: 'active' }] })
  registerSubagentWait(ctx, waitDeps)
  const waiters = [
    ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 5000 }, exec),
    ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 5000 }, exec),
  ]
  await new Promise((resolve) => setTimeout(resolve, 10))
  ctx.emit('subagent/end', { id: 'c1', stopReason: 'completed' })
  const outs = await Promise.all(waiters)
  assert.deepEqual(outs.map((o) => o.status), ['completed', 'completed'])
  assert.equal(ctx.listenerCount('subagent/end'), 0)
})

// ---- subagent_progress ----

test('progress: bridge binding path — PS shape (pinned product, remote id, inFlight, settings, fold)', async () => {
  const bindings = new Map()
  bindings.set('c-bridge', {
    product: 'codex',
    remote: {
      threadId: 'thread-9',
      progress: { busySince: T0 + 2500, stage: 'submitting', receivedChars: 42 },
    },
    settings: { model: 'gpt-5-codex' },
  })
  const progressCalls = []
  const assembled = progressAssembled({ bindings, progressCalls })
  const ctx = observCtx({
    children: [{ id: 'c-bridge', activity: 'running', mode: 'continuable', label: 'codex research', hasChildren: false }],
    sessions: { 'c-bridge': foldableSession() },
  })
  registerSubagentProgress(ctx, { assembled, ...realFolds })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-bridge' }, exec)
  assert.deepEqual(out, {
    childId: 'c-bridge',
    status: 'running',
    mode: 'continuable',
    label: 'codex research',
    pinnedProduct: 'codex',
    remoteSessionId: 'thread-9',
    model: 'gpt-5-codex',
    reasoningEffort: 'inherit (product default)',
    turn: 1,
    stepCount: 1,
    lastTask: 'research the repo',
    lastAnswer: 'PARTIAL ANSWER',
    lastActivityAt: iso(T0 + 4000),
    tokenUsage: EXPECTED_USAGE,
    trace: EXPECTED_TRACE,
    inFlight: { busySince: iso(T0 + 2500), stage: 'submitting', receivedChars: 42 },
  })
  assert.equal(progressCalls.length, 0, 'bridge path never consults the native driver')
})

test('progress: native path — driver snapshot + pure session fold; bridge fields omitted; listing label wins', async () => {
  const assembled = progressAssembled({
    snapshots: { 'c-native': { childId: 'c-native', status: 'running', label: 'driver label' } },
  })
  const ctx = observCtx({
    children: [{ id: 'c-native', activity: 'running', mode: 'continuable', label: 'scout the repo', hasChildren: false }],
    sessions: { 'c-native': foldableSession() },
  })
  registerSubagentProgress(ctx, { assembled, ...realFolds })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-native' }, exec)
  assert.deepEqual(out, {
    childId: 'c-native',
    status: 'running',
    mode: 'continuable',
    label: 'scout the repo',
    turn: 1,
    stepCount: 1,
    lastTask: 'research the repo',
    lastAnswer: 'PARTIAL ANSWER',
    lastActivityAt: iso(T0 + 4000),
    tokenUsage: EXPECTED_USAGE,
    trace: EXPECTED_TRACE,
  })
  assert.equal(out.pinnedProduct, undefined, 'no pinnedProduct key value for native children')
})

test('progress: native path — driver snapshot is the fallback when the listing fails', async () => {
  const assembled = progressAssembled({
    snapshots: { 'c-native': { childId: 'c-native', status: 'inactive', label: 'forked helper' } },
  })
  const ctx = observCtx({ listError: new Error('listing unavailable') })
  registerSubagentProgress(ctx, { assembled, ...realFolds })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-native' }, exec)
  // E3 contract: unset optional fields are OMITTED (undefined-valued keys are
  // rejected by dsh-tools' lossless-JSON snapshot — see test/json-safe.test.js).
  assert.deepEqual(out, {
    childId: 'c-native',
    status: 'inactive',
    label: 'forked helper',
    stepCount: 0,
  })
  assertLosslessJsonValue(out)
})

test('progress: native path passes the parent session id down to the driver (T08 fix)', async () => {
  const progressCalls = []
  const assembled = progressAssembled({
    progressCalls,
    snapshots: { 'c-native': { childId: 'c-native', status: 'running' } },
  })
  const ctx = observCtx({ children: [] })
  registerSubagentProgress(ctx, { assembled, ...realFolds })
  await ctx.tool('subagent_progress').execute({ subagent_id: 'c-native' }, exec)
  // exec.agent.session.id ('parent-1' in the shared exec fixture) must reach
  // driver.progress as the parent-scoping argument.
  assert.deepEqual(progressCalls, [['c-native', 'parent-1']])
})

test('progress: native path — session evidence maps an unlisted child to running (PS semantics)', async () => {
  const assembled = progressAssembled({ snapshots: {} }) // driver: unknown
  const ctx = observCtx({
    children: [], // listing misses the child
    sessions: { 'c-native': foldableSession() },
  })
  registerSubagentProgress(ctx, { assembled, ...realFolds })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-native' }, exec)
  assert.equal(out.status, 'running')
  assert.equal(out.stepCount, 1)
  assert.equal(out.trace.length, 5)
})

test('progress: no binding, no driver knowledge, no session → unknown', async () => {
  const assembled = progressAssembled({ snapshots: {} })
  const ctx = observCtx({ children: [] })
  registerSubagentProgress(ctx, { assembled, ...realFolds })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'ghost' }, exec)
  // E3 contract: unset optional fields are OMITTED (undefined-valued keys are
  // rejected by dsh-tools' lossless-JSON snapshot — see test/json-safe.test.js).
  assert.deepEqual(out, {
    childId: 'ghost',
    status: 'unknown',
    stepCount: 0,
  })
  assertLosslessJsonValue(out)
})

test('progress: registration guards — native.spawn and state.bindings are required', () => {
  const ctx = observCtx()
  assert.throws(
    () => registerSubagentProgress(ctx, { assembled: { native: {}, state: { bindings: new Map() } }, ...realFolds }),
    /native\.spawn/,
  )
  assert.throws(
    () => registerSubagentProgress(ctx, { assembled: { native: { spawn: {} }, state: {} }, ...realFolds }),
    /state\.bindings/,
  )
})

// ---- subagent_roles ----

test('roles: backend column renders caller-chooses / native / pinned provider', async () => {
  const ctx = observCtx()
  registerSubagentRoles(ctx, {
    roles: {
      list: () => [
        { id: 'general', description: 'General purpose', backend: '', permissionMode: 'full', allowDelegation: true },
        { id: 'explore', description: 'Read-only scout', backend: 'native', permissionMode: 'default', allowDelegation: false },
        { id: 'codex-full', description: 'Full-permission codex', backend: 'codex', permissionMode: 'full', allowDelegation: true },
      ],
    },
  })
  const tool = ctx.tool('subagent_roles')
  assert.equal(tool.name, 'subagent_roles')
  const out = await tool.execute({}, exec)
  assert.deepEqual(out, {
    roles: [
      { id: 'general', description: 'General purpose', backend: '(caller chooses)', permissionMode: 'full', allowDelegation: true },
      { id: 'explore', description: 'Read-only scout', backend: 'native', permissionMode: 'default', allowDelegation: false },
      { id: 'codex-full', description: 'Full-permission codex', backend: 'codex', permissionMode: 'full', allowDelegation: true },
    ],
  })
})

test('roles: real role library fallback (missing roles dir) renders general with caller-chooses backend', async () => {
  const ctx = observCtx()
  registerSubagentRoles(ctx, { roles: createRoleLibrary(join(tmpdir(), 'no-such-roles-dir')) })
  const out = await ctx.tool('subagent_roles').execute({}, exec)
  assert.equal(out.roles.length, 1)
  assert.equal(out.roles[0].id, 'general')
  assert.equal(out.roles[0].backend, '(caller chooses)')
  assert.equal(out.roles[0].permissionMode, 'full')
  assert.equal(out.roles[0].allowDelegation, true)
})

// ---- subagent_agents ----

const AGENTS_AVAILABILITY = {
  codex: { registered: true, command: true, reason: 'available', auth: { ok: true, note: 'auth.json present (validity verified at call time)' } },
  'claude-code': { registered: false, command: false, reason: 'command "claude" not found on PATH', auth: { ok: false, note: 'no Claude login artifacts found' } },
  grok: { registered: true, command: true, reason: 'available', auth: { ok: true, note: 'no auth required' } },
}

test('agents: bridge availability three states + native spawn/fork view + live children overview', async () => {
  const bindings = new Map()
  bindings.set('c-bridge', { product: 'codex', settings: { model: 'gpt-5-codex' } })
  const assembled = agentsAssembled({
    availability: AGENTS_AVAILABILITY,
    nativeAvailability: {
      fork: { registered: false, reason: 'native subagent provider "fork" is not registered yet (resolves when the provider appears)' },
    },
    bindings,
    liveChildren: new Set(['c-bridge']),
  })
  const ctx = observCtx({
    children: [
      { id: 'c-bridge', activity: 'running', mode: 'continuable', label: 'codex research', hasChildren: false },
      { id: 'c-native', activity: 'inactive', mode: 'continuable', label: 'scout the repo', hasChildren: false },
    ],
  })
  registerSubagentAgents(ctx, { assembled })
  const tool = ctx.tool('subagent_agents')
  assert.equal(tool.name, 'subagent_agents')
  const out = await tool.execute({}, exec)
  assert.deepEqual(out, {
    availability: {
      codex: { registered: true, commandPresent: true, auth: 'auth.json present (validity verified at call time)', note: 'available' },
      'claude-code': { registered: false, commandPresent: false, auth: 'no Claude login artifacts found', note: 'command "claude" not found on PATH' },
      grok: { registered: true, commandPresent: true, auth: 'no auth required', note: 'available' },
    },
    native: {
      spawn: { backend: 'native:spawn', registered: true, note: 'native subagent provider "spawn" is registered' },
      fork: { backend: 'native:fork', registered: false, note: 'native subagent provider "fork" is not registered yet (resolves when the provider appears)' },
    },
    children: [
      { id: 'c-bridge', backend: 'codex', activity: 'running', mode: 'continuable', label: 'codex research', pinned: true, busy: true, model: 'gpt-5-codex' },
      { id: 'c-native', backend: 'native', activity: 'inactive', mode: 'continuable', label: 'scout the repo', pinned: false, busy: false, model: 'inherit' },
    ],
  })
})

test('agents: children listing failure degrades to empty children; availability still reported', async () => {
  const assembled = agentsAssembled({ availability: AGENTS_AVAILABILITY })
  const ctx = observCtx({ listError: new Error('listing unavailable') })
  registerSubagentAgents(ctx, { assembled })
  const out = await ctx.tool('subagent_agents').execute({}, exec)
  assert.deepEqual(out.children, [])
  assert.equal(out.availability.codex.registered, true)
  assert.equal(out.availability['claude-code'].registered, false)
  assert.equal(out.native.spawn.registered, true)
})

test('agents: registration guards — availability, both native drivers, and state.bindings are required', () => {
  const ctx = observCtx()
  assert.throws(
    () => registerSubagentAgents(ctx, { assembled: { native: { spawn: {}, fork: {} }, state: { bindings: new Map() } } }),
    /availability/,
  )
  assert.throws(
    () => registerSubagentAgents(ctx, { assembled: { availability: {}, native: { spawn: {} }, state: { bindings: new Map() } } }),
    /spawn and fork/,
  )
  assert.throws(
    () => registerSubagentAgents(ctx, { assembled: { availability: {}, native: { spawn: {}, fork: {} }, state: {} } }),
    /state\.bindings/,
  )
})
