// dsh-plugin-subagents — NativeDriver（T08，DESIGN §3.4）。
//
// 原生 in-process 子代理驱动：spawn / fork 两实例共用本模块，差异仅在
// `id`（'native:spawn' | 'native:fork'）与 `inheritsParentContext`（fork = true，
// 子代理看到父会话完成回合；spawn / bridge = false）。
//
// 定位：一层「请求组装器 + 结果 settle 器」。请求组装/ settle 纯函数来自
// `../native-delegate.js`（legacy-cwd-plugin 抽出，逐行照搬）；本模块只做三路由
// 分发、cwd 补丁 stamp 门控、可用性与最小进度快照。**零补丁原则**：per-call
// `agentOptions`/`persona`/`toolFilter`/`maxDepth`/`label` 全部走 rc.6 原生
// request 字段；仅 `cwd` 依赖 `request.cwd` 透传 + §6.4 补丁。
//
// cwd 补丁 stamp 门控（§6.4.2 定稿语义）：
//   - stamp = `<pkg>/patches/.applied`（T16 安装脚本写入的 JSON：
//     `{ dshVersion, liveRoot, appliedAt, patches: { inProcessDriver, subagentBundle }, mtimes }`）；
//   - 放行条件 = 两枚补丁状态均为 `applied` 或 `native-verified`；
//   - 仅 `native`（版本白名单命中但未经 install 行为探针证实）**不产生任何
//     信任态** → 仍 throw 指引（「宁可误报漂移，不可误报 native」）；
//   - stamp 缺失 / 不可解析 / 字段不全 → 一律 throw 指引跑 `patches/install`。
//   stamp 每次带 cwd 的调用都重读（不缓存负结果：用户跑完 install 后无需重启
//   即可重试成功）。
//
// 红线 12：对 `@deepseek-ai/dsh-subagent` 只 import `{ assertSubagentMaxDepth,
// settleRun }`；本文件仅用 `assertSubagentMaxDepth`（CW apply() 的 maxDepth
// 配置校验随迁移落在 createNativeDriver）。settleRun 在 native-delegate.js。
//
// 进度说明（§3.4）：本 driver 只提供基于 `ctx.subagents.listChildren` 的最小
// 快照（label/status）；完整进度（session 事件折叠 foldProgress 等）由工具层
// （T13 subagent-progress）组合，bridge 专属字段在此恒省略。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import { NATIVE_CAPS } from './types.js'
import {
  assertCwd,
  resolveModelRoute,
  resolvePersona,
  settleForegroundRun,
  settleStart,
} from '../native-delegate.js'

/** 包根下 cwd 补丁 stamp 的缺省路径（`<pkg>/patches/.applied`，§6.4.2-C）。 */
const DEFAULT_STAMP_PATH = fileURLToPath(new URL('../../patches/.applied', import.meta.url))

/** 两枚 cwd 补丁在 stamp 中的状态键（§6.4.2 B 段逐枚独立判定）。 */
const CWD_PATCH_KEYS = ['inProcessDriver', 'subagentBundle']

/** 可信状态：`applied`（补丁已打）/ `native-verified`（版本白名单 + install 行为探针双闸后记入）。 */
const TRUSTED_CWD_PATCH_STATES = new Set(['applied', 'native-verified'])

/**
 * 构造带安装指引的 cwd 门控错误。
 * @param {string} detail stamp 不被信任的具体原因
 * @returns {Error}
 */
function cwdPatchError(detail) {
  return new Error(
    `dsh-plugin-subagents: per-call cwd requires the cwd patches to be installed and trusted (${detail}); `
    + 'run patches/install.sh from the dsh-plugin-subagents package (patches/.applied records the result)',
  )
}

/**
 * 校验 cwd 补丁 stamp 处于可信状态（§6.4.2 定稿：两枚均 `applied` 或
 * `native-verified` 才放行；`native` 独态不放行）。
 * @param {string} stampPath stamp 文件路径
 * @returns {Promise<void>}
 * @throws {Error} stamp 缺失 / 不可解析 / 字段不全 / 存在不可信状态。
 */
