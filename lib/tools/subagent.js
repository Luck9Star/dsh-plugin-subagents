// dsh-plugin-subagents — 统一委派工具（T11，DESIGN §5.1 / §5.3）。
//
// 接管官方工具名的单一委派入口：默认 native（D4 —— 不带 backend/role 时行为
// 对齐官方工具 + per-call 覆盖增强），`backend` 参数切换 bridge 后端（codex /
// claude-code / config.providers 接入的任意 ACP agent），`role` 从角色库
// （§6.2）取 backend 锁定、远端权限档、instructions 前缀与 native overrides。
//
// execute 校验链（§5.3 次序，每步 loud）：
//   1. role 解析 —— 未知 id 报可用列表（schema enum 之外的第二道防线，
//      覆盖注册后角色库变化 / 空库兜底路径）；省略 → general；
//   2. backend 归并 —— 显式 args.backend > role.backend > 'native'；
//      role.backend 非空（锁定）且与显式 backend 不同 → throw（选了
//      codex-full 又传 backend=native 多半是误会）；role.backend 空串
//      （调用方选择）时任何显式 backend 合法；
//   3. 参数-能力矩阵 assertParamsSupported（§3.5 / 红线 8：不支持的参数
//      绝不静默忽略，消息含参数名）；
//   4. bridge 分支 —— driver.available() 未注册 → throw 含 reason；权限
//      天花板 assertWithinCeiling（binding ∪ durable registry 命中即 bridge
//      子代理，未知档 fail closed 到 readonly —— 红线 3；registry 缺席时
//      loud 拒绝，绝不降级为只查 binding）；
//   5. native 分支 —— persona/@preset 解析（resolvePersona，presetsRoot 可
//      经 deps 注入）、model 路由拆分（resolveModelRoute）、overrides 合并
//      （次序：args > role.overrides > config）；cwd 值断言与补丁 stamp 门控
//      在 native driver 内（工具层不重复）；maxDepth 能力检查在 driver；
//   6. task = role.instructions 前缀 + '\n\n' + prompt；
//   7. 路由 —— run_in_background（默认随 backgroundMode：continuable →
//      true，否则 false；enableRunInBackground=false 时显式 true → loud）
//      × backend：native true→continuable|job（视 backgroundMode）、
//      false→sync；bridge true→continuable、false→sync（relay child 天然
//      后台，无 job 语义）；
//   8. driver.start(DelegateRequest)（§3.2 形状；bridge 的 allowDelegation
//      在请求顶层 —— bridge driver 从该字段读）；
//   9. DelegateOutcome → 对外蛇形字段（child_id/job_id/run_id/output/…），
//      foreground 渲染用 outputValueText（CW 语义）。
//
// ceiling 依赖说明：本工具从 `assembled.state.bindings` 与
// `assembled.state.registry` 读调用者身份 —— 二者必须齐备（T10
// assembleDrivers 的 state 需暴露 registry；缺失时本工具 loud 拒绝 bridge
// 委派，fail closed）。
//
// systemPrompt：仅当 config.backgroundMode==='continuable' 且工具注册成功时
// 注册 `tool:<toolName>` 段（order 116.5，沿 legacy-cwd-plugin 的后台使用段
// + 一句 backend 参数说明）。
//
// 注意：本工具是 delegate（spawn 语义 + backend 扩展）；subagent_fork
// （T12）不在此文件。

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  assertCallerWithinCeiling,
  buildBridgeSettings,
  resolveBridgePermissionMode,
} from '../dispatch.js'
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
 * 注册统一委派工具 `subagent`（接管官方名）。
 *
 * @param {Object} ctx                          宿主 ctx（需 ctx.tools.register；
 *                                              backgroundMode=continuable 时另需
 *                                              ctx.systemPrompt.section）
 * @param {Object} deps
 * @param {Object} deps.assembled               assembleDrivers 产物（至少
 *                                              native.spawn 与 bridges: Map）；
 *                                              bridge 委派另需 state.bindings +
 *                                              state.registry（权限天花板）
 * @param {Object} deps.roles                   角色库（createRoleLibrary 产物：
 *                                              list()/get()）
 * @param {Object} [deps.config]                已校验插件配置（backgroundMode /
 *                                              enableRunInBackground / provider /
 *                                              agentOptions / persona / toolFilter /
 *                                              maxDepth / presetHints）
 * @param {string} [deps.toolName]              工具名，默认 'subagent'
 * @param {string} [deps.presetsRoot]           可选 preset 根目录覆盖（测试注入；
 *                                              缺省 dshHomePath('.agent-presets')）
 */
