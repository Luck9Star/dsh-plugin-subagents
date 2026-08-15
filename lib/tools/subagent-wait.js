// dsh-plugin-subagents — `subagent_wait` 事件驱动等待工具（T13，DESIGN §5.1）。
//
// 自前身 legacy-bridges-plugin `lib/tools/product-wait.js` 逐行迁移：仅工具名
// （product_wait → subagent_wait）、描述文案中的工具引用（product_delegate →
// subagent）与 deps 来源改变；执行体（execute）语义零改动 —— 这些语义对
// native / bridge 两类可续续子代理通用，因为两者都由 harness 同一 seam 发出
// `subagent/end` 事件（一次性 epoch 与可续续回合同词汇，DESIGN §2.3-E）：
//
//   - subscribe-before-check：先挂 `subagent/end` 监听再查 listChildren ——
//     在 listing 往返期间 settle 的子代理若后订阅就会整个漏掉、白等一个
//     完整 timeout；监听在返回前恒被移除（finally offEnd）；
//   - settle 观察三态：DURING listing（事件先行，listing 结果作废）/
//     AFTER listing（await endPromise + timeout/abort 竞速）；
//   - timeout 上限 600000、下限 1000，缺省 300000；
//   - unknown：listing 里没有且事件未命中 → 报 unknown（绝不无限等）；
//   - 并发 waiter：同一 child 上多个等待各自持有监听与 promise，settle 时
//     全部 resolve（`settled` 标志防重复）。
//
// deps 契约：`{ foldProgress, foldTrace }`（lib/progress.js 的折叠函数经
// apply 层注入，与前身一致 —— 测试可注入 fake）。native 子代理的会话折叠
// 无 PRODUCT_SESSION marker，pinnedProduct/remoteSessionId 自然为 undefined。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { toLosslessJson } from '../json-safe.js'

/**
 * Wait tool: attach to a continuable child and block until it settles,
 * returning its final answer. Event-driven (subagent/end), never polling.
 */
export function registerSubagentWait(ctx, deps) {
  const { foldProgress, foldTrace } = deps
  ctx.tools.register(defineTool({
    name: 'subagent_wait',
    description: 'Block until the given subagent finishes (or the timeout elapses), then return its final answer, stop reason, and latest trace. Attaches to a background subagent id returned by subagent — no polling needed. Works for native continuable children and bridge relay children alike. Returns immediately with status "ready" when the child already settled, and "timeout"/"aborted" otherwise.',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The continuable child session id returned by subagent (native continuable child or bridge relay child).' },
      timeout_ms: { type: 'number', description: 'Max milliseconds to wait (default 300000, capped 600000).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const childId = args.subagent_id
      const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 300000, 1000), 600000)
      const parent = exec.agent
      const sessionSvc = ctx.get('sessions')

      const foldNow = () => {
        const session = sessionSvc ? sessionSvc.get(childId) : undefined
        return session ? foldProgress(session) : null
      }

      // Subscribe BEFORE checking the child's state: a child that settles
      // between the listChildren round-trip and a later subscription would
      // otherwise be missed entirely and cost a full timeout. The listener is
      // ALWAYS removed before returning.
      let settled = null
      let offEnd = () => {}
      const endPromise = new Promise((resolve) => {
        offEnd = ctx.on('subagent/end', (info) => {
          if (info && info.id === childId && !settled) {
            settled = { status: 'completed', info }
            resolve(settled)
          }
        })
      })
      endPromise.catch(() => {}) // never awaited directly in some paths

      try {
        let activity = 'unknown'
        try {
          const children = await ctx.subagents.listChildren(parent.session.id, exec.signal)
          const me = children.find((c) => c.id === childId)
          activity = me ? me.activity : 'unknown'
        } catch {
          activity = 'unknown'
        }

        let outcome
        if (settled) {
          // the child settled while the listing was in flight — the event is
          // authoritative even if the listing missed or errored on it
          outcome = settled
        } else if (activity === 'unknown') {
          outcome = { status: 'unknown', note: 'no such subagent under this parent (or listing unavailable)' }
        } else if (activity === 'inactive') {
          // already settled: report immediately
          outcome = { status: 'ready' }
        } else {
          // live: await the child's next settlement (subagent/end is scoped
          // to the delegating parent, so only this parent's children match)
          outcome = await new Promise((resolve) => {
            let done = false
            let onAbort
            const finish = (value) => {
              if (done) return
              done = true
              clearTimeout(timer)
              if (onAbort && exec.signal && typeof exec.signal.removeEventListener === 'function') {
                exec.signal.removeEventListener('abort', onAbort)
              }
              resolve(value)
            }
            const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)
            if (exec.signal && exec.signal.aborted) finish({ status: 'aborted' })
            else if (exec.signal && typeof exec.signal.addEventListener === 'function') {
              onAbort = () => finish({ status: 'aborted' })
              exec.signal.addEventListener('abort', onAbort, { once: true })
            }
            endPromise.then((value) => finish(value))
          })
        }

        const fold = foldNow()
        const lastAssistant = outcome.info && outcome.info.lastAssistantMessage
        const answer = lastAssistant
          ? lastAssistant.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
          : (fold ? fold.lastAnswer : undefined)
        // E3：返回边界 toLosslessJson —— dsh-tools 对工具返回值做无损 JSON
        // 快照，undefined 值键（stopReason/answer/pinnedProduct/… 在无事件
        // 路径上必然出现）整体被拒（"value is not lossless JSON"，2026-08-15
        // 冒烟 E3）；未 set 的可选字段在清洗后整键消失。
        return toLosslessJson({
          childId,
          status: outcome.status,
          stopReason: outcome.info ? outcome.info.stopReason : undefined,
          answer: answer || undefined,
          pinnedProduct: fold ? fold.product : undefined,
          remoteSessionId: fold ? fold.remoteSessionId : undefined,
          trace: fold ? foldTrace(sessionSvc ? sessionSvc.get(childId) : undefined) : undefined,
        })
      } finally {
        offEnd()
      }
    },
  }))
}
