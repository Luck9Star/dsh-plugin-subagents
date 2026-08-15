// dsh-plugin-subagents — `subagent_fork` 工具测试（T12）。
//
// 覆盖 TASKS T12 验收（fork 侧）：
//   - 极简面：schema 恰为官方 fork 面 + per-call 覆盖（无 backend / role /
//     permission_mode / reasoning_effort）；默认注册名 subagent_fork，可经
//     deps.toolName 覆盖；
//   - `inherits conversation` 文案取 providerWording(true)（fork 继承父上下文，
//     prompt 表述「只说新内容」）；one-shot 默认（省略 run_in_background →
//     sync；显式 true → job）；
//   - bridge 专属参数（permission_mode / reasoning_effort）→ assertParamsSupported
//     以 fork driver 的 NATIVE_CAPS throw（消息含参数名与 native:fork）；
//     schema 未声明的 backend / role 显式传入 → fork 守卫 loud（红线 8）；
//   - per-call 覆盖透传：model（provider/model 组合拆分）/ persona / toolFilter /
//     cwd / provider；config.fork 默认在 args 缺席时生效、被 args 覆盖
//     （次序 args > config.fork）；
//   - 默认 provider=fork：真实 native fork driver + fake ctx 证
//     ctx.subagents.start 收到 provider 'fork'（工具层不传时驱动回落实例配置）；
//   - fork.backgroundMode=continuable：默认路由 continuable + systemPrompt 段
//     （order 116.5、fork 文案、无 backend 句）；one-shot 部署无该段；
//   - 输出三态映射（蛇形字段，continuable 无 role/permission_mode）与 render；
//     enableRunInBackground=false 时显式 true → CW 原文案 loud；
//   - deps 装配校验（缺 assembled.native.fork → loud）。
//
// 全部 fake：fakeCtx 记录 tools.register / systemPrompt.section、fake fork
// driver 记录 start 入参；默认 provider 用例走真实 createNativeDriver + fake
// ctx.subagents.start —— 无真实 CLI、无密钥。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSubagentFork } from '../lib/tools/subagent-fork.js'
import { createNativeDriver } from '../lib/drivers/native.js'
import { NATIVE_CAPS } from '../lib/drivers/types.js'

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

/** 伪 native fork 驱动：记录 start 入参，返回可注入 outcome。 */
function fakeForkDriver({ outcome } = {}) {
  const calls = []
  return {
    calls,
    id: 'native:fork',
    kind: 'native',
    inheritsParentContext: true,
    capabilities: NATIVE_CAPS,
    available: () => ({ registered: true, reason: 'native subagent provider "fork" is registered' }),
    async start(request) {
      calls.push(request)
      return outcome ?? {
        kind: 'foreground',
        runId: 'run-1',
        output: [{ type: 'text', text: 'fork done' }],
        stopReason: 'completed',
      }
    },
  }
}

/** 假 assembled：assembleDrivers 产物中 fork 工具消费的最小子集。 */
function fakeAssembled(driver) {
  return { native: { fork: driver } }
}

const execFor = (sessionId = 'root-1') => ({
  agent: { id: 'agent', session: { id: sessionId } },
  signal: new AbortController().signal,
})

// ---- 极简面与文案 ----

test('registers as subagent_fork (or deps.toolName) with exactly the minimal native-only parameter face', () => {
  const ctxDefault = fakeCtx()
  registerSubagentFork(ctxDefault, { assembled: fakeAssembled(fakeForkDriver()), config: {} })
  const tool = ctxDefault.tool('subagent_fork')
  assert.ok(tool, 'default tool name is subagent_fork')
  // 极简面：官方 fork 面 + per-call 覆盖，且 ONLY 这些 —— 无 backend / role /
  // permission_mode / reasoning_effort（§5.3 末行：fork 无角色/后端语义）
  assert.deepEqual(
    Object.keys(tool.parameters.properties).sort(),
    ['cwd', 'description', 'model', 'persona', 'prompt', 'provider', 'run_in_background', 'toolFilter'],
  )

  const ctxNamed = fakeCtx()
  registerSubagentFork(ctxNamed, {
    assembled: fakeAssembled(fakeForkDriver()),
    config: {},
    toolName: 'fork_task',
  })
  assert.ok(ctxNamed.tool('fork_task'))
})

test('description uses providerWording(true): inherits this conversation; prompt says state only what is new', () => {
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(fakeForkDriver()), config: {} })
  const tool = ctx.tool('subagent_fork')
  assert.match(tool.description, /inherits this conversation/)
  assert.match(tool.description, /It does not see the current in-flight turn|does not see the current/)
  assert.doesNotMatch(tool.description, /does not share this conversation/, 'spawn wording must not leak into fork')
  const prompt = tool.parameters.properties.prompt
  assert.match(prompt.description, /already sees this conversation/)
  assert.match(prompt.description, /state only what is new/)
})

// ---- one-shot 默认与路由 ----

