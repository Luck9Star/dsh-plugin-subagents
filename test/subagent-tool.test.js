// dsh-plugin-subagents — `subagent` 统一委派工具测试（T11）。
//
// 覆盖 TASKS T11 验收 8 条：
//   ① 默认（无 backend/role）走 native spawn，收到合并后的 agentOptions/persona
//     （含 route 默认随 backgroundMode：continuable / job / sync）；
//   ② backend=codex + run_in_background true → bridge 收到 route 'continuable' +
//     settings.permissionMode（role 默认）；false → 'sync'；
//   ③ role.backend 被显式 backend 覆盖（role.backend 空串合法）；非空锁定 +
//     不同显式 backend → throw；
//   ④ 未知 role → throw 列出 ids（schema enum 拒绝 + execute 纵深防御两道）；
//   ⑤ 调用者是 bridge 子代理（binding 命中 + registry 命中，readonly）请求
//     full → 天花板 throw；root 调用者不受限；
//   ⑥ native + permission_mode / bridge + cwd / bridge + persona →
//     assertParamsSupported throw（消息含参数名）；
//   ⑦ role.instructions 前缀拼接进 task（native 与 bridge 两路）；
//   ⑧ overrides 次序 args > role.overrides > config（三方不同值断言 driver
//     收到的最终值）。
//
// 附加：输出三态映射（job→background/job_id）、render、bridge 可用性 throw、
// ceiling state 契约 guard（缺 registry loud）、enableRunInBackground=false、
// systemPrompt 段仅 continuable 注册。
//
// 全部 fake：fakeCtx 记录 tools.register / systemPrompt.section、fake
// native/bridge driver 记录 start 入参、fakeRoles / fake assembled（含
// state.bindings + state.registry 两个 Map）—— 无真实 CLI、无密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSubagentTool } from '../lib/tools/subagent.js'
import { NATIVE_CAPS, BRIDGE_CAPS } from '../lib/drivers/types.js'

// ---- fixtures ----

/** Capture registered tools + prompt sections; minimal ctx surface the tool uses. */
function fakeCtx() {
  const tools = new Map()
  const sections = []
  return {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      get: (name) => tools.get(name),
    },
    systemPrompt: { section: (spec) => sections.push(spec) },
    sections,
    tool: (name) => tools.get(name),
  }
}

/** 伪 native 驱动：记录 start 入参，返回可注入 outcome。 */
function fakeNativeDriver({ outcome } = {}) {
  const calls = []
  return {
    calls,
    id: 'native:spawn',
    kind: 'native',
    inheritsParentContext: false,
    capabilities: NATIVE_CAPS,
    available: () => ({ registered: true, reason: 'native provider "spawn" is registered' }),
    async start(request) {
      calls.push(request)
      return outcome ?? {
        kind: 'foreground',
        runId: 'run-1',
        output: [{ type: 'text', text: 'native done' }],
        stopReason: 'completed',
      }
    },
  }
}

/** 伪 bridge 驱动（codex）：记录 start 入参，返回可注入 outcome。 */
function fakeBridgeDriver({ outcome, registered = true, reason = 'codex CLI not found on PATH' } = {}) {
  const calls = []
  return {
    calls,
    id: 'codex',
    kind: 'bridge',
    inheritsParentContext: false,
    capabilities: BRIDGE_CAPS,
    available: () => ({ registered, reason: registered ? 'codex CLI detected on PATH' : reason }),
    async start(request) {
      calls.push(request)
      return outcome ?? {
        kind: 'continuable',
        childId: 'child-9',
        backend: 'codex',
        permissionMode: request.bridge && request.bridge.settings && request.bridge.settings.permissionMode,
      }
    },
  }
}

/** 假 assembled：assembleDrivers 产物中工具层消费的最小子集。 */
function fakeAssembled({ native, bridge } = {}) {
  const bindings = new Map()
  const registry = new Map()
  return {
    assembled: {
      native: { spawn: native },
      bridges: new Map(bridge ? [['codex', bridge]] : []),
      state: { bindings, registry },
    },
    bindings,
    registry,
  }
}

/** 假角色库：list()/get() 两个方法即可。 */
function fakeRoles(map) {
  return {
    list: () => Object.values(map),
    get: (id) => map[id] || null,
  }
}

