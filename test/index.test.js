// dsh-plugin-subagents — lib/index.js apply() 总装测试（T14）。
//
// 覆盖（任务书 + 补充验收「工具名碰撞守卫」）：
//   - 装配与注册顺序：默认 apply 注册七工具（默认名）+ attachAll 的 provider
//     注册（availability 用绝对路径 shim 确定性构造）+ teardown effect；
//   - register 开关（关闭 fork/roles 则不注册）与 toolNames 改名；
//   - teardown 调 state.disposeAll（spy 包裹后触发 ctx.effect 注册的清理函数）；
//   - 两实例并存：(a) presetRow 显式独立 toolName（scout_agent）与全局实例
//     并存 —— 各自注册成功、无 registerProvider 第二次调用、无辅助工具重名；
//     (b) presetRow 默认 toolName（'subagent'）在全局实例已注册 'subagent'
//     后 → loud throw，消息含「撞名」指引（§6.3-L2）；
//   - presetRow 独立部署：只注册单工具、零 provider 注册、无辅助工具、无
//     teardown effect、不触发 registry 迁移；
//   - 迁移（§6.6）：tmp 造旧 registry → 断言新文件条目 backend 字段 =
//     旧 product 值 + .migrated 标记 + 旧文件不动 + 二次 apply 不重复迁移；
//   - legacy 别名：迁移后 product_submit / product_delegate 出现；
//     legacyProductAliases: false 抑制；无旧 registry 时 'auto' 不注册；
//     product_submit 别名走同一恢复管道（fake bridge 断言 marker 行）；
//     product_delegate 别名 execute 委派统一工具（旧参数名 → 新词汇映射，
//     旧输出形状返回）；
//   - dsh-tools 双实例自检：Symbol 命中 → 静默；形似 ToolRuntime 但 Symbol
//     缺席 → logger.fatal + throw；fake ctx → 仅 warn。
//
// 全部 fake：无真实 CLI、无密钥、不触碰真实 ~/.dsh（registryPath 与旧
// registry 路径均注入 tmp）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name as pluginName } from '../lib/index.js'
import { assembleDrivers, attachAll } from '../lib/drivers/index.js'
import { migrateLegacyRegistry } from '../lib/registry.js'
import { registerSubagentSubmit } from '../lib/tools/subagent-submit.js'
import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'

const IS_WIN = process.platform === 'win32'

// ---- fixtures ----