export function registerSubagentTool(ctx, deps) {
  const { assembled, roles, config = {}, toolName = 'subagent', presetsRoot } = deps
  if (!assembled || !assembled.native || !assembled.native.spawn) {
    throw new Error('subagent: registerSubagentTool requires deps.assembled with native.spawn (the assembleDrivers product)')
  }
  if (!(assembled.bridges instanceof Map)) {
    throw new Error('subagent: registerSubagentTool requires deps.assembled.bridges to be a Map of bridge drivers')
  }

  const roleIds = roles.list().map((r) => r.id)
  const backendIds = ['native', ...assembled.bridges.keys()]
  // Backend description, three states (P3: the old single wording claimed
  // "(none detected on this deployment)" even when bridges ARE detected —
  // just not usable from THIS row; a presetRow row is native-only by design):
  //   1. bridge drivers present → list them (unchanged join);
  //   2. none + presetRow row → this tool is native-only by design; bridges
  //      live on the global "subagent" tool;
  //   3. none + global instance → nothing detected on this deployment.
  const bridgeNames = backendIds.slice(1)
  const backendBridgeSentence = bridgeNames.length > 0
    ? `a bridge name (${bridgeNames.join(' / ')}) delegates to that external agent CLI`
    : (config.presetRow === true
      ? 'this tool is native-only; external agent CLIs (codex / claude-code / grok-native / configured ACP providers) are delegated via the global "subagent" tool\'s backend parameter'
      : 'no external agent CLI is currently detected on this deployment — backend stays "native" (see subagent_agents)')
  // delegate 工具级默认：backgroundMode 缺省视为 'continuable'（对齐 DESIGN §6.1
  // —— delegate 默认 continuable）。显式 one-shot 才关闭后台默认。
  const continuableDefault = (config.backgroundMode ?? 'continuable') === 'continuable'
  const backgroundEnabled = config.enableRunInBackground !== false
  // The delegate tool is spawn-semantics (a fork variant exists as its own tool).
  const wording = providerWording(false)

  const description = wording.description
    + ' The optional `backend` parameter delegates to an external agent CLI (codex / claude-code / grok-native / any configured ACP provider) instead, and `role` (subagent_roles lists them) bundles a backend default, the remote permission mode, and extra instructions.'
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
      backend: {
        type: 'string',
        enum: backendIds,
        description: `Backend for this delegation: "native" (default) runs a native in-process subagent; ${backendBridgeSentence}. Must agree with the chosen role's pinned backend when the role pins one.`,
      },
      role: {
        type: 'string',
        enum: roleIds.length ? roleIds : ['general'],
        description: 'Role from the declarative role library (subagent_roles lists them). Defaults to "general" (no pinned backend; full product permissions; may delegate).',
      },
      model: {
        type: 'string',
        description: 'Optional model override. native: a bare model id (`k3`) or a `provider/model` composite (`kimi-code/k3`) that also switches the LLM provider. bridge: the external product\'s own model id (claude-code: --model, codex: -c model=; ACP uses the agent\'s own configuration).',
      },
      reasoning_effort: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Bridge backends only: the external product\'s reasoning effort. Omit to inherit the product\'s own default.',
      },
      persona: {
        type: 'string',
        description: 'Native only. Optional per-call persona text that shadows the role/instance default for this child, or an `@preset:<id>` reference (display name or directory id) to load a saved agent preset\'s persona.'
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
        description: 'Native only. Optional per-call tool allow/deny filter applied to this child (overrides the role/instance default).',
      },
      cwd: {
        type: 'string',
        description: 'Native only. Optional absolute working directory for this child (defaults to the parent session cwd). Requires the cwd patches from patches/ (run patches/install).',
      },
      permission_mode: {
        type: 'string',
        enum: ['readonly', 'default', 'full'],
        description: 'Bridge backends only: the external product\'s permission mode for this delegation, capped by the delegation ceiling (a child can never grant a descendant more permission than it has itself).',
      },
      provider: {
        type: 'string',
        description: 'Native only. Optional per-call subagent provider override (defaults to the instance config, e.g. spawn/fork). This selects the SUBAGENT backend, not an LLM provider.',
      },
      run_in_background: {
        type: 'boolean',
        description: continuableDefault
          ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true on this deployment (backgroundMode: continuable). Set false to wait for the result when your next action depends on it. Bridge backends always run continuable when this is true.'
          : 'Whether to run as a background job (native) and return its id — collect with job_output, stop with job_kill. Defaults to false on this deployment (backgroundMode: one-shot). Bridge backends always run continuable when this is true.',
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
              role: { type: 'string' },
              permission_mode: { type: 'string' },
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
            ? `started subagent ${value.child_id} (backend ${value.backend}${value.role ? `, role ${value.role}` : ''})`
            : outputValueText(value.output),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) {
        throw new Error('subagent tool requires a calling agent (exec.agent was undefined)')
      }

      // ── 1. role 解析：未知 id loud（schema enum 之外的第二道防线——覆盖
      //      注册后角色库变化与空库兜底）；省略 → general ──────────────────
      const roleId = args.role || 'general'
      const role = roles.get(roleId)
      if (!role) {
        throw new Error(`subagent: unknown role "${args.role}" (available: ${roles.list().map((r) => r.id).join(', ')})`)
      }

      // ── 2. backend 归并：显式 args.backend > role.backend > 'native'。
      //      role 锁定 backend（非空）时显式值必须一致 —— 不一致 loud；
      //      role.backend 空串 = 调用方选择，任何显式 backend 合法 ─────────
      const roleBackend = role.backend || ''
      if (args.backend !== undefined && roleBackend !== '' && args.backend !== roleBackend) {
        throw new Error(
          `subagent: role "${role.id}" pins backend "${roleBackend}" but backend "${args.backend}" was passed. `
          + 'Omit `backend` to use the role\'s pinned backend, or pick a role that does not pin one.',
        )
      }
      const backend = args.backend !== undefined ? args.backend : (roleBackend !== '' ? roleBackend : 'native')

      const driver = backend === 'native' ? assembled.native.spawn : assembled.bridges.get(backend)
      if (!driver) {
        throw new Error(`subagent: unknown backend "${backend}" (available: ${backendIds.join(', ')})`)
      }

      // ── 3. 参数-能力矩阵（§3.5 / 红线 8）：不支持的参数绝不静默忽略 ─────
      const nativeProvider = args.provider !== undefined ? args.provider : (config.provider ?? 'spawn')
      assertParamsSupported(driver.capabilities, args, backend === 'native' ? `native:${nativeProvider}` : backend)

      // ── 6. task：role instructions 前缀进任务文本（PS 语义：发给干活的
      //      后端；relay 人格固定） ─────────────────────────────────────────
      const task = role.instructions ? `${role.instructions}\n\n${args.prompt}` : args.prompt

      // ── 7. 路由（含 run_in_background 默认随 backgroundMode；禁用时显式
      //      true → resolveDelegationRun 的 CW 原文案 loud） ────────────────
      const { runInBackground } = resolveDelegationRun(args, {
        backgroundEnabled,
        continuable: continuableDefault,
      })

      // ── 4/5 + 8. 后端各自的组装与 start ─────────────────────────────────
      let request
      if (driver.kind === 'bridge') {
        const availability = driver.available()
        if (!availability || !availability.registered) {
          throw new Error(`subagent: backend "${backend}" is not available${availability ? `: ${availability.reason}` : ''}`)
        }
        // Delegation permission ceiling (fail closed): a bridge child is
        // recognized by live binding OR durable registry entry — losing the
        // in-memory binding (idle disposal, restart) must not lift the
        // ceiling, and an unknown stored mode fails closed to readonly.
        // The registry MUST be reachable: silently degrading to binding-only
        // would let a restarted child regain root privileges.
        const { bindings, registry } = assembled.state ?? {}
        if (!bindings || !registry) {
          throw new Error(
            'subagent: assembled.state must expose both `bindings` and `registry` for the delegation ceiling '
            + '(fail-closed: without the durable registry a restarted bridge child would be mistaken for a root session)',
          )
        }
        // requestedMode: args.permission_mode > role.permissionMode > 'default'
        // (role files default general to full via the role library itself).
        // 解析链 / settings 组装 / ceiling 判定是与引擎级 dispatch 缝
        // （lib/dispatch.js，T22）共用的函数。
        const permissionMode = resolveBridgePermissionMode({
          explicit: args.permission_mode,
          role,
        })
        assertCallerWithinCeiling({
          parent,
          bindings,
          registry,
          requestedMode: permissionMode,
        })
        const settings = buildBridgeSettings({
          permissionMode,
          model: args.model,
          reasoningEffort: args.reasoning_effort,
        })
        request = {
          label: args.description,
          task,
          parent,
          signal: exec.signal,
          route: runInBackground ? 'continuable' : 'sync',
          bridge: { provider: backend, settings },
          allowDelegation: role.allowDelegation !== false,
        }

        // 并发槽（DESIGN §5.5）：仅 bridge continuable 占槽。cap 满 → loud，
        // 提示等待子代理 settle（subagent_progress / subagent_wait）或调大
        // maxConcurrentChildren。sync 不占槽；native 走 harness jobs（自治）。
        if (runInBackground) {
          const maxConcurrent = config.maxConcurrentChildren ?? 8
          const liveChildren = assembled.state?.liveChildren
          if (liveChildren && liveChildren.size >= maxConcurrent) {
            throw new Error(
              `subagent: concurrency limit reached (${maxConcurrent} bridge children with a turn in flight). `
              + 'Wait for a subagent to settle (subagent_progress / subagent_wait) or raise maxConcurrentChildren.',
            )
          }
        }
      } else {
        // native：per-call 覆盖合并，次序 args > role.overrides > config。
        const persona = await resolvePersona(
          args.persona !== undefined
            ? args.persona
            : (role.overrides && role.overrides.persona !== undefined ? role.overrides.persona : config.persona),
          presetsRoot,
        )
        const toolFilter = args.toolFilter !== undefined
          ? args.toolFilter
          : (role.overrides && role.overrides.toolFilter !== undefined ? role.overrides.toolFilter : config.toolFilter)
        const maxDepth = role.overrides && role.overrides.maxDepth !== undefined
          ? role.overrides.maxDepth
          : config.maxDepth
        // model 路由拆分：`provider/model` 组合 id 同时切换 LLM provider；
        // 拆分结果最后展开 → 覆盖 role/config 的 agentOptions 同名字段。
        const modelRoute = resolveModelRoute(args.model)
        const baseAgentOptions = {
          ...((role.overrides && role.overrides.agentOptions) ?? {}),
          ...(config.agentOptions ?? {}),
        }
        const agentOptions = modelRoute.provider !== undefined || modelRoute.model !== undefined || Object.keys(baseAgentOptions).length > 0
          ? {
            ...baseAgentOptions,
            ...(modelRoute.provider !== undefined ? { provider: modelRoute.provider } : {}),
            ...(modelRoute.model !== undefined ? { model: modelRoute.model } : {}),
          }
          : undefined
        request = {
          label: args.description,
          task,
          parent,
          signal: exec.signal,
          route: runInBackground ? (continuableDefault ? 'continuable' : 'job') : 'sync',
          native: {
            provider: args.provider ?? config.provider,
            ...(agentOptions !== undefined ? { agentOptions } : {}),
            ...(persona !== undefined ? { persona } : {}),
            ...(toolFilter !== undefined ? { toolFilter } : {}),
            ...(maxDepth !== undefined ? { maxDepth } : {}),
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          },
        }
      }

      const outcome = await driver.start(request)

      // ── 9. DelegateOutcome → 对外蛇形字段；job 语义对外叫 background ────
      if (outcome.kind === 'job') {
        return { kind: 'background', job_id: outcome.jobId }
      }
      if (outcome.kind === 'continuable') {
        return {
          kind: 'continuable',
          child_id: outcome.childId,
          backend: outcome.backend,
          role: role.id,
          ...(outcome.permissionMode !== undefined ? { permission_mode: outcome.permissionMode } : {}),
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

  // Background-usage prompt section (CW parity + one backend sentence), only
  // for continuable-default deployments and only once the tool is registered
  // (ctx.tools.register above throws on failure — reaching here = success).
  if (continuableDefault && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.systemPrompt.section({
      name: `tool:${toolName}`,
      order: SUBAGENT_SECTION_ORDER,
      text: (context) => (typeof ctx.tools?.get === 'function' && ctx.tools.get(toolName, context && context.scope) === undefined
        ? ''
        : `Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. Set \`run_in_background: false\` only when your next action depends on that subagent's result. When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message. The \`backend\` parameter selects an external agent CLI (e.g. codex or a configured ACP provider) instead of a native subagent; the default is native.`),
    })
  }
}