const GENERAL = {
  id: 'general',
  description: 'general purpose',
  backend: '',            // caller chooses
  permissionMode: 'full',
  allowDelegation: true,
  instructions: '',
  overrides: {},
}
const CODEX_FULL = {
  id: 'codex-full',
  description: 'full-permission codex',
  backend: 'codex',       // pinned
  permissionMode: 'full',
  allowDelegation: true,
  instructions: '',
  overrides: {},
}

const execFor = (sessionId = 'root-1') => ({
  agent: { id: 'agent', session: { id: sessionId } },
  signal: new AbortController().signal,
})

// ---- ① 默认走 native spawn + 合并后的 agentOptions/persona ----

test('① default (no backend/role) delegates to the native spawn driver with merged agentOptions/persona', async () => {
  const native = fakeNativeDriver()
  const bridge = fakeBridgeDriver()
  const { assembled } = fakeAssembled({ native, bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, 'codex-full': CODEX_FULL }),
    config: { agentOptions: { maxTokens: 512 }, persona: 'config persona' },
  })
  const exec = execFor()
  const out = await ctx.tool('subagent').execute(
    { description: 'scout the repo', prompt: 'Read the repo and report.' },
    exec,
  )
  assert.equal(native.calls.length, 1, 'native spawn driver is used')
  assert.equal(bridge.calls.length, 0, 'bridge driver untouched')
  const request = native.calls[0]
  assert.equal(request.route, 'sync', 'backgroundMode not continuable → default run is foreground')
  assert.equal(request.label, 'scout the repo')
  assert.equal(request.task, 'Read the repo and report.')
  assert.equal(request.parent, exec.agent)
  assert.equal(request.signal, exec.signal)
  assert.deepEqual(request.native.agentOptions, { maxTokens: 512 })
  assert.equal(request.native.persona, 'config persona')
  // 前台结果映射为蛇形字段
  assert.deepEqual(out, {
    kind: 'foreground',
    run_id: 'run-1',
    output: [{ type: 'text', text: 'native done' }],
    stop_reason: 'completed',
  })
})

test('① native route default follows backgroundMode (continuable default; one-shot explicit true → job)', async () => {
  // backgroundMode=continuable：省略 run_in_background → 默认 true → continuable
  const nativeContinuable = fakeNativeDriver({ outcome: { kind: 'continuable', childId: 'c-1', backend: 'native:spawn' } })
  const ctxA = fakeCtx()
  registerSubagentTool(ctxA, {
    assembled: fakeAssembled({ native: nativeContinuable }).assembled,
    roles: fakeRoles({ general: GENERAL }),
    config: { backgroundMode: 'continuable' },
  })
  const outA = await ctxA.tool('subagent').execute({ description: 'bg work', prompt: 'Do it.' }, execFor())
  assert.equal(nativeContinuable.calls[0].route, 'continuable')
  assert.deepEqual(outA, { kind: 'continuable', child_id: 'c-1', backend: 'native:spawn', role: 'general' })

  // backgroundMode 缺省（one-shot 语义）+ 显式 true → job（一次性后台作业）
  const nativeJob = fakeNativeDriver({ outcome: { kind: 'job', jobId: 'job-7' } })
  const ctxB = fakeCtx()
  registerSubagentTool(ctxB, {
    assembled: fakeAssembled({ native: nativeJob }).assembled,
    roles: fakeRoles({ general: GENERAL }),
    config: {},
  })
  const outB = await ctxB.tool('subagent').execute(
    { description: 'bg job', prompt: 'Do it.', run_in_background: true },
    execFor(),
  )
  assert.equal(nativeJob.calls[0].route, 'job')
  assert.deepEqual(outB, { kind: 'background', job_id: 'job-7' }, 'job outcome maps to kind background')
})

// ---- ② backend=codex 的 bridge 路由 ----