/** Temp dir + cleanup. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'index-apply-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Absolute-path executable shim (deterministic availability, CI-safe). */
function shim(dir, file) {
  const path = join(dir, file)
  writeFileSync(path, IS_WIN ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', IS_WIN ? {} : { mode: 0o755 })
}

/**
 * Fake Cordis-like ctx: tool registry (register/get), subagents seam, event
 * bus, effect recorder, logger recorder. `toolHost` replaces the tools object
 * wholesale (self-check tests).
 */
function fakeCtx({ registered = ['spawn', 'fork'], toolHost } = {}) {
  const tools = new Map()
  const registeredProviders = []
  const listeners = new Map()
  const teardowns = []
  const continuableContributions = []
  const logs = { fatal: [], warn: [] }
  return {
    tools: toolHost ?? {
      register: (tool) => { tools.set(tool.name, tool) },
      get: (toolName) => tools.get(toolName),
    },
    systemPrompt: { section: () => {} },
    subagents: {
      getProvider: (providerName) => (registered.includes(providerName) ? { name: providerName, capabilities: {} } : undefined),
      registerProvider: (provider) => { registeredProviders.push(provider) },
      listChildren: async () => [],
      start: async () => ({
        id: 'run-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'native done' }], stopReason: 'completed' }),
        dispose: async () => {},
      }),
      startContinuable: async () => ({ childId: 'child-1', messageId: 'msg-1' }),
      // D2b relay guard seam: capture each contribution + hand back its undo.
      registerContinuableSetup: (contribution) => {
        continuableContributions.push(contribution)
        return () => {
          const idx = continuableContributions.indexOf(contribution)
          if (idx >= 0) continuableContributions.splice(idx, 1)
        }
      },
    },
    on: (event, fn) => {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
    },
    effect: (fn) => { teardowns.push(fn()) },
    get: () => undefined,
    logger: {
      fatal: (message) => { logs.fatal.push(message) },
      warn: (message) => { logs.warn.push(message) },
    },
    __tools: tools,
    __registered: registeredProviders,
    __teardowns: teardowns,
    __logs: logs,
    __listeners: listeners,
    __continuableContributions: continuableContributions,
  }
}

/**
 * Deterministic bridge config: codex shimmed (detected), claude-code/acp
 * overridden to absent paths. The registry target defaults into tmp too —
 * no test ever touches the real ~/.dsh.
 */
function shimmedConfig(dir, extra = {}) {
  return {
    providers: {
      codex: { type: 'codex', command: join(dir, 'codex-cli') },
      'claude-code': { type: 'claude', command: join(dir, 'claude-cli') },
      acp: { command: join(dir, 'opencode-cli') },
    },
    registryPath: join(dir, 'registry', 'subagents-registry.json'),
    ...extra,
  }
}

/** A legacy-registry path that never exists → the 'auto' alias probe stays off. */
const absentLegacy = (dir) => join(dir, 'absent', 'legacy-registry.json')

const DEFAULT_TOOLS = [
  'subagent', 'subagent_fork', 'subagent_submit', 'subagent_progress',
  'subagent_wait', 'subagent_roles', 'subagent_agents',
]

// ---- 装配与注册 ----

test('apply(): plugin identity exports', () => {
  assert.equal(pluginName, 'dsh-plugin-subagents')
})

test('apply(): default global wiring — seven default-named tools, provider registered, teardown effect armed', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir), { legacyRegistryPath: absentLegacy(dir) })

  assert.deepEqual([...ctx.__tools.keys()].sort(), [...DEFAULT_TOOLS].sort())
  // availability-detected codex (shim) → exactly one provider registration
  assert.deepEqual(ctx.__registered.map((p) => p.name), ['codex'])
  // teardown effect registered by attachAll → attachBridgeLifecycle
  assert.equal(ctx.__teardowns.length, 1)
  // fake tool host cannot be verified → one warn, never fatal
  assert.equal(ctx.__logs.fatal.length, 0)
})

test('apply(): register switches — disabled families are not registered', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir, { register: { fork: false, roles: false, submit: false } }), { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__tools.has('subagent_fork'), false)
  assert.equal(ctx.__tools.has('subagent_roles'), false)
  assert.equal(ctx.__tools.has('subagent_submit'), false)
  for (const toolName of ['subagent', 'subagent_progress', 'subagent_wait', 'subagent_agents']) {
    assert.equal(ctx.__tools.has(toolName), true, `${toolName} stays on`)
  }
})

test('apply(): toolNames rename the delegate/fork tools', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir, { toolNames: { delegate: 'my_delegate', fork: 'my_fork' } }), { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__tools.has('my_delegate'), true)
  assert.equal(ctx.__tools.has('my_fork'), true)
  assert.equal(ctx.__tools.has('subagent'), false)
  assert.equal(ctx.__tools.has('subagent_fork'), false)
})

test('apply(): teardown effect calls state.disposeAll', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  // apply must resolve to undefined (loader contract), so inspect the assembled
  // state directly through the internal assembly seam.
  const assembled = await assembleDrivers({ ctx, config: shimmedConfig(dir) })
  attachAll(ctx, assembled) // registers the ctx.effect teardown that closes over state.disposeAll
  const original = assembled.state.disposeAll
  let calls = 0
  assembled.state.disposeAll = () => { calls += 1; original() }
  for (const teardown of ctx.__teardowns) teardown()
  assert.equal(calls, 1)
})

// ---- 两实例并存（presetRow × 全局） ----

