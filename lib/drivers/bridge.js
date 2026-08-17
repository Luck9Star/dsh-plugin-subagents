// dsh-plugin-subagents — BridgeDriver（外部 agent 桥接驱动，T09）。
//
// 本模块自前身 legacy-bridges-plugin `lib/index.js` L77–L264 迁移生命周期治理
// 内核与 provider 注册逻辑，语义逐行等价（idle 释放 / 孤儿清理 / 并发槽配对
// 是 DESIGN §9 红线 9 的回归防护对象，见 R9）：
//
//   - `createBridgeState`      ← PS index.js L77–L166 治理内核
//                                （persistRemote + idle 调度 + 并发槽 +
//                                 pending-start guard + endedAt + taskText/seq）
//   - `createBridgeProviders`  ← PS index.js L169–L213 provider 对象生成
//                                （仅生成，不调 ctx.subagents.registerProvider
//                                 —— 注册由调用方 apply 层做，便于测试）
//   - `attachBridgeLifecycle`  ← PS index.js L238–L264 生命周期配对与 teardown
//   - `createBridgeDriver`     ← 统一 SubagentDriver 契约（lib/drivers/types.js）
//                                的 bridge 实现：sync 直连 / continuable relay /
//                                job 拒绝（BRIDGE_CAPS.backgroundJob=false）
//
// 迁移期改名（ DESIGN §5.2 / T03）：
//   - registry 条目字段 `product` → `backend`（内存 binding 记录仍为 `product`，
//     见 lib/bindings.js 头注 —— binding 与 registry 是两层不同的记录）；
//   - relay 管道词汇 `product_submit`/`product_delegate` → `subagent_submit`/`subagent`
//     （providers.js 的 providerPersona 已完成文案迁移）。
//
// 红线（DESIGN §9）在此模块的落点：
//   1. relay 永远只读管道：toolFilter 白名单恒为 ['subagent_submit']，
//      仅当委派被允许时追加 'subagent'（§5.4）；
//   6. registry 是唯一恢复源：idle/guard 释放只删 binding、永不删 registry 条目，
//      且 settings（权限天花板）随 binding 一并持久化；
//   8. 能力不匹配 loud error：job 路由在 bridge 后端直接 throw。

import { createBindings } from '../bindings.js'
import { foldProgress, safeIso } from '../progress.js'
import { providerPersona } from '../providers.js'
import { parentCwd } from '../run.js'
import { BRIDGE_CAPS } from './types.js'

/**
 * If a child is prepared (remote session created) but never starts — the
 * harness failed between prepareContinuable and the first activation — the
 * pending guard disposes the orphaned remote after this delay instead of
 * leaking the process until plugin unload. (Line-for-line from PS index.js;
 * `createBridgeState({ pendingStartGuardMs })` may override it so tests can
 * exercise the timeout without waiting a real minute.)
 */
export const PENDING_START_GUARD_MS = 60000

/** Default idle release window for a settled child's remote session (10 min). */
export const DEFAULT_IDLE_TIMEOUT_MS = 600000

/**
 * Bridge 生命周期治理内核 —— 状态可注入、可独立测试。
 *
 * 持有（语义逐行迁移自 PS index.js L77–L166）：
 *  - `bindings`             childId → { product, bridge, remote, settings? }
 *                           （createBindings() per-call，双实例互不干扰）
 *  - `disposeTimers` / `cancelDispose` / `scheduleDispose`
 *                           idle 释放：settle 后 `idleTimeoutMs` 内未被复用即
 *                           dispose 远端并删 binding；registry 条目保留
 *                           （红线 6：idle 释放不消灭恢复源）。<=0 禁用；
 *                           timer.unref；重入先 cancel。
 *  - `liveChildren`         并发槽：仅 bridge continuable 占槽，按 childId
 *                           严格配对 add/remove（subagent/start|end 事件）。
 *  - `endedAt` / `markEnded` 最近 epoch 结束时间戳（128 上限惰性清理），防止
 *                           第一次 epoch 在委派调用返回前已 settle 时重复占槽。
 *  - `pendingStarts` / `armStartGuard` / `cancelStartGuard`
 *                           孤儿清理：remote 已建但子代理从未启动，60s 后释放。
 *  - `persistRemote`        child 的远端身份 + settings 持久化到 registry
 *                           （remoteId 取 sessionId || threadId || pendingSessionId；
 *                            claude 的预分配 pendingSessionId 也算 remote id）。
 *  - `disposeAll`           teardown：清全部 timer + 全量 bridge.dispose。
 *  - `nextSeq` / `taskText` runId 计数器与 prompt text blocks join（'\n'）。
 *
 * @param {Object} options
 * @param {ReturnType<typeof import('../registry.js').createRegistry>} options.registry
 *        durable registry 实例（必填 —— persistRemote 的写入目标，红线 6）
 * @param {number} [options.idleTimeoutMs] idle 释放窗口；<=0 禁用；缺省 600000
 * @param {number} [options.pendingStartGuardMs] 孤儿清理超时；缺省 60000（仅测试注入用）
 * @returns {Object} 治理状态与操作集合
 */