test('② backend=codex: run_in_background true → continuable with role-default permissionMode; false → sync', async () => {
  const native = fakeNativeDriver()
  const bridge = fakeBridgeDriver()
  const { assembled } = fakeAssembled({ native, bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, 'codex-full': CODEX_FULL }),
    config: { backgroundMode: 'continuable' },
  })

  // true → continuable；settings.permissionMode 取 role 默认（general → full）
  const outBg = await ctx.tool('subagent').execute(
    { description: 'codex work', prompt: 'Fix the bug.', backend: 'codex', run_in_background: true },
    execFor(),
  )
  assert.equal(bridge.calls.length, 1)
  assert.equal(native.calls.length, 0)
  assert.equal(bridge.calls[0].route, 'continuable')
  assert.equal(bridge.calls[0].bridge.provider, 'codex')
  assert.equal(bridge.calls[0].bridge.settings.permissionMode, 'full', 'role default permissionMode')
  assert.equal(bridge.calls[0].allowDelegation, true)
  assert.deepEqual(outBg, { kind: 'continuable', child_id: 'child-9', backend: 'codex', role: 'general', permission_mode: 'full' })

  // false → sync（bridge 无 job 语义，显式 false 恒前台）
  await ctx.tool('subagent').execute(
    { description: 'codex sync', prompt: 'Quick check.', backend: 'codex', run_in_background: false },
    execFor(),
  )
  assert.equal(bridge.calls[1].route, 'sync')

  // 省略 run_in_background + backgroundMode=continuable → bridge 默认 continuable
  await ctx.tool('subagent').execute(
    { description: 'codex default', prompt: 'Async by default.', backend: 'codex' },
    execFor(),
  )
  assert.equal(bridge.calls[2].route, 'continuable')
})

test('② bridge settings carry model / reasoning_effort / explicit permission_mode', async () => {
  const bridge = fakeBridgeDriver()
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, { assembled, roles: fakeRoles({ general: GENERAL }), config: {} })
  await ctx.tool('subagent').execute(
    {
      description: 'tuned codex',
      prompt: 'Work.',
      backend: 'codex',
      run_in_background: false,
      model: 'gpt-5-codex',
      reasoning_effort: 'high',
      permission_mode: 'readonly',
    },
    execFor(),
  )
  assert.deepEqual(bridge.calls[0].bridge.settings, {
    permissionMode: 'readonly',
    model: 'gpt-5-codex',
    reasoningEffort: 'high',
  })
})

// ---- ③ role.backend 归并 ----

test('③ role.backend merge: empty accepts any explicit backend; pinned + different explicit → throw', async () => {
  const native = fakeNativeDriver()
  const bridge = fakeBridgeDriver()
  const { assembled } = fakeAssembled({ native, bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, 'codex-full': CODEX_FULL }),
    config: {},
  })

  // role.backend 空串（general，调用方选择）+ 显式 backend=codex → 合法走 codex
  await ctx.tool('subagent').execute(
    { description: 'choose codex', prompt: 'Work.', backend: 'codex' },
    execFor(),
  )
  assert.equal(bridge.calls.length, 1)
  assert.equal(native.calls.length, 0)

  // 省略 backend + role 锁定 codex → 归并到 role.backend
  await ctx.tool('subagent').execute(
    { description: 'pinned codex', prompt: 'Work.', role: 'codex-full' },
    execFor(),
  )
  assert.equal(bridge.calls.length, 2)

  // 显式 backend 与锁定值相同 → 合法（不误伤）
  await ctx.tool('subagent').execute(
    { description: 'same codex', prompt: 'Work.', role: 'codex-full', backend: 'codex' },
    execFor(),
  )
  assert.equal(bridge.calls.length, 3)

  // role 锁定 codex + 显式 backend=native → loud（防误用）
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'conflict', prompt: 'Work.', role: 'codex-full', backend: 'native' },
      execFor(),
    ),
    (err) => err.message.includes('role "codex-full" pins backend "codex"')
      && err.message.includes('backend "native" was passed'),
  )
  assert.equal(bridge.calls.length, 3, 'conflicting call never reaches a driver')
})

// ---- ④ 未知 role ----

test('④ unknown role: schema enum rejects; execute defense-in-depth lists available ids', async () => {
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge: fakeBridgeDriver() })
  const ctx = fakeCtx()
  const roles = fakeRoles({ general: GENERAL, 'codex-full': CODEX_FULL })
  registerSubagentTool(ctx, { assembled, roles, config: {} })

  // 第一道：schema enum（defineTool 参数校验，PS 先例 —— "must be one of"）
  await assert.rejects(
    () => ctx.tool('subagent').execute({ description: 'x', prompt: 'y', role: 'typo' }, execFor()),
    /must be one of/,
  )

  // 第二道：execute 纵深防御（角色库在注册后变化 / 空库兜底路径）→ 消息列出 ids
  const originalGet = roles.get
  roles.get = () => null
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', role: 'codex-full', backend: 'codex' },
      execFor(),
    ),
    (err) => err.message.includes('unknown role "codex-full"')
      && err.message.includes('available: general, codex-full'),
  )
  roles.get = originalGet
})

