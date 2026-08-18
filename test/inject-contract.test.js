// dsh-plugin-subagents — Cordis `inject` service-access contract test。
//
// 背景（真实故障）：用户启动 dsh 报
//   `cannot get property "systemPrompt" without inject`
// 栈 lib/tools/subagent.js:401（registerSubagentTool 注册 systemPrompt 段）←
// lib/index.js:187（apply）。根因：Cordis 要求 `ctx.<service>` 直接属性访问
// 必须在插件 `export const inject` 数组声明；本插件实际直接访问
// ctx.tools / ctx.subagents / ctx.systemPrompt（ctx.logger 免声明；
// ctx.get('sessions') / ctx.get('jobs') 是惰性访问器，免声明），但 inject 原是
// `['subagents','tools','sessions']` —— sessions 零访问、systemPrompt 缺失。
// 旧版 cwd 插件的正确声明是 `['tools','subagents','systemPrompt']`。
//
// 两道防线：
//   (a) 静态扫描 —— 读 lib/index.js 的 inject 数组，grep lib/ 全部直接属性访问，
//       断言「访问到的服务集合 ⊆ inject 集合」，失败列出缺声明的服务名。
//   (b) 严格 ctx 全链测试 —— 复刻 Cordis 的 get-property-without-inject 机制：
//       Proxy 包装，访问 tracked 服务（subagents|tools|systemPrompt|sessions|jobs）
//       而未在 whitelist 声明时 throw `cannot get property "X" without inject`；
//       然后对 lib/index.js 的 apply 跑完整分支（默认 config → continuable →
//       systemPrompt.section；以及 presetRow 分支），断言不抛 inject 错且工具注册。
//
// 全部 fake：无真实 CLI、无密钥、不触碰真实 ~/.dsh（registryPath 与 legacy
// registry 路径均注入 tmp）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globSync } from 'node:fs'
import { apply } from '../lib/index.js'

const IS_WIN = process.platform === 'win32'

// 直接属性访问（需 inject 声明）的服务集合；ctx.logger 免声明，ctx.get('x')
// 惰性访问器免声明，故均不列入。
const TRACKED_SERVICES = ['subagents', 'tools', 'systemPrompt', 'sessions', 'jobs']
// Cordis 运行时基础面（本测试直接提供函数实现，不需要 inject 声明）。
const RUNTIME_BASE = ['logger', 'on', 'effect', 'get']

// ---- 工具 ----

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'inject-contract-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function shim(dir, file) {
  const path = join(dir, file)
  writeFileSync(path, IS_WIN ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', IS_WIN ? {} : { mode: 0o755 })
}

/** 从 lib/index.js 解析 `export const inject = [...]` 数组内容。 */
function readInjectArray() {
  const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const match = source.match(/export\s+const\s+inject\s*=\s*\[([^\]]*)\]/)
  assert.ok(match, 'lib/index.js must declare `export const inject = [...]`')
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
}

/** 收集 lib/ 下对某服务的直接属性访问条数（排除 classifies 形式与 .logger）。 */
function countDirectAccess(service) {
  const re = new RegExp(`ctx\\.${service}\\b`, 'g')
  let count = 0
  const files = globSync('**/*.js', { cwd: new URL('../lib/', import.meta.url) }).map((f) => new URL(`../lib/${f}`, import.meta.url))
  for (const file of files) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim()
      if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
      count += (line.match(re) || []).length
    }
  }
  return count
}

// ---- (a) 静态扫描：inject 声明 ⊆ 实际直接访问 ──────────────────────────────

test('inject declares the superset of directly-accessed services (static scan)', () => {
  const inject = readInjectArray()
  // inject 只允许声明本插件真正直接访问的服务；白名单必须恰好涵盖 tracked。
  // 关键回归断言：systemPrompt 必须被声明（缺它即用户启动失败的根因）。
  for (const service of ['subagents', 'tools', 'systemPrompt']) {
    assert.ok(
      inject.includes(service),
      `inject must declare "${service}" (Cordis service-access contract); current inject = [${inject.join(', ')}]`,
    )
  }

  const accessed = TRACKED_SERVICES.filter((s) => countDirectAccess(s) > 0)
  assert.ok(
    inject.length > 0,
    'inject array must not be empty',
  )
  const missing = accessed.filter((s) => !inject.includes(s))
  assert.deepEqual(
    missing,
    [],
    `directly-accessed service(s) not declared in inject: ${missing.join(', ')} — add them to export const inject`,
  )
  // sessions / jobs 只允许通过惰性访问器 ctx.get(...)，绝不能直接属性访问。
  assert.equal(
    countDirectAccess('sessions'),
    0,
    'ctx.sessions direct access is forbidden — use lazy ctx.get(\'sessions\') instead (no inject needed)',
  )
  assert.equal(
    countDirectAccess('jobs'),
    0,
    'ctx.jobs direct access is forbidden — use lazy ctx.get(\'jobs\') instead (no inject needed)',
  )
})

// ---- (b) 严格 ctx 全链测试（复刻 Cordis 机制，真正的防线）────────────────

/**
 * 构造严格 ctx：Proxy 包装白名单服务。访问 tracked 服务却未在白名单时 throw
 * `cannot get property "X" without inject`（与 Cordis 同文案）。基础面
 * logger/on/effect/get 直接提供函数实现；其它未知属性返回 undefined。
 */
