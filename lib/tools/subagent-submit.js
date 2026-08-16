// dsh-plugin-subagents — `subagent_submit` relay 管道工具（T12，DESIGN §5.1 / §5.2）。
//
// 自前身 legacy-bridges-plugin `lib/tools/product-submit.js` 逐行迁移（逻辑等价）：
// 每个桥接（bridge）continuable 子代理的远端任务管道。只有持有活 binding 或
// durable registry 条目的会话可用 —— session-log marker 刻意**不是**鉴权源
// （任何转发过含 marker 答案的父会话、或打印伪造 marker 的远端产品，否则都能
// 冒领远端会话）。恢复自 durable registry 重连丢失的会话，并还原子代理创建时的
// settings（权限天花板）；尚无 remote id 的条目（claude/codex 首次提交前）授权
// 一个带记录 settings 的全新会话。
//
// 同一子代理的提交经 per-child tail 队列串行化，入队发生在恢复**之前**：两个
// 重叠的 submit 否则都会走重连、在同一远端会话上竞态（交错 ACP JSON-RPC，或
// 两个 resume 中的 CLI 进程）。
//
// 迁移期差异（仅四类，均经 T03/T12/T14 定案）：
//   - 工具名 `product_submit` → `subagent_submit`（§5.2 全家族统一前缀；错误
//     文案前缀随之工具名化；marker 字符串保持 `PRODUCT_SESSION:`
//     —— 历史会话日志兼容，lib/bindings.js）；
//   - deps 来源：前身从 apply() 局部取 { bindings, MARKER, bridges, registry,
//     persistRemote, cancelDispose }；现在 deps = { assembled, config, toolName }
//     —— bindings/registry/persistRemote/cancelDispose 取自
//     assembled.state（createBridgeState 治理内核，state.registry 自 T12 起
//     暴露），底层 bridge 实例表取自 assembled.providerBridges（provider 名 →
//     原始 bridge；恢复路径的 reconnect/create/submit 不经 driver 面）；MARKER
//     直接 import lib/bindings.js；config 为 T14 统一装配的形状保留位，本工具
//     无配置驱动行为；toolName（T14/§6.6 legacy 别名）默认 'subagent_submit'，
//     别名注册传 'product_submit'（同 executor，仅名字回退旧词汇）；
//   - registry 条目字段 `product` → `backend`（T03 改名，persistRemote 写入侧
//     已然）；内存 binding 记录仍为 `product`（bindings.js 头注 —— 两层记录
//     字段名不同是有意为之）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { MARKER } from '../bindings.js'

/**
 * 注册 relay 管道工具 `subagent_submit`（改名自 product_submit）。
 *
 * @param {Object} ctx                宿主 ctx（需 ctx.tools.register）
 * @param {Object} deps
 * @param {Object} deps.assembled     assembleDrivers 产物：state（bindings /
 *                                    registry / persistRemote / cancelDispose）
 *                                    与 providerBridges（provider 名 → 底层
 *                                    bridge 实例，仅含检测到的 CLI）均须齐备
 *                                    —— 缺失即 loud（fail closed，绝不静默
 *                                    降级为无恢复源的管道）
 * @param {Object} [deps.config]      已校验插件配置（形状统一保留；本工具不消费）
 * @param {string} [deps.toolName]    工具名，默认 'subagent_submit'。legacy 别名
 *                                    （§6.6）复用本注册器传 'product_submit'：
 *                                    同一 executor 与恢复管道，仅名字回退旧词汇
 */