// ---- ⑤ 权限天花板 ----

test('⑤ bridge child caller under a readonly ceiling cannot request full (binding and registry)', async () => {
  const bridge = fakeBridgeDriver()
  const { assembled, bindings, registry } = fakeAssembled({ native: fakeNativeDriver(), bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, 'codex-full': CODEX_FULL }),
    config: {},
  })

  // 活 binding 命中（idle 释放前的 bridge 子代理）
  bindings.set('child-1', { product: 'codex', remote: {}, settings: { permissionMode: 'readonly' } })
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'escalate', prompt: 'Work.', backend: 'codex' },
      execFor('child-1'),
    ),
    /permission escalation blocked/,
  )
  bindings.delete('child-1')

  // binding 已失（重启 / idle 释放）→ durable registry 兜底，天花板不解除
  registry.set('child-1', { backend: 'codex', remoteId: 'remote-9', settings: { permissionMode: 'readonly' } })
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'escalate via registry', prompt: 'Work.', backend: 'codex', permission_mode: 'full' },
      execFor('child-1'),
    ),
    (err) => err.message.includes('permission escalation blocked')
      && err.message.includes('"readonly"')
      && err.message.includes('"full"'),
  )
  registry.delete('child-1')

  // root 调用者（binding ∪ registry 均未命中）不受 bridge 天花板约束
  await ctx.tool('subagent').execute(
    { description: 'root full', prompt: 'Work.', backend: 'codex', permission_mode: 'full', run_in_background: false },
    execFor('root-1'),
  )
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].bridge.settings.permissionMode, 'full')

  // 天花板允许不越级：readonly 子代理请求 readonly → 放行
  bindings.set('child-2', { product: 'codex', remote: {}, settings: { permissionMode: 'readonly' } })
  await ctx.tool('subagent').execute(
    { description: 'same level', prompt: 'Work.', backend: 'codex', permission_mode: 'readonly', run_in_background: false },
    execFor('child-2'),
  )
  assert.equal(bridge.calls.length, 2)
  assert.equal(bridge.calls[1].bridge.settings.permissionMode, 'readonly')
})

test('⑤ ceiling requires assembled.state.registry — missing registry fails loudly (fail closed)', async () => {
  const bridge = fakeBridgeDriver()
  const native = fakeNativeDriver()
  const assembled = {
    native: { spawn: native },
    bridges: new Map([['codex', bridge]]),
    state: { bindings: new Map() },   // registry 不可达 —— 绝不静默降级为只查 binding
  }
  const ctx = fakeCtx()
  registerSubagentTool(ctx, { assembled, roles: fakeRoles({ general: GENERAL }), config: {} })
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', backend: 'codex', run_in_background: false },
      execFor(),
    ),
    /must expose both `bindings` and `registry`/,
  )
  assert.equal(bridge.calls.length, 0)
})

// ---- ⑥ 参数-能力矩阵 ----

test('⑥ capability matrix: native+permission_mode / bridge+cwd / bridge+persona throw with the parameter name', async () => {
  const native = fakeNativeDriver()
  const bridge = fakeBridgeDriver()
  const { assembled } = fakeAssembled({ native, bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, 'codex-full': CODEX_FULL }),
    config: {},
  })

  // native + permission_mode（native 不适用远端权限档）
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', permission_mode: 'full' },
      execFor(),
    ),
    (err) => err.message.includes('"permission_mode"') && err.message.includes('native:spawn'),
  )

  // bridge + cwd（bridge 用父会话 cwd）
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', backend: 'codex', cwd: '/tmp' },
      execFor(),
    ),
    (err) => err.message.includes('"cwd"') && err.message.includes('"codex"'),
  )

  // bridge + persona（relay 人格固定）
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', backend: 'codex', persona: 'You are X.' },
      execFor(),
    ),
    /"persona" is not supported by backend "codex"/,
  )
  assert.equal(native.calls.length, 0)
  assert.equal(bridge.calls.length, 0)
})

