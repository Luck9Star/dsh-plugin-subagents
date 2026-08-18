// dsh-plugin-subagents — `product_delegate` legacy 别名工具（T14，DESIGN §6.6）。
//
// 为什么存在：旧版桥接插件的 durable relay 子代理，其
// toolFilter 白名单与 relay 人格写死了 `product_delegate` / `product_submit`
// 两个旧名。§6.6 一次性迁移旧 registry 后，冷恢复的旧子代理若看不到旧名
// 工具，白名单即指向不存在的名字。本别名让旧子代理在自然消亡前继续可用
// （用户可经 legacyProductAliases: false 关闭）。
//
// 形态：薄适配注册器（T14 任务书定案）。registerSubagentTool 虽吃 toolName
// 参数化，但其参数 schema 用统一词汇（prompt/description/backend/
// run_in_background），与旧 schema（task/provider/background）不兼容 —— 故
// 这里保持**旧参数 schema + 旧输出形状**（前 product-delegate.js 原样），
// execute 把旧参数映射为统一词汇后委派给已注册的统一 `subagent` 工具的
// execute（defineTool 产物自带参数校验，映射遗漏会在统一 schema 处 loud）。
// 委派在**调用时**经 ctx.tools.get(delegateToolName) 解析：Cordis 并行加载下
// 注册顺序不可假设（§2.1），调用时统一工具必然已在。
//
// 映射表（旧 → 统一）：
//   task → prompt（description 以旧 label 形状合成 `${role}: ${task.slice(0,50)}`）
//   provider → backend
//   background（默认 true）→ run_in_background（true → continuable、false → sync，
//     与旧 product_delegate 的双路由语义一致；统一工具再叠加 job 路由 —— 旧
//     工具没有的形态，输出按 childId 句柄折返）
//   role / model / reasoning_effort 直通；旧 schema 无 permission_mode（权限档
//     恒取 role.permissionMode，与旧行为一致 —— 统一侧缺省链同样落到角色档）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { outputValueText } from '../native-delegate.js'

/**
 * 注册 legacy 别名工具 `product_delegate`（旧 schema，execute 委派统一逻辑）。
 *
 * @param {Object} ctx                      宿主 ctx（需 ctx.tools.register/get）
 * @param {Object} deps
 * @param {Object} deps.assembled           assembleDrivers 产物（bridges 键用于
 *                                          provider enum 展示；形状统一保留）
 * @param {Object} deps.roles               角色库（role enum + 旧输出形状的
 *                                          permissionMode 还原）
 * @param {Object} [deps.config]            已校验插件配置（形状统一保留）
 * @param {string} [deps.toolName]          别名工具名，默认 'product_delegate'
 * @param {string} [deps.delegateToolName]  委派目标的统一工具名，默认 'subagent'
 *                                          （apply 层传 toolNames.delegate）
 */
export function registerProductDelegateAlias(ctx, deps) {
  const {
    assembled, roles, config, toolName = 'product_delegate', delegateToolName = 'subagent',
  } = deps
  void config // deps-shape parity with the other T14 registrations
  const roleIds = roles.list().map((r) => r.id)
  const backendIds = assembled && assembled.bridges instanceof Map ? [...assembled.bridges.keys()] : []

  ctx.tools.register(defineTool({
    name: toolName,
    description: 'LEGACY alias of the unified subagent tool, kept so relay children created by the previous legacy bridges-plugin release (whose tool filters pin this old name) can keep delegating after its registry was migrated. Same behavior as subagent under the old parameter names; prefer subagent for new delegations.',
    parameters: {
      role: {
        type: 'string',
        enum: roleIds.length ? roleIds : ['general'],
        description: 'Role from the declarative role library (subagent_roles lists them). Defaults to "general" (full product permissions, may delegate).',
      },
      provider: {
        type: 'string',
        enum: backendIds.length ? backendIds : ['codex', 'claude-code', 'acp'],
        description: 'Product CLI to use. Defaults to the role\'s pinned backend; required when the role does not pin one (only detected agents are registered).',
      },
      task: { type: 'string', required: true, description: 'The task text for the product agent.' },
      model: { type: 'string', description: 'Product model override. Omit to inherit the product\'s own default model configuration.' },
      reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Product reasoning effort. Omit to inherit the product\'s own default.' },
      background: { type: 'boolean', default: true, description: 'false = run one-shot synchronously and return the final answer now.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', description: 'continuable child session id (background mode).' },
          output: { type: 'string', description: 'final answer (one-shot mode).' },
          stopReason: { type: 'string', description: 'one-shot stop reason.' },
          role: { type: 'string', description: 'resolved role id.' },
          permissionMode: { type: 'string', description: 'resolved product permission mode.' },
        },
      },
      render: (_args, value) => {
        if (value.childId) return [{ type: 'text', text: `started product subagent ${value.childId} (role ${value.role})` }]
        return [{ type: 'text', text: value.output }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      // Resolve the unified tool AT CALL TIME (load order is not assumable).
      const unified = typeof ctx.tools?.get === 'function' ? ctx.tools.get(delegateToolName) : undefined
      if (!unified || typeof unified.execute !== 'function') {
        throw new Error(
          `${toolName}: the unified "${delegateToolName}" tool is not registered — this legacy alias delegates to it. `
          + `Re-enable it (register.delegate) or drop the alias with legacyProductAliases: false.`,
        )
      }
      const roleId = args.role || 'general'
      const mapped = {
        // Old label shape: `${role.id}: ${task.slice(0, 50)}` (predecessor product-delegate.js).
        description: `${roleId}: ${String(args.task).slice(0, 50)}`,
        prompt: args.task,
        ...(args.role !== undefined ? { role: args.role } : {}),
        ...(args.provider !== undefined ? { backend: args.provider } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.reasoning_effort !== undefined ? { reasoning_effort: args.reasoning_effort } : {}),
        run_in_background: args.background !== false,
      }
      const result = await unified.execute(mapped, exec)
      // Old output always carried the resolved permission mode (the alias never
      // passes permission_mode, so the unified default chain resolves to the
      // role's own mode; a bridge continuable outcome may refine it).
      const role = roles.get(roleId)
      const fallbackPermissionMode = role && role.permissionMode ? role.permissionMode : 'default'

      if (result.kind === 'foreground') {
        return {
          output: outputValueText(result.output),
          ...(result.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          role: roleId,
          permissionMode: fallbackPermissionMode,
        }
      }
      // continuable — and the unified job route (absent in the old tool), for
      // which the job id is reported through the same childId-shaped handle.
      return {
        childId: result.kind === 'continuable' ? result.child_id : result.job_id,
        role: roleId,
        permissionMode: result.permission_mode !== undefined ? result.permission_mode : fallbackPermissionMode,
      }
    },
  }))
}