test('one-shot default: omitted run_in_background → sync; explicit true → job', async () => {
  const driver = fakeForkDriver()
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(driver), config: {} })

  await ctx.tool('subagent_fork').execute({ description: 'review this', prompt: 'Continue the analysis.' }, execFor())
  assert.equal(driver.calls[0].route, 'sync', 'official fork semantics: waits for the result by default')
  assert.equal(driver.calls[0].task, 'Continue the analysis.')

  await ctx.tool('subagent_fork').execute(
    { description: 'bg fork', prompt: 'Do it.', run_in_background: true },
    execFor(),
  )
  assert.equal(driver.calls[1].route, 'job')
})

test('run_in_background=true under fork enableRunInBackground=false throws the CW message', async () => {
  const driver = fakeForkDriver()
  const ctx = fakeCtx()
  registerSubagentFork(ctx, {
    assembled: fakeAssembled(driver),
    config: { fork: { enableRunInBackground: false } },
  })
  await assert.rejects(
    () => ctx.tool('subagent_fork').execute(
      { description: 'x', prompt: 'y', run_in_background: true },
      execFor(),
    ),
    /run_in_background is disabled for this tool instance/,
  )
  assert.equal(driver.calls.length, 0)
})

// ---- bridge 参数与入口参数守卫（红线 8） ----

test('bridge-specific params throw via assertParamsSupported under the fork driver caps (native:fork)', async () => {
  const driver = fakeForkDriver()
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(driver), config: {} })

  await assert.rejects(
    () => ctx.tool('subagent_fork').execute(
      { description: 'x', prompt: 'y', permission_mode: 'full' },
      execFor(),
    ),
    (err) => err.message.includes('"permission_mode"') && err.message.includes('native:fork'),
  )
  await assert.rejects(
    () => ctx.tool('subagent_fork').execute(
      { description: 'x', prompt: 'y', reasoning_effort: 'high' },
      execFor(),
    ),
    (err) => err.message.includes('"reasoning_effort"') && err.message.includes('native:fork'),
  )
  assert.equal(driver.calls.length, 0, 'capability violations never reach the driver')
})

test('undeclared entry params backend/role are rejected loudly, not silently ignored', async () => {
  const driver = fakeForkDriver()
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(driver), config: {} })

  await assert.rejects(
    () => ctx.tool('subagent_fork').execute(
      { description: 'x', prompt: 'y', backend: 'codex' },
      execFor(),
    ),
    (err) => err.message.includes('subagent_fork') && err.message.includes('`backend`'),
  )
  await assert.rejects(
    () => ctx.tool('subagent_fork').execute(
      { description: 'x', prompt: 'y', role: 'codex-full' },
      execFor(),
    ),
    (err) => err.message.includes('subagent_fork') && err.message.includes('`role`'),
  )
  assert.equal(driver.calls.length, 0)
})

// ---- per-call 覆盖透传与 config.fork 合并（次序 args > config.fork） ----

test('per-call overrides pass through: composite model, persona, toolFilter, cwd, provider', async () => {
  const driver = fakeForkDriver()
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(driver), config: {} })

  await ctx.tool('subagent_fork').execute(
    {
      description: 'tuned fork',
      prompt: 'Work.',
      model: 'kimi-code/k3',
      persona: 'args persona',
      toolFilter: { deny: ['write'] },
      cwd: '/tmp',
      provider: 'spawn',
    },
    execFor(),
  )
  const n = driver.calls[0].native
  // `provider/model` 组合 id 同时切换 LLM provider；provider 参数选的是
  // SUBAGENT 后端（此处 spawn），两者互不相干
  assert.deepEqual(n.agentOptions, { provider: 'kimi-code', model: 'k3' })
  assert.equal(n.persona, 'args persona')
  assert.deepEqual(n.toolFilter, { deny: ['write'] })
  assert.equal(n.cwd, '/tmp')
  assert.equal(n.provider, 'spawn')
})

test('config.fork defaults apply when args omit them; args win over config.fork', async () => {
  const driver = fakeForkDriver()
  const ctx = fakeCtx()
  registerSubagentFork(ctx, {
    assembled: fakeAssembled(driver),
    config: {
      fork: {
        provider: 'fork',
        agentOptions: { model: 'config-model', maxTokens: 1024 },
        persona: 'fork config persona',
        toolFilter: { deny: ['config-tool'] },
        maxDepth: 2,
      },
    },
  })

  // args 全部缺席 → config.fork 默认生效
  await ctx.tool('subagent_fork').execute({ description: 'defaults', prompt: 'Work.' }, execFor())
  let n = driver.calls[0].native
  assert.equal(n.provider, 'fork')
  assert.deepEqual(n.agentOptions, { model: 'config-model', maxTokens: 1024 })
  assert.equal(n.persona, 'fork config persona')
  assert.deepEqual(n.toolFilter, { deny: ['config-tool'] })
  assert.equal(n.maxDepth, 2)

  // args 覆盖 config.fork（model 组合 id 覆盖 agentOptions 同名字段，保留 maxTokens）
  await ctx.tool('subagent_fork').execute(
    { description: 'override', prompt: 'Work.', model: 'args-llm/args-model', persona: 'args persona', provider: 'spawn' },
    execFor(),
  )
  n = driver.calls[1].native
  assert.equal(n.provider, 'spawn')
  assert.deepEqual(n.agentOptions, { provider: 'args-llm', model: 'args-model', maxTokens: 1024 })
  assert.equal(n.persona, 'args persona')
})

