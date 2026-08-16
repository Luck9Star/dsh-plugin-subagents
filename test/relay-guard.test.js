// dsh-plugin-subagents — D2b relay 回合闭环确定性校验测试。
//
// 复现缺陷（2026-08-15 真机 D2b）：relay 子代理零 subagent_submit 自答后
// report，父代理静默拿到 relay 自答。本文件钉死修复行为：
//   1. 主链复现 —— 真 createBridgeState + fakeBridge fixture：epoch 开始
//      （subagent/start）→ report guard 拒（含 subagent_submit 指引）→
//      经注册好的 subagent_submit execute 转发一次 → guard 放行；
//   2. submit 失败仍计数（failSubmit → execute reject → guard 仍放行 ——
//      report 错误是合法闭环）；
//   3. send_message 新 epoch：subagent/start 重置计数 → 再拒；
//   4. 冷恢复：删 binding 留 registry 条目 → guard 仍识别 relay（并集判定）
//      且计数 0 → 拒；submit 后放行；
//   5. 非 relay（id 不在 bindings/registry）与 exec.name !== 'report' → no-op；
//   6. contribution 装配：fake registerContinuableSetup 捕获 contribution →
//      fake childCtx { tools: { guard } } 调用 → guard 装入；
//      seam 缺失（registerContinuableSetup 非函数）→ warn 后继续不炸。
//
// 全部 fake：无真实 CLI、无密钥、无网络（红线：套件必须在裸 runner 上绿）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRegistry } from '../lib/registry.js'
import { createBridgeState, attachBridgeLifecycle } from '../lib/drivers/bridge.js'
import { registerSubagentSubmit } from '../lib/tools/subagent-submit.js'
import {
  RELAY_GUARD_REASON,
  buildRelayReportGuard,
  attachRelayGuard,
} from '../lib/relay-guard.js'

// ---- fixtures（与 bridge-driver.test.js 同款 fakeBridge，另加 failSubmit 延迟开关）----

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