test('coexistence: presetRow with a distinct toolName registers cleanly beside the global instance', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir), { legacyRegistryPath: absentLegacy(dir) })
  const providerRegistrations = ctx.__registered.length
  const toolCount = ctx.__tools.size

  await apply(ctx, { presetRow: true, provider: 'spawn', toolName: 'scout_agent', persona: '@preset:scout', maxDepth: 1 })

  assert.equal(ctx.__tools.has('scout_agent'), true)
  assert.equal(ctx.__registered.length, providerRegistrations, 'no second registerProvider wave from a presetRow instance')
  assert.equal(ctx.__tools.size, toolCount + 1, 'exactly one new tool: no auxiliary re-registration, no aliases')
  assert.equal(ctx.__tools.has('product_submit'), false)
})

test('coexistence: presetRow default toolName colliding with the global delegate → loud guidance', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir), { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__tools.has('subagent'), true)

  await assert.rejects(
    () => apply(ctx, { presetRow: true, provider: 'spawn' }),
    (error) => {
      assert.match(error.message, /撞名/)
      assert.match(error.message, /subagent/)
      assert.match(error.message, /plan_agent|§6\.3-L2/)
      return true
    },
  )
})

test('presetRow standalone: exactly one tool, zero providers, no auxiliaries, no teardown, no migration', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const ctx = fakeCtx()
  // A legacy registry exists — proving the presetRow branch never migrates.
  const legacyPath = legacyRegistry(dir)

  await apply(ctx, { presetRow: true, provider: 'spawn' }, { legacyRegistryPath: legacyPath })

  assert.deepEqual([...ctx.__tools.keys()], ['subagent'])
  assert.equal(ctx.__registered.length, 0)
  assert.equal(ctx.__teardowns.length, 0, 'presetRow holds no bridge state → no teardown')
  assert.equal(existsSync(join(dir, 'product-subagents-registry.migrated')), false, 'no migration marker')
  assert.equal(existsSync(legacyPath), true, 'legacy file untouched')
})

// ---- relay 回合闭环 guard 挂载（D2b） ----

test('relay guard: default global wiring registers exactly one registerContinuableSetup contribution', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir), { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__continuableContributions.length, 1, 'D2b guard contribution attached by default')
  // the contribution installs a guard into a child scope (behavioral probe)
  const installed = []
  ctx.__continuableContributions[0]({ tools: { guard: (fn) => installed.push(fn) } })
  assert.equal(installed.length, 1)
  assert.equal(typeof installed[0], 'function')
})

test('relay guard: relayReportGuard:false skips the contribution entirely', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir, { relayReportGuard: false }), { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__continuableContributions.length, 0, 'switched off → no contribution')
  // the tool surface is unchanged — only the guard layer is skipped
  assert.deepEqual([...ctx.__tools.keys()].sort(), [...DEFAULT_TOOLS].sort())
})

test('relay guard: the presetRow branch never registers a contribution (stateless)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, { presetRow: true, provider: 'spawn', toolName: 'scout_agent' }, { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__continuableContributions.length, 0, 'presetRow instances hold no bridge state → no guard')
})

// ---- registry 迁移与 legacy 别名（§6.6） ----

function legacyRegistry(dir) {
  const legacyPath = join(dir, 'product-subagents-registry.json')
  writeFileSync(legacyPath, JSON.stringify({
    'sess-1': { product: 'codex', remoteId: 'thread-1', cwd: '/work', settings: { permissionMode: 'full' }, updatedAt: 1700000000000 },
    'sess-2': { product: 'claude-code', remoteId: 'sess-2-remote', cwd: '/work2', settings: { permissionMode: 'readonly', model: 'opus' }, updatedAt: 1700000000001 },
  }))
  return legacyPath
}