// ---- 默认 provider=fork（真实 driver 证 ctx.subagents.start 收到 'fork'） ----

test('default subagent provider is fork: the real native fork driver starts provider "fork" when args omit it', async () => {
  const started = []
  const ctx = fakeCtx()
  ctx.subagents = {
    start: async (provider, request) => {
      started.push({ provider, request })
      return {
        id: 'run-real',
        result: Promise.resolve({ output: [{ type: 'text', text: 'real fork done' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  const toolCtx = fakeCtx()
  registerSubagentFork(toolCtx, { assembled: fakeAssembled(driver), config: {} })

  const out = await toolCtx.tool('subagent_fork').execute(
    { description: 'real fork', prompt: 'Continue here.' },
    execFor(),
  )
  assert.equal(started.length, 1)
  assert.equal(started[0].provider, 'fork', 'default provider falls back to the fork instance config')
  assert.deepEqual(
    started[0].request.prompt,
    [{ type: 'text', text: 'Continue here.' }],
  )
  assert.deepEqual(out, {
    kind: 'foreground',
    run_id: 'run-real',
    output: [{ type: 'text', text: 'real fork done' }],
    stop_reason: 'completed',
  })
})

// ---- fork.backgroundMode=continuable：默认路由 + systemPrompt 段 ----

test('fork.backgroundMode=continuable: default route continuable; background wording; systemPrompt section at 116.5', async () => {
  const driver = fakeForkDriver({ outcome: { kind: 'continuable', childId: 'c-1', backend: 'native:fork' } })
  const ctx = fakeCtx()
  registerSubagentFork(ctx, {
    assembled: fakeAssembled(driver),
    config: { fork: { backgroundMode: 'continuable' } },
  })

  assert.match(ctx.tool('subagent_fork').description, /runs in the background by default/)

  const out = await ctx.tool('subagent_fork').execute({ description: 'bg', prompt: 'Work.' }, execFor())
  assert.equal(driver.calls[0].route, 'continuable', 'omitted run_in_background defaults to true under fork continuable config')
  assert.deepEqual(out, { kind: 'continuable', child_id: 'c-1', backend: 'native:fork' }, 'no role/permission fields on fork outcomes')

  assert.equal(ctx.sections.length, 1)
  assert.equal(ctx.sections[0].name, 'tool:subagent_fork')
  assert.equal(ctx.sections[0].order, 116.5)
  const text = ctx.sections[0].text({ scope: 'any' })
  assert.match(text, /in the background by default/)
  assert.match(text, /inherits this conversation/)
  assert.doesNotMatch(text, /backend/, 'fork section never mentions the backend parameter it does not have')
})

test('one-shot deployments register no systemPrompt section', () => {
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(fakeForkDriver()), config: {} })
  assert.equal(ctx.sections.length, 0)
})

// ---- 输出三态映射与 render ----

test('outcome mapping and render: foreground snake fields / background job id / continuable child', async () => {
  const ctx = fakeCtx()
  registerSubagentFork(ctx, { assembled: fakeAssembled(fakeForkDriver()), config: {} })
  const render = ctx.tool('subagent_fork').output.render

  const outForeground = await ctx.tool('subagent_fork').execute(
    { description: 'sync', prompt: 'Work.' },
    execFor(),
  )
  assert.deepEqual(outForeground, {
    kind: 'foreground',
    run_id: 'run-1',
    output: [{ type: 'text', text: 'fork done' }],
    stop_reason: 'completed',
  })

  assert.deepEqual(render({}, { kind: 'background', job_id: 'job-3' }), [{
    type: 'text',
    text: 'started background subagent task job-3',
  }])
  assert.deepEqual(render({}, { kind: 'continuable', child_id: 'c-1', backend: 'native:fork' }), [{
    type: 'text',
    text: 'started subagent c-1 (backend native:fork)',
  }])
  assert.deepEqual(render({}, { kind: 'foreground', output: [{ type: 'text', text: 'answer' }] }), [{
    type: 'text',
    text: 'answer',
  }])
})

// ---- deps 装配校验 ----

test('registerSubagentFork validates the deps wiring loudly', () => {
  assert.throws(
    () => registerSubagentFork(fakeCtx(), { config: {} }),
    /requires deps\.assembled with native\.fork/,
  )
  assert.throws(
    () => registerSubagentFork(fakeCtx(), { assembled: { native: { spawn: fakeForkDriver() } }, config: {} }),
    /requires deps\.assembled with native\.fork/,
  )
})
