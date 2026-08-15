// dsh-plugin-subagents — NativeDriver 测试（T08）。
//
// 覆盖：
//   - 驱动元数据（id/kind/inheritsParentContext/capabilities = NATIVE_CAPS）
//     与 createNativeDriver 的 config.maxDepth 校验（CW apply() 行为随迁）；
//   - 三路由输出 kind（sync 含 output/settle、job 含 jobId、continuable 含
//     childId/backend）；
//   - per-call 字段透传（agentOptions/persona/toolFilter/cwd/provider/maxDepth
//     到达伪 start 的 request）；
//   - `@preset:` 解析（目录 id / 显示名 / 缺 persona / 不存在；presetsRoot 注入）；
//   - `provider/model` 组合 id 拆分（复合覆盖 provider、裸 id 不动、保留 maxTokens）；
//   - cwd 补丁 stamp 门控（两枚 applied → 放行；一枚 native（非 verified）→ throw；
//     stamp 缺失 / 非 JSON / 字段不全 → throw；native-verified 混合 applied → 放行）；
//   - cwd 值断言（相对路径 → assertCwd throw，CW 原文案）；
//   - settleForegroundRun 语义（stopReason≠completed → throw 含 partial output；
//     disposal 聚合错误；未知 stopReason）；
//   - jobs 缺失 + job 路由 → throw（CW 原文案）；job done 的 killed/failed 语义；
//   - available() 两态、progress 最小快照、dispose no-op；
//   - native-delegate 纯函数单测（resolveModelRoute/outputValueText/
//     providerWording/resolveDelegationRun/stopReasonError/withPartialText）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNativeDriver } from '../lib/drivers/native.js'
import { NATIVE_CAPS } from '../lib/drivers/types.js'
import {
  resolveModelRoute,
  outputValueText,
  providerWording,
  resolveDelegationRun,
  stopReasonError,
  withPartialText,
} from '../lib/native-delegate.js'

// ---- fixtures ----

/** 伪 SubagentRun：{id, result: Promise<{stopReason, output}>, dispose()}。 */
function makeRun({
  id = 'run-7',
  stopReason = 'completed',
  output = [{ type: 'text', text: 'scout done' }],
  reject,
  dispose,
} = {}) {
  return {
    id,
    result: reject === undefined ? Promise.resolve({ stopReason, output }) : Promise.reject(reject),
    dispose: dispose === undefined ? () => Promise.resolve() : () => Promise.reject(dispose),
  }
}

