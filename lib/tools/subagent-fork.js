// dsh-plugin-subagents — `subagent_fork` 工具（T12，DESIGN §5.1 / §5.3）。
//
// 接管官方名的 fork 变体：native-only（走 assembleDrivers 的 native.fork 驱动，
// 子代理继承父会话完成回合），保持官方极简参数面 + per-call 覆盖增强
// （model / persona / toolFilter / cwd / provider / run_in_background）。
//
// 与 `subagent`（T11）的差异，全部源自「fork 无角色语义」（§5.3 末行）：
//   - schema 去掉 `backend` / `role` / `permission_mode` / `reasoning_effort`
//     —— 前两者是 delegate 的后端/角色入口（fork 恒 native、无角色），后两者
//     是 bridge 专属参数。schema 未声明的参数 harness 不会代为拒绝（参数对象
//     未声明 additionalProperties: false），故 execute 对 `backend` / `role`
//     另设显式 loud 守卫（红线 8：不支持的参数绝不静默忽略），bridge 专属参数
//     则由 assertParamsSupported 以 fork driver 的 caps（NATIVE_CAPS）天然覆盖；
//   - config 默认取 `config.fork ?? {}` 覆盖（§6.1）：provider 默认 'fork'、
//     backgroundMode 默认 one-shot（对齐官方 base 行 —— fork 的官方语义即前台
//     等结果）；enableRunInBackground / agentOptions / persona / toolFilter /
//     maxDepth 同由 config.fork 提供；
//   - `inherits conversation` 文案取 providerWording(true)（fork 继承父上下文，
//     prompt 表述为「在其已见的会话之上只说新内容」）；
//   - systemPrompt 后台使用段仅当 fork 配置为 continuable 时注册（order 116.5，
//     沿 T11 / 旧版 cwd 插件；文案不含 backend 句 —— fork 无该参数）。
//
// 路由三态与 T11 native 分支一致：run_in_background（默认随 fork.backgroundMode：
// continuable → true，否则 false）→ true 时 continuable（fork 配 continuable）或
// job（默认 one-shot），false → sync。per-call 覆盖合并次序：args > config.fork
// （fork 无 role.overrides 层）。输出 oneOf 三态映射与 render 沿 T11。
//
// deps 形状与 T11 对齐（T14 统一装配）：`roles` 为形状统一保留 —— fork 无角色
// 语义，不消费；`presetsRoot` 同 T11 为测试注入点（@preset 解析）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertParamsSupported } from '../drivers/types.js'
import {
  outputValueText,
  providerWording,
  resolveDelegationRun,
  resolveModelRoute,
  resolvePersona,
} from '../native-delegate.js'

/** Prompt order after bounded delegation policy and before child reporting (CW parity). */
const SUBAGENT_SECTION_ORDER = 116.5

/**
 * 注册 fork 变体工具 `subagent_fork`（接管官方名，native-only）。
 *
 * @param {Object} ctx                          宿主 ctx（需 ctx.tools.register；
 *                                              fork 配置为 continuable 时另需
 *                                              ctx.systemPrompt.section）
 * @param {Object} deps
 * @param {Object} deps.assembled               assembleDrivers 产物（需
 *                                              assembled.native.fork）
 * @param {Object} [deps.roles]                 形状统一保留（T14 统一装配）；fork
 *                                              无角色语义，本工具不消费
 * @param {Object} [deps.config]                已校验插件配置（本工具读
 *                                              config.fork ?? {} 与顶层
 *                                              config.presetHints）
 * @param {string} [deps.toolName]              工具名，默认 'subagent_fork'
 * @param {string} [deps.presetsRoot]           可选 preset 根目录覆盖（测试注入；
 *                                              缺省 dshHomePath('.agent-presets')）
 */