test('migration: imports legacy entries (product → backend), writes the marker, leaves the legacy file untouched', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)
  const legacyBefore = readFileSync(legacyPath, 'utf8')
  const registryPath = join(dir, 'subagents-registry.json')
  const markerPath = join(dir, 'subagents-registry.migrated')

  // apply resolves undefined (loader contract); the migration goes straight to
  // the internal migrateLegacyRegistry seam it wraps.
  const migration = migrateLegacyRegistry({ legacyPath, targetPath: registryPath })

  assert.equal(migration.performed, true)
  assert.equal(migration.imported, 2)
  const imported = JSON.parse(readFileSync(registryPath, 'utf8'))
  assert.equal(imported['sess-1'].backend, 'codex', 'backend field = legacy product value')
  assert.equal(imported['sess-1'].product, undefined, 'old product key is translated away')
  assert.equal(imported['sess-2'].backend, 'claude-code')
  assert.equal(imported['sess-2'].settings.permissionMode, 'readonly', 'settings (ceiling) survive verbatim')
  assert.equal(existsSync(markerPath), true, '.migrated re-entry marker written')
  assert.equal(readFileSync(legacyPath, 'utf8'), legacyBefore, 'legacy file untouched')
})

test('migration: a second apply does not re-import (target exists + marker)', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)
  const registryPath = join(dir, 'subagents-registry.json')

  const first = fakeCtx()
  await apply(first, shimmedConfig(dir, { registryPath }), { legacyRegistryPath: legacyPath })
  const afterFirst = readFileSync(registryPath, 'utf8')

  // Simulate a restart: a fresh process/apply on the same paths.
  const second = fakeCtx()
  await apply(second, shimmedConfig(dir, { registryPath }), { legacyRegistryPath: legacyPath })
  const migration = migrateLegacyRegistry({ legacyPath, targetPath: registryPath })
  assert.equal(migration.performed, false)
  // the marker is checked first (belt), an existing target would also guard (braces)
  assert.equal(migration.reason, 'marker-exists')
  assert.equal(readFileSync(registryPath, 'utf8'), afterFirst, 'registry not rewritten')
  // …but the alias decision is durable across restarts (marker + entries).
  assert.equal(second.__tools.has('product_submit'), true)
  assert.equal(second.__tools.has('product_delegate'), true)
})

test('aliases: registered after a migration with entries; legacyProductAliases: false suppresses them', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)

  const on = fakeCtx()
  await apply(on, shimmedConfig(dir, { registryPath: join(dir, 'r1', 'subagents-registry.json') }), { legacyRegistryPath: legacyPath })
  assert.equal(on.__tools.has('product_submit'), true)
  assert.equal(on.__tools.has('product_delegate'), true)

  const off = fakeCtx()
  await apply(off, shimmedConfig(dir, { registryPath: join(dir, 'r2', 'subagents-registry.json'), legacyProductAliases: false }), { legacyRegistryPath: legacyPath })
  assert.equal(off.__tools.has('product_submit'), false)
  assert.equal(off.__tools.has('product_delegate'), false)
})

test('aliases: auto without a legacy registry registers nothing extra', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir, { registryPath: join(dir, 'fresh', 'subagents-registry.json') }), { legacyRegistryPath: absentLegacy(dir) })
  assert.deepEqual([...ctx.__tools.keys()].sort(), [...DEFAULT_TOOLS].sort())
})

test('alias product_submit: same recovery pipe under the old name (fake bridge, marker line)', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)
  const registryPath = join(dir, 'subagents-registry.json')
  const ctx = fakeCtx()
  const config = shimmedConfig(dir, { registryPath })
  // apply resolves undefined (loader contract); drive the same assembly plus the
  // alias registration apply performs against one assembled whose state we can
  // preload with a binding the tool's recovery pipe reads.
  const assembled = await assembleDrivers({ ctx, config })
  attachAll(ctx, assembled)
  migrateLegacyRegistry({ legacyPath, targetPath: registryPath })
  registerSubagentSubmit(ctx, { assembled, config, toolName: 'product_submit' })

  // A live binding for the calling session → the alias drives the same
  // bridge.submit path and appends the PRODUCT_SESSION marker line.
  assembled.state.bindings.set('legacy-child', {
    product: 'codex',
    bridge: { submit: async () => ({ text: 'REMOTE ANSWER', stopReason: 'completed' }) },
    remote: { threadId: 'thread-1' },
    settings: { permissionMode: 'full' },
  })
  const out = await ctx.__tools.get('product_submit').execute(
    { task: 'continue the old work' },
    { agent: { session: { id: 'legacy-child', header: { cwd: dir } } }, signal: undefined },
  )
  assert.match(out.text, /REMOTE ANSWER/)
  assert.match(out.text, /PRODUCT_SESSION:codex:thread-1/)
})