// ---- ⑦ role.instructions 前缀 ----

test('⑦ role.instructions are prepended to the task (native and bridge)', async () => {
  const native = fakeNativeDriver()
  const bridge = fakeBridgeDriver()
  const { assembled } = fakeAssembled({ native, bridge })
  const scout = { ...GENERAL, id: 'scout', instructions: 'You are the scout. Report findings as bullet points.' }
  const reviewer = { ...CODEX_FULL, id: 'codex-reviewer', instructions: 'Review only; never edit files.' }
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, scout, 'codex-reviewer': reviewer }),
    config: {},
  })

  await ctx.tool('subagent').execute(
    { description: 'scout', prompt: 'Read the repo.', role: 'scout' },
    execFor(),
  )
  assert.equal(
    native.calls[0].task,
    'You are the scout. Report findings as bullet points.\n\nRead the repo.',
  )

  await ctx.tool('subagent').execute(
    { description: 'review', prompt: 'Review PR 7.', role: 'codex-reviewer', run_in_background: false },
    execFor(),
  )
  assert.equal(bridge.calls[0].task, 'Review only; never edit files.\n\nReview PR 7.')
})

// ---- ⑧ overrides 次序：args > role.overrides > config ----

test('⑧ override precedence args > role.overrides > config (three-way distinct values)', async () => {
  const native = fakeNativeDriver()
  const { assembled } = fakeAssembled({ native, bridge: fakeBridgeDriver() })
  const deep = {
    ...GENERAL,
    id: 'deep',
    instructions: '',
    overrides: {
      agentOptions: { model: 'role-model', maxTokens: 2048 },
      persona: 'role persona',
      toolFilter: { deny: ['role-tool'] },
      maxDepth: 2,
    },
  }
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL, deep }),
    config: {
      agentOptions: { provider: 'config-llm', model: 'config-model' },
      persona: 'config persona',
      toolFilter: { deny: ['config-tool'] },
      maxDepth: 5,
    },
  })

  // per-call（args）全部给出 → 全胜；未被 args 覆盖的键按次序向下取
  await ctx.tool('subagent').execute(
    {
      description: 'three way',
      prompt: 'Work.',
      role: 'deep',
      model: 'args-llm/args-model',
      persona: 'args persona',
      toolFilter: { deny: ['args-tool'] },
    },
    execFor(),
  )
  let n = native.calls[0].native
  // agentOptions：role.maxTokens 存活、config.provider 被 args 组合 id 覆盖、
  // config.model 与 role.model 均被 args.model 覆盖
  assert.deepEqual(n.agentOptions, { model: 'args-model', provider: 'args-llm', maxTokens: 2048 })
  assert.equal(n.persona, 'args persona')
  assert.deepEqual(n.toolFilter, { deny: ['args-tool'] })
  assert.equal(n.maxDepth, 2, 'maxDepth 无 per-call 参数：role.overrides 覆盖 config')

  // 省略 args 的 persona / toolFilter → 取 role.overrides（> config）
  await ctx.tool('subagent').execute(
    { description: 'role tier', prompt: 'Work.', role: 'deep', model: 'glm-5.3' },
    execFor(),
  )
  n = native.calls[1].native
  assert.equal(n.persona, 'role persona')
  assert.deepEqual(n.toolFilter, { deny: ['role-tool'] })
  assert.deepEqual(n.agentOptions, { model: 'glm-5.3', provider: 'config-llm', maxTokens: 2048 })

  // 无 role.overrides（general）→ 取 config
  await ctx.tool('subagent').execute(
    { description: 'config tier', prompt: 'Work.' },
    execFor(),
  )
  n = native.calls[2].native
  assert.equal(n.persona, 'config persona')
  assert.deepEqual(n.toolFilter, { deny: ['config-tool'] })
  assert.deepEqual(n.agentOptions, { provider: 'config-llm', model: 'config-model' })
  assert.equal(n.maxDepth, 5)
})

// ---- 附加：工具注册面 / 可用性 / 后台开关 / systemPrompt / render ----

