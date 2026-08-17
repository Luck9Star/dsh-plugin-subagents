// dsh-plugin-subagents — 引擎级 dispatch 缝（T22，docs/dispatch-seam.md）。
//
// 让插件代码（非模型工具调用）以受控 permissionMode 程序化派发 bridge 后端
// （claude-code / codex / grok-native / 任意 ACP agent）任务：
// `ctx.provide('subagentsDispatch', { dispatchAgentTask, available, backends })`
// （由全局实例 provide —— 红线 10：presetRow 分支无状态、永不提供）。
//
// 定位（设计 §0/§5）：**bridge 专精的 one-shot 直连路径**。官方程序化通道
// `ctx.subagents.start` 的 SubagentStartRequest 没有 settings 概念
// （permissionMode / reasoningEffort 是外部产品 CLI 的概念，只随本插件的
// bridge settings 通道流动）—— 本缝就是那个缺失的程序化入口；native 派发
// 官方通道已完备，`backend: 'native'|'spawn'|'fork'` 在此 loud 重定向。
//
// 校验链（设计 §2.2 逐字段论证表，每步 loud）：
//   1. 参数白名单（红线 8）：只收 backend/task/parent/label/role/settings/
//      cwd/signal；persona / toolFilter / maxDepth / provider / outputSchema /
//      maxTokens（native 专属，BRIDGE_CAPS 恒 false）任一出现即 throw，
//      未知键同样 loud —— 参数绝不静默忽略；
//   2. backend 校验：native 系名 → 重定向官方 ctx.subagents.start；未知名 →
//      报可用列表；已装配但 availability 未 registered → throw 含 reason；
//   3. role 解析（可选、无缺省角色）：解析语义与工具层逐字相同（未知 id 报
//      列表；role.backend 锁定与显式 backend 冲突 → throw）；
//   4. settings 组装 + 手工 enum 校验（fail closed，比工具层 schema 更前置）；
//   5. 两道权限闸：parent-based ceiling（binding ∪ durable registry 并集，
//      逐字复用工具层判定）+ config cap `maxDispatchPermissionMode`（§3.2）；
//   6. task 前缀：role.instructions 存在时前缀进任务文本；
//   7. cwd 解析：显式值过 assertCwd（本缝唯一的 deliberate 扩展，§2.2）；
//      省略 → parentCwd(parent)（与工具层 sync 路径逐字一致）；
//   8. 并发槽（§3.4 定案占槽）：准入检查 + 合成键 `dispatch:<nextSeq()>` 在
//      任一 await 之前同步完成（JS 单线程无 TOCTOU 窗口），finally 释放
//      （settle 或 throw 都删键）—— 工具层 sync 路由不占槽的前提「调用方
//      回合有界」对代码调用方不成立（一次 tick 可无上限 fan-out 真实子进程）；
//   9. 执行：driver.start({ route: 'sync', ... })（create → submit(settings)
//      → dispose）；零 binding / 零 registry 写入（§3.3：one-shot 无恢复语义，
//      与工具层 sync 路由同权同形）；
//  10. 结果压平（§2.3）：DelegateOutcome foreground 变体 → 窄形状
//      DispatchOutcome（单 text block 压平为 text 字符串）；
//  11. 一行 dispatch 日志（backend / permissionMode / label / runId）。
//
// 错误前缀约定：本缝所有自有错误统一 `subagentsDispatch:` 前缀（新面新名，
// 与 ceiling 的 `subagent:` / config 的 `dsh-plugin-subagents:` 并列）；唯一
// 例外是 parent-based ceiling —— 复用 lib/ceiling.js 的 assertWithinCeiling，
// 保留其 `subagent: permission escalation blocked …` 文案（同一治理判定，
// 同一文案便于排障与测试断言）。
//
// 红线 12：本模块不 import 任何 `@deepseek-ai/*`（只 import 本仓库模块）。

import { assertWithinCeiling, PERM_RANK } from './ceiling.js'
import { assertCwd } from './native-delegate.js'
import { parentCwd } from './run.js'

/** 请求白名单（设计 §2.2）：native 专属参数与一切未知键都不进本缝。 */
const ALLOWED_PARAMS = ['backend', 'task', 'parent', 'label', 'role', 'settings', 'cwd', 'signal']

/**
 * native 专属参数（能力矩阵 `lib/drivers/types.js` L168–L176：BRIDGE_CAPS 对
 * 这些能力恒 false）—— 出现即 loud（红线 8：绝不静默忽略）。文案形态对齐
 * `assertParamsSupported`（消息含参数名 + 指引 native 通道）。
 */