export function registerSubagentSubmit(ctx, deps) {
  const { assembled, config, toolName = 'subagent_submit' } = deps
  void config // deps-shape parity for the T14 wiring; submit has no config-driven behavior
  const state = assembled && assembled.state
  const { bindings, registry, persistRemote, cancelDispose } = state ?? {}
  const bridges = assembled && assembled.providerBridges
  if (!bindings || !registry || typeof persistRemote !== 'function' || typeof cancelDispose !== 'function') {
    throw new Error(
      'subagent_submit: registerSubagentSubmit requires deps.assembled.state to expose '
      + 'bindings / registry / persistRemote / cancelDispose (the createBridgeState kernel — '
      + 'without the durable registry this pipe would have no fail-closed recovery source)',
    )
  }
  if (!bridges) {
    throw new Error(
      'subagent_submit: registerSubagentSubmit requires deps.assembled.providerBridges '
      + '(provider name → raw bridge instance; the recovery path drives bridge.reconnect/create directly)',
    )
  }
  const tails = new Map()

  ctx.tools.register(defineTool({
    name: toolName,
    description: 'Submit one task to the persistent remote product session bound to this agent (Codex / Claude Code / ACP CLI) and return the product agent\'s answer. The remote session remembers the full conversation, so later submissions continue it. Use this for all task work while you are a bridge subagent.',
    parameters: {
      task: { type: 'string', required: true, description: 'The task text to send to the remote product agent.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const agent = exec && exec.agent
      if (!agent || !agent.session) throw new Error(`${toolName} requires a calling agent session`)
      const childSessionId = agent.session.id
      // D2b relay-epoch accounting: count at the execute ENTRANCE (not on
      // forward success) — reporting an error after a failed submit is a legal
      // turn closure, and the guard must not block it. Optional-chain keeps old
      // assembled shapes (pre-D2b tests, seam injections) working unchanged.
      state.noteRelaySubmit?.(childSessionId)
      // Enter the per-child queue BEFORE any await (including recovery), so
      // concurrent submits — even on a lost binding — run strictly one at a
      // time for this child.
      const previous = tails.get(childSessionId) || Promise.resolve()
      let release
      const mine = new Promise((resolve) => { release = resolve })
      tails.set(childSessionId, mine)
      try {
        await previous.catch(() => {})
        // This child is being used again — cancel any pending idle disposal
        // so a fast continuation never pays a reconnect.
        cancelDispose(childSessionId)
        const cwd = (agent.session.header && agent.session.header.cwd) || process.cwd()
        let record = bindings.get(childSessionId)
        if (!record) {
          // The binding is gone (idle disposal or restart). The durable registry
          // is the ONLY recovery + authorization source. No registry entry →
          // this session is not a bridge child; refuse. (T03: registry entries
          // say `backend`; an unavailable/uninstalled CLI also refuses here.)
          const persisted = registry.get(childSessionId)
          if (!persisted || !bridges[persisted.backend]) {
            throw new Error(`${toolName}: no remote product session is bound to this agent`)
          }
          const bridge = bridges[persisted.backend]
          // An entry from before the first submission has no remote id yet —
          // start a fresh remote session (with the recorded settings).
          const remote = persisted.remoteId
            ? await bridge.reconnect(persisted.remoteId, persisted.cwd || cwd, exec.signal)
            : await bridge.create(persisted.cwd || cwd, exec.signal)
          record = { product: persisted.backend, bridge, remote, settings: persisted.settings }
          bindings.set(childSessionId, record)
        }
        const out = await record.bridge.submit(record.remote, args.task, exec.signal, cwd, record.settings)
        const remoteId = record.remote.sessionId || record.remote.threadId
        const marker = remoteId ? `${MARKER}${record.product}:${remoteId}` : ''
        const text = marker ? `${out.text}\n${marker}` : out.text
        return { text }
      } finally {
        release()
        // Only clear the queue pointer when WE are still the tail — a newer
        // submit may already be queued behind us.
        if (tails.get(childSessionId) === mine) tails.delete(childSessionId)
        // Persist the remote id (and any newly-learned one) so recovery
        // survives the next disposal/restart.
        const record = bindings.get(childSessionId)
        if (record) persistRemote(childSessionId, record, (agent.session.header && agent.session.header.cwd) || process.cwd())
      }
    },
  }))
}