test('alias product_delegate: old schema in, old output shape out (sync native route)', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)
  const ctx = fakeCtx()
  await apply(ctx, shimmedConfig(dir, { registryPath: join(dir, 'subagents-registry.json') }), { legacyRegistryPath: legacyPath })

  const out = await ctx.__tools.get('product_delegate').execute(
    // old vocabulary: task (+ no provider → native, background false → one-shot sync)
    { task: 'review the diff', background: false },
    { agent: { session: { id: 'parent-1', header: { cwd: dir } } }, signal: undefined },
  )
  assert.deepEqual(out, {
    output: 'native done',
    stopReason: 'completed',
    role: 'general',
    permissionMode: 'full',
  })
})

test('alias product_delegate: background default returns a childId handle (continuable route)', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)
  const ctx = fakeCtx()
  await apply(
    ctx,
    shimmedConfig(dir, { registryPath: join(dir, 'subagents-registry.json'), backgroundMode: 'continuable' }),
    { legacyRegistryPath: legacyPath },
  )
  const out = await ctx.__tools.get('product_delegate').execute(
    { task: 'long research' },
    { agent: { session: { id: 'parent-1', header: { cwd: dir } } }, signal: undefined },
  )
  assert.equal(out.childId, 'child-1')
  assert.equal(out.role, 'general')
  assert.equal(out.permissionMode, 'full')
})

test('alias product_delegate: loud when the unified delegate tool is not registered', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const legacyPath = legacyRegistry(dir)
  const ctx = fakeCtx()
  await apply(
    ctx,
    shimmedConfig(dir, { registryPath: join(dir, 'subagents-registry.json'), legacyProductAliases: true }),
    { legacyRegistryPath: legacyPath },
  )
  // The alias resolves its delegate target AT CALL TIME; drop the unified tool
  // from the registry to simulate register.delegate=false deployments.
  ctx.__tools.delete('subagent')
  await assert.rejects(
    () => ctx.__tools.get('product_delegate').execute(
      { task: 'x' },
      { agent: { session: { id: 'parent-1', header: { cwd: dir } } }, signal: undefined },
    ),
    /product_delegate.*subagent.*not registered/,
  )
})

// ---- dsh-tools 双实例自检 ----

test('self-check: scheduler symbol present → silent (single instance healthy)', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const host = {
    register: (tool) => host.__map.set(tool.name, tool),
    get: (toolName) => host.__map.get(toolName),
    __map: new Map(),
    [TOOL_RUNTIME_SCHEDULER]: { prepare: () => {} },
  }
  const ctx = fakeCtx({ toolHost: host })
  await apply(ctx, shimmedConfig(dir), { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__logs.fatal.length, 0)
  assert.equal(ctx.__logs.warn.length, 0)
})

test('self-check: ToolRuntime-shaped host without our symbol → logger.fatal + throw', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const host = {
    register: () => {},
    get: () => undefined,
    view: () => ({}),      // ToolRuntime shape probes
    schemas: () => [],
  }
  const ctx = fakeCtx({ toolHost: host })
  await assert.rejects(() => apply(ctx, shimmedConfig(dir)), (error) => {
    assert.match(error.message, /second @deepseek-ai\/dsh-tools module instance/)
    assert.match(error.message, /patches\/install/)
    return true
  })
  assert.equal(ctx.__logs.fatal.length, 1)
})

test('self-check: unverifiable host shape → warn only, apply proceeds', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const ctx = fakeCtx() // register/get only — no symbol, no view/schemas
  await apply(ctx, { registryPath: join(dir, 'registry', 'subagents-registry.json') }, { legacyRegistryPath: absentLegacy(dir) })
  assert.equal(ctx.__logs.fatal.length, 0)
  assert.equal(ctx.__logs.warn.length, 1)
  assert.match(ctx.__logs.warn[0], /patches\/verify/)
})