export function createBridgeState({ registry, idleTimeoutMs, pendingStartGuardMs } = {}) {
  if (!registry) throw new Error('createBridgeState: registry is required (the durable registry is the only recovery source)')

  // Per-state binding map: two plugin instances (tests, hot reload) must not
  // dispose each other's remote sessions. (Mirrors createBindings' per-apply
  // contract from the predecessor.)
  const bindings = createBindings()

  const idleMs = idleTimeoutMs !== undefined ? Math.max(0, Number(idleTimeoutMs) || 0) : DEFAULT_IDLE_TIMEOUT_MS
  const guardMs = pendingStartGuardMs !== undefined ? Math.max(0, Number(pendingStartGuardMs) || 0) : PENDING_START_GUARD_MS

  // Idle disposal: a settled child's remote session (a persistent ACP server
  // process, or a resumable claude/codex id) is disposed after it stays
  // unreused for `idleMs`. 0 disables auto-disposal. Reuse (a
  // subagent_submit call) cancels the pending timer, so fast continuation
  // (send_message cold resume) never pays a reconnect; long-idle children
  // release their processes instead of leaking until plugin unload. The
  // registry entry is KEPT so a later cold resume still reconnects.
  const disposeTimers = new Map()
  const cancelDispose = (childId) => {
    const timer = disposeTimers.get(childId)
    if (timer !== undefined) {
      clearTimeout(timer)
      disposeTimers.delete(childId)
    }
  }
  const scheduleDispose = (childId) => {
    cancelDispose(childId)
    if (idleMs <= 0) return
    const timer = setTimeout(() => {
      disposeTimers.delete(childId)
      const record = bindings.get(childId)
      if (record) {
        record.bridge.dispose(record.remote).catch(() => {})
        bindings.delete(childId)
      }
    }, idleMs)
    if (typeof timer.unref === 'function') timer.unref()
    disposeTimers.set(childId, timer)
  }

  // Concurrency: count bridge children with a turn IN FLIGHT (a settled,
  // continuable child holds no slot; a resumed epoch re-acquires one via
  // subagent/start). Keyed by child id and strictly paired add/remove, so
  // other subagents' lifecycle events can never skew the count.
  const liveChildren = new Set()

  // Orphan guard: children whose remote was created but that never started.
  const pendingStarts = new Map()

  // ── relay epoch 计数（D2b 修复，DESIGN §5.4「回合闭环确定性校验」）────────
  //
  // `subagent/start` / `subagent/end` 每个 continuable Activation（residency
  // epoch）各触发一次 —— 一次 epoch 通常恰一个回合，罕见 settle 前唤醒会在
  // 同一 Activation 内跑多个回合，此时计数跨回合累计（漏拒不误拒，见
  // DESIGN §5.4 边界）。noteRelayEpochStart 在每个 epoch 开始时归零（relay
  // 子代并集判定：binding ∪ registry）；noteRelaySubmit 由 subagent_submit
  // 工具层在 execute 入口自增（不以转发成功为准 —— submit 失败后 report 错误
  // 是合法闭环）；lastRelayEpochNoForward 是 end 钩子维护的「最近一个已完成
  // epoch 是否零 submit」标记，供 progress/wait 观测（settlement 通知是
  // harness 代码、不可改写，只能补软防线）。presetRow 实例不建 state（红线
  // 10），本计数天然只存在于全局实例。
  const relayEpochs = new Map()
  const noteRelayEpochStart = (childId) => {
    relayEpochs.set(childId, { submits: 0 })
  }
  const noteRelaySubmit = (childId) => {
    const entry = relayEpochs.get(childId)
    if (entry) entry.submits += 1
    else relayEpochs.set(childId, { submits: 1 }) // cold-resume first turn: no start seen
  }
  const relayNoForward = new Set()
  const lastRelayEpochNoForward = (childId) => relayNoForward.has(childId)
  const relayNoForwardMark = (childId) => { relayNoForward.add(childId) }
  const relayNoForwardClear = (childId) => { relayNoForward.delete(childId) }

  // Recent epoch-end timestamps, so the delegating path does not re-reserve a
  // slot for a child whose first epoch already settled before the delegating
  // call returned. Pruned lazily.
  const endedAt = new Map()
  const markEnded = (childId) => {
    endedAt.set(childId, Date.now())
    if (endedAt.size > 128) {
      const cutoff = Date.now() - 60000
      for (const [id, at] of endedAt) {
        if (at < cutoff) {
          endedAt.delete(id)
          // Same lazy pruning for the D2b epoch bookkeeping (optional
          // convergence): a child idle for 60s+ starts a fresh epoch entry
          // on its next subagent/start anyway (noteRelayEpochStart resets).
          relayEpochs.delete(id)
          relayNoForward.delete(id)
        }
      }
    }
  }
  const armStartGuard = (childId) => {
    cancelStartGuard(childId)
    const timer = setTimeout(() => {
      pendingStarts.delete(childId)
      if (liveChildren.has(childId) || disposeTimers.has(childId)) return
      const record = bindings.get(childId)
      if (record) {
        record.bridge.dispose(record.remote).catch(() => {})
        bindings.delete(childId)
      }
    }, guardMs)
    if (typeof timer.unref === 'function') timer.unref()
    pendingStarts.set(childId, timer)
  }
  const cancelStartGuard = (childId) => {
    const timer = pendingStarts.get(childId)
    if (timer !== undefined) {
      clearTimeout(timer)
      pendingStarts.delete(childId)
    }
  }

  /**
   * Persist the child's remote identity AND settings (migration note: PS
   * index.js L77–L86). The entry is written even BEFORE the remote id is
   * known (claude/codex learn it only on the first submission): an entry
   * without remoteId still authorizes recovery with a FRESH session and —
   * critically — restores the permission ceiling, so an idle-disposed or
   * restarted child can never be mistaken for a ceiling-less root. Claude's
   * preallocated pendingSessionId counts as the remote id (sessions are
   * resumable by it). Registry entries say `backend` (T03 rename); the
   * in-memory binding record still says `product`.
   */
  const persistRemote = (childId, record, cwd) => {
    if (!record) return
    const remoteId = record.remote && (record.remote.sessionId || record.remote.threadId || record.remote.pendingSessionId)
    registry.set(childId, {
      backend: record.product,
      ...(remoteId ? { remoteId } : {}),
      cwd,
      ...(record.settings ? { settings: record.settings } : {}),
    })
  }

  // Teardown: dispose every live remote session and clear every timer
  // (PS index.js L252–L264). Registry entries survive — they are the durable
  // recovery source, not plugin state.
  const disposeAll = () => {
    for (const timer of disposeTimers.values()) clearTimeout(timer)
    disposeTimers.clear()
    for (const timer of pendingStarts.values()) clearTimeout(timer)
    pendingStarts.clear()
    liveChildren.clear()
    for (const record of bindings.values()) {
      record.bridge.dispose(record.remote).catch(() => {})
    }
    bindings.clear()
  }

  let seq = 0
  /** Next value of the per-state run-id counter (provider/driver run ids). */
  const nextSeq = () => {
    seq += 1
    return seq
  }
  /** Join a SubagentStartRequest's prompt text blocks into one task string. */
  const taskText = (request) => {
    const prompt = request && request.prompt
    if (!Array.isArray(prompt)) return ''
    return prompt.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n')
  }

  return {
    bindings,
    // The shared registry instance, exposed for the layers above (T11's
    // delegation-ceiling check and T12's subagent_submit recovery read
    // `assembled.state.registry`; missing key would fail their closed
    // contracts). Same instance that persistRemote writes to — the only
    // recovery source (red line 6).
    registry,
    disposeTimers,
    cancelDispose,
    scheduleDispose,
    liveChildren,
    pendingStarts,
    endedAt,
    markEnded,
    armStartGuard,
    cancelStartGuard,
    persistRemote,
    disposeAll,
    nextSeq,
    taskText,
    relayEpochs,
    noteRelayEpochStart,
    noteRelaySubmit,
    lastRelayEpochNoForward,
    relayNoForwardMark,
    relayNoForwardClear,
  }
}

