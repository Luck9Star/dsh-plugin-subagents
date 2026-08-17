// dsh-plugin-subagents — SubagentDriver 契约模块（T07）。
//
// 本模块固定 DESIGN §3.2 的统一子代理抽象契约，并承载 §3.4 的两后端能力
// 常量与 §3.5 的参数-能力矩阵校验。JS 无类型层，JSDoc（TypeScript 风格签名）
// 即契约文档：字段注释逐条对应 `docs/DESIGN.md` §3.2 / §3.4 / §3.5。
//
// 纯新增模块，不依赖其它 lib/ 文件，可独立 import。

/**
 * 后端 id：native 用 'native:spawn' | 'native:fork'；bridge 用 provider 名
 * （'codex' | 'claude-code' | 'acp' | config.providers 键）。
 * @typedef {string} BackendId
 */

/**
 * 能力声明 —— 工具层据此决定参数是否可见、不支持的参数如何失败（一律 loud error）。
 * 对应 DESIGN §3.2 `DriverCapabilities`。
 * @typedef {Object} DriverCapabilities
 * @property {boolean} cwd             per-call 工作目录（native：需 provider 补丁就位）
 * @property {boolean} persona         per-call persona / @preset:（native）
 * @property {boolean} toolFilter      per-call 子代理工具过滤（native）
 * @property {boolean} llmRoute        per-call LLM 路由 provider/model（native）
 * @property {boolean} maxDepth        委派深度上限（native：harness depthLimit）
 * @property {boolean} permissionMode  远端产品权限档（bridge）
 * @property {boolean} reasoningEffort 远端产品推理档（bridge）
 * @property {boolean} continuable     可续续会话（native：continuable child；bridge：relay child）
 * @property {boolean} backgroundJob   一次性后台作业（native：jobs 集成；bridge：无需 —— relay child 天然后台）
 * @property {boolean} durableResume   跨重启恢复（native：harness session 持久化；bridge：durable registry）
 * @property {boolean} promptInjectionGuard 任务文本恒走 '--' 之后 + flag 值白名单（bridge；native 不适用恒 true 语义缺省）
 */

/**
 * 可用性探测结果（DESIGN §3.2 `DriverAvailability`）。
 * @typedef {Object} DriverAvailability
 * @property {boolean} registered 是否已注册/可命中
 * @property {string} reason      未就绪的原因；就绪时为描述性说明
 * @property {{ok: boolean, note: string}} [auth] 鉴权状态（bridge 登录产物是否就绪）
 */

/**
 * 单条 driver 的元信息（DESIGN §3.2 `DriverInfo`）。
 * @typedef {Object} DriverInfo
 * @property {BackendId} id                         后端 id
 * @property {'native'|'bridge'} kind               后端类型
 * @property {boolean} inheritsParentContext        描述性（非强制）：子代理是否看到父会话完成回合
 *                                                  （native fork = true，spawn/bridge = false）
 * @property {DriverCapabilities} capabilities      能力声明
 * @property {() => DriverAvailability} available   可用性：CLI 是否在 PATH、登录产物是否存在（bridge）；
 *                                                  provider 是否注册（native）
 */

/**
 * 一次委派请求（工具层已完成 role 解析、instructions 前缀拼接、天花板校验）。
 * 对应 DESIGN §3.2 `DelegateRequest`。
 * @typedef {Object} DelegateRequest
 * @property {string} label                                3-5 词展示标签
 * @property {string} task                                 已含 role.instructions 前缀的任务文本
 * @property {Object} [parent]                             父代理句柄
 * @property {Object} [signal]                             中止信号（AbortSignal）
 * @property {string} [cwd]                                 可选，仅 sync 路径：显式远端会话
 *                                                          cwd（绝对路径，assertCwd 已在调用方
 *                                                          —— 引擎级 dispatch 缝 lib/dispatch.js
 *                                                          —— 校验）。工具层 bridge 分支不设该
 *                                                          字段（能力矩阵 bridge cwd ❌：模型面
 *                                                          恒用父会话 cwd），continuable 路由亦
 *                                                          不消费；缺省 = parentCwd(parent)
 * @property {'sync'|'job'|'continuable'} route            'sync'（前台等结果）| 'job'（一次性后台作业）
 *                                                         | 'continuable'（可续续子代理）
 * @property {Object} [native]                             仅 native 后端（capabilities 不满足的字段出现即 throw，
 *                                                         工具层先行校验，driver 兜底）
 * @property {string} [native.provider]                    spawn | fork | 其它已注册 in-process provider 名
 * @property {{provider?: string, model?: string, maxTokens?: number}} [native.agentOptions] 代理选项
 * @property {string} [native.persona]                     persona，可含 @preset: 引用
 * @property {{allow?: string[], deny?: string[]}} [native.toolFilter] 子代理工具过滤
 * @property {number|'provider-managed'} [native.maxDepth] 委派深度上限
 * @property {string} [native.cwd]                         绝对路径；补丁未就位时由工具层以明确错误拒绝
 * @property {Object} [bridge]                             仅 bridge 后端
 * @property {string} bridge.provider                      远端产品名
 * @property {{model?: string, reasoningEffort?: 'low'|'medium'|'high', permissionMode?: 'readonly'|'default'|'full'}} bridge.settings 远端设置
 */