const NATIVE_ONLY_PARAMS = ['persona', 'toolFilter', 'maxDepth', 'provider', 'outputSchema', 'maxTokens']

/** permissionMode 的合法闭集（与 config enum / 角色库白名单一致）。 */
const PERMISSION_MODES = ['readonly', 'default', 'full']

/** reasoningEffort 的合法闭集（与工具层 schema enum 一致）。 */
const REASONING_EFFORTS = ['low', 'medium', 'high']

/**
 * 解析 bridge settings 的 permissionMode —— 工具层（lib/tools/subagent.js）
 * 与引擎级 dispatch 缝共用的解析链：`explicit > role.permissionMode > 'default'`。
 * （工具层 L306–L308 原语义；general 角色的 full 缺省由角色库本身提供，
 * 不在解析链里。）
 *
 * @param {Object} spec
 * @param {string} [spec.explicit]  调用方显式给出的 permissionMode
 * @param {Object} [spec.role]      已解析的角色（permissionMode 可选）
 * @returns {string} 生效的 permissionMode
 */
export function resolveBridgePermissionMode({ explicit, role }) {
  return explicit !== undefined ? explicit : ((role && role.permissionMode) ?? 'default')
}

/**
 * 组装 bridge settings —— 工具层（L314–L318 的展开组装）与引擎级 dispatch 缝
 * 共用：permissionMode 恒在；model / reasoningEffort 仅在给出时成键
 * （undefined 键永不出现，deepEqual 断言友好）。
 *
 * @param {Object} spec
 * @param {string} spec.permissionMode     生效 permissionMode（恒在）
 * @param {string} [spec.model]            产品自有 model id（直通）
 * @param {'low'|'medium'|'high'} [spec.reasoningEffort] 产品推理档（直通）
 * @returns {{permissionMode: string, model?: string, reasoningEffort?: string}}
 *          bridge settings（随 bridge.submit 第五参 / binding.settings 流动）
 */