export function registerSubagentFork(ctx, deps) {
  const { assembled, roles, config = {}, toolName = 'subagent_fork', presetsRoot } = deps
  void roles // deps-shape parity with registerSubagentTool; fork carries no role semantics
  if (!assembled || !assembled.native || !assembled.native.fork) {
    throw new Error('subagent_fork: registerSubagentFork requires deps.assembled with native.fork (the assembleDrivers product)')
  }
  const driver = assembled.native.fork

  // config.fork 覆盖（§6.1）：fork 专属默认 —— provider 'fork'、one-shot。
  const forkConfig = config.fork ?? {}
  // fork 工具级默认：backgroundMode 缺省视为 'one-shot'（对齐 DESIGN §6.1 /
  // 官方 base 行 —— fork 官方语义前台等结果）。显式 continuable 才后台默认。
  const continuableDefault = (forkConfig.backgroundMode ?? 'one-shot') === 'continuable'
  const backgroundEnabled = forkConfig.enableRunInBackground !== false
  // Fork wording: the child inherits this conversation's completed turns.
  const wording = providerWording(true)

  const description = wording.description
    + (backgroundEnabled
      ? (continuableDefault
        ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; `send_message` starts a later turn in the same child conversation. Set `run_in_background: false` only when your next action depends on receiving the result.'
        : ' This call waits for the result by default. Set `run_in_background: true` to return a job id; collect with `job_output` and stop with `job_kill`.')
      : ' This call waits for the subagent and returns its result.')

  ctx.tools.register(defineTool({
    name: toolName,
    description,
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: wording.promptDescription,
      },
      model: {
        type: 'string',
        description: 'Optional model override: a bare model id (`k3`) or a `provider/model` composite (`kimi-code/k3`) that also switches the LLM provider.',
      },
      persona: {
        type: 'string',
        description: 'Optional per-call persona text that shadows the instance default for this child, or an `@preset:<id>` reference (display name or directory id) to load a saved agent preset\'s persona.'
          + (Array.isArray(config.presetHints) && config.presetHints.length > 0
            ? ` Available presets on this deployment: ${config.presetHints.map((p) => (p.startsWith('@preset:') ? p : `@preset:${p}`)).join(', ')}.`
            : ''),
      },
      toolFilter: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allow: { type: 'array', items: { type: 'string' } },
          deny: { type: 'array', items: { type: 'string' } },
        },
        description: 'Optional per-call tool allow/deny filter applied to this child (overrides the instance default).',
      },
      cwd: {
        type: 'string',
        description: 'Optional absolute working directory for this child (defaults to the parent session cwd). Requires the cwd patches from patches/ (run patches/install).',
      },
      provider: {
        type: 'string',
        description: 'Optional per-call subagent provider override (defaults to the fork instance config). This selects the SUBAGENT backend, not an LLM provider.',
      },
      run_in_background: {
        type: 'boolean',
        description: continuableDefault
          ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true on this deployment (fork.backgroundMode: continuable). Set false to wait for the result when your next action depends on it.'
          : 'Whether to run as a background job and return its id — collect with job_output, stop with job_kill. Defaults to false on this deployment (fork.backgroundMode: one-shot).',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'continuable' },
              child_id: { type: 'string', required: true },
              backend: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'background' },
              job_id: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'foreground' },
              run_id: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
              stop_reason: { type: 'string' },
            },
          },
        ],
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.kind === 'background'
          ? `started background subagent task ${value.job_id}`
          : value.kind === 'continuable'
            ? `started subagent ${value.child_id} (backend ${value.backend})`
            : outputValueText(value.output),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('subagent_fork tool requires a calling agent (exec.agent was undefined)')
      }

      // ── fork 极简面守卫（红线 8）：schema 已去掉的入口参数显式传入 → loud。
      //      harness 对未声明参数不做 additionalProperties 拒绝，静默忽略恰是
      //      红线禁止的失效面 ─────────────────────────────────────────────────
      if (args.backend !== undefined) {
        throw new Error(
          'subagent_fork: fork has no `backend` parameter — it always runs a native in-process subagent '
          + 'that inherits this conversation (use `subagent` to delegate to a bridge backend)',
        )
      }
      if (args.role !== undefined) {
        throw new Error(
          'subagent_fork: fork has no `role` parameter — fork delegations carry no role semantics '
          + '(use `subagent` to pick a role from the library)',
        )
      }

      // ── 参数-能力矩阵：bridge 专属参数（permission_mode / reasoning_effort）
      //      在 fork driver 的 NATIVE_CAPS 下天然 loud ──────────────────────────
      assertParamsSupported(driver.capabilities, args, 'native:fork')

      // ── per-call 覆盖合并（args > config.fork；fork 无 role.overrides 层）────
      const persona = await resolvePersona(
        args.persona !== undefined ? args.persona : forkConfig.persona,
        presetsRoot,
      )
      const toolFilter = args.toolFilter !== undefined ? args.toolFilter : forkConfig.toolFilter
      // model 路由拆分：`provider/model` 组合 id 同时切换 LLM provider。
      const modelRoute = resolveModelRoute(args.model)
      const baseAgentOptions = { ...(forkConfig.agentOptions ?? {}) }
      const agentOptions = modelRoute.provider !== undefined || modelRoute.model !== undefined || Object.keys(baseAgentOptions).length > 0
        ? {
          ...baseAgentOptions,
          ...(modelRoute.provider !== undefined ? { provider: modelRoute.provider } : {}),
          ...(modelRoute.model !== undefined ? { model: modelRoute.model } : {}),
        }
        : undefined

      // ── 路由：run_in_background 默认随 fork.backgroundMode（官方语义 one-shot）──
      const { runInBackground } = resolveDelegationRun(args, {
        backgroundEnabled,
        continuable: continuableDefault,
      })

      const outcome = await driver.start({
        label: args.description,
        task: args.prompt,
        parent,
        signal: exec.signal,
        route: runInBackground ? (continuableDefault ? 'continuable' : 'job') : 'sync',
        native: {
          provider: args.provider ?? forkConfig.provider,
          ...(agentOptions !== undefined ? { agentOptions } : {}),
          ...(persona !== undefined ? { persona } : {}),
          ...(toolFilter !== undefined ? { toolFilter } : {}),
          ...(forkConfig.maxDepth !== undefined ? { maxDepth: forkConfig.maxDepth } : {}),
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
        },
      })

      // DelegateOutcome → 对外蛇形字段；job 语义对外叫 background（沿 T11）。
      if (outcome.kind === 'job') {
        return { kind: 'background', job_id: outcome.jobId }
      }
      if (outcome.kind === 'continuable') {
        return {
          kind: 'continuable',
          child_id: outcome.childId,
          backend: outcome.backend,
        }
      }
      return {
        kind: 'foreground',
        run_id: outcome.runId,
        output: outcome.output,
        ...(outcome.stopReason !== undefined ? { stop_reason: outcome.stopReason } : {}),
      }
    },
  }))

  // Background-usage prompt section, only for continuable-configured forks and
  // only once the tool is registered (ctx.tools.register above throws on
  // failure — reaching here = success). No `backend` sentence: fork has none.
  if (continuableDefault && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: (context) => (typeof ctx.tools?.get === 'function' && ctx.tools.get(toolName, context && context.scope) === undefined
        ? ''
        : `Use ${toolName} in the background by default. Start independent fork delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message. The fork child inherits this conversation's completed turns.`),
    })
  }
}