/**
 * 委派结果 —— stopReason 统一采用 harness 词汇
 * （completed/aborted/error/max-tokens/refusal；bridge 外来值原样透传）。
 * 对应 DESIGN §3.2 `DelegateOutcome`。
 * @typedef {{kind:'foreground', runId:string, output:Array<Object>, stopReason:string}
 *          |{kind:'job', jobId:string}
 *          |{kind:'continuable', childId:string, backend:BackendId, role?:string, permissionMode?:string}} DelegateOutcome
 */

/**
 * 进度快照 —— 两条路径共用 session-log 折叠 + bridge binding/registry 补充。
 * 对应 DESIGN §3.2 `ProgressSnapshot`。
 * @typedef {Object} ProgressSnapshot
 * @property {string} childId                                  子代理 id
 * @property {'running'|'inactive'|'stored'|'unknown'} status  状态
 * @property {string} [label]                                  展示标签
 * @property {number} [turn]                                   回合数
 * @property {number} [stepCount]                              步数
 * @property {string} [lastTask]                               最近任务
 * @property {string} [lastAnswer]                             最近答案
 * @property {string} [lastActivityAt]                         最近活跃时间
 * @property {*} [tokenUsage]                                  令牌用量
 * @property {string} [pinnedProduct]                          桥接产品名（bridge 专属；native driver 返回 undefined）
 * @property {string} [remoteSessionId]                        远端会话 id（bridge 专属）
 * @property {{busySince?: string, stage?: string, receivedChars?: number, partialPreview?: string}} [inFlight] 进行中状态（bridge 专属）
 * @property {string} [model]                                  所用模型
 * @property {string} [reasoningEffort]                        推理档
 */

/**
 * 统一子代理驱动 —— 一个接口覆盖 native 与 bridge 两类后端（DESIGN §3.2 `SubagentDriver`）。
 * 生命周期词汇复用 harness seam（subagent/start|end、stopReason、AbortError/TimeoutError），
 * driver 不发明第二套状态机。
 * @typedef {DriverInfo} SubagentDriver
 * @property {(request: DelegateRequest) => Promise<DelegateOutcome>} start
 *   发起一次委派。一次性/前台路径在返回前 settle；job/continuable 立即返回句柄。
 * @property {(childId: string, task: string, opts: {signal?: Object}) => Promise<void>} [followup]
 *   可续续子代理的后续回合
 *   （bridge = 向远端会话提交；native = 提示模型用官方 send_message，本方法仅 bridge driver 实现）。
 * @property {(childId: string) => Promise<ProgressSnapshot>} progress
 *   进度快照：两条路径共用 session-log 折叠 + bridge binding/registry 补充。
 * @property {(childId: string) => Promise<void>} dispose
 *   释放一个子代理占用的后端资源
 *   （native：run.dispose / harness 自理；bridge：idle 语义由共享层调度，此方法用于显式释放）。
 */

/**
 * Native 能力常量（DESIGN §3.4 NativeDriver.capabilities）。
 * native 具备：cwd / persona / toolFilter / llmRoute / maxDepth / continuable /
 * backgroundJob / durableResume 全 true；permissionMode / reasoningEffort /
 * promptInjectionGuard 不适用 → false（§3.2 界面上这些字段总是布尔）。
 * @type {DriverCapabilities}
 */