export function buildBridgeSettings({ permissionMode, model, reasoningEffort }) {
  return {
    permissionMode,
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}

/**
 * caller-union 权限天花板判定 —— 工具层（L301–L303 + assertWithinCeiling 调用）
 * 与引擎级 dispatch 缝共用：以 `parent.session.id` 查 `bindings.get(id)` ∪
 * `registry.get(id)`，任一命中即「调用者是 bridge 子代理」，交给
 * `assertWithinCeiling`（lib/ceiling.js）拒绝任何上调（未知 callerMode
 * fail closed 到 readonly —— 红线 3）。
 *
 * 调用方须先自行确保 bindings / registry 齐备（工具层与 seam 都在各自入口
 * loud 守卫 state；此函数不重复守卫，保持与工具层原内联代码逐行等价）。
 *
 * @param {Object} spec
 * @param {Object} spec.parent         委派父 live Agent（ceiling 主体）
 * @param {Map} spec.bindings          childId → binding 记录（活会话）
 * @param {Object} spec.registry       durable registry（createRegistry 产物）
 * @param {string} spec.requestedMode  请求的 permissionMode
 * @returns {{callerRecord?: Object, callerPersisted?: Object}} 命中的调用方
 *          记录（均未命中时两个键值均为 undefined）—— 审计/日志透传用
 * @throws {Error} ceiling 拒绝时（`subagent: permission escalation blocked …`）
 */
export function assertCallerWithinCeiling({ parent, bindings, registry, requestedMode }) {
  const sessionId = parent.session.id
  const callerRecord = bindings.get(sessionId)
  const callerPersisted = !callerRecord ? registry.get(sessionId) : undefined
  assertWithinCeiling({
    callerSettings: callerRecord ? callerRecord.settings : (callerPersisted && callerPersisted.settings),
    callerIsProductChild: Boolean(callerRecord || callerPersisted),
    requestedMode,
  })
  return { callerRecord, callerPersisted }
}

/**
 * 一次引擎级 bridge 派发请求（设计 §2.1 DispatchAgentTaskRequest）。
 * @typedef {Object} DispatchAgentTaskRequest
 * @property {string} DispatchAgentTaskRequest.backend      必填。bridge provider 名
 *                                                           （必须是 assembled.bridges 的键）；
 *                                                           'native' / 'spawn' / 'fork' → loud 重定向
 * @property {string} DispatchAgentTaskRequest.task         必填。完整自包含任务文本
 * @property {Object} DispatchAgentTaskRequest.parent       必填。委派父 live Agent
 *                                                           （ceiling 主体 + cwd 缺省来源）
 * @property {string} [DispatchAgentTaskRequest.label]      可选。3-5 词展示标签（仅回显与日志）
 * @property {string} [DispatchAgentTaskRequest.role]       可选。角色 id（无缺省角色；解析语义
 *                                                           与工具层逐字相同）
 * @property {{model?: string, reasoningEffort?: 'low'|'medium'|'high', permissionMode?: 'readonly'|'default'|'full'}} [DispatchAgentTaskRequest.settings]
 *                                                           可选。远端设置（bridge settings 形状）
 * @property {string} [DispatchAgentTaskRequest.cwd]        可选。远端会话 cwd（绝对路径；缺省
 *                                                           parentCwd(parent)）
 * @property {Object} [DispatchAgentTaskRequest.signal]     可选。取消信号（贯穿任务提交 submit ——
 *                                                           driver sync 路由把它转传给 bridge.submit；
 *                                                           bridge.create 不携带 signal）
 */

/**
 * 引擎级派发结果（设计 §2.3 —— 从 DelegateOutcome foreground 变体压平的窄形状；
 * 基础设施故障 reject，子代理级失败走 stopReason ≠ 'completed'，不 throw）。
 * @typedef {Object} DispatchOutcome
 * @property {string} DispatchOutcome.backend     所用 bridge provider 名（回显）
 * @property {string} DispatchOutcome.runId       run id（driver sync 路由的
 *                                                 `${name}-${ts36}-${seq}` 同款生成）
 * @property {string} [DispatchOutcome.label]     调用方给的 label（给了才回显）
 * @property {string} DispatchOutcome.text        远端产品最终回答文本（单 text block
 *                                                 压平；无 text block 时 ''；经
 *                                                 redactSecrets 边界，§3.7）
 * @property {string} DispatchOutcome.stopReason  harness 词汇；外来值原样透传
 */

/**
 * 创建引擎级 dispatch 缝 —— `apply()` 全局实例段在 attachAll 后一行
 * `ctx.provide('subagentsDispatch', createDispatchSeam({ ctx, assembled, roles, config }))`。
 *
 * state 齐备守卫 **fail at create**（设计 §3.1）：`assembled.state` 必须齐备
 * ceiling 所需的 `bindings` + `registry`（文案沿用工具层的守卫语义 —— 加载期
 * 失败好过每次调用失败）与并发槽所需的 `liveChildren` + `nextSeq`（seam 定案
 * 占槽 —— 缺席即静默绕开并发治理，违背红线 10，同样 fail at create）。
 *
 * @param {Object} deps
 * @param {Object} deps.ctx        宿主 ctx（仅用于可选的一行 dispatch 日志；
 *                                 测试可省略）
 * @param {Object} deps.assembled  assembleDrivers 产物（bridges: Map + state）
 * @param {Object} deps.roles      角色库（createRoleLibrary 产物：list()/get()）
 * @param {Object} [deps.config]   已校验插件配置（maxDispatchPermissionMode /
 *                                 maxConcurrentChildren）
 * @returns {{available: boolean, backends: () => string[], dispatchAgentTask: (request: DispatchAgentTaskRequest) => Promise<DispatchOutcome>}}
 *          `subagentsDispatch` 服务值
 * @throws {Error} assembled / state / roles 不齐备时（加载期失败）
 */
export function createDispatchSeam({ ctx, assembled, roles, config = {} } = {}) {
  if (!assembled || !(assembled.bridges instanceof Map)) {
    throw new Error('subagentsDispatch: createDispatchSeam requires deps.assembled with a bridges Map (the assembleDrivers product)')
  }
  const state = assembled.state
  const { bindings, registry } = state ?? {}
  if (!bindings || !registry) {
    throw new Error(
      'subagentsDispatch: assembled.state must expose both `bindings` and `registry` for the delegation ceiling '
      + '(fail-closed: without the durable registry a restarted bridge child would be mistaken for a root session)',
    )
  }
  if (!state.liveChildren || typeof state.nextSeq !== 'function') {
    throw new Error(
      'subagentsDispatch: assembled.state must expose `liveChildren` and `nextSeq` for the concurrency slot '
      + '(a dispatch that cannot reserve a slot would bypass the concurrency governance)',
    )
  }
  if (!roles || typeof roles.get !== 'function' || typeof roles.list !== 'function') {
    throw new Error('subagentsDispatch: createDispatchSeam requires deps.roles (the createRoleLibrary product: list()/get())')
  }

  /** 一行 dispatch 日志：ctx 可用且宿主 logger 有 info 才发（宁缺勿错）。 */
  const log = (message) => { ctx?.logger?.info?.(message) }

  /**
   * 派发一个 one-shot bridge 任务并 await 其结果（校验链见模块头 1–11 步）。
   *
   * @param {DispatchAgentTaskRequest} request 派发请求
   * @returns {Promise<DispatchOutcome>} 压平结果；基础设施故障 reject（与
   *          driver sync 路由一致），子代理级失败不 throw（stopReason 承载）
   * @throws {Error} 参数白名单 / backend / role / enum / 两道权限闸 / cwd /
   *         并发槽任一不过时（全部 loud，绝不静默降级或改道）
   */
  async function dispatchAgentTask(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('subagentsDispatch: dispatchAgentTask requires a request object')
    }

    // ── 1. 参数白名单（红线 8）：native 专属与未知参数绝不静默忽略 ────────
    // 四个 bypass 面一并封死（合法调用方是普通对象 / JSON 形态、进程未被
    // 污染，四者皆零命中：零开销、零行为变化）：
    //  a) 符号键 —— Object.keys 只枚举字符串键，[Symbol('x')]: 1 会绕过下方
    //     循环被静默忽略（解构同样读不到）；
    //  b) 原型链继承键 —— Object.create({ persona: 'x' }) 的继承键同样不进
    //     Object.keys；更糟的是解构沿原型链读取，继承的合法键（backend /
    //     settings…）会被实际消费、继承的未知键被静默忽略 —— 两种形态都
    //     违背红线 8，故非 plain-object 原型一律 loud（不解内容、拒原型面；
    //     类实例的非枚举 getter 也能被解构读到，严格拒是对的）。
    //     null 原型（Object.create(null)）放行：它没有任何继承键，bypass 面
    //     为空，放行更精确。
    //  c) Object.prototype 污染 —— 若进程内发生原型污染（缺陷 merge /
    //     deepClone 的常见后果，如 Object.prototype.persona = 'x'），污染键
    //     同时绕过 Object.keys 白名单与下方 proto === Object.prototype 快速
    //     路径，且会被沿原型链的解构实际消费。标准污染（赋值式）产生可枚举
    //     键 → 此处 loud；非枚举的 Object.defineProperty 污染属蓄意行为、
    //     超出意外污染面。fail-closed：污染发生时所有 dispatch loud 拒绝，
    //     好于静默消费污染键。
    const symbolKeys = Object.getOwnPropertySymbols(request)
    if (symbolKeys.length > 0) {
      throw new Error(
        `subagentsDispatch: request must not carry symbol-keyed properties (${symbolKeys.length} found) `
        + `— only ${ALLOWED_PARAMS.join(', ')} are accepted`,
      )
    }
    const proto = Object.getPrototypeOf(request)
    if (proto !== null && proto !== Object.prototype) {
      throw new Error(
        `subagentsDispatch: request must be a plain object — a custom prototype would carry inherited properties past the parameter whitelist `
        + `(only ${ALLOWED_PARAMS.join(', ')} are accepted; red line 8: nothing is silently ignored)`,
      )
    }
    if (proto === Object.prototype && Object.keys(proto).length > 0) {
      throw new Error(
        `subagentsDispatch: Object.prototype is polluted with enumerable keys (${Object.keys(proto).join(', ')}) `
        + '— inherited keys would bypass the parameter whitelist and be consumed by destructuring '
        + '(red line 8: nothing is silently ignored). Fix the in-process prototype pollution.',
      )
    }
    for (const key of Object.keys(request)) {
      if (NATIVE_ONLY_PARAMS.includes(key)) {
        throw new Error(
          `subagentsDispatch: parameter "${key}" is not supported by this seam (bridge-only dispatch; `
          + 'native-only parameters belong to the official ctx.subagents.start channel)',
        )
      }
      if (!ALLOWED_PARAMS.includes(key)) {
        throw new Error(
          `subagentsDispatch: unknown parameter "${key}" (allowed: ${ALLOWED_PARAMS.join(', ')})`,
        )
      }
    }
    const { backend, task, parent, label, role: roleId, settings, cwd, signal } = request
    if (typeof backend !== 'string' || backend.length === 0) {
      throw new Error('subagentsDispatch: dispatchAgentTask requires a non-empty string `backend`')
    }
    if (typeof task !== 'string' || task.length === 0) {
      throw new Error('subagentsDispatch: dispatchAgentTask requires a non-empty string `task`')
    }
    if (!parent || typeof parent !== 'object') {
      throw new Error('subagentsDispatch: dispatchAgentTask requires a `parent` (the delegating live Agent handle)')
    }
    // parent 形状前置校验（live Agent 句柄契约）：ceiling 主体（session.id）
    // 与 cwd 缺省（session.header.cwd）都依赖它 —— 缺失时在深处 TypeError
    // 不如在这里 loud 指明契约。
    if (!parent.session || typeof parent.session !== 'object'
      || typeof parent.session.id !== 'string' || parent.session.id.length === 0) {
      throw new Error(
        'subagentsDispatch: `parent` must be a live Agent handle with parent.session.id (a non-empty string) '
          + '— it is the delegation-ceiling subject and the default cwd source',
      )
    }
    if (label !== undefined && typeof label !== 'string') {
      throw new Error('subagentsDispatch: `label` must be a string')
    }
    if (roleId !== undefined && (typeof roleId !== 'string' || roleId.length === 0)) {
      throw new Error('subagentsDispatch: `role` must be a non-empty role id string')
    }
    if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
      throw new Error('subagentsDispatch: `settings` must be an object { model?, reasoningEffort?, permissionMode? }')
    }
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new Error('subagentsDispatch: `cwd` must be an absolute path string')
    }

    // ── 2. backend 校验（§5 桥专精：native 名 loud 重定向，不静默改道）────
    if (backend === 'native' || backend === 'spawn' || backend === 'fork') {
      throw new Error(
        `subagentsDispatch: backend "${backend}" is not served by this seam — this seam dispatches bridge backends only `
        + '(native subagents carry no permissionMode / reasoningEffort settings, and the official channel already covers them). '
        + 'Use ctx.subagents.start(provider, request) for native subagents instead of routing them through this seam.',
      )
    }
    const driver = assembled.bridges.get(backend)
    if (!driver) {
      const names = [...assembled.bridges.keys()]
      throw new Error(
        `subagentsDispatch: unknown backend "${backend}" (${names.length > 0
          ? `available: ${names.join(', ')}`
          : 'no bridge backend is assembled on this deployment — see subagent_agents for availability'})`,
      )
    }
    const availability = driver.available()
    if (!availability || !availability.registered) {
      throw new Error(`subagentsDispatch: backend "${backend}" is not available${availability ? `: ${availability.reason}` : ''}`)
    }

    // ── 3. role 解析（可选、无缺省角色；语义与工具层逐字相同）──────────────
    const role = roleId !== undefined ? roles.get(roleId) : undefined
    if (roleId !== undefined && !role) {
      throw new Error(`subagentsDispatch: unknown role "${roleId}" (available: ${roles.list().map((r) => r.id).join(', ')})`)
    }
    if (role) {
      const roleBackend = role.backend || ''
      if (roleBackend !== '' && roleBackend !== backend) {
        throw new Error(
          `subagentsDispatch: role "${role.id}" pins backend "${roleBackend}" but backend "${backend}" was passed. `
          + `Pass backend "${roleBackend}" or drop the role — a pinned role and a different explicit backend is a mismatch.`,
        )
      }
    }

    // ── 4. settings 组装 + 手工 enum 校验（无 schema 面；fail closed）──────
    if (settings !== undefined) {
      if (settings.permissionMode !== undefined && !PERMISSION_MODES.includes(settings.permissionMode)) {
        throw new Error(
          `subagentsDispatch: settings.permissionMode must be one of "readonly", "default", "full" (got ${JSON.stringify(settings.permissionMode)})`,
        )
      }
      if (settings.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(settings.reasoningEffort)) {
        throw new Error(
          `subagentsDispatch: settings.reasoningEffort must be one of "low", "medium", "high" (got ${JSON.stringify(settings.reasoningEffort)})`,
        )
      }
    }
    const permissionMode = resolveBridgePermissionMode({
      explicit: settings && settings.permissionMode,
      role,
    })
    if (!PERMISSION_MODES.includes(permissionMode)) {
      throw new Error(
        `subagentsDispatch: resolved permissionMode must be one of "readonly", "default", "full" (got ${JSON.stringify(permissionMode)}${role && role.permissionMode !== undefined ? ` — from role "${role.id}"` : ''})`,
      )
    }
    const resolvedSettings = buildBridgeSettings({
      permissionMode,
      model: settings && settings.model,
      reasoningEffort: settings && settings.reasoningEffort,
    })

    // ── 5. 两道权限闸（§3.1–3.2）───────────────────────────────────────────
    // gate 1 — parent-based ceiling：binding ∪ durable registry 并集（逐字
    // 复用工具层判定；readonly 子代理借插件之手 spawn full 后代被结构性堵死）。
    assertCallerWithinCeiling({ parent, bindings, registry, requestedMode: permissionMode })
    // gate 2 — config cap：部署侧第二道闸；越界 loud（绝不静默降级）。
    // 合法性用 PERMISSION_MODES.includes（闭集数组）而非 PERM_RANK[cap]：
    // 'toString' / 'constructor' 等原型键会从 PERM_RANK 查出继承函数（非
    // undefined），NaN 比较恒 false → cap 静默失效（fail-open）。
    const cap = config.maxDispatchPermissionMode ?? 'full'
    if (!PERMISSION_MODES.includes(cap)) {
      throw new Error(
        `subagentsDispatch: config.maxDispatchPermissionMode must be one of "readonly", "default", "full" (got ${JSON.stringify(cap)})`,
      )
    }
    const capRank = PERM_RANK[cap]
    if (PERM_RANK[permissionMode] > capRank) {
      throw new Error(
        `subagentsDispatch: dispatch permissionMode "${permissionMode}" exceeds the deployment cap `
        + `maxDispatchPermissionMode "${cap}" — raise maxDispatchPermissionMode in the plugin config, or request a lower permission mode`,
      )
    }

    // ── 6. task 前缀：role.instructions 进任务文本（对齐工具层）────────────
    const prefixedTask = role && role.instructions ? `${role.instructions}\n\n${task}` : task

    // ── 7. cwd 解析：显式值过 assertCwd；省略 → parentCwd(parent) ─────────
    const resolvedCwd = cwd !== undefined ? assertCwd(cwd) : parentCwd(parent)

    // ── 8. 并发槽（§3.4 定案占槽）：检查 + 加合成键在任一 await 前同步完成
    //        （JS 单线程无 TOCTOU 窗口）；finally 释放（settle 或 throw 都删）。
    const maxConcurrent = config.maxConcurrentChildren ?? 8
    const liveChildren = state.liveChildren
    if (liveChildren.size >= maxConcurrent) {
      throw new Error(
        `subagentsDispatch: concurrency limit reached (${maxConcurrent} bridge children with a turn in flight). `
        + 'Wait for a subagent or in-flight dispatch to settle, or raise maxConcurrentChildren.',
      )
    }
    const slotKey = `dispatch:${state.nextSeq()}`
    liveChildren.add(slotKey)

    // ── 9. 执行（driver sync 路由：create → submit(settings) → dispose；
    //        零 binding / 零 registry 写入 —— one-shot 无恢复语义，§3.3）────
    let outcome
    try {
      outcome = await driver.start({
        ...(label !== undefined ? { label } : {}),
        task: prefixedTask,
        parent,
        signal,
        route: 'sync',
        cwd: resolvedCwd,
        bridge: { provider: backend, settings: resolvedSettings },
      })
    } finally {
      liveChildren.delete(slotKey)
    }

    // ── 10. 结果压平（§2.3）：恒 foreground；单 text block → text ─────────
    if (!outcome || outcome.kind !== 'foreground') {
      throw new Error(
        `subagentsDispatch: unexpected driver outcome kind "${outcome && outcome.kind}" from the sync route (expected "foreground")`,
      )
    }
    const blocks = Array.isArray(outcome.output) ? outcome.output : []
    const firstText = blocks.find((b) => b && b.type === 'text')
    const result = {
      backend,
      runId: outcome.runId,
      ...(label !== undefined ? { label } : {}),
      text: firstText && typeof firstText.text === 'string' ? firstText.text : '',
      stopReason: outcome.stopReason,
    }

    // ── 11. 一行 dispatch 日志（backend / permissionMode / label / runId）─
    log(
      `dsh-plugin-subagents: dispatch backend=${backend} permissionMode=${permissionMode}`
      + `${label !== undefined ? ` label="${label}"` : ''} runId=${outcome.runId} settled (${outcome.stopReason})`,
    )

    return result
  }

  return {
    /** 是否有至少一个 bridge driver 装配成功（availability 检测通过）。 */
    available: assembled.bridges.size > 0,
    /** 已装配 bridge provider 名列表（等价 assembled.bridges.keys()）。 */
    backends: () => [...assembled.bridges.keys()],
    dispatchAgentTask,
  }
}
