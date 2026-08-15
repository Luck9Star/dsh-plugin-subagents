import { z } from 'zod'

/**
 * Configuration validation (T14, DESIGN §6.1). Invalid config — including
 * unknown/misspelled keys — fails LOUDLY at apply time with a precise
 * message, instead of surfacing as a confusing runtime error later (a typo
 * like `provider:` instead of `providers:` would otherwise be silently
 * ignored). Style follows the predecessor legacy-bridges-plugin lib/config.js.
 *
 * Two branches, dispatched on the RAW `presetRow` value before parsing:
 *
 *  1. presetRow branch (`config.presetRow === true`, DESIGN §6.3-L2): the
 *     OFFICIAL tool-row shape (the row a preset rewrite carries — a superset
 *     of the official `dsh-tool-subagent` row config, red line 9). Only the
 *     official keys are legal; bridge-side config (providers / registryPath /
 *     …) is rejected — a presetRow instance is native-only by contract.
 *     `toolName` defaults to 'subagent' (the official row default).
 *  2. full branch (presetRow absent or false): the complete §6.1 table.
 *
 * The fork-default name guard: a presetRow row named 'subagent_fork' (the
 * global instance's fork tool default) is never sensible — a row registers a
 * SPAWN-semantics delegate — and would collide with the global fork tool in
 * the standard coexistence setup, so it is rejected here with the §6.3-L2
 * guidance. ('subagent' itself is NOT statically rejected: it is the legal
 * official default for a standalone presetRow row; the actual collision with
 * a registered global instance is caught at apply time by the runtime guard
 * in lib/index.js, which sees the real registry state.)
 */

const providerDefSchema = z.object({
  type: z.enum(['claude', 'codex', 'acp']).optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict()

const agentOptionsSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict()

const toolFilterSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
}).strict()

const backgroundModeSchema = z.enum(['one-shot', 'continuable'])

const maxDepthSchema = z.union([z.number().int().positive(), z.literal('provider-managed')])

/** Shared native-delegation fields (identical in both branches, §6.1). */
const nativeCommon = {
  enableRunInBackground: z.boolean().optional(),
  backgroundMode: backgroundModeSchema.optional(),
  agentOptions: agentOptionsSchema.optional(),
  persona: z.string().optional(),
  toolFilter: toolFilterSchema.optional(),
  maxDepth: maxDepthSchema.optional(),
  presetHints: z.array(z.string()).optional(),
}

// minor 1 (loud empty toolFilter): CW rejects a `toolFilter` that is configured
// but names neither `allow` nor `deny` (a bare `{ allow: [] }` would otherwise
// silently deny every tool). Applied to both branches and to `fork.*`.
const EMPTY_TOOLFILTER_MSG = 'toolFilter is configured but names neither allow nor deny'
  + ' — remove the key or fill the filter'
function emptyToolFilterRefine(data, ctx, prefix) {
  const tf = data === null || typeof data !== 'object' ? undefined : data.toolFilter
  if (tf === undefined || tf === null) return
  const namingAllow = Array.isArray(tf.allow) && tf.allow.length > 0
  const namingDeny = Array.isArray(tf.deny) && tf.deny.length > 0
  if (!namingAllow && !namingDeny) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${prefix}${EMPTY_TOOLFILTER_MSG}` })
  }
}

/** presetRow branch: the official tool-row shape (§6.3-L2). */
export const presetRowConfigSchema = z.object({
  provider: z.string().min(1),
  toolName: z.string().min(1).default('subagent'),
  presetRow: z.literal(true),
  ...nativeCommon,
}).strict().superRefine((data, ctx) => emptyToolFilterRefine(data, ctx, ''))

/** Full branch: the complete §6.1 table. */
export const pluginConfigSchema = z.object({
  // —— 工具面 ——
  toolNames: z.object({
    delegate: z.string().min(1).optional(),
    fork: z.string().min(1).optional(),
  }).strict().optional(),
  register: z.object({
    delegate: z.boolean().optional(),
    fork: z.boolean().optional(),
    submit: z.boolean().optional(),
    progress: z.boolean().optional(),
    wait: z.boolean().optional(),
    roles: z.boolean().optional(),
    agents: z.boolean().optional(),
  }).strict().optional(),
  presetRow: z.literal(false).optional(),
  // —— native 委派默认（fork 可用 fork.* 覆盖）——
  provider: z.string().min(1).optional(),
  ...nativeCommon,
  fork: z.object({
    provider: z.string().min(1).optional(),
    backgroundMode: backgroundModeSchema.optional(),
    enableRunInBackground: z.boolean().optional(),
    agentOptions: agentOptionsSchema.optional(),
    persona: z.string().optional(),
    toolFilter: toolFilterSchema.optional(),
    maxDepth: maxDepthSchema.optional(),
  }).strict().optional(),
  // —— bridge（原 legacy-bridges-plugin 全量保留）——
  providers: z.record(providerDefSchema).optional(),
  registryPath: z.string().min(1).optional(),
  idleTimeoutMs: z.number().int().min(0).optional(),
  maxConcurrentChildren: z.number().int().positive().optional(),
  rolesDir: z.string().min(1).optional(),
  // —— 迁移 ——
  legacyProductAliases: z.union([z.literal('auto'), z.boolean()]).optional(),
}).strict().superRefine((data, ctx) => {
  emptyToolFilterRefine(data, ctx, '')
  if (data.fork !== undefined) emptyToolFilterRefine(data.fork, ctx, 'fork.')
})

/** The guidance shared by the static fork-name guard and the apply-time collision guard. */
const DISTINCT_TOOLNAME_HINT = 'presetRow 行必须使用与全局实例 delegate/fork 及其它 presetRow 行不同的 toolName'
  + '（如 plan_agent / scout_agent，见 DESIGN §6.3-L2）'

/**
 * Validate and return a normalized config; throws with a clear message.
 * Dispatches on the raw `presetRow === true` marker BEFORE parsing, so the
 * row shape never leaks through the full schema (and vice versa).
 */
export function validateConfig(config = {}) {
  const schema = config !== null && typeof config === 'object' && config.presetRow === true
    ? presetRowConfigSchema
    : pluginConfigSchema
  const result = schema.safeParse(config)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(`dsh-plugin-subagents: invalid config — ${issues.join('; ')}`)
  }
  if (result.data.presetRow === true && result.data.toolName === 'subagent_fork') {
    throw new Error(
      `dsh-plugin-subagents: invalid config — ${DISTINCT_TOOLNAME_HINT}；`
      + `当前撞名：toolName "subagent_fork" 与全局实例 fork 工具的默认名相同`
      + '（且本行注册的是 spawn 语义的委派工具，冒用 fork 名只会误导模型）。'
      + 'Preset-row rewrites must register a distinct toolName.',
    )
  }
  return result.data
}