/**
 * 为每个 bridge 生成 harness `SubagentProvider` 对象（迁移自 PS index.js
 * L169–L213，逻辑照搬）。**不在此处调用 ctx.subagents.registerProvider** ——
 * 注册由调用方 apply 层做（便于测试与按可用性过滤）。
 *
 * provider 契约（DESIGN §2.3-E / PS 原注释）：
 *  - `capabilities: { persona: true, toolFilter: true }`：harness 对未声明
 *    能力的 provider 拒绝 persona/toolFilter 请求。continuable 子代理由
 *    continuation manager 自行应用两者（applyChildComposition）；一次性远端
 *    子代理则平凡满足（无子工具面）。
 *  - `start(request)`：一次性路径 —— create + submit（settings 不经此路：
 *    harness 的 SubagentStartRequest 无 bridge 设置概念）→ 返回 SubagentRun
 *    （dispose 由 run.dispose 显式做）；失败路径 dispose 后 rethrow。
 *  - `prepareContinuable(request)`：create + binding + armStartGuard +
 *    persistRemote（settings 此时未知 → undefined，首次委派后补写）→ { seed: [] }。
 *
 * @param {Object} options
 * @param {Record<string, Object>} options.bridges  provider 名 → bridge 实例
 *        （调用方已按可用性过滤，沿 PS index.js L54–L58）
 * @param {Record<string, Object>} [options.providers] provider 名 → 定义
 *        （buildProviders 产物；provider 对象本身不消费它 —— relay persona
 *         组装在 driver 侧 —— 保留入参以与 createBridgeDriver 的装配形状对称）
 * @param {ReturnType<typeof createBridgeState>} options.state 治理内核
 * @returns {Array<Object>} provider 对象数组
 */
