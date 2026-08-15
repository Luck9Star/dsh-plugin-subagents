// dsh-plugin-subagents — 驱动装配层（T10，DESIGN §3.4）。
//
// 把 native（spawn/fork）与 bridge（外部 agent CLI）两后端统一装配成一份
// 可解析的后端注册表，供工具层（T11+）按后端 id 取用：
//
//   - native.spawn / native.fork 是 createNativeDriver 的两实例（kind 区分，
//     provider 取 config.provider ?? 'spawn' / config.fork?.provider ?? 'fork'）；
//   - bridges 是 Map<name, BridgeDriver>，仅对 PATH 检测存在（`registered`）
//     的 provider 建 driver（逻辑参照前身 legacy-bridges-plugin lib/index.js
//     L49–L58：availability 后过滤注册名）；
//   - state 是跨全部 bridge 共享的单一治理态（createBridgeState），registry
//     实例在此创建并共享 —— 红线 10「唯一恢复源」：一次装配内只此一个；
//   - bridgeProviders 是 createBridgeProviders 产物（仅生成不注册，注册由
//     apply 层 T14 经 attachAll 一行做）；
//   - resolveBackend(id) 统一后端 id → driver 解析（'native' →
//     native.spawn；'native:fork' → native.fork；bridge 名 → bridges.get(id)；
//     未知 → undefined）。
//
// 本层**不**调用 ctx.subagents.registerProvider、**不**挂事件 —— 这些是 apply
// 层（T14）职责；导出 attachAll(ctx, assembled) 辅助一次性完成。
//
// 注意：config 是本装配层接收的**已校验对象**（zod 校验在 T14 lib/config.js），
// 此处直接按字段取用（config.providers ?? {} / registryPath / idleTimeoutMs
// / maxConcurrentChildren），不作为本层职责。

import { buildProviders, createBridgeFor } from '../providers.js'
import { detectAvailability } from '../availability.js'
import { createRegistry } from '../registry.js'
import { createNativeDriver } from './native.js'
import {
  createBridgeState,
  createBridgeProviders,
  attachBridgeLifecycle,
  createBridgeDriver,
} from './bridge.js'

/**
 * 装配全部子代理驱动（DESIGN §3.4 两后端）。
 *
 * @param {Object} spec
 * @param {Object} spec.ctx       宿主 ctx（透传：native provider 注册探测 /
 *                                 bridge 驱动 / bridgeProviders 生命周期接缝）
 * @param {Object} [spec.config]  已校验插件配置（provider / fork / providers /
 *                                 registryPath / idleTimeoutMs / ...；未校验原样透传）
 * @returns {Promise<{
 *   native: {spawn: Object, fork: Object},
 *   bridges: Map<string, Object>,
 *   providerBridges: Record<string, Object>,
 *   availability: Object,
 *   state: Object,
 *   bridgeProviders: Array<Object>,
 *   resolveBackend: (id: string) => Object | undefined,
 * }>}
 */
export async function assembleDrivers({ ctx, config = {} }) {
  // ── native：spawn / fork 两实例 ───────────────────────────────────────────
  // provider 默认 'spawn'（delegate）/ config.fork?.provider ?? 'fork'（fork）。
  // 同名字段（agentOptions/persona/toolFilter/maxDepth）随 config 直传。
  const spawn = createNativeDriver({
    kind: 'spawn',
    ctx,
    config: {
      provider: config.provider ?? 'spawn',
      agentOptions: config.agentOptions,
      persona: config.persona,
      toolFilter: config.toolFilter,
      maxDepth: config.maxDepth,
    },
  })
  const fork = createNativeDriver({
    kind: 'fork',
    ctx,
    config: {
      provider: config.fork && config.fork.provider !== undefined ? config.fork.provider : 'fork',
      ...(config.fork ?? {}),
    },
  })

  // ── bridge：availability 后只对 registered 的 provider 建桥与 driver ─────
  const providers = buildProviders({ providers: config.providers ?? {} })
  const availability = await detectAvailability(providers)

  // 全局唯一治理态：registry 实例在此创建并随 state 共享（红线 10）。
  const registry = createRegistry(config.registryPath)
  const state = createBridgeState({
    registry,
    idleTimeoutMs: config.idleTimeoutMs,
  })

  const bridges = new Map()            // 后端 id → BridgeDriver
  const providerBridges = {}           // provider 名 → 底层 bridge 实例（createBridgeProviders 用；
                                       // 亦随 assembled 透出 —— subagent_submit 的恢复管道直用
                                       // bridge.reconnect/create/submit，driver 面不承载该路径）
  for (const [name, def] of Object.entries(providers)) {
    if (!availability[name].registered) continue
    const bridge = createBridgeFor(def)
    providerBridges[name] = bridge
    bridges.set(name, createBridgeDriver({
      name,
      bridge,
      providers,
      state,
      availability: () => availability[name],
      ctx,
    }))
  }

  // provider 对象数组（仅生成，注册由 apply 层 T14 做）。
  const bridgeProviders = createBridgeProviders({
    bridges: providerBridges,
    providers,
    state,
  })

  /**
   * 后端 id → driver 的统一解析。
   * @param {string} id 'native' | 'native:fork' | bridge provider 名
   * @returns {Object | undefined}
   */
  const resolveBackend = (id) => {
    if (id === 'native') return spawn
    if (id === 'native:fork') return fork
    return bridges.get(id)
  }

  return {
    native: { spawn, fork },
    bridges,
    providerBridges,
    availability,
    state,
    bridgeProviders,
    resolveBackend,
  }
}

/**
 * 装配态的副作用挂载：bridge 生命周期挂接 + bridgeProviders 全部注册。
 * 供 apply 层（T14）一行调用；本装配层自身不执行任何副作用。
 *
 * @param {Object} ctx                  宿主 ctx（需 ctx.on / ctx.effect /
 *                                      ctx.subagents.registerProvider）
 * @param {ReturnType<typeof assembleDrivers>} assembled assembleDrivers 产物
 */
export function attachAll(ctx, assembled) {
  attachBridgeLifecycle(ctx, assembled.state)
  for (const provider of assembled.bridgeProviders) {
    ctx.subagents.registerProvider(provider)
  }
}
