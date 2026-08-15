// dsh-plugin-subagents — `subagent_progress` 进度工具（T13，DESIGN §5.1）。
//
// 自前身 legacy-bridges-plugin `lib/tools/subagent-progress.js` 迁移（原名即
// subagent_progress）+ native 扩展（TASKS T13：「无 binding 时纯 session 折叠；
// bridge 字段缺省」）。两条路径按同一优先级分流：
//
//   1. bridge 路径 —— `assembled.state.bindings.get(childId)` 命中（内存
//      binding，PS 逐行照搬）：listChildren 的 activity/mode/label 优先，
//      binding 补充 pinnedProduct / remoteSessionId / inFlight /
//      settings.model / reasoningEffort（缺省 'inherit (product default)'）；
//      状态链 `listStatus.activity > session ? 'running' : 'stored'` 与 PS
//      完全一致；
//   2. native 路径 —— 无 binding：`assembled.native.spawn.progress(childId)`
//      提供最小快照（status/label；spawn 与 fork 两 driver 的 progress 实现
//      同形，且按 childId 查询不区分 provider，故用 spawn 实例即可），工具层
//      再做纯 session 折叠（turn/stepCount/lastTask/lastAnswer/
//      lastActivityAt/tokenUsage/trace —— native 子代理的 session 事件同样
//      可折，DESIGN §3.4；driver 自身不做折叠，见 lib/drivers/native.js 头注
//      的分工）。bridge 专属字段（pinnedProduct/remoteSessionId/inFlight/
//      model/reasoningEffort）在此路径整键省略。状态链：
//      `listStatus.activity > driver.status(非 unknown) > session ? 'running'
//      : 'unknown'`（PS 对「listing 缺席但 session 存在」判 running 的语义
//      随迁；driver 也不认识且无 session → 'unknown'）。
//
//   两者的 session 折叠与 listChildren 查询共用（PS 原execute 前半段）。
//   driver.progress 的调用包 try/catch：观测工具不因驱动侧 seam 异常而炸
//   （异常按快照缺席处理，落 unknown 链）。
//
// deps 契约：`{ assembled, foldProgress, foldTrace, foldTokenUsage }` ——
// assembled 是 assembleDrivers 产物（需 native.spawn 与 state.bindings），
// 三个折叠函数经 apply 层注入（与前身一致，测试可注入 fake）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { safeIso } from '../progress.js'

/** Progress tool: latest status, internal trace, token usage of one child. */
export function registerSubagentProgress(ctx, deps) {
  const { assembled, foldProgress, foldTrace, foldTokenUsage } = deps
  if (!assembled || !assembled.native || !assembled.native.spawn) {
    throw new Error('subagent_progress: requires deps.assembled with native.spawn (the assembleDrivers product)')
  }
  if (!assembled.state || !(assembled.state.bindings instanceof Map)) {
    throw new Error('subagent_progress: requires deps.assembled.state.bindings (a Map) to classify bridge children')
  }
  ctx.tools.register(defineTool({
    name: 'subagent_progress',
    description: 'Report the latest progress of one subagent: lifecycle status, the current/last task, the latest answer, live activity while a turn is in flight, and (for bridge backends) the pinned product and remote session. Works for native children and bridge relay children alike.',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The child session id returned by subagent (native or bridge backend).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const childId = args.subagent_id
      const record = assembled.state.bindings.get(childId)
      const session = ctx.get('sessions') ? ctx.get('sessions').get(childId) : undefined
      const fold = session ? foldProgress(session) : null
      let listStatus = null
      try {
        const children = await ctx.subagents.listChildren(exec.agent.session.id, exec.signal)
        const me = children.find((c) => c.id === childId)
        if (me) listStatus = { activity: me.activity, mode: me.mode, hasChildren: me.hasChildren, label: me.label }
      } catch {
        listStatus = null
      }

      if (record) {
        // ── bridge 路径（PS 逐行照搬；仅 pinnedProduct 仍读 binding 记录的
        //    `product` 字段 —— binding 与 registry 是两层记录，见
        //    lib/bindings.js 头注） ─────────────────────────────────────────
        const remoteId = record.remote && (record.remote.sessionId || record.remote.threadId)
        const inFlight = record.remote && record.remote.progress && record.remote.progress.busySince
          ? { ...record.remote.progress, busySince: safeIso(record.remote.progress.busySince) }
          : undefined
        return {
          childId,
          status: listStatus ? listStatus.activity : session ? 'running' : 'stored',
          mode: listStatus ? listStatus.mode : undefined,
          label: listStatus ? listStatus.label : undefined,
          pinnedProduct: record.product,
          remoteSessionId: remoteId || (fold && fold.remoteSessionId) || undefined,
          // model: explicit override, else inherited from the product's own config
          model: record.settings && record.settings.model
            ? record.settings.model
            : 'inherit (product default)',
          reasoningEffort: record.settings && record.settings.reasoningEffort
            ? record.settings.reasoningEffort
            : 'inherit (product default)',
          turn: fold ? fold.turn : undefined,
          stepCount: fold ? fold.stepCount : 0,
          lastTask: fold ? fold.lastTask : undefined,
          lastAnswer: fold ? fold.lastAnswer : undefined,
          lastActivityAt: fold && fold.lastActivityAt ? safeIso(fold.lastActivityAt) : undefined,
          tokenUsage: session ? foldTokenUsage(session) : undefined,
          // internal trace: recent turn/step/tool/answer events from the child's own log
          trace: session ? foldTrace(session) : undefined,
          inFlight,
        }
      }

      // ── native 路径：driver 最小快照（status/label）+ 工具层纯 session 折叠；
      //    bridge 专属字段整键省略。driver.progress 第二参传父会话 id（T08：
      //    listChildren 按父域枚举直接子代，裸调匹配不到任何条目）────────────
      let nativeSnapshot = null
      try {
        const parentSessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : undefined
        nativeSnapshot = await assembled.native.spawn.progress(childId, parentSessionId)
      } catch {
        nativeSnapshot = null // observability: a driver-side seam error degrades to the fold chain
      }
      const status = listStatus
        ? listStatus.activity
        : (nativeSnapshot && nativeSnapshot.status !== 'unknown' ? nativeSnapshot.status : (session ? 'running' : 'unknown'))
      return {
        childId,
        status,
        mode: listStatus ? listStatus.mode : undefined,
        label: (listStatus && listStatus.label) || (nativeSnapshot && nativeSnapshot.label) || undefined,
        turn: fold ? fold.turn : undefined,
        stepCount: fold ? fold.stepCount : 0,
        lastTask: fold ? fold.lastTask : undefined,
        lastAnswer: fold ? fold.lastAnswer : undefined,
        lastActivityAt: fold && fold.lastActivityAt ? safeIso(fold.lastActivityAt) : undefined,
        tokenUsage: session ? foldTokenUsage(session) : undefined,
        // internal trace: recent turn/step/tool/answer events from the child's own log
        trace: session ? foldTrace(session) : undefined,
      }
    },
  }))
}