export function createBridgeProviders({ bridges, providers, state }) {
  void providers // see JSDoc: consumed by createBridgeDriver's relay persona, not here
  const out = []
  for (const [providerName, bridge] of Object.entries(bridges || {})) {
    out.push({
      name: providerName,
      inheritsParentContext: false,
      // The harness rejects persona/toolFilter requests unless the provider
      // advertises the capability. For continuable children the manager
      // applies both itself (applyChildComposition); for one-shot remote
      // children they are trivially satisfied (no child tool surface).
      capabilities: { persona: true, toolFilter: true },
      async start(request) {
        const cwd = parentCwd(request.parent)
        const task = state.taskText(request)
        const remote = await bridge.create(cwd)
        try {
          const out2 = await bridge.submit(remote, task, request.signal, cwd)
          const id = `${providerName}-${Date.now().toString(36)}-${state.nextSeq()}`
          return {
            id,
            localAgent: undefined,
            result: Promise.resolve({
              output: [{ type: 'text', text: out2.text }],
              stopReason: out2.stopReason,
            }),
            async dispose() {
              await bridge.dispose(remote).catch(() => {})
            },
          }
        } catch (error) {
          await bridge.dispose(remote).catch(() => {})
          throw error
        }
      },
      async prepareContinuable(request) {
        const cwd = parentCwd(request.parent)
        const remote = await bridge.create(cwd)
        state.bindings.set(request.sessionId, { product: providerName, bridge, remote, settings: undefined })
        state.armStartGuard(request.sessionId)
        // acp learns its session id at creation; claude/codex persist it after
        // the first submission via subagent_submit.
        state.persistRemote(request.sessionId, { product: providerName, remote }, cwd)
        return { seed: [] }
      },
    })
  }
  return out
}

