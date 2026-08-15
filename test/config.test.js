// dsh-plugin-subagents — lib/config.js 测试（T14）。
//
// 覆盖：
//   - strict 拒绝未知键（全分支两形态：顶层未知键 / 嵌套未知键），报错含键名；
//   - 双分支各自通过/拒绝：presetRow === true 走官方行形状（provider 必填、
//     toolName 默认 'subagent'、bridge 侧键非法）；其余走 §6.1 全表（行专属键
//     toolName 非法、presetRow 显式 false 合法）；
//   - toolNames / register 形状与未知子键拒绝；
//   - providers 值形状（type 枚举 / args 数组 / env 字符串表 / timeoutMs 正整数）；
//   - maxDepth 双形态（正整数 | 'provider-managed'）、backgroundMode 枚举；
//   - legacyProductAliases 三态（'auto' / true / false）与非法值拒绝；
//   - presetRow 静态撞名守卫：toolName === 'subagent_fork' → loud 指引（含
//     「撞名」与 §6.3-L2 指引；'subagent' 是独立部署的合法默认，不静态拒绝）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../lib/config.js'

test('full branch: empty config passes (all keys optional)', () => {
  assert.deepEqual(validateConfig({}), {})
})

test('full branch: rejects unknown top-level keys with the key name', () => {
  assert.throws(() => validateConfig({ provider: 'spawn', providers2: {} }), (error) => {
    assert.match(error.message, /invalid config/)
    assert.match(error.message, /providers2/)
    return true
  })
})

test('full branch: accepts the complete §6.1 table', () => {
  const cfg = validateConfig({
    toolNames: { delegate: 'my_subagent', fork: 'my_subagent_fork' },
    register: { delegate: true, fork: false, submit: true, progress: false, wait: true, roles: false, agents: true },
    presetRow: false,
    presetHints: ['orchestrator', '@preset:scout'],
    provider: 'spawn',
    enableRunInBackground: true,
    backgroundMode: 'continuable',
    agentOptions: { provider: 'newapi', model: 'glm-5.3', maxTokens: 8192 },
    persona: 'senior reviewer',
    toolFilter: { allow: ['read', 'grep'], deny: ['write'] },
    maxDepth: 2,
    fork: {
      provider: 'fork',
      backgroundMode: 'one-shot',
      enableRunInBackground: false,
      agentOptions: { model: 'k3' },
      persona: '@preset:scout',
      toolFilter: { deny: ['write'] },
      maxDepth: 'provider-managed',
    },
    providers: {
      grok: { type: 'acp', command: 'grok', args: ['agent', '--always-approve', 'stdio'], env: { X: '1' }, timeoutMs: 30000 },
      codex: { command: '/abs/codex' },
    },
    registryPath: '/tmp/subagents-registry.json',
    idleTimeoutMs: 0,
    maxConcurrentChildren: 4,
    rolesDir: '/tmp/roles',
    legacyProductAliases: 'auto',
  })
  assert.equal(cfg.toolNames.delegate, 'my_subagent')
  assert.equal(cfg.fork.maxDepth, 'provider-managed')
  assert.equal(cfg.providers.grok.type, 'acp')
})

test('full branch: rejects row-only keys (presetRow shape never leaks through)', () => {
  assert.throws(() => validateConfig({ toolName: 'plan_agent' }), /toolName/)
  assert.throws(() => validateConfig({ presetRow: true, providers: {} }), /providers/)
})

test('full branch: presetRow accepts only the literal false', () => {
  assert.equal(validateConfig({ presetRow: false }).presetRow, false)
  assert.throws(() => validateConfig({ presetRow: 'yes' }), /presetRow/)
})

test('full branch: rejects unknown nested keys (toolNames / register / fork / providers entry)', () => {
  assert.throws(() => validateConfig({ toolNames: { delegateTool: 'x' } }), /delegateTool/)
  assert.throws(() => validateConfig({ register: { submits: true } }), /submits/)
  assert.throws(() => validateConfig({ fork: { backgroundModes: 'one-shot' } }), /backgroundModes/)
  assert.throws(() => validateConfig({ providers: { grok: { command: 'grok', extra: 1 } } }), /extra/)
})