function strictCtx({ jobs } = {}) {
  // 白名单与 lib/index.js 当前 `export const inject` 保持一致 —— 否则 strict ctx
  // 不能忠实地复刻「Cordis 会拒绝什么」；这正是它能抓到原缺陷的关键。
  const whitelist = readInjectArray()
  const tools = new Map()
  const registeredProviders = []
  const listeners = new Map()
  const teardowns = []
  const logs = []

  const services = {
    tools: {
      register: (tool) => { tools.set(tool.name, tool) },
      get: (toolName) => tools.get(toolName),
    },
    subagents: {
      getProvider: (providerName) => (providerName === 'spawn' ? { name: 'spawn', capabilities: {} } : undefined),
      registerProvider: (provider) => { registeredProviders.push(provider) },
      listChildren: async () => [],
      start: async () => ({
        id: 'run-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'native done' }], stopReason: 'completed' }),
        dispose: async () => {},
      }),
      startContinuable: async () => ({ childId: 'child-1', messageId: 'msg-1' }),
    },
    systemPrompt: {
      section: () => {},
    },
  }

  const base = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      fatal: (m) => { logs.push(['fatal', m]); throw new Error(`fatal: ${m}`) },
    },
    on: (event, fn) => {
      const list = listeners.get(event) || []
      list.push(fn)
      listeners.set(event, list)
      return () => {
        const idx = list.indexOf(fn)
        if (idx >= 0) list.splice(idx, 1)
      }
    },
    effect: (fn) => { teardowns.push(fn()) },
    get: (key) => {
      if (key === 'jobs') return jobs // undefined 模拟 jobs 缺失的优雅路径；或注入 fake jobs
      return undefined
    },
  }

  const ctx = new Proxy({}, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop.startsWith('__')) return Reflect.get(target, prop, receiver)
      if (typeof prop === 'string' && RUNTIME_BASE.includes(prop)) return base[prop]
      if (typeof prop === 'string' && TRACKED_SERVICES.includes(prop)) {
        if (whitelist.includes(prop)) return services[prop]
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return undefined
    },
  })

  ctx.__tools = tools
  ctx.__registered = registeredProviders
  ctx.__teardowns = teardowns
  ctx.__listeners = listeners
  ctx.__logs = logs
  return ctx
}

/** 确定性 config：codex shimmed、registry 目标注入 tmp、legacy 目录缺席。 */
function sealedConfig(dir, extra = {}) {
  return {
    providers: { codex: { type: 'codex', command: join(dir, 'codex-cli') } },
    registryPath: join(dir, 'registry', 'subagents-registry.json'),
    ...extra,
  }
}

test('strict ctx: default global branch (backgroundMode default → continuable → systemPrompt.section) registers all seven tools without inject error', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = strictCtx()
  // 默认 config：subagent 的 backgroundMode 缺省为 'continuable' → 工具注册成功后
  // 走 ctx.systemPrompt.section —— 若 inject 未声明 systemPrompt 即在此抛错。
  const out = await apply(ctx, sealedConfig(dir), { legacyRegistryPath: join(dir, 'absent', 'legacy-registry.json') })

  const expected = ['subagent', 'subagent_fork', 'subagent_submit', 'subagent_progress',
    'subagent_wait', 'subagent_roles', 'subagent_agents']
  assert.deepEqual([...ctx.__tools.keys()].sort(), [...expected].sort(), 'all seven tools registered')
  // teardown effect 由 attachAll → attachBridgeLifecycle 注册。
  assert.equal(ctx.__teardowns.length, 1)
})

test('strict ctx: presetRow branch (native-only single tool) registers without inject error', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  const ctx = strictCtx()
  await apply(ctx, sealedConfig(dir), { legacyRegistryPath: join(dir, 'absent', 'legacy-registry.json') })
  const before = ctx.__tools.size

  // presetRow 行：provider required + 独立 toolName；只注册单工具。
  await apply(ctx, { presetRow: true, provider: 'spawn', toolName: 'scout_agent', maxDepth: 1 })

  assert.equal(ctx.__tools.has('scout_agent'), true, 'presetRow tool registered')
  assert.equal(ctx.__tools.size, before + 1, 'exactly one new tool from the presetRow row')
  // presetRow requireRProvider: 'spawn' 命中 fake subagents.getProvider → 无死分支。
})

test('apply() resolves to undefined on every branch — the Cordis loader contract', async (t) => {
  const { dir, done } = tempDir()
  shim(dir, 'codex-cli')
  t.after(done)
  // Cordis treats the plugin callback's return value as a disposable; a
  // non-nullable non-function return fails real boots with 'Invalid effect'
  // (safeCollect → `TypeError: Invalid effect`). Assert both branches yield
  // exactly undefined.
  const defaultResult = await apply(strictCtx(), sealedConfig(dir), { legacyRegistryPath: join(dir, 'absent', 'legacy-registry.json') })
  assert.strictEqual(defaultResult, undefined, 'default global branch must resolve to undefined')
  const presetRowResult = await apply(strictCtx(), { presetRow: true, provider: 'spawn', toolName: 'scout_agent', maxDepth: 1 })
  assert.strictEqual(presetRowResult, undefined, 'presetRow branch must resolve to undefined')
})
