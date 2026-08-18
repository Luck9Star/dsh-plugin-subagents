// dsh-plugin-subagents — `subagent_agents` 可用性总览工具（T13，DESIGN §5.1）。
//
// 自旧版桥接插件 `lib/tools/product-agents.js` 迁移 + native 视图
// （TASKS T13：「availability + native provider 视图 + live children」）：
//
//   - `availability` —— bridge CLI 检测三态视图（PS 逐行照搬）：每个已配置
//     provider 的 registered / commandPresent / auth / note，来源
//     `assembled.availability`（assembleDrivers 的 detectAvailability 产物；
//     三态 = PATH 命中且免鉴权 / 命中但鉴权产物缺失 / 未命中）；
//   - `native` —— 新增：`assembled.native.spawn/fork` 两 provider 的
//     available()（registered + reason note；provider 未注册时 reason 说明
//     「provider 出现后自动解析」）；
//   - `children` —— 在册子代理总览：listChildren(parentSessionId, signal)
//     逐行照搬（PS：listing 失败时 children 置空、availability 照报），行内
//     改动两处 —— ① `product` 列更名 `backend`：bridge binding 命中时报
//     binding.product，否则 'native'（模型可分辨两类子代理）；② 新增
//     `busy`：`assembled.state.liveChildren`（bridge 并发槽，仅 bridge
//     continuable 回合进行中占槽 —— native 后台走 harness jobs，harness
//     自治，DESIGN §5.5）。
//
// deps 契约：`{ assembled }`（assembleDrivers 产物：availability / native /
// state.bindings / state.liveChildren）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { toLosslessJson } from '../json-safe.js'

/** Overview tool: bridge CLI availability + native providers + live children. */
export function registerSubagentAgents(ctx, deps) {
  const { assembled } = deps
  if (!assembled || typeof assembled.availability !== 'object' || assembled.availability === null) {
    throw new Error('subagent_agents: requires deps.assembled with an availability record (the assembleDrivers product)')
  }
  if (!assembled.native || !assembled.native.spawn || !assembled.native.fork) {
    throw new Error('subagent_agents: requires deps.assembled.native with both spawn and fork drivers')
  }
  if (!assembled.state || !(assembled.state.bindings instanceof Map)) {
    throw new Error('subagent_agents: requires deps.assembled.state.bindings (a Map) to classify bridge children')
  }
  ctx.tools.register(defineTool({
    name: 'subagent_agents',
    description: 'Overview of every delegation backend and live subagent: detected bridge CLI agents (codex / claude-code / grok-native / configured ACP providers) with availability, the native subagent providers (spawn / fork), and every live subagent with its backend and activity.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const availabilityView = Object.fromEntries(
        Object.entries(assembled.availability).map(([name, v]) => [name, {
          registered: v.registered,
          commandPresent: v.command,
          auth: v.auth.note,
          note: v.reason,
        }]),
      )
      const nativeView = {}
      for (const key of ['spawn', 'fork']) {
        const driver = assembled.native[key]
        const availability = driver.available()
        nativeView[key] = {
          backend: driver.id,
          registered: availability.registered,
          note: availability.reason,
        }
      }
      const children = []
      try {
        const list = await ctx.subagents.listChildren(exec.agent.session.id, exec.signal)
        for (const child of list) {
          const record = assembled.state.bindings.get(child.id)
          children.push({
            id: child.id,
            backend: record ? record.product : 'native',
            activity: child.activity,
            mode: child.mode,
            label: child.label,
            pinned: Boolean(record),
            busy: assembled.state.liveChildren ? assembled.state.liveChildren.has(child.id) : false,
            model: record && record.settings && record.settings.model ? record.settings.model : 'inherit',
          })
        }
      } catch {
        // children listing unavailable; availability still reported
      }
      // E3：返回边界 toLosslessJson —— listChildren 行可缺 mode/label、
      // availability 记录可缺 reason/note，直通会把 undefined 值键带给
      // dsh-tools 的无损 JSON 快照（"value is not lossless JSON"）；省略
      // 字段清洗后整键消失。
      return toLosslessJson({ availability: availabilityView, native: nativeView, children })
    },
  }))
}