test('full branch: providers value shape validation', () => {
  assert.throws(() => validateConfig({ providers: { grok: { type: 'bogus' } } }), /type/)
  assert.throws(() => validateConfig({ providers: { grok: { args: 'agent' } } }), /args/)
  assert.throws(() => validateConfig({ providers: { grok: { env: { X: 1 } } } }), /env/)
  assert.throws(() => validateConfig({ providers: { grok: { timeoutMs: -1 } } }), /timeoutMs/)
  // a bare custom ACP provider (no fields at all) is legal — defaults apply
  assert.deepEqual(validateConfig({ providers: { grok: {} } }).providers.grok, {})
})

test('full branch: maxDepth and backgroundMode value domains', () => {
  assert.equal(validateConfig({ maxDepth: 3 }).maxDepth, 3)
  assert.equal(validateConfig({ maxDepth: 'provider-managed' }).maxDepth, 'provider-managed')
  assert.throws(() => validateConfig({ maxDepth: 0 }), /maxDepth/)
  assert.throws(() => validateConfig({ maxDepth: 2.5 }), /maxDepth/)
  assert.equal(validateConfig({ backgroundMode: 'one-shot' }).backgroundMode, 'one-shot')
  assert.throws(() => validateConfig({ backgroundMode: 'weird' }), /backgroundMode/)
})

test('full branch: legacyProductAliases accepts auto/true/false, rejects other strings', () => {
  assert.equal(validateConfig({ legacyProductAliases: 'auto' }).legacyProductAliases, 'auto')
  assert.equal(validateConfig({ legacyProductAliases: true }).legacyProductAliases, true)
  assert.equal(validateConfig({ legacyProductAliases: false }).legacyProductAliases, false)
  assert.throws(() => validateConfig({ legacyProductAliases: 'yes' }), /legacyProductAliases/)
})

test('presetRow branch: official row shape passes with toolName defaulting to subagent', () => {
  const cfg = validateConfig({ presetRow: true, provider: 'spawn' })
  assert.equal(cfg.presetRow, true)
  assert.equal(cfg.toolName, 'subagent')
  assert.equal(cfg.provider, 'spawn')
})

test('presetRow branch: full official-row superset passes', () => {
  const cfg = validateConfig({
    presetRow: true,
    provider: 'spawn',
    toolName: 'scout_agent',
    enableRunInBackground: true,
    backgroundMode: 'continuable',
    agentOptions: { provider: 'newapi', model: 'glm-5.3' },
    persona: '@preset:scout',
    toolFilter: { deny: ['write'] },
    maxDepth: 1,
    presetHints: ['scout'],
  })
  assert.equal(cfg.toolName, 'scout_agent')
  assert.equal(cfg.backgroundMode, 'continuable')
})

test('presetRow branch: provider is required', () => {
  assert.throws(() => validateConfig({ presetRow: true }), /provider/)
})

test('presetRow branch: rejects bridge-side / global-instance keys', () => {
  assert.throws(() => validateConfig({ presetRow: true, provider: 'spawn', providers: { grok: {} } }), /providers/)
  assert.throws(() => validateConfig({ presetRow: true, provider: 'spawn', registryPath: '/tmp/x.json' }), /registryPath/)
  assert.throws(() => validateConfig({ presetRow: true, provider: 'spawn', toolNames: { delegate: 'x' } }), /toolNames/)
})

test('presetRow branch: toolName "subagent_fork" is rejected with the collision guidance', () => {
  assert.throws(
    () => validateConfig({ presetRow: true, provider: 'spawn', toolName: 'subagent_fork' }),
    (error) => {
      assert.match(error.message, /撞名/)
      assert.match(error.message, /subagent_fork/)
      assert.match(error.message, /§6\.3-L2|plan_agent/)
      return true
    },
  )
})

test('presetRow branch: toolName "subagent" stays legal at the config layer (standalone default)', () => {
  // The actual collision with a registered global instance is apply()'s runtime
  // guard's job (lib/index.js) — config only rejects the never-sensible fork name.
  assert.equal(validateConfig({ presetRow: true, provider: 'spawn', toolName: 'subagent' }).toolName, 'subagent')
})
