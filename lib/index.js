// dsh-plugin-subagents — apply() 总装（T14，DESIGN §4.1 / §6.1 / §6.6 / §6.3-L2）。
//
// 单实例双面（§4.1）：全局实例持有全部共享状态（bindings / registry / 并发槽
// —— 红线 10），presetRow 实例（§6.3-L2）无状态、只注册本行 toolName 的
// native 委派工具。apply() 次序：
//
//   a. validateConfig（lib/config.js zod strict 双分支：presetRow === true 走
//      官方行形状的轻分支，其余走 §6.1 全表；未知键 fail loud）；
//   b. dsh-tools 双实例自检（R2，见 assertSingleDshToolsInstance）；
//   c. presetRow 分支：toolName 撞名守卫（与全局实例/其它 presetRow 行并存
//      的硬约束）→ 最小 native 装配 → 只注册行 toolName → 返回（不注册
//      provider / 辅助工具 / 不迁移 / 不别名）；
//   d. registry 一次性迁移（§6.6，lib/registry.js migrateLegacyRegistry：
//      product 字段→backend、原子写、.migrated 标记防重入、旧文件不动）；
//   e. assembleDrivers + attachAll（bridge provider 注册、生命周期配对、
//      teardown effect —— disposeAll 由 attachBridgeLifecycle 的 ctx.effect
//      持有，此处不再重复注册）；
//   f. 按 register 开关注册七工具（默认全 true；toolNames.delegate/fork 可
//      改名）；
//   g. legacy 别名（§6.6，legacyProductAliases 默认 'auto'：迁移导入有条目，
//      或迁移标记在且 registry 有条目 —— 重启后仍判定 —— 时额外注册
//      product_submit（复用 registerSubagentSubmit 换名）与 product_delegate
//      （薄适配注册器，旧 schema，execute 委派统一 subagent 工具））。
//
// 返回值：恒 undefined —— Cordis 将该回调返回值当 disposable 校验（非
// null/undefined 或函数即抛 `TypeError: Invalid effect`），故绝不返回装配产物。
// 装配/迁移的内省通过直接调用内部构件（assembleDrivers / migrateLegacyRegistry）
// 或 fakeCtx 的注册记录完成。第三参 injections 是**测试专用**注入缝
// （legacyRegistryPath），宿主恒以 apply(ctx, config) 调用。

import { TOOL_RUNTIME_SCHEDULER } from '@deepseek-ai/dsh-tools'
import { validateConfig } from './config.js'
import { createDispatchSeam } from './dispatch.js'
import { assembleDrivers, attachAll } from './drivers/index.js'
import { createNativeDriver } from './drivers/native.js'
import { foldProgress, foldTrace, foldTokenUsage } from './progress.js'
import { migrateLegacyRegistry } from './registry.js'
import { attachRelayGuard } from './relay-guard.js'
import { createRoleLibrary, defaultRolesDir } from './roles.js'
import { registerSubagentTool } from './tools/subagent.js'
import { registerSubagentFork } from './tools/subagent-fork.js'
import { registerSubagentSubmit } from './tools/subagent-submit.js'
import { registerSubagentProgress } from './tools/subagent-progress.js'
import { registerSubagentWait } from './tools/subagent-wait.js'
import { registerSubagentRoles } from './tools/subagent-roles.js'
import { registerSubagentAgents } from './tools/subagent-agents.js'
import { registerProductDelegateAlias } from './tools/product-delegate-alias.js'

export const name = 'dsh-plugin-subagents'
export const inject = ['subagents', 'tools', 'systemPrompt']

/** register 开关缺省全开（§4.1「工具是否注册由 register 开关控制，默认全开」）。 */
const REGISTER_DEFAULTS = Object.freeze({
  delegate: true, fork: true, submit: true, progress: true, wait: true, roles: true, agents: true,
})

/** presetRow 撞名守卫与 config.js 静态守卫共用的指引文案（§6.3-L2）。 */
const DISTINCT_TOOLNAME_HINT = 'presetRow 行必须使用与全局实例 delegate/fork 及其它 presetRow 行不同的 toolName'
  + '（如 plan_agent / scout_agent，见 DESIGN §6.3-L2）'

