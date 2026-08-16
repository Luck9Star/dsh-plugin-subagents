// dsh-plugin-subagents — `subagent_roles` 角色目录工具（T13，DESIGN §5.1）。
//
// 自前身 legacy-bridges-plugin `lib/tools/product-roles.js` 逐行迁移：工具名
// product_roles → subagent_roles、描述文案 product_delegate → subagent，并按
// T04 的角色 schema 改名将输出列 `provider` → `backend`（roles.list() 已含
// backend 字段：'native' | bridge provider 名 | '' = 调用方选择 —— 空串渲染
// 为 '(caller chooses)'，与 PS 对 provider 空串的渲染语义一致）。其余逐行
// 等价：id/description/permissionMode/allowDelegation 直通。
//
// deps 契约：`{ roles }`（createRoleLibrary 产物：list()/get()）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { toLosslessJson } from '../json-safe.js'

/** Role catalog tool: lists the declarative role library for the model. */
export function registerSubagentRoles(ctx, deps) {
  const { roles } = deps
  ctx.tools.register(defineTool({
    name: 'subagent_roles',
    description: 'List the declarative subagent roles: id, description, pinned backend ("native", a bridge provider name such as codex / claude-code / grok-native, or caller chooses), the remote product permission mode (readonly/default/full) and whether the role may delegate to its own subagents. Use a role with subagent.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      // E3：返回边界 toLosslessJson —— 角色文件可省略 permissionMode /
      // allowDelegation，直通会把 undefined 值键带给 dsh-tools 的无损 JSON
      // 快照（"value is not lossless JSON"）；省略字段清洗后整键消失。
      return toLosslessJson({
        roles: roles.list().map((r) => ({
          id: r.id,
          description: r.description,
          backend: r.backend || '(caller chooses)',
          permissionMode: r.permissionMode,
          allowDelegation: r.allowDelegation,
        })),
      })
    },
  }))
}
