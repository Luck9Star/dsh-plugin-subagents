// dsh-plugin-subagents — relay 回合闭环确定性校验（D2b P2 修复）。
//
// 缺陷（2026-08-15 真机证据 D2b）：continuable bridge relay 在自指型 prompt
// （如 "Which product/CLI are you running as?"）下可不经 subagent_submit 转发、
// 按自身系统提示自答后仅调 report 闭环 —— 装配全对（persona/只读管道），
// 但 relay 模型违规时无任何报错，父代理静默拿到 relay 自答却以为是远端
// 产品的回答（registry remoteId=—、远端无会话工件佐证）。
//
// 本模块把「relay 是否真转发过」从模型自觉变成确定性校验：
//
//   - 通道是宿主提供的 `ctx.subagents.registerContinuableSetup(contribution)`
//     + `childCtx.tools.guard(fn)` seam（官方 dsh-subagent-in-process-driver
//     同款先例）：guard 在 pre-execute waterfall 之后运行，返回字符串 → 本次
//     调用以 `Error: <reason>` isError 结果返回给模型、回合继续 —— 模型仍可
//     补调 subagent_submit 后再 report，不炸子代理、不吞回合。
//   - 同 scope 顶名 shadow（注册自己的 'report' 工具）不可行：官方
//     dsh-tool-subagent-report 经同一 SetupRegistry 注册，duplicate name 会
//     让整个 child 创建回滚 —— 本方案绝不走那条路。
//   - guard 只拒绝/放行既有 report 调用，不给 relay 增加任何工具（红线 1：
//     relay 永远只读管道）；非 relay 子代理（native / 非 bridge 会话）与
//     legacy 别名 product_submit 的 submit 计数复用同一 execute（计数在
//     subagent-submit.js execute 入口，别名自动生效）。
//
// 边界（DESIGN §5.4）：settlement 通知（notifySettlement 直接把子代理最后
// assistant 消息发给父会话）是 harness 代码、插件不可改写 —— 所以本 guard
// 之外还需 progress/wait 的观测标记（软防线）：end 钩子的零-submit 告警 +
// lastRelayEpochNoForward 标记 + wait answer 前缀。settle 前唤醒复用同一
// Activation 的罕见场景下计数跨回合累计（漏拒不误拒）。
//
// seam 缺失容忍：registerContinuableSetup 非函数（老宿主 / 非 Cordis 测试
// ctx）→ warn 一行后继续，不炸 apply（能力缺失大声失败的红线 8 指的是参数
// 静默忽略；这里是宿主能力探测，降级为 warn 是有意为之 —— 插件其余功能
// 不应因一个可选 seam 缺席而整体不可用）。

/**
 * The denial reason returned by the guard when a relay child's report call
 * arrives before any subagent_submit call in the same epoch. English on
 * purpose — the relay model reads it as a tool error.
 */
export const RELAY_GUARD_REASON = 'You are a bridge relay: every user message must be forwarded to the remote product via subagent_submit BEFORE reporting. This turn has not called subagent_submit, so this report is blocked — it would deliver your own answer as if it were the product\'s. Call subagent_submit with the task text now (a brief ack is fine if nothing needs forwarding), then report the product\'s answer.'

/**
 * Build the synchronous guard fn for one bridge state kernel.
 *
 * Deny (return the reason string) ONLY when ALL hold:
 *   - the call is `report` with a resolvable calling-agent session id;
 *   - that session is a bridge relay child (live binding OR durable registry
 *     entry — the cold-resume union; registry 是唯一恢复源，冷子代理同样算);
 *   - the current epoch has zero subagent_submit calls.
 * Everything else — native children, non-report tools, missing session ids,
 * submits > 0 — passes through untouched (no interference).
 *
 * @param {ReturnType<typeof import('./drivers/bridge.js').createBridgeState>} state
 * @returns {(exec: {name?: string, agent?: {session?: {id?: string}}}) => string | undefined}
 */
export function buildRelayReportGuard(state) {
  return (exec) => {
    if (!exec || exec.name !== 'report') return undefined
    const id = exec.agent && exec.agent.session && exec.agent.session.id
    if (!id) return undefined
    const isRelay = state.bindings.get(id) !== undefined || state.registry.get(id) !== undefined
    if (!isRelay) return undefined
    if ((state.relayEpochs.get(id)?.submits ?? 0) > 0) return undefined
    return RELAY_GUARD_REASON
  }
}

/**
 * Attach the relay report guard to every continuable child this host creates.
 *
 * Registers one `registerContinuableSetup` contribution whose installer calls
 * `childCtx.tools.guard(buildRelayReportGuard(state))` and RETURNS the guard's
 * unregistration disposer (the seam contract `ContinuableSetupContribution =
 * (childCtx) => () => void` — the host calls the returned disposer
 * unconditionally at child-scope release; returning undefined would throw at
 * every child teardown). The contribution
 * applies to every continuable child (native ones included) — the guard fn
 * itself no-ops for any session that is not a bridge relay child, so native
 * children are untouched. Contributions install before Activation publication
 * and roll back with the child scope; the disposer returned by
 * `registerContinuableSetup` (a ctx.effect disposer) is owned by the caller's
 * plugin scope, so plugin unload revokes every resident installation.
 *
 * @param {Object} ctx     Cordis ctx（需 ctx.subagents.registerContinuableSetup）
 * @param {Object} assembled assembleDrivers 产物（须含 state 治理内核）
 * @returns {boolean} whether the guard was attached (false = seam missing)
 */
export function attachRelayGuard(ctx, assembled) {
  const state = assembled && assembled.state
  if (!state || typeof state.noteRelaySubmit !== 'function') {
    ctx.logger?.warn?.(
      'dsh-plugin-subagents: relay report guard skipped — assembled.state lacks the D2b epoch kernel '
        + '(bridge children will not be checked for un-forwarded report turns)',
    )
    return false
  }
  const seam = ctx && ctx.subagents && ctx.subagents.registerContinuableSetup
  if (typeof seam !== 'function') {
    ctx.logger?.warn?.(
      'dsh-plugin-subagents: relay report guard skipped — this host does not provide '
        + 'ctx.subagents.registerContinuableSetup (bridge children will not be checked for un-forwarded report turns)',
    )
    return false
  }
  const guard = buildRelayReportGuard(state)
  seam.call(ctx.subagents, (childCtx) => {
    // Seam contract: ContinuableSetupContribution = (childCtx) => () => void —
    // the host's SubagentActivationSetupRegistry.release() calls the returned
    // disposer UNCONDITIONALLY when the child scope ends, so returning
    // undefined would throw "installation.dispose is not a function" at child
    // teardown. tools.guard() returns the exact unregistration disposer
    // (official dsh-tools contract) and we forward it when it is one — but a
    // host whose guard() violates its own contract and returns undefined
    // would reintroduce the same release() crash, so a non-function return
    // degrades to a no-op disposer (matching this module's defensive posture).
    if (childCtx && childCtx.tools && typeof childCtx.tools.guard === 'function') {
      const disposer = childCtx.tools.guard(guard)
      return typeof disposer === 'function' ? disposer : () => {}
    }
    return () => {}
  })
  return true
}