/** 伪宿主 ctx：subagents.start/startContinuable/getProvider(/listChildren) + ctx.get('jobs')。 */
function fakeCtx({
  run,
  startError,
  startWaitsForAbort = false,
  childId = 'child-42',
  providerNames = ['spawn', 'fork'],
  children,
  jobs,
} = {}) {
  const calls = { start: [], startContinuable: [] }
  const ctx = {
    subagents: {
      getProvider: (name) => (providerNames.includes(name) ? { name, capabilities: {} } : undefined),
      start: async (providerName, request) => {
        calls.start.push({ providerName, request })
        if (startWaitsForAbort) {
          // 让 start 在 abort 事件后才拒绝，使 settleStart 的 killed 分支可确定性地观测。
          await new Promise((resolve) => {
            if (request.signal?.aborted) resolve()
            else request.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        if (startError !== undefined) throw startError
        return run ?? makeRun()
      },
      startContinuable: async (spec) => {
        calls.startContinuable.push(spec)
        return { childId, messageId: 'msg-1' }
      },
    },
    get: (name) => (name === 'jobs' ? jobs : undefined),
  }
  if (children !== undefined) ctx.subagents.listChildren = async () => children
  return { ctx, calls }
}

/** 伪 jobs 服务：立即调 spec.run() 并返回 job id。 */
function fakeJobs() {
  const specs = []
  const handles = []
  return {
    specs,
    handles,
    start(spec) {
      specs.push(spec)
      const handle = spec.run()
      handles.push(handle)
      return `job-${specs.length}`
    },
  }
}

/** 基准 DelegateRequest（sync 路由）。 */
function baseRequest(overrides = {}) {
  return {
    label: 'scout the repo',
    task: 'Read the repo and report.',
    parent: { id: 'parent-agent' },
    signal: new AbortController().signal,
    route: 'sync',
    native: {},
    ...overrides,
  }
}

/** T16 安装脚本同形的 stamp JSON 文档。 */
function stampDoc(patches, extra = {}) {
  return {
    dshVersion: '0.1.0-rc.6',
    liveRoot: '/fake/live-root',
    appliedAt: '2025-01-01T00:00:00.000Z',
    patches,
    mtimes: { inProcessDriver: 111, subagentBundle: 222 },
    ...extra,
  }
}

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plugin-subagents-t08-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const PERSONA_YAML = ['- id: persona', '  config:', '    text: You are the scout preset persona.'].join('\n')

// ---- 驱动元数据与构造校验 ----

test('spawn driver metadata: id/kind/inheritsParentContext/capabilities', () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  assert.equal(driver.id, 'native:spawn')
  assert.equal(driver.kind, 'native')
  assert.equal(driver.inheritsParentContext, false)
  assert.strictEqual(driver.capabilities, NATIVE_CAPS)
})

test('fork driver metadata: id and inheritsParentContext=true', () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  assert.equal(driver.id, 'native:fork')
  assert.equal(driver.inheritsParentContext, true)
})

test('createNativeDriver rejects unknown kind', () => {
  const { ctx } = fakeCtx()
  assert.throws(
    () => createNativeDriver({ kind: 'acp', ctx, config: { provider: 'acp' } }),
    /kind must be 'spawn' or 'fork'/,
  )
})

test('createNativeDriver validates numeric config.maxDepth (CW apply() behavior)', () => {
  const { ctx } = fakeCtx()
  assert.throws(
    () => createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn', maxDepth: -1 } }),
    /subagent maxDepth must be a non-negative safe integer/,
  )
  assert.doesNotThrow(() => createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn', maxDepth: 0 } }))
  assert.doesNotThrow(() => createNativeDriver({
    kind: 'spawn',
    ctx,
    config: { provider: 'spawn', maxDepth: 'provider-managed' },
  }))
})

// ---- 三路由 ----

test('sync route settles to foreground outcome with output and stopReason completed', async () => {
  const run = makeRun({ id: 'run-7', output: [{ type: 'text', text: 'scout done' }] })
  const { ctx, calls } = fakeCtx({ run })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  const req = baseRequest()
  const outcome = await driver.start(req)
  assert.deepEqual(outcome, {
    kind: 'foreground',
    runId: 'run-7',
    output: [{ type: 'text', text: 'scout done' }],
    stopReason: 'completed',
  })
  // provider 来自 config，request 形状对齐 CW：prompt 文本块 + parent + signal。
  assert.equal(calls.start.length, 1)
  assert.equal(calls.start[0].providerName, 'spawn')
  assert.deepEqual(calls.start[0].request.prompt, [{ type: 'text', text: 'Read the repo and report.' }])
  assert.equal(calls.start[0].request.parent, req.parent)
  assert.equal(calls.start[0].request.signal, req.signal)
})

test('job route returns job id and forwards spec to jobs.start', async () => {
  const jobs = fakeJobs()
  const { ctx } = fakeCtx({ jobs })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  const parent = { id: 'parent-agent' }
  const outcome = await driver.start(baseRequest({ route: 'job', parent }))
  assert.deepEqual(outcome, { kind: 'job', jobId: 'job-1' })
  assert.equal(jobs.specs.length, 1)
  assert.equal(jobs.specs[0].kind, 'subagent')
  assert.equal(jobs.specs[0].label, 'scout the repo')
  assert.equal(jobs.specs[0].owner, parent)
})

test('job route run handle passes abort to ctx.subagents.start signal and settles completed', async () => {
  const jobs = fakeJobs()
  const { ctx, calls } = fakeCtx({ jobs })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ route: 'job' }))
  const handle = jobs.handles[0]
  assert.equal(calls.start.length, 1)
  handle.cancel('test kill')
  assert.equal(calls.start[0].request.signal.aborted, true)
  assert.deepEqual(await handle.done, { status: 'completed', output: 'scout done' })
})

test('continuable route returns childId and backend, startContinuable spec matches CW shape', async () => {
  const { ctx, calls } = fakeCtx({ childId: 'child-42' })
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  const signal = new AbortController().signal
  const req = baseRequest({ route: 'continuable', signal })
  const outcome = await driver.start(req)
  assert.deepEqual(outcome, { kind: 'continuable', childId: 'child-42', backend: 'native:fork' })
  const spec = calls.startContinuable[0]
  assert.equal(spec.provider, 'fork')
  assert.equal(spec.label, 'scout the repo')
  assert.equal(spec.signal, signal)
  // CW 语义：signal 在 spec 顶层，request 本体不带 signal。
  assert.equal(spec.request.signal, undefined)
  assert.equal(spec.request.parent, req.parent)
})