async function assertCwdPatchesTrusted(stampPath) {
  let raw
  try {
    raw = await readFile(stampPath, 'utf8')
  } catch {
    throw cwdPatchError(`stamp file missing or unreadable: ${stampPath}`)
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch {
    throw cwdPatchError('stamp file is not valid JSON')
  }
  const patches = doc !== null && typeof doc === 'object' ? doc.patches : undefined
  if (patches === null || typeof patches !== 'object' || Array.isArray(patches)) {
    throw cwdPatchError('stamp file has no `patches` record')
  }
  const untrusted = CWD_PATCH_KEYS
    .filter((key) => !TRUSTED_CWD_PATCH_STATES.has(patches[key]))
    .map((key) => `${key}=${typeof patches[key] === 'string' ? `"${patches[key]}"` : String(patches[key])}`)
  if (untrusted.length > 0) {
    throw cwdPatchError(`patch state ${untrusted.join(', ')}; trusted states are "applied" and "native-verified"`)
  }
}

/**
 * 创建原生 in-process 子代理驱动（DESIGN §3.4）。
 *
 * @param {Object} spec
 * @param {'spawn'|'fork'} spec.kind      子代理 provider 类别（决定 id 与 inheritsParentContext）
 * @param {Object} spec.ctx               宿主上下文（须携带 `ctx.subagents` seam；job 路由另需 `ctx.get('jobs')`）
 * @param {Object} spec.config            实例配置（至少 `provider`：已注册的 in-process provider 名；
 *                                        `maxDepth` 数字时经 assertSubagentMaxDepth 校验 —— CW apply() 行为随迁）
 * @param {string} [spec.presetsRoot]     可选 preset 根目录覆盖（测试注入；缺省 dshHomePath('.agent-presets')）
 * @param {string} [spec.stampPath]       可选 cwd 补丁 stamp 路径覆盖（测试注入；缺省 `<pkg>/patches/.applied`）
 * @returns {import('./types.js').SubagentDriver}
 */
export function createNativeDriver({ kind, ctx, config, presetsRoot, stampPath }) {
  if (kind !== 'spawn' && kind !== 'fork') {
    throw new Error(`dsh-plugin-subagents: createNativeDriver kind must be 'spawn' or 'fork' (got ${String(kind)})`)
  }
  if (config !== null && typeof config === 'object' && config.maxDepth !== undefined && config.maxDepth !== 'provider-managed') {
    assertSubagentMaxDepth(config.maxDepth)
  }
  const id = `native:${kind}`
  const stampFile = stampPath !== undefined ? stampPath : DEFAULT_STAMP_PATH

  return {
    id,
    kind: 'native',
    inheritsParentContext: kind === 'fork',
    capabilities: NATIVE_CAPS,

    /** 可用性 = 实例配置的 in-process provider 是否已注册（惰性：provider-added 事件感知在装配层 T10）。 */
    available() {
      const registered = ctx?.subagents?.getProvider?.(config?.provider) !== undefined
      return registered
        ? { registered: true, reason: `native subagent provider "${String(config?.provider)}" is registered` }
        : {
          registered: false,
          reason: `native subagent provider "${String(config?.provider)}" is not registered yet`
            + ' (resolves when the provider appears)',
        }
    },

    /**
     * 发起一次委派（三路由）。请求组装逐行对齐 CW execute：
     * `@preset:` 解析、`provider/model` 拆分、cwd 断言在驱动内做；字段合并
     * （per-call > role overrides > config）已在工具层完成，`request.native`
     * 即最终值。
     * @param {import('./types.js').DelegateRequest} request
     * @returns {Promise<import('./types.js').DelegateOutcome>}
     */
    async start(request) {
      const native = request.native ?? {}
      const providerName = native.provider ?? config?.provider
      if (typeof providerName !== 'string' || providerName.length === 0) {
        throw new Error(
          `dsh-plugin-subagents: native driver "${id}" has no subagent provider`
          + ' (set config.provider or request.native.provider)',
        )
      }

      // Per-call overrides take precedence over instance config.
      // NOTE: `provider` selects the SUBAGENT backend (spawn/fork/...) and is
      // passed to ctx.subagents.start/startContinuable — it is NOT an LLM
      // provider. LLM provider routing is covered by the composite `model`
      // id (`kimi-code/k3`) inside agentOptions.
      const persona = await resolvePersona(native.persona, presetsRoot)
      const toolFilter = native.toolFilter
      const modelRoute = resolveModelRoute(native.agentOptions?.model)
      const llmProvider = modelRoute.provider
      const llmModel = modelRoute.model

      const maxDepth = typeof native.maxDepth === 'number' ? native.maxDepth : undefined
      let cwd
      if (native.cwd !== undefined) {
        cwd = assertCwd(native.cwd)
        await assertCwdPatchesTrusted(stampFile)
      }

      const inner = {
        label: request.label,
        prompt: [{ type: 'text', text: request.task }],
        parent: request.parent,
        ...(native.agentOptions !== undefined || llmProvider !== undefined || llmModel !== undefined)
          ? { agentOptions: {
            ...(native.agentOptions !== undefined ? native.agentOptions : {}),
            ...(llmProvider !== undefined ? { provider: llmProvider } : {}),
            ...(llmModel !== undefined ? { model: llmModel } : {}),
          } }
          : {},
        ...persona !== undefined ? { persona } : {},
        ...toolFilter !== undefined ? { toolFilter } : {},
        ...cwd !== undefined ? { cwd } : {},
        ...maxDepth !== undefined ? { maxDepth } : {},
      }

      if (request.route === 'sync') {
        const run = await ctx.subagents.start(providerName, { ...inner, signal: request.signal })
        const outcome = await settleForegroundRun(run)
        return { ...outcome, stopReason: 'completed' }
      }

      if (request.route === 'job') {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        const jobId = jobs.start({
          kind: 'subagent',
          label: request.label,
          owner: request.parent,
          run: () => {
            const controller = new AbortController()
            const start = ctx.subagents.start(providerName, { ...inner, signal: controller.signal })
            return {
              cancel: (reason) => {
                controller.abort(reason ?? 'background subagent task killed')
              },
              done: settleStart(start, controller.signal),
            }
          },
        })
        return { kind: 'job', jobId }
      }

      if (request.route === 'continuable') {
        const started = await ctx.subagents.startContinuable({
          provider: providerName,
          label: request.label,
          request: inner,
          signal: request.signal,
        })
        return { kind: 'continuable', childId: started.childId, backend: id }
      }

      throw new Error(
        `dsh-plugin-subagents: native driver "${id}" got an unknown delegation route "${String(request.route)}"`
        + ' (expected sync | job | continuable)',
      )
    },

    /**
     * 最小进度快照：基于 `ctx.subagents.listChildren(parentSessionId)` 找
     * label/status；拿不到详细信息（服务不可用 / 未找到该 child）返回
     * `{childId, status:'unknown'}`。完整进度（session 折叠）由工具层组合；
     * bridge 专属字段恒省略。
     *
     * T08 修复：dsh-subagent 的签名是 `listChildren(parentSessionId, signal)` ——
     * 按父会话 id 枚举其直接子代（`record.header.parentSession === id` 匹配；
     * 传 Agent 对象匹配不到任何条目，故此处收 **session id 字符串**）。
     * 可选第二参提供即按父域枚举；缺省保持旧的无域调用（全量枚举）。
     * ProgressSnapshot 契约不变。
     *
     * @param {string} childId
     * @param {string} [parentSessionId] 父会话 id（调用方 exec.agent.session.id）
     * @returns {Promise<import('./types.js').ProgressSnapshot>}
     */
    async progress(childId, parentSessionId) {
      const listChildren = ctx?.subagents?.listChildren
      if (typeof listChildren !== 'function') {
        return { childId, status: 'unknown' }
      }
      const entries = await listChildren(parentSessionId)
      const row = Array.isArray(entries)
        ? entries.find((entry) => entry && entry.kind === 'child' && entry.id === childId)
        : undefined
      if (row === undefined) {
        return { childId, status: 'unknown' }
      }
      return {
        childId,
        status: row.activity === 'running' ? 'running' : row.activity === 'inactive' ? 'inactive' : 'unknown',
        ...row.label !== undefined ? { label: row.label } : {},
      }
    },

    /**
     * 释放一个子代理占用的后端资源：native 子代理由 harness 自理（continuable
     * child 归 continuation manager 全权所有，一次性 run 的 dispose 在 settle 内
     * 完成），本方法为 no-op。
     * @returns {Promise<void>}
     */
    async dispose() {},
  }
}