/**
 * 生命周期配对与 teardown（迁移自 PS index.js L238–L264）。
 *
 * `subagent/start`/`subagent/end` 每个 continuable Activation epoch 各触发
 * 一次（即子代理每个完成的回合后）、一次性 run 亦同词汇。只追踪（曾）绑定
 * 到 bridge 的 child id：
 *  - start：binding 命中 → cancelStartGuard + liveChildren.add（占槽）；
 *    epoch 计数归零用与 end 钩子同款的 relay 并集（binding ∪ registry ——
 *    冷恢复子代理的 submits 不跨 epoch 残留，review MAJOR-1）；
 *  - end：markEnded + liveChildren.delete（放槽）+ binding/registry 命中 →
 *    scheduleDispose（idle 释放）+ 零-submit 告警与 noForward 标记
 *    （binding 已被 idle 释放但 registry 条目仍在的 bridge 子代理同样
 *    计入 —— registry 是唯一恢复源，冷子代理的 epoch 同样可能漏转发）；
 *  - ctx.effect teardown → state.disposeAll()（清 timer + 全量 bridge.dispose）。
 *
 * @param {Object} ctx Cordis ctx（需 on/effect）
 * @param {ReturnType<typeof createBridgeState>} state 治理内核
 */
export function attachBridgeLifecycle(ctx, state) {
  ctx.on('subagent/start', (info) => {
    if (info && info.id && state.bindings.has(info.id)) {
      state.cancelStartGuard(info.id)
      state.liveChildren.add(info.id)
    }
    // D2b epoch reset: the SAME relay-child union as the end hook (live
    // binding ∪ durable registry entry). A cold-resumed child (binding lost
    // to idle disposal / restart, registry entry surviving) must also reset
    // its submit counter per epoch — otherwise submits accumulate across
    // epochs and a zero-forward self-answer in a LATER epoch slips past the
    // guard (review MAJOR-1). Slot acquisition above stays binding-only
    // (concurrency semantics unchanged).
    if (info && info.id
      && (state.bindings.has(info.id) || state.registry.get(info.id) !== undefined)) {
      state.noteRelayEpochStart(info.id)
    }
  })
  ctx.on('subagent/end', (info) => {
    if (!info || !info.id) return
    state.markEnded(info.id)
    state.liveChildren.delete(info.id)
    if (state.bindings.has(info.id)) state.scheduleDispose(info.id)
    // D2b epoch 闭环观测：本 epoch 零 subagent_submit 的 bridge 子代理 →
    // warn 一行 + 记 noForward 标记（subagent_wait 据此给 answer 加前缀；
    // settlement 通知本身是 harness 代码，不可改写）。非 bridge 子代理
    // （无 binding 且无 registry 条目）零干扰。
    const isRelayChild = state.bindings.has(info.id) || state.registry.get(info.id) !== undefined
    if (isRelayChild && state.relayEpochs.get(info.id)?.submits === 0) {
      ctx.logger?.warn?.(
        `dsh-plugin-subagents: relay child "${info.id}" ended an epoch with zero subagent_submit calls — `
          + 'its reported answer is the relay model\'s own output, not the remote product\'s '
          + '(D2b; see DESIGN §5.4 turn-closure guard)',
      )
      state.relayNoForwardMark(info.id)
    } else if (isRelayChild) {
      state.relayNoForwardClear(info.id)
    }
  })
  // Plugin teardown: dispose every live remote session (registry entries
  // survive — they are the durable recovery source, not plugin state).
  ctx.effect(() => () => state.disposeAll())
}