test('unknown route throws loudly', async () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest({ route: 'weird' })),
    /unknown delegation route "weird"/,
  )
})

test('missing provider (neither config nor per-call) throws', async () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: {} })
  await assert.rejects(() => driver.start(baseRequest()), /has no subagent provider/)
})

// ---- per-call 字段透传 ----

test('per-call agentOptions/persona/toolFilter/maxDepth reach ctx.subagents.start', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({
    native: {
      provider: 'spawn',
      agentOptions: { model: 'glm-5.3', maxTokens: 4096 },
      persona: 'You are terse.',
      toolFilter: { deny: ['write', 'edit'] },
      maxDepth: 2,
    },
  }))
  const request = calls.start[0].request
  assert.deepEqual(request.agentOptions, { model: 'glm-5.3', maxTokens: 4096 })
  assert.equal(request.persona, 'You are terse.')
  assert.deepEqual(request.toolFilter, { deny: ['write', 'edit'] })
  assert.equal(request.maxDepth, 2)
})

test('omitted per-call fields stay omitted (no empty agentOptions/persona/toolFilter keys)', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest())
  const request = calls.start[0].request
  assert.equal('agentOptions' in request, false)
  assert.equal('persona' in request, false)
  assert.equal('toolFilter' in request, false)
  assert.equal('maxDepth' in request, false)
  assert.equal('cwd' in request, false)
})

test('maxDepth "provider-managed" is not forwarded as a request field', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ native: { maxDepth: 'provider-managed' } }))
  assert.equal('maxDepth' in calls.start[0].request, false)
})

test('per-call provider overrides config.provider', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ native: { provider: 'fork' } }))
  assert.equal(calls.start[0].providerName, 'fork')
})

// ---- @preset: 解析（presetsRoot 注入） ----

test('@preset:<directory id> resolves persona text from agent.cordis.yml', async () => {
  await withTmpDir(async (root) => {
    await mkdir(join(root, 'scout'))
    await writeFile(join(root, 'scout', 'agent.cordis.yml'), PERSONA_YAML, 'utf8')
    const { ctx, calls } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      presetsRoot: root,
    })
    await driver.start(baseRequest({ native: { persona: '@preset:scout' } }))
    assert.equal(calls.start[0].request.persona, 'You are the scout preset persona.')
  })
})

test('@preset:<display name> resolves via preset.yml name', async () => {
  await withTmpDir(async (root) => {
    await mkdir(join(root, 'preset-dir'))
    await writeFile(join(root, 'preset-dir', 'preset.yml'), 'name: Scout Display\n', 'utf8')
    await writeFile(join(root, 'preset-dir', 'agent.cordis.yml'), PERSONA_YAML, 'utf8')
    const { ctx, calls } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      presetsRoot: root,
    })
    await driver.start(baseRequest({ native: { persona: '@preset:Scout Display' } }))
    assert.equal(calls.start[0].request.persona, 'You are the scout preset persona.')
  })
})

test('@preset: with no persona entry throws CW message', async () => {
  await withTmpDir(async (root) => {
    await mkdir(join(root, 'broken'))
    await writeFile(join(root, 'broken', 'agent.cordis.yml'), '- id: tools\n  config: {}\n', 'utf8')
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      presetsRoot: root,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ native: { persona: '@preset:broken' } })),
      /agent preset "broken" has no persona text/,
    )
  })
})

test('@preset: unknown id throws CW not-found message', async () => {
  await withTmpDir(async (root) => {
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      presetsRoot: root,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ native: { persona: '@preset:missing' } })),
      /agent preset "missing" not found under/,
    )
  })
})

// ---- provider/model 组合 id 拆分 ----

test('composite model id splits into agentOptions provider+model overrides', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ native: { agentOptions: { model: 'kimi-code/k3' } } }))
  assert.deepEqual(calls.start[0].request.agentOptions, { provider: 'kimi-code', model: 'k3' })
})

test('composite model id overrides an explicit agentOptions.provider but keeps other keys', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({
    native: { agentOptions: { provider: 'newapi', model: 'kimi-code/k3', maxTokens: 8192 } },
  }))
  // CW 语义：组合 id 的 provider 段覆盖 agentOptions.provider（后展开）。
  assert.deepEqual(calls.start[0].request.agentOptions, { provider: 'kimi-code', model: 'k3', maxTokens: 8192 })
})