export const NATIVE_CAPS = Object.freeze({
  cwd: true,
  persona: true,
  toolFilter: true,
  llmRoute: true,
  maxDepth: true,
  continuable: true,
  backgroundJob: true,
  durableResume: true,
  permissionMode: false,
  reasoningEffort: false,
  promptInjectionGuard: false,
})

/**
 * Bridge 能力常量（DESIGN §3.4 BridgeDriver.capabilities）。
 * bridge 具备：permissionMode / reasoningEffort / continuable / durableResume /
 * promptInjectionGuard 全 true；cwd / persona / toolFilter / llmRoute / maxDepth /
 * backgroundJob 不适用 → false。
 * @type {DriverCapabilities}
 */
export const BRIDGE_CAPS = Object.freeze({
  cwd: false,
  persona: false,
  toolFilter: false,
  llmRoute: false,
  maxDepth: false,
  continuable: true,
  backgroundJob: false,
  durableResume: true,
  permissionMode: true,
  reasoningEffort: true,
  promptInjectionGuard: true,
})

/**
 * §3.5 能力矩阵：普通参数（归一化名称）→ 所需 capability 键的映射。
 * 覆盖除 `model` 外的全部 §3.5 行。`model` 两后端都收（native llmRoute / bridge
 * 白名单在工具层外层），因此不在此映射、不校验。
 */
const MATRIX = Object.freeze([
  ['provider', 'llmRoute'],          // 仅 native（provider 覆盖）；bridge 用 backend 选产品 → loud error
  ['persona', 'persona'],            // native @preset:；bridge relay 人格固定 → loud error
  ['toolFilter', 'toolFilter'],      // native 子代理过滤；bridge relay 恒只读 → loud error
  ['cwd', 'cwd'],                    // native 需补丁；bridge 用父会话 cwd → loud error
  ['maxDepth', 'maxDepth'],          // native 层 depthLimit；bridge 不支持 → loud error
  ['permission_mode', 'permissionMode'],  // bridge 天花板校验；native 不支持 → loud error
  ['reasoning_effort', 'reasoningEffort'],// bridge 推理档；native 不支持 → loud error
])

/**
 * 依据能力声明推断后端类型（native / bridge / unknown）。
 * 仅用于错误消息的可读提示，不作身份判定。
 * @param {DriverCapabilities} [capabilities]
 * @returns {'native'|'bridge'|'unknown'}
 */
export function backendKind(capabilities) {
  if (!capabilities || typeof capabilities !== 'object') return 'unknown'
  if (capabilities.permissionMode || capabilities.reasoningEffort) return 'bridge'
  if (capabilities.llmRoute || capabilities.persona || capabilities.cwd) return 'native'
  return 'unknown'
}

/**
 * 参数-能力矩阵校验（DESIGN §3.5）。
 *
 * 对归一化参数对象（键：model, provider, persona, toolFilter, cwd, maxDepth,
 * permission_mode, reasoning_effort）逐条按能力矩阵校验：某参数存在而对应 capability
 * 为 false，则**绝不静默忽略**——同步 throw `Error`，消息含参数名与后端能力提示。
 * `model` 两后端都收，不校验。空参数对象恒通过。
 *
 * 规则映射：
 * - provider       → 需 llmRoute（native 仅）→ bridge 收到 throw
 * - persona        → 需 persona
 * - toolFilter     → 需 toolFilter
 * - cwd            → 需 cwd
 * - maxDepth       → 需 maxDepth
 * - permission_mode → 需 permissionMode
 * - reasoning_effort → 需 reasoningEffort
 *
 * @param {DriverCapabilities} capabilities 后端能力声明（通常 = driver.capabilities）
 * @param {Object} params                   工具层归一参数对象
 * @param {BackendId} [backendId]           后端 id（可选，仅用于错误消息；缺省按能力推断）
 * @returns {void}
 * @throws {Error} 当某提供的参数不被后端能力支持时。
 */
export function assertParamsSupported(capabilities, params, backendId) {
  const kind = backendKind(capabilities)
  const id = backendId ?? kind
  for (const [param, capKey] of MATRIX) {
    if (params?.[param] !== undefined && !capabilities?.[capKey]) {
      throw new Error(
        `subagent: parameter "${param}" is not supported by backend "${id}" (${kind})`
      )
    }
  }
}
