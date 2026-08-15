// dsh-plugin-subagents — lib/drivers/index.js 装配层测试（T10）。
//
// 覆盖（TASKS T10 验收 + 简报明细）：
//   - 三态可用性：grok（config.providers）+ codex（built-in 覆盖 absolute shim）
//     registered → 在 bridges；claude-code 无 shim → 不在 bridges；acp（built-in
//     opencode）同样无 shim → 不在；
//   - native spawn/fork 两实例的 id 与 inheritsParentContext（fork true）；
//   - resolveBackend 四分支（native / native:fork / bridge 名 / 未知）；
//   - state 单例：两次 assembleDrivers 各自独立 state；同一次装配内 bridges
//     共享同一 state 实例（改 assembled.state.bindings 可被 driver progress 观测）；
//   - attachAll：bridgeProviders 全部 registerProvider、lifecycle 事件挂接。
//
// availability 断言用**绝对路径 shim**（commandExists 对绝对存在路径计为 found），
// 覆盖 built-in 的 command 指向临时目录，使结果不依赖宿主机 PATH 是否真实安装
// 了 claude/codex/opencode —— 保证在 CI（macOS/Ubuntu/Windows × Node 18/20/22）
// 上确定性。shim 文件 POSIX 用 shebang 可执行、win32 用 .cmd。
// 全部 fake：无真实 CLI、无密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleDrivers, attachAll } from '../lib/drivers/index.js'

const IS_WIN = process.platform === 'win32'

/** Return a temp dir path and a cleanup fn. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'drivers-assembly-'))
  return {
    dir,
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Write an absolute-path executable shim named `file` into `dir`. */
function shim(dir, file) {
  const path = join(dir, file)
  const body = IS_WIN
    ? '@echo off\r\nexit /b 0\r\n'
    : '#!/bin/sh\nexit 0\n'
  writeFileSync(path, body, IS_WIN ? {} : { mode: 0o755 })
}

/** Fake Cordis-like host ctx: getProvider / registerProvider / on / effect. */
function fakeCtx({ registered = ['spawn', 'fork'] } = {}) {
  const registeredProviders = []
  const listeners = new Map()
  const effects = []
  return {
    subagents: {
      getProvider: (name) => (registered.includes(name) ? { name, capabilities: {} } : undefined),
      registerProvider: (p) => { registeredProviders.push(p) },
    },
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
    },
    effect: (fn) => { effects.push(fn()) },
    __registered: registeredProviders,
    __listeners: listeners,
    __effectCount: () => effects.length,
  }
}

/**
 * Deterministic config: every provider's command is an absolute path under
 * `dir`, so availability depends only on whether the shim file was written
 * (never on the ambient host PATH). Shimmed: grok-cli, codex-cli. Absent:
 * claude-cli (override built-in claude-code), opencode-cli (override `acp`).
 */
function configWithShims(dir) {
  return {
    provider: 'spawn',
    fork: { provider: 'fork' },
    providers: {
      grok: { type: 'acp', command: join(dir, 'grok-cli') },
      codex: { type: 'codex', command: join(dir, 'codex-cli') },
      'claude-code': { type: 'claude', command: join(dir, 'claude-cli') },
      acp: { command: join(dir, 'opencode-cli') },
    },
  }
}

/** Full three-state fixture: grok/codex shims present, claude-code/acp absent. */
async function assemblesThreeState(t) {
  const { dir, done } = tempDir()
  shim(dir, 'grok-cli')
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = fakeCtx()
  const assembled = await assembleDrivers({ ctx, config: configWithShims(dir) })
  return { dir, ctx, assembled }
}

test('three-state availability: grok+codex in bridges; claude-code/acp not', async (t) => {
  const { assembled } = await assemblesThreeState(t)

  // three-state registered flags
  assert.equal(assembled.availability.grok.registered, true)
  assert.equal(assembled.availability.codex.registered, true)
  assert.equal(assembled.availability['claude-code'].registered, false)
  assert.equal(assembled.availability.acp.registered, false)

  // bridges contains exactly the registered providers
  assert.ok(assembled.bridges.has('grok'))
  assert.ok(assembled.bridges.has('codex'))
  assert.ok(!assembled.bridges.has('claude-code'))
  assert.ok(!assembled.bridges.has('acp'))

  // each bridge driver is a BridgeDriver with the provider name as its id
  const grokDriver = assembled.bridges.get('grok')
  const codexDriver = assembled.bridges.get('codex')
  assert.equal(grokDriver.kind, 'bridge')
  assert.equal(grokDriver.id, 'grok')
  assert.equal(codexDriver.kind, 'bridge')
  assert.equal(codexDriver.id, 'codex')
  assert.equal(codexDriver.inheritsParentContext, false)
})

test('bridge drivers report the injected availability', async (t) => {
  const { assembled } = await assemblesThreeState(t)
  const grokDriver = assembled.bridges.get('grok')
  const avail = grokDriver.available()
  assert.equal(avail.registered, true)
  assert.equal(avail.command, true)
})

test('native spawn/fork: ids and inheritsParentContext', async (t) => {
  const { assembled } = await assemblesThreeState(t)
  assert.equal(assembled.native.spawn.kind, 'native')
  assert.equal(assembled.native.spawn.id, 'native:spawn')
  assert.equal(assembled.native.spawn.inheritsParentContext, false)
  assert.equal(assembled.native.fork.kind, 'native')
  assert.equal(assembled.native.fork.id, 'native:fork')
  assert.equal(assembled.native.fork.inheritsParentContext, true)
})

test('resolveBackend: native / native:fork / bridge name / unknown', async (t) => {
  const { assembled } = await assemblesThreeState(t)
  assert.equal(assembled.resolveBackend('native'), assembled.native.spawn)
  assert.equal(assembled.resolveBackend('native:fork'), assembled.native.fork)
  assert.equal(assembled.resolveBackend('grok'), assembled.bridges.get('grok'))
  // unknown and non-registered names both resolve undefined
  assert.equal(assembled.resolveBackend('nope'), undefined)
  assert.equal(assembled.resolveBackend('claude-code'), undefined)
})

test('state single instance: two calls independent; one assembly shares state with bridges', async (t) => {
  const { dir, assembled } = await assemblesThreeState(t)
  const second = await assembleDrivers({ ctx: fakeCtx(), config: configWithShims(dir) })

  // independent states across two assemblies (red line 10: one state per assembly)
  assert.notEqual(assembled.state, second.state)
  assert.notEqual(assembled.state.bindings, second.state.bindings)

  // a single assembly shares ONE state across all its bridge drivers:
  // write a binding via assembled.state and confirm the driver sees it.
  const grokDriver = assembled.bridges.get('grok')
  assembled.state.bindings.set('child-x', {
    product: 'grok',
    bridge: { dispose: async () => {} },
    remote: {},
    settings: undefined,
  })
  const snap = await grokDriver.progress('child-x')
  assert.equal(snap.childId, 'child-x')
  assert.equal(snap.pinnedProduct, 'grok')
  assert.equal(snap.status, 'inactive')
})

test('attachAll registers every bridge provider and attaches lifecycle', async (t) => {
  const { ctx, assembled } = await assemblesThreeState(t)
  attachAll(ctx, assembled)

  // every registered bridge provider was registered on the ctx seam
  assert.deepEqual(
    ctx.__registered.map((p) => p.name).sort(),
    ['codex', 'grok'],
  )
  // lifecycle events are wired and one teardown effect installed
  assert.ok(ctx.__listeners.has('subagent/start'))
  assert.ok(ctx.__listeners.has('subagent/end'))
  assert.equal(ctx.__effectCount(), 1)
})