test('bare model id stays bare (no provider override)', async () => {
  const { ctx, calls } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ native: { agentOptions: { model: 'glm-5.3', maxTokens: 1024 } } }))
  assert.deepEqual(calls.start[0].request.agentOptions, { model: 'glm-5.3', maxTokens: 1024 })
})

// ---- cwd：值断言 + 补丁 stamp 门控（勘误 2 语义） ----

test('relative cwd throws CW assertCwd message regardless of stamp', async () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest({ native: { cwd: 'relative/dir' } })),
    /cwd must be an absolute path: relative\/dir/,
  )
})

test('cwd with stamp both applied is forwarded (stamp injected to tmp)', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    await writeFile(stampPath, JSON.stringify(stampDoc({
      inProcessDriver: 'applied',
      subagentBundle: 'applied',
    })), 'utf8')
    const { ctx, calls } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await driver.start(baseRequest({ native: { cwd: root } }))
    assert.equal(calls.start[0].request.cwd, root)
  })
})

test('cwd passes when one patch is applied and the other native-verified', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    await writeFile(stampPath, JSON.stringify(stampDoc({
      inProcessDriver: 'native-verified',
      subagentBundle: 'applied',
    })), 'utf8')
    const { ctx, calls } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await driver.start(baseRequest({ native: { cwd: root } }))
    assert.equal(calls.start[0].request.cwd, root)
  })
})

test('cwd throws with install guidance when one patch state is bare "native"', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    await writeFile(stampPath, JSON.stringify(stampDoc({
      inProcessDriver: 'applied',
      subagentBundle: 'native',
    })), 'utf8')
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ native: { cwd: root } })),
      (err) => err.message.includes('run patches/install.sh from the dsh-plugin-subagents package')
        && err.message.includes('subagentBundle="native"'),
    )
  })
})

test('cwd throws with install guidance when the stamp file is missing', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ native: { cwd: root } })),
      /stamp file missing or unreadable.*run patches\/install\.sh from the dsh-plugin-subagents package/s,
    )
  })
})

test('cwd throws when the stamp file is not valid JSON', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    await writeFile(stampPath, 'not json {{{', 'utf8')
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ native: { cwd: root } })),
      /stamp file is not valid JSON/,
    )
  })
})

test('cwd throws when the stamp lacks one patch state (incomplete fields)', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    await writeFile(stampPath, JSON.stringify(stampDoc({ inProcessDriver: 'applied' })), 'utf8')
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ native: { cwd: root } })),
      /subagentBundle=undefined/,
    )
  })
})

test('cwd gate applies to the continuable route too', async () => {
  await withTmpDir(async (root) => {
    const stampPath = join(root, '.applied')
    const { ctx } = fakeCtx()
    const driver = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: { provider: 'spawn' },
      stampPath,
    })
    await assert.rejects(
      () => driver.start(baseRequest({ route: 'continuable', native: { cwd: root } })),
      /stamp file missing or unreadable/,
    )
  })
})

// ---- settleForegroundRun 语义（CW 逐行等价） ----

test('non-completed stopReason throws with partial output appended', async () => {
  const run = makeRun({
    stopReason: 'max-tokens',
    output: [{ type: 'text', text: 'partial answer' }],
  })
  const { ctx } = fakeCtx({ run })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest()),
    (err) => err.message.includes('subagent run hit its token limit before finishing')
      && err.message.includes('Partial output before the run ended:\npartial answer'),
  )
})

test('non-completed stopReason without output has no partial section', async () => {
  const run = makeRun({ stopReason: 'error', output: [] })
  const { ctx } = fakeCtx({ run })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest()),
    (err) => err.message === 'subagent run failed' && !err.message.includes('Partial output'),
  )
})

test('unknown stopReason maps to the abnormal-end wording', async () => {
  const run = makeRun({ stopReason: 'mystery' })
  const { ctx } = fakeCtx({ run })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest()),
    /subagent run ended abnormally \(mystery\)/,
  )
})

test('successful result with failing dispose throws the disposal error (CW semantics)', async () => {
  const run = makeRun({ dispose: new Error('dispose boom') })
  const { ctx } = fakeCtx({ run })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(() => driver.start(baseRequest()), /dispose boom/)
})