/**
 * dsh-tools 双实例自检（R2 / 任务 b）。
 *
 * 机制（§2.2 peer 陷阱）：宿主的 ToolRuntime 实例以**其自身模块副本**的
 * `TOOL_RUNTIME_SCHEDULER` Symbol 为键携带调度器；本插件 import 的 Symbol 若
 * 来自第二物理副本，`ctx.tools[Symbol]` 即 undefined —— 这正是全部工具调用
 * 死于 "Cannot read properties of undefined (reading 'prepare')" 的根因。
 * 该 Symbol 由 dsh-tools 导出，故探测**直接且无副作用**：
 *
 *   1. `ctx.tools[TOOL_RUNTIME_SCHEDULER] !== undefined` → 同一副本，健康；
 *   2. Symbol 缺席但 ctx.tools 形似真 ToolRuntime（view/schemas/register 均在）
 *      → 真双实例：logger.fatal + throw（apply 失败好过加载后全工具阵亡），
 *      指引重跑 patches/install（A 段链接修复）/ patches/verify；
 *   3. 其余（fake ctx / 未见过的宿主形状）→ 无法可靠判定，仅 warn 提示手动
 *      跑 patches/verify —— 不 fatal（测试与非标准宿主不该被误杀）。
 *
 * 已知边界：若宿主 dsh-tools 版本老于 rc.6（调度器字段尚未引入），分支 2 会
 * 误报 —— peerDependencies 已锁 ^0.1.0-rc.6 版本族，越界组合不属本插件契约。
 */
function assertSingleDshToolsInstance(ctx) {
  const tools = ctx && ctx.tools
  if (!tools || typeof tools.register !== 'function') return
  if (tools[TOOL_RUNTIME_SCHEDULER] !== undefined) return // same physical module — healthy
  const looksLikeToolRuntime = typeof tools.view === 'function' && typeof tools.schemas === 'function'
  if (looksLikeToolRuntime) {
    const detail = 'dsh-plugin-subagents: detected a second @deepseek-ai/dsh-tools module instance — '
      + "every tool call from this plugin would die with \"Cannot read properties of undefined (reading 'prepare')\". "
      + 'Run the link-fix stage from the dsh-plugin-subagents package (patches/install.sh, or patches/install.sh --links-only) '
      + 'so both dsh-tools copies resolve to the live harness root, then restart dsh; patches/verify.sh reports the current state.'
    if (ctx.logger && typeof ctx.logger.fatal === 'function') ctx.logger.fatal(detail)
    throw new Error(detail)
  }
  if (ctx.logger && typeof ctx.logger.warn === 'function') {
    ctx.logger.warn(
      'dsh-plugin-subagents: could not reliably verify the @deepseek-ai/dsh-tools single-instance invariant '
        + 'from this ctx (no scheduler symbol, no ToolRuntime shape) — run patches/verify.sh to check the dedupe links',
    )
  }
}

/**
 * presetRow 撞名守卫（T14 补充验收）：注册前查 ctx.tools —— 同名工具已注册
 * （全局实例的 delegate/fork，或更早的 presetRow 行）即 loud throw 并给出
 * §6.3-L2 指引。Cordis 全局层同名重复注册本身会抛 duplicate error，但报错
 * 不指路；这里抢在注册前给出可行动的文案。'subagent' 不在 config 层静态
 * 拒绝（独立 presetRow 部署的合法默认名），实际碰撞由本守卫按真实注册态判定。
 */
function assertPresetRowToolNameFree(ctx, toolName) {
  let existing
  try {
    existing = typeof ctx.tools?.get === 'function' ? ctx.tools.get(toolName) : undefined
  } catch {
    existing = undefined // a throwing get() must not break apply; register() would surface a duplicate loudly anyway
  }
  if (existing !== undefined) {
    throw new Error(
      `dsh-plugin-subagents: ${DISTINCT_TOOLNAME_HINT}——当前撞名：${toolName}`
      + `（该名字已在本宿主注册，通常来自全局实例的 delegate/fork 工具或另一条 presetRow 行）。`
      + 'A presetRow row must register a toolName distinct from the global instance\'s tools.',
    )
  }
}

/**
 * Plugin entry (T14). See the module header for the assembly order.
 *
 * @param {Object} ctx   Cordis ctx（subagents / tools / sessions + on/effect/logger）
 * @param {Object} [config] raw plugin config (validated here; zod strict)
 * @param {Object} [injections] TEST-ONLY seam ({ legacyRegistryPath }); the
 *                              host always calls apply(ctx, config)
 * @returns {Promise<undefined>} always undefined — the loader treats the plugin
 *          callback's return value as a disposable; a non-nullable non-function
 *          return fails real boots with "TypeError: Invalid effect"
 */