function tmpRegistry(t) {
  const path = join(tmpdir(), `relay-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  t.after(() => { rmSync(path, { force: true }); rmSync(`${path}.tmp`, { force: true }) })
  return createRegistry(path)
}

/** Minimal Cordis-like ctx: event listeners + effects + logger + subagents seam. */
function fakeCtx({ startContinuable } = {}) {
  const listeners = new Map()
  const effects = []
  const logs = { warn: [] }
  return {
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    effect: (fn) => { effects.push(fn()) },
    get: () => undefined,
    dispatch: (name, info) => { for (const fn of listeners.get(name) || []) fn(info) },
    logger: { warn: (m) => logs.warn.push(m) },
    subagents: {
      startContinuable: startContinuable || (async () => { throw new Error('unexpected startContinuable') }),
      listChildren: async () => [],
    },
    __logs: logs,
  }
}

/**
 * 真实接线：createBridgeState 治理内核 + attachBridgeLifecycle 事件面 +
 * 注册好的 subagent_submit 工具。child 'c-1' 带 prepareContinuable 形状的
 * binding + registry 条目（等价 createBridgeProviders 写入的记录）。
 */
const reportExecFor = (childId) => ({ name: 'report', agent: { session: { id: childId } } })
const execFor = (sessionId, cwd = '/tmp') => ({ agent: { session: { id: sessionId, header: { cwd } } }, signal: undefined })

function world(t, { bridge = fakeBridge() } = {}) {
  const registry = tmpRegistry(t)
  const state = createBridgeState({ registry })
  const tools = new Map()
  const ctx = fakeCtx()
  attachBridgeLifecycle(ctx, state)
  const assembled = { state, providerBridges: { fake: bridge } }
  registerSubagentSubmit({ tools: { register: (tool) => tools.set(tool.name, tool) } }, { assembled, config: {} })
  // a prepared bridge child: binding + registry entry (createBridgeProviders.prepareContinuable shape)
  state.bindings.set('c-1', { product: 'fake', bridge, remote: { sessionId: 's-1' }, settings: undefined })
  state.persistRemote('c-1', { product: 'fake', remote: { sessionId: 's-1' } }, '/tmp')
  return { bridge, registry, state, assembled, ctx, tools }
}

// ── 1. D2b 复现主链 ───────────────────────────────────────────────────────────

test('main chain: report before any subagent_submit in the epoch is denied; one submit unblocks it', async (t) => {
  const { bridge, state, ctx, tools } = world(t)
  // epoch begins (the harness fires subagent/start per residency epoch)
  ctx.dispatch('subagent/start', { id: 'c-1' })
  assert.equal(state.relayEpochs.get('c-1').submits, 0, 'epoch start resets the counter')

  const guard = buildRelayReportGuard(state)
  const denial = guard(reportExecFor('c-1'))
  assert.ok(denial, 'a zero-submit report is denied')
  assert.match(denial, /subagent_submit/, 'the denial names the pipe tool')
  assert.match(denial, /relay/, 'the denial explains the relay role')

  // the relay then forwards via the REGISTERED subagent_submit tool execute…
  const out = await tools.get('subagent_submit').execute({ task: 'Which product are you?' }, execFor('c-1'))
  assert.match(out.text, /echo:Which product are you\?/)
  assert.equal(bridge.calls.filter((c) => c.op === 'submit').length, 1)

  // …and the same guard now passes the report through
  assert.equal(guard(reportExecFor('c-1')), undefined, 'after one submit the report is allowed')
})

// ── 2. submit 失败仍计数 ─────────────────────────────────────────────────────

test('a FAILED submit still counts: reporting the error afterwards is a legal closure', async (t) => {
  const bridge = fakeBridge({ failSubmit: true })
  const { state, ctx, tools } = world(t, { bridge })
  ctx.dispatch('subagent/start', { id: 'c-1' })
  const guard = buildRelayReportGuard(state)

  await assert.rejects(
    tools.get('subagent_submit').execute({ task: 'boom' }, execFor('c-1')),
    /submit boom/,
  )
  assert.equal(guard(reportExecFor('c-1')), undefined, 'the guard passes: the relay did try to forward')
})

// ── 3. send_message 新 epoch ─────────────────────────────────────────────────

test('a new epoch (send_message wake) resets the counter and denies again', async (t) => {
  const { state, ctx, tools } = world(t)
  ctx.dispatch('subagent/start', { id: 'c-1' })
  await tools.get('subagent_submit').execute({ task: 'first' }, execFor('c-1'))
  const guard = buildRelayReportGuard(state)
  assert.equal(guard(reportExecFor('c-1')), undefined)

  ctx.dispatch('subagent/end', { id: 'c-1' })
  ctx.dispatch('subagent/start', { id: 'c-1' }) // the wake for a later turn
  assert.equal(state.relayEpochs.get('c-1').submits, 0, 'counter reset on the new epoch')
  assert.match(guard(reportExecFor('c-1')), /subagent_submit/, 'denied again until the new epoch forwards')
})

// ── 4. 冷恢复：binding 失 + registry 在 ──────────────────────────────────────

test('cold resume: a registry-only child (binding lost) is still recognized and starts at zero', async (t) => {
  const { state, ctx, tools, registry } = world(t)
  // idle disposal dropped the binding; the durable registry entry survives
  state.bindings.delete('c-1')
  assert.ok(registry.get('c-1'), 'registry entry present')

  const guard = buildRelayReportGuard(state)
  assert.match(guard(reportExecFor('c-1')), /subagent_submit/, 'registry-only child is still a relay')

  // the submit tool recovers from the registry (fresh create: no remoteId)…
  const out = await tools.get('subagent_submit').execute({ task: 'resume work' }, execFor('c-1'))
  assert.match(out.text, /echo:resume work/)
  assert.equal(guard(reportExecFor('c-1')), undefined)
})

test('cold resume across two epochs: a zero-submit second epoch is denied and warned (review MAJOR-1)', async (t) => {
  const { state, ctx, tools } = world(t)
  const guard = buildRelayReportGuard(state)

  // epoch 1 forwards once, then the binding is lost to idle disposal
  ctx.dispatch('subagent/start', { id: 'c-1' })
  await tools.get('subagent_submit').execute({ task: 'first' }, execFor('c-1'))
  ctx.dispatch('subagent/end', { id: 'c-1' })
  state.bindings.delete('c-1')

  // epoch 2 (cold resume, registry-only) with ZERO submits: the report must
  // be denied — a binding-only epoch reset would leave submits at 1 and let
  // the self-answer through (review MAJOR-1 regression).
  ctx.dispatch('subagent/start', { id: 'c-1' })
  assert.equal(state.relayEpochs.get('c-1').submits, 0, 'epoch 2 resets to zero via the union')
  assert.equal(guard(reportExecFor('c-1')), RELAY_GUARD_REASON, 'zero-forward epoch 2 report is denied')

  const warnsBefore = ctx.__logs.warn.length
  ctx.dispatch('subagent/end', { id: 'c-1' })
  assert.equal(ctx.__logs.warn.length, warnsBefore + 1, 'end warns on the zero-submit cold-resumed epoch')
  assert.match(ctx.__logs.warn[warnsBefore], /zero subagent_submit/)
  assert.equal(state.lastRelayEpochNoForward('c-1'), true)
})

// ── 5. 非 relay / 非 report → no-op ──────────────────────────────────────────

test('non-relay sessions and non-report tools pass untouched', async (t) => {
  const { state } = world(t)
  const guard = buildRelayReportGuard(state)
  assert.equal(guard(reportExecFor('native-child-77')), undefined, 'a native child (no binding/registry entry) passes')
  assert.equal(guard({ name: 'subagent_submit', agent: { session: { id: 'c-1' } } }), undefined, 'non-report tools are never guarded')
  assert.equal(guard({ name: 'report', agent: undefined }), undefined, 'a report without a resolvable session id passes')
  assert.equal(guard(undefined), undefined, 'defensive: undefined exec passes')
})

// ── 6. contribution 装配 ─────────────────────────────────────────────────────

test('attachRelayGuard installs the guard into every continuable child scope; the returned disposer unregisters it', async (t) => {
  const { state, assembled } = world(t)
  const contributions = []
  const ctx = fakeCtx()
  ctx.subagents.registerContinuableSetup = (contribution) => {
    contributions.push(contribution)
    return () => { contributions.pop() }
  }
  const attached = attachRelayGuard(ctx, assembled)
  assert.equal(attached, true)
  assert.equal(contributions.length, 1, 'one contribution registered')

  // the continuation manager installs each contribution into a child scope
  // whose tools.guard registers the fn and hands back its OWN unregistration
  // disposer (the official dsh-tools contract — host-realistic shape):
  const registered = new Set()
  const childCtx = {
    tools: {
      guard: (fn) => {
        registered.add(fn)
        return () => { registered.delete(fn) }
      },
    },
  }
  const dispose = contributions[0](childCtx)
  assert.equal(registered.size, 1, 'guard installed into the child tool scope')

  // SEAM CONTRACT (review BLOCKER-1): ContinuableSetupContribution must return
  // a disposer — the host's SubagentActivationSetupRegistry.release() calls
  // installation.dispose() UNCONDITIONALLY at child-scope teardown, so an
  // undefined return would throw "installation.dispose is not a function".
  assert.equal(typeof dispose, 'function', 'the installer returns a disposer function')
  const [fn] = [...registered]
  ctx.dispatch('subagent/start', { id: 'c-1' })
  assert.equal(fn(reportExecFor('c-1')), RELAY_GUARD_REASON, 'guard intercepts before disposal')

  // calling the disposer unregisters the guard — no fn remains registered
  dispose()
  assert.equal(registered.size, 0, 'after disposal the guard is unregistered (no interception left)')
  void state

  // a state without the D2b kernel is skipped loudly, never fatal
  const logs = fakeCtx()
  const attachedLegacy = attachRelayGuard(logs, { state: {} })
  assert.equal(attachedLegacy, false)
  assert.equal(logs.__logs.warn.length, 1)
  assert.match(logs.__logs.warn[0], /epoch kernel/)
})

test('contribution honors the host SetupRegistry shape: guard() returns its own disposer, forwarded verbatim (BLOCKER-1)', async (t) => {
  const { assembled } = world(t)
  const contributions = []
  const ctx = fakeCtx()
  ctx.subagents.registerContinuableSetup = (contribution) => {
    contributions.push(contribution)
    return () => {}
  }
  attachRelayGuard(ctx, assembled)

  // a host-realistic tools.guard: registers the fn AND hands back the exact
  // disposer that unregisters it (the official dsh-tools contract)
  const registered = new Set()
  const guardDisposers = []
  const childCtx = {
    tools: {
      guard: (fn) => {
        registered.add(fn)
        const disposer = () => { registered.delete(fn) }
        guardDisposers.push(disposer)
        return disposer
      },
    },
  }
  const installerReturn = contributions[0](childCtx)
  assert.equal(registered.size, 1)
  // the installer must forward tools.guard()'s OWN disposer when the host
  // honors its contract (not a no-op):
  assert.equal(installerReturn, guardDisposers[0], 'a contract-honoring guard() disposer is forwarded as-is')

  // a host whose guard() VIOLATES its contract and returns undefined must not
  // reintroduce the release() crash — the contribution degrades to a no-op
  // disposer (advisor nit: same defensive posture as the missing-seam branch)
  const sloppyReturn = contributions[0]({ tools: { guard: () => undefined } })
  assert.equal(typeof sloppyReturn, 'function', 'a contract-violating guard() still yields a callable disposer')
  assert.doesNotThrow(() => sloppyReturn())

  // …and a child scope without a usable tools.guard still yields a callable
  // disposer (defensive branch: release() calls it unconditionally)
  const bareReturn = contributions[0]({ tools: {} })
  assert.equal(typeof bareReturn, 'function', 'defensive branch returns a no-op disposer')
  assert.doesNotThrow(() => bareReturn(), 'the no-op disposer is callable')
})

test('attachRelayGuard warns and continues when the host lacks the seam', async (t) => {
  const { assembled } = world(t)
  const ctx = fakeCtx() // ctx.subagents has no registerContinuableSetup
  const attached = attachRelayGuard(ctx, assembled)
  assert.equal(attached, false, 'not attached')
  assert.equal(ctx.__logs.warn.length, 1)
  assert.match(ctx.__logs.warn[0], /registerContinuableSetup/)
})

// ── 附：end 钩子的零-submit 告警与标记（软防线数据源）───────────────────────

test('subagent/end warns and flags a zero-submit relay epoch; a forwarding epoch clears the flag', async (t) => {
  const { state, ctx, tools } = world(t)
  ctx.dispatch('subagent/start', { id: 'c-1' })
  ctx.dispatch('subagent/end', { id: 'c-1' })
  assert.match(ctx.__logs.warn[0], /zero subagent_submit/)
  assert.equal(state.lastRelayEpochNoForward('c-1'), true, 'flag set for the parent\'s wait/progress copy')

  // forwarding epoch: no warning, flag cleared
  ctx.dispatch('subagent/start', { id: 'c-1' })
  await tools.get('subagent_submit').execute({ task: 'x' }, execFor('c-1'))
  const warnsBefore = ctx.__logs.warn.length
  ctx.dispatch('subagent/end', { id: 'c-1' })
  assert.equal(ctx.__logs.warn.length, warnsBefore, 'no zero-submit warning for a forwarding epoch')
  assert.equal(state.lastRelayEpochNoForward('c-1'), false)
})

test('subagent/end never warns for non-bridge children (native ids are untouched)', async (t) => {
  const { ctx } = world(t)
  ctx.dispatch('subagent/start', { id: 'native-child' })
  ctx.dispatch('subagent/end', { id: 'native-child' })
  assert.equal(ctx.__logs.warn.length, 0)
})