test('failed result and failed dispose aggregate both errors', async () => {
  const run = makeRun({
    stopReason: 'aborted',
    output: [{ type: 'text', text: 'half work' }],
    dispose: new Error('dispose boom'),
  })
  const { ctx } = fakeCtx({ run })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest()),
    (err) => err instanceof AggregateError
      && err.message.includes('subagent run was cancelled')
      && err.message.includes('dispose failed: Error: dispose boom'),
  )
})

// ---- job 路由语义 ----

test('job route without a jobs service throws the CW message', async () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.rejects(
    () => driver.start(baseRequest({ route: 'job' })),
    /background jobs unavailable: load @deepseek-ai\/dsh-jobs and @deepseek-ai\/dsh-tool-jobs/,
  )
})

test('job done settles killed when the run stopReason is aborted (real settleRun)', async () => {
  const jobs = fakeJobs()
  const { ctx } = fakeCtx({ jobs, run: makeRun({ stopReason: 'aborted', output: [] }) })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ route: 'job' }))
  assert.deepEqual(await jobs.handles[0].done, { status: 'killed' })
})

test('job done settles failed with the stopReason as detail', async () => {
  const jobs = fakeJobs()
  const { ctx } = fakeCtx({ jobs, run: makeRun({ stopReason: 'error', output: [] }) })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ route: 'job' }))
  assert.deepEqual(await jobs.handles[0].done, { status: 'failed', detail: 'error' })
})

test('job start rejection after cancel settles killed; without cancel settles failed', async () => {
  // killed 分支：start 等 abort 事件后才拒绝（真实世界里 start 在运行期被杀），
  // settleStart 的 catch 观测到 signal.aborted → killed（确定性，无微任务竞态）。
  const jobs = fakeJobs()
  const { ctx } = fakeCtx({ jobs, startError: new Error('start exploded'), startWaitsForAbort: true })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await driver.start(baseRequest({ route: 'job' }))
  jobs.handles[0].cancel('kill it')
  assert.deepEqual(await jobs.handles[0].done, { status: 'killed' })

  // failed 分支：start 在未 abort 时拒绝 → detail 保留原始错误。
  const jobs2 = fakeJobs()
  const { ctx: ctx2 } = fakeCtx({ jobs: jobs2, startError: new Error('start exploded') })
  const driver2 = createNativeDriver({ kind: 'spawn', ctx: ctx2, config: { provider: 'spawn' } })
  await driver2.start(baseRequest({ route: 'job' }))
  const settled = await jobs2.handles[0].done
  assert.equal(settled.status, 'failed')
  assert.match(settled.detail, /start exploded/)
})

// ---- available / progress / dispose ----

test('available(): registered when the configured provider exists', () => {
  const { ctx } = fakeCtx({ providerNames: ['spawn', 'fork'] })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  assert.equal(driver.available().registered, true)
})

test('available(): not registered when the provider is missing', () => {
  const { ctx } = fakeCtx({ providerNames: ['fork'] })
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  const availability = driver.available()
  assert.equal(availability.registered, false)
  assert.match(availability.reason, /"spawn" is not registered yet/)
})

test('progress(): minimal snapshot from listChildren (label + activity)', async () => {
  const children = [
    { kind: 'diagnostic', id: 'diag-1', reason: 'corrupt' },
    { kind: 'child', id: 'child-42', activity: 'running', mode: 'continuable', label: 'scout the repo', hasChildren: false },
  ]
  const { ctx } = fakeCtx({ children })
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  assert.deepEqual(await driver.progress('child-42'), {
    childId: 'child-42',
    status: 'running',
    label: 'scout the repo',
  })
})

test('progress(): inactive child maps to inactive status', async () => {
  const children = [{ kind: 'child', id: 'child-42', activity: 'inactive', mode: 'continuable', label: 'x', hasChildren: false }]
  const { ctx } = fakeCtx({ children })
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  assert.equal((await driver.progress('child-42')).status, 'inactive')
})

test('progress(): unknown when the child is not listed', async () => {
  const { ctx } = fakeCtx({ children: [] })
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  assert.deepEqual(await driver.progress('child-42'), { childId: 'child-42', status: 'unknown' })
})

test('progress(): unknown when listChildren is unavailable', async () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'fork', ctx, config: { provider: 'fork' } })
  assert.deepEqual(await driver.progress('child-42'), { childId: 'child-42', status: 'unknown' })
})