export async function apply(ctx, config = {}, injections = {}) {
  const cfg = validateConfig(config)
  assertSingleDshToolsInstance(ctx)

  // ── presetRow 分支（§6.3-L2）：native-only 单工具，无共享状态 ──────────────
  if (cfg.presetRow === true) {
    assertPresetRowToolNameFree(ctx, cfg.toolName)
    // 最小装配：直接 createNativeDriver（native-only 语义精确，且不经
    // assembleDrivers 的 availability 探测 / bridge 构造）。registerSubagentTool
    // 只消费 assembled.native.spawn 与 assembled.bridges（Map）并自带形状
    // loud 校验；空 bridges Map 使任何显式 bridge 名解析失败 → 明确
    // "unknown backend"（§6.3-L2：全局实例缺失时 bridge 委派给明确错误）。
    const spawn = createNativeDriver({
      kind: 'spawn',
      ctx,
      config: {
        provider: cfg.provider,
        ...(cfg.agentOptions !== undefined ? { agentOptions: cfg.agentOptions } : {}),
        ...(cfg.persona !== undefined ? { persona: cfg.persona } : {}),
        ...(cfg.toolFilter !== undefined ? { toolFilter: cfg.toolFilter } : {}),
        ...(cfg.maxDepth !== undefined ? { maxDepth: cfg.maxDepth } : {}),
      },
    })
    const assembled = { native: { spawn }, bridges: new Map() }
    registerSubagentTool(ctx, {
      assembled,
      // Package role library (not an empty one): registerSubagentTool resolves
      // the omitted role to "general" and fails loudly when roles.get returns
      // null — a truly empty library would break every presetRow delegation.
      roles: createRoleLibrary(defaultRolesDir()),
      config: cfg,
      toolName: cfg.toolName,
    })
    return undefined
  }

  // ── 全局实例 ────────────────────────────────────────────────────────────────
  const names = { delegate: 'subagent', fork: 'subagent_fork', ...(cfg.toolNames ?? {}) }
  const reg = { ...REGISTER_DEFAULTS, ...(cfg.register ?? {}) }
  const roles = createRoleLibrary(cfg.rolesDir || defaultRolesDir())

  // registry 一次性迁移（§6.6）。旧文件不可读/形状异常 → warn 后继续（新功能
  // 不依赖旧数据，仅旧 relay 子代理无法自动恢复）。
  const migration = migrateLegacyRegistry({
    ...(injections.legacyRegistryPath !== undefined ? { legacyPath: injections.legacyRegistryPath } : {}),
    targetPath: cfg.registryPath,
  })
  if (!migration.performed && !migration.markerExists && typeof migration.reason === 'string'
    && migration.reason.startsWith('legacy-unreadable')) {
    ctx.logger?.warn?.(`dsh-plugin-subagents: legacy legacy-bridges-plugin registry found but not importable (${migration.reason}); legacy relay children will not be auto-recovered`)
  }

  const assembled = await assembleDrivers({ ctx, config: cfg })
  // Providers + lifecycle pairing + teardown (ctx.effect → state.disposeAll):
  // owned by attachBridgeLifecycle inside attachAll — not re-registered here.
  attachAll(ctx, assembled)
  // 引擎级 dispatch 缝（T22，docs/dispatch-seam.md §4.1）：程序化 bridge 派发
  // （受控 permissionMode）的唯一入口，只由全局实例 provide（红线 10 ——
  // presetRow 分支在上面已 return，无状态、永不提供）。`provide` 是 Cordis
  // 基础 Context API，真实宿主恒在；typeof 守卫只为非 Cordis 的测试 double
  // （无 provide 面的 strict ctx）兜底，真实部署行为不变。
  if (typeof ctx.provide === 'function') {
    ctx.provide('subagentsDispatch', createDispatchSeam({ ctx, assembled, roles, config: cfg }))
  }
  // D2b relay 回合闭环确定性校验（DESIGN §5.4）：guard 只在「bridge relay
  // 子代理本 epoch 零 subagent_submit 就想 report」时拒绝；relayReportGuard:
  // false 关闭。presetRow 分支在上面已 return，永不挂（无状态，红线 10）。
  if (cfg.relayReportGuard !== false) attachRelayGuard(ctx, assembled)

  if (reg.delegate) registerSubagentTool(ctx, { assembled, roles, config: cfg, toolName: names.delegate })
  if (reg.fork) registerSubagentFork(ctx, { assembled, roles, config: cfg, toolName: names.fork })
  if (reg.submit) registerSubagentSubmit(ctx, { assembled, config: cfg })
  if (reg.progress) registerSubagentProgress(ctx, { assembled, foldProgress, foldTrace, foldTokenUsage })
  if (reg.wait) registerSubagentWait(ctx, { assembled, foldProgress, foldTrace })
  if (reg.roles) registerSubagentRoles(ctx, { roles })
  if (reg.agents) registerSubagentAgents(ctx, { assembled })

  // legacy 别名（§6.6）：'auto'（默认）= 本次迁移导入有条目，或迁移标记在且
  // registry 有条目（重启后的持久判定 —— 标记只写一次，条目随新旧子代理存续）；
  // true 强制注册；false 永不。别名同样受 register 开关约束（开关是工具族的
  // 总闸，别名是族内旧名副本）。
  if (cfg.legacyProductAliases === true
    || (cfg.legacyProductAliases !== false
      && (migration.performed ? migration.imported > 0 : (migration.markerExists && assembled.state.registry.size > 0)))) {
    if (reg.submit) registerSubagentSubmit(ctx, { assembled, config: cfg, toolName: 'product_submit' })
    if (reg.delegate) {
      registerProductDelegateAlias(ctx, { assembled, roles, config: cfg, toolName: 'product_delegate', delegateToolName: names.delegate })
    }
  }
}