test('registers under deps.toolName (default subagent) and the backend enum lists detected bridges only', () => {
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge: fakeBridgeDriver() })
  const ctxDefault = fakeCtx()
  registerSubagentTool(ctxDefault, { assembled, roles: fakeRoles({ general: GENERAL }), config: {} })
  assert.ok(ctxDefault.tool('subagent'))
  assert.deepEqual(
    ctxDefault.tool('subagent').parameters.properties.backend.enum,
    ['native', 'codex'],
  )

  const ctxNamed = fakeCtx()
  registerSubagentTool(ctxNamed, {
    assembled: fakeAssembled({ native: fakeNativeDriver() }).assembled,
    roles: fakeRoles({ general: GENERAL }),
    config: {},
    toolName: 'delegate_task',
  })
  assert.ok(ctxNamed.tool('delegate_task'))
  assert.deepEqual(ctxNamed.tool('delegate_task').parameters.properties.backend.enum, ['native'])
})

test('bridge backend that is not available throws with its reason', async () => {
  const bridge = fakeBridgeDriver({ registered: false, reason: 'codex CLI not found on PATH' })
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, { assembled, roles: fakeRoles({ general: GENERAL }), config: {} })
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', backend: 'codex' },
      execFor(),
    ),
    (err) => err.message.includes('backend "codex" is not available')
      && err.message.includes('codex CLI not found on PATH'),
  )
  assert.equal(bridge.calls.length, 0)
})

test('run_in_background=true under enableRunInBackground=false throws the CW message', async () => {
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge: fakeBridgeDriver() })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, {
    assembled,
    roles: fakeRoles({ general: GENERAL }),
    config: { enableRunInBackground: false },
  })
  await assert.rejects(
    () => ctx.tool('subagent').execute(
      { description: 'x', prompt: 'y', run_in_background: true },
      execFor(),
    ),
    /run_in_background is disabled for this tool instance/,
  )
})

test('systemPrompt section registers only for continuable deployments and mentions the backend parameter', async () => {
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge: fakeBridgeDriver() })
  const roles = fakeRoles({ general: GENERAL })

  const ctxContinuable = fakeCtx()
  registerSubagentTool(ctxContinuable, {
    assembled,
    roles,
    config: { backgroundMode: 'continuable' },
  })
  assert.equal(ctxContinuable.sections.length, 1)
  assert.equal(ctxContinuable.sections[0].name, 'tool:subagent')
  assert.equal(ctxContinuable.sections[0].order, 116.5)
  const text = ctxContinuable.sections[0].text({ scope: 'any' })
  assert.match(text, /in the background by default/)
  assert.match(text, /`backend` parameter selects an external agent CLI/)
  assert.match(text, /default is native/)

  const ctxOneShot = fakeCtx()
  registerSubagentTool(ctxOneShot, {
    assembled: fakeAssembled({ native: fakeNativeDriver() }).assembled,
    roles,
    config: {},
  })
  assert.equal(ctxOneShot.sections.length, 0, 'one-shot deployments get no background-usage section')
})

test('render: background job id / continuable child / foreground output text (CW wording)', async () => {
  const { assembled } = fakeAssembled({ native: fakeNativeDriver(), bridge: fakeBridgeDriver() })
  const ctx = fakeCtx()
  registerSubagentTool(ctx, { assembled, roles: fakeRoles({ general: GENERAL }), config: {} })
  const render = ctx.tool('subagent').output.render
  assert.deepEqual(render({}, { kind: 'background', job_id: 'job-3' }), [{
    type: 'text',
    text: 'started background subagent task job-3',
  }])
  assert.deepEqual(render({}, { kind: 'continuable', child_id: 'c-1', backend: 'codex', role: 'general' }), [{
    type: 'text',
    text: 'started subagent c-1 (backend codex, role general)',
  }])
  assert.deepEqual(render({}, { kind: 'foreground', output: [{ type: 'text', text: 'answer' }] }), [{
    type: 'text',
    text: 'answer',
  }])
})

test('registerSubagentTool validates the deps wiring loudly', () => {
  const roles = fakeRoles({ general: GENERAL })
  assert.throws(
    () => registerSubagentTool(fakeCtx(), { roles, config: {} }),
    /requires deps\.assembled with native\.spawn/,
  )
  assert.throws(
    () => registerSubagentTool(fakeCtx(), {
      assembled: { native: { spawn: fakeNativeDriver() }, bridges: { codex: fakeBridgeDriver() } },
      roles,
      config: {},
    }),
    /bridges to be a Map/,
  )
})