test('progress(): scopes listChildren to the given parent session id (T08 fix)', async () => {
  const children = [{ kind: 'child', id: 'child-42', activity: 'running', mode: 'continuable', label: 'x', hasChildren: false }]
  const { ctx } = fakeCtx({ children })
  const seen = []
  const original = ctx.subagents.listChildren
  ctx.subagents.listChildren = async (...args) => {
    seen.push(args)
    return original(...args)
  }
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  const snapshot = await driver.progress('child-42', 'parent-7')
  // dsh-subagent's seam is listChildren(parentSessionId, signal): the parent
  // session id string (NOT an Agent object) must reach it verbatim.
  assert.deepEqual(seen, [['parent-7']])
  assert.equal(snapshot.status, 'running')
})

test('progress(): without a parent keeps the legacy unscoped listing (T08 fix, back-compat)', async () => {
  const children = [{ kind: 'child', id: 'child-42', activity: 'inactive', mode: 'continuable', label: 'x', hasChildren: false }]
  const { ctx } = fakeCtx({ children })
  const seen = []
  const original = ctx.subagents.listChildren
  ctx.subagents.listChildren = async (...args) => {
    seen.push(args)
    return original(...args)
  }
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  assert.equal((await driver.progress('child-42')).status, 'inactive')
  assert.deepEqual(seen, [[undefined]])
})

test('dispose(): no-op that resolves', async () => {
  const { ctx } = fakeCtx()
  const driver = createNativeDriver({ kind: 'spawn', ctx, config: { provider: 'spawn' } })
  await assert.doesNotReject(() => driver.dispose('child-42'))
})

// ---- native-delegate 纯函数单测 ----

test('resolveModelRoute: non-string / bare / composite', () => {
  assert.deepEqual(resolveModelRoute(undefined), { provider: undefined, model: undefined })
  assert.deepEqual(resolveModelRoute(42), { provider: undefined, model: undefined })
  assert.deepEqual(resolveModelRoute('k3'), { provider: undefined, model: 'k3' })
  assert.deepEqual(resolveModelRoute('kimi-code/k3'), { provider: 'kimi-code', model: 'k3' })
  assert.deepEqual(resolveModelRoute('a/b/c'), { provider: 'a', model: 'b/c' })
})

test('outputValueText: only string text blocks survive', () => {
  assert.equal(outputValueText([
    { type: 'text', text: 'a' },
    { type: 'image', url: 'x' },
    null,
    [1, 2],
    { type: 'text', text: 'b' },
    { type: 'text', text: 7 },
  ]), 'ab')
})

test('providerWording: fork vs spawn wording', () => {
  const fork = providerWording(true)
  const spawn = providerWording(false)
  assert.match(fork.description, /inherits this conversation/)
  assert.match(fork.promptDescription, /state only what is new/)
  assert.match(spawn.description, /does not see this conversation/)
  assert.match(spawn.promptDescription, /include everything it needs/)
})

test('resolveDelegationRun: disabled / defaults / explicit', () => {
  assert.throws(
    () => resolveDelegationRun({ run_in_background: true }, { backgroundEnabled: false }),
    /run_in_background is disabled for this tool instance/,
  )
  assert.deepEqual(resolveDelegationRun({}, { backgroundEnabled: false }), { runInBackground: false })
  assert.deepEqual(
    resolveDelegationRun({}, { backgroundEnabled: true, continuable: true }),
    { runInBackground: true },
  )
  assert.deepEqual(
    resolveDelegationRun({}, { backgroundEnabled: true, continuable: false }),
    { runInBackground: false },
  )
  assert.deepEqual(
    resolveDelegationRun({ run_in_background: false }, { backgroundEnabled: true, continuable: true }),
    { runInBackground: false },
  )
})

test('stopReasonError / withPartialText matrix', () => {
  assert.equal(stopReasonError({ stopReason: 'completed' }), undefined)
  assert.equal(stopReasonError({ stopReason: 'aborted' }), 'subagent run was cancelled')
  assert.equal(stopReasonError({ stopReason: 'error' }), 'subagent run failed')
  assert.equal(stopReasonError({ stopReason: 'refusal' }), 'subagent declined the task')
  assert.equal(withPartialText('boom', []), 'boom')
  assert.equal(
    withPartialText('boom', [{ type: 'text', text: 'half ' }, { type: 'text', text: 'work' }]),
    'boom\nPartial output before the run ended:\nhalf work',
  )
})