/**
 * DelegateRequest 的 bridge 扩展字段（工具层 T11 组装；`lib/drivers/types.js`
 * 不动 —— 本 JSDoc 即该可选字段的契约说明，见 T09 简报）：
 *  - `bridge.settings` — { model?, reasoningEffort?, permissionMode? }：sync
 *    路径直接透传 bridge.submit；continuable 路径写入 binding 记录并随
 *    persistRemote 持久化（恢复必须还原 settings —— 红线 6）。
 *  - `allowDelegation?: boolean` — 角色是否允许 relay 子代理再委派：
 *    决定 §5.4 toolFilter 白名单是否追加 'subagent' 以及 persona 委派句。
 *
 * @typedef {Object} CreateBridgeDriverOptions
 * @property {string} CreateBridgeDriverOptions.name            provider 名（driver id）
 * @property {Object} CreateBridgeDriverOptions.bridge          该 provider 的 bridge 实例
 * @property {Record<string, Object>} [CreateBridgeDriverOptions.providers] provider 定义表
 *        （providerPersona 的入参来源）
 * @property {ReturnType<typeof createBridgeState>} CreateBridgeDriverOptions.state 治理内核
 * @property {(parent: Object) => string} [CreateBridgeDriverOptions.parentCwdFn]
 *        父会话 cwd 提取器（缺省 lib/run.js 的 parentCwd；可注入便于测试）
 * @property {() => import('./types.js').DriverAvailability} [CreateBridgeDriverOptions.availability]
 *        外层可用性探测（缺省恒 registered: true —— 真实可用性由装配层 T10 注入）
 * @property {Object} [CreateBridgeDriverOptions.ctx] 宿主 ctx（continuable 路径需
 *        ctx.subagents.startContinuable；progress 经 ctx.get('sessions') 折叠）
 */

/**
 * BridgeDriver —— 统一 SubagentDriver 契约的 bridge 实现（DESIGN §3.4）。
 *
 * 三路由：
 *  - `sync`：直连 bridge.create → bridge.submit（含 settings）→ bridge.dispose →
 *    `{ kind:'foreground', runId, output, stopReason }`；失败路径 dispose 后 rethrow
 *    （一次性前台运行不占并发槽、不动 relay —— 沿 PS product_delegate one-shot 语义）。
 *  - `continuable`：组装 relay 子代理（persona = providerPersona + 委派句、
 *    toolFilter = §5.4 白名单）经 ctx.subagents.startContinuable；成功后补写
 *    binding.settings + persistRemote，并按 endedAt 防重复占槽。
 *  - `job`：throw —— BRIDGE_CAPS.backgroundJob=false（relay child 天然后台，
 *    工具层把 bridge + 后台路由折叠为 continuable）。
 *
 * @param {CreateBridgeDriverOptions} options
 * @returns {import('./types.js').SubagentDriver}
 */
export function createBridgeDriver({
  name, bridge, providers, state, parentCwdFn = parentCwd, availability, ctx,
}) {
  return {
    id: name,
    kind: 'bridge',
    inheritsParentContext: false,
    capabilities: BRIDGE_CAPS,
    available() {
      if (availability) return availability()
      return { registered: true, reason: `bridge provider "${name}" is registered` }
    },

    async start(request) {
      const settings = request && request.bridge && request.bridge.settings
      if (request.route === 'sync') {
        // One-shot is synchronous and bounded by the caller's own turn
        // (signal/timeout), so it deliberately consumes no concurrency slot.
        // `request.cwd` (optional) is the explicit cwd from the engine-level
        // dispatch seam (lib/dispatch.js, T22) — validated there via assertCwd
        // before the call, so it is used as-is here. The tool layer's bridge
        // branch never sets it (capability matrix: bridge cwd ❌ — the parent
        // session cwd stays the rule there), so default behavior is unchanged.
        const cwd = request.cwd !== undefined ? request.cwd : parentCwdFn(request.parent)
        const remote = await bridge.create(cwd)
        try {
          const out = await bridge.submit(remote, request.task, request.signal, cwd, settings)
          await bridge.dispose(remote).catch(() => {})
          return {
            kind: 'foreground',
            runId: `${name}-${Date.now().toString(36)}-${state.nextSeq()}`,
            output: [{ type: 'text', text: out.text }],
            stopReason: out.stopReason,
          }
        } catch (error) {
          await bridge.dispose(remote).catch(() => {})
          throw error
        }
      }
      if (request.route === 'continuable') {
        if (!ctx || !ctx.subagents || typeof ctx.subagents.startContinuable !== 'function') {
          throw new Error(`bridge driver "${name}": continuable route requires a ctx with ctx.subagents.startContinuable`)
        }
        // The relay is ALWAYS a read-only pipe (red line 1 / DESIGN §5.4):
        // subagent_submit only, plus subagent exactly when the delegating
        // role allows delegation. No write-capable tool is ever exposed to
        // the relay model.
        const allow = request.allowDelegation ? ['subagent_submit', 'subagent'] : ['subagent_submit']
        const persona = providerPersona(name, providers ? providers[name] : undefined) + (request.allowDelegation
          ? ' You MAY delegate subtasks to your own subagents via subagent (choose an appropriate role) and integrate the answers.'
          : '')
        const start = await ctx.subagents.startContinuable({
          provider: name,
          label: request.label,
          request: {
            prompt: [{ type: 'text', text: request.task }],
            parent: request.parent,
            persona,
            toolFilter: { allow },
          },
          signal: request.signal,
        })
        // Reserve the concurrency slot once the child id is known; the child's
        // own subagent/start (armed by attachBridgeLifecycle) keeps it, and
        // its subagent/end releases it. If the first epoch already settled
        // before this call returned (endedAt), do not re-reserve — the slot
        // is free.
        if (!state.endedAt.has(start.childId)) state.liveChildren.add(start.childId)
        const record = state.bindings.get(start.childId)
        if (record) {
          record.settings = settings
          // Persist immediately: a restart before the child's first turn must
          // not lose the permission ceiling it was created with.
          state.persistRemote(start.childId, record, parentCwdFn(request.parent))
        }
        return {
          kind: 'continuable',
          childId: start.childId,
          backend: name,
          ...(settings && settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
        }
      }
      // route === 'job' (or unknown): background jobs are native-only.
      throw new Error('bridge backends run continuable — route "job" is native-only')
    },

    /**
     * 可续续子代理的后续回合 —— 契约占位（types.js 仅 bridge driver 实现）。
     * 实际提交由 relay 子代理自身经 subagent_submit 工具层完成（含
     * binding→registry 恢复语义）；本方法只校验活 binding 存在，不存在即
     * loud 失败（恢复路径不在此层）。
     */
    async followup(childId) {
      if (!state.bindings.get(childId)) {
        throw new Error(`no live binding for subagent "${childId}" — registry-based recovery is handled by the subagent_submit tool layer`)
      }
    },

    async progress(childId) {
      const record = state.bindings.get(childId)
      if (!record) return { childId, status: 'unknown' }
      // Fold the child's own session log when the sessions service is
      // reachable; the snapshot is schema-tolerant without it.
      let fold = null
      try {
        const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        const session = sessions ? sessions.get(childId) : undefined
        fold = session ? foldProgress(session) : null
      } catch {
        fold = null
      }
      const remoteId = record.remote && (record.remote.sessionId || record.remote.threadId)
      const inFlight = record.remote && record.remote.progress && record.remote.progress.busySince
        ? { ...record.remote.progress, busySince: safeIso(record.remote.progress.busySince) }
        : undefined
      return {
        childId,
        status: state.liveChildren.has(childId) ? 'running' : 'inactive',
        pinnedProduct: record.product,
        remoteSessionId: remoteId || (fold && fold.remoteSessionId) || undefined,
        model: record.settings && record.settings.model,
        reasoningEffort: record.settings && record.settings.reasoningEffort,
        turn: fold ? fold.turn : undefined,
        stepCount: fold ? fold.stepCount : undefined,
        lastTask: fold ? fold.lastTask : undefined,
        lastAnswer: fold ? fold.lastAnswer : undefined,
        lastActivityAt: fold && fold.lastActivityAt ? safeIso(fold.lastActivityAt) : undefined,
        inFlight,
      }
    },

    /** Explicit release (idle semantics stay with the shared state layer). */
    async dispose(childId) {
      state.cancelDispose(childId)
      const record = state.bindings.get(childId)
      if (!record) return
      state.bindings.delete(childId)
      await record.bridge.dispose(record.remote).catch(() => {})
    },
  }
}
