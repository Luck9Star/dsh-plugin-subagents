// dsh-plugin-subagents — native 委派纯函数层（T08）。
//
// 自前身 `legacy-cwd-plugin/lib/index.js` 抽出的 execute 主体纯函数：请求组装
// （persona/@preset 解析、model 路由拆分、cwd 断言）与结果 settle（前台
// `settleForegroundRun` / 后台 `settleStart`）。逻辑逐行照搬 CW；错误文案的
// 消息体保持逐字等价，前缀按上级定案统一品牌为 `dsh-plugin-subagents:`
// （这些函数现属本插件，保留前身包名会让排障用户看到从未安装过的包名；
// 与 T05 将 ceiling 前缀 `product_delegate:` 改 `subagent:` 的先例一致）。
//
// 与 CW 的唯一差异（设计要求的测试注入点）：
//   - `resolvePersona(persona, presetsRoot?)` 增加可选 `presetsRoot` 覆盖参数；
//     缺省值仍在 `@preset:` 分支内惰性求值 `dshHomePath('.agent-presets')`
//     （CW 原行为：非 @preset 入参不触任何文件系统访问）。
//
// 红线 12（DESIGN §6.4.4 / §9）：对 `@deepseek-ai/dsh-subagent` 恒只 import
// 纯函数白名单 `{ assertSubagentMaxDepth, settleRun }`；本文件仅使用 `settleRun`
// （参数校验与结果归一化，无模块态、无 Symbol 身份）。一切服务访问走 `ctx`
// （宿主实例），由调用方（lib/drivers/native.js）注入。

import { settleRun } from '@deepseek-ai/dsh-subagent'
import { readFile, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Validate a per-call cwd override: absolute and an accessible directory. */
export function assertCwd(cwd) {
  if (!isAbsolute(cwd)) throw new Error(`dsh-plugin-subagents: cwd must be an absolute path: ${cwd}`)
  let stat
  try {
    stat = statSync(cwd)
  } catch (error) {
    throw new Error(`dsh-plugin-subagents: cwd is not an accessible directory: ${cwd} (${String(error)})`)
  }
  if (!stat.isDirectory()) throw new Error(`dsh-plugin-subagents: cwd is not a directory: ${cwd}`)
  return cwd
}

/**
 * Resolve a per-call persona argument. A plain string is used as-is; a
 * `@preset:<id>` value loads the named agent preset's persona text from its
 * composition file (`<dshHome>/.agent-presets/<id>/agent.cordis.yml`), so the
 * caller can reference a preset by name instead of inlining its full text.
 * `id` may be the preset's directory id or its display name (preset.yml
 * `name`).
 *
 * @param {string|undefined} persona per-call persona（可为 `@preset:<id|显示名>`）
 * @param {string} [presetsRoot] 可选覆盖 preset 根目录（测试注入）；缺省走
 *   `dshHomePath('.agent-presets')`，且仅在 `@preset:` 分支内求值。
 * @returns {Promise<string|undefined>} 解析后的 persona 文本
 */
export async function resolvePersona(persona, presetsRoot) {
  if (typeof persona !== 'string' || !persona.startsWith('@preset:')) return persona
  const id = persona.slice('@preset:'.length).trim()
  if (id.length === 0) throw new Error('dsh-plugin-subagents: empty preset id after `@preset:`')
  const root = presetsRoot !== undefined ? presetsRoot : dshHomePath('.agent-presets')
  let file = join(root, id, 'agent.cordis.yml')
  try {
    await readFile(file, 'utf8')
  } catch {
    file = await resolvePresetByDisplayName(root, id)
  }
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`dsh-plugin-subagents: cannot read agent preset "${id}" (${file}): ${String(error)}`)
  }
  const doc = parseYaml(raw)
  const entry = Array.isArray(doc)
    ? doc.find((row) => row !== null && typeof row === 'object' && row.id === 'persona')
    : undefined
  const text = entry !== undefined && entry.config !== undefined && typeof entry.config.text === 'string'
    ? entry.config.text
    : undefined
  if (text === undefined) {
    throw new Error(`dsh-plugin-subagents: agent preset "${id}" has no persona text (no \`id: persona\` entry with a string config.text)`)
  }
  return text
}

/** Map a preset display name (preset.yml `name`) to its composition file path. */
export async function resolvePresetByDisplayName(presetsRoot, displayName) {
  let dirs
  try {
    dirs = await readdir(presetsRoot, { withFileTypes: true })
  } catch (error) {
    throw new Error(`dsh-plugin-subagents: cannot list agent presets (${presetsRoot}): ${String(error)}`)
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const metaFile = join(presetsRoot, dir.name, 'preset.yml')
    let metaRaw
    try {
      metaRaw = await readFile(metaFile, 'utf8')
    } catch {
      continue
    }
    const meta = parseYaml(metaRaw)
    if (meta !== null && typeof meta === 'object' && meta.name === displayName) {
      return join(presetsRoot, dir.name, 'agent.cordis.yml')
    }
  }
  throw new Error(`dsh-plugin-subagents: agent preset "${displayName}" not found under ${presetsRoot} (checked directory id and preset.yml display name)`)
}

/** Resolve a per-call model argument into an explicit provider/model pair. */
export function resolveModelRoute(model) {
  if (typeof model !== 'string') return { provider: undefined, model: undefined }
  const slash = model.indexOf('/')
  if (slash === -1) return { provider: undefined, model }
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) }
}

/** Render text blocks from the canonical JSON block array without trusting arbitrary values. */
export function outputValueText(values) {
  return values
    .filter((value) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
      && value.type === 'text' && typeof value.text === 'string')
    .map((value) => value.text)
    .join('')
}

/** Settle pending startup without rejecting the task producer contract. */
export async function settleStart(start, signal) {
  try {
    return await settleRun(await start)
  } catch (error) {
    return signal.aborted
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

/** A non-`completed` stop reason means the child did not finish cleanly. */
export function stopReasonError(result) {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return `subagent run ended abnormally (${String(result.stopReason)})`
  }
}

/** Append the child's preserved partial answer to a stop-reason error. */
export function withPartialText(error, output) {
  const text = output
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.length === 0 ? error : `${error}\nPartial output before the run ended:\n${text}`
}

/** Collect and release one foreground run without letting disposal replace an independent result failure. */
export async function settleForegroundRun(run) {
  const [execution] = await Promise.allSettled([
    run.result.then((result) => {
      const error = stopReasonError(result)
      if (error !== undefined) {
        throw new Error(withPartialText(error, result.output))
      }
      return {
        kind: 'foreground',
        runId: run.id,
        output: result.output,
      }
    }),
  ])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `subagent run failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}

/** Model-facing wording from the provider's conversation-history descriptor. */
export function providerWording(inheritsConversation) {
  if (inheritsConversation) {
    return {
      description:
        'Delegate a task to a subagent that inherits this conversation: a child agent seeded with all '
        + 'completed turns so far (it does not see the current in-flight turn). Use this when the subtask '
        + 'builds on this conversation\'s context — a follow-up analysis, '
        + 'a review, a continuation — without consuming this conversation\'s context for the work itself. '
        + 'You receive its result, not its intermediate steps.',
      promptDescription:
        'The task for the subagent. It already sees this conversation\'s completed turns, so build on them '
        + 'freely and state only what is new.',
    }
  }
  return {
    description:
      'Delegate a self-contained task to a subagent (a separate agent that works in its own context) '
      + 'to offload focused, independent work — research, a scoped '
      + 'implementation, an analysis — so it does not consume this conversation\'s context. The subagent '
      + 'returns its result, not its intermediate steps. Give it a '
      + 'complete, standalone prompt: it does not see this conversation.',
    promptDescription:
      'The complete, self-contained task for the subagent. It does not share this '
      + 'conversation\'s context, so include everything it needs.',
  }
}

/** Resolve the model's optional scheduling request into one execution route. */
export function resolveDelegationRun(request, options) {
  if (!options.backgroundEnabled) {
    if (request.run_in_background === true) {
      throw new Error('run_in_background is disabled for this tool instance (enableRunInBackground: false)')
    }
    return { runInBackground: false }
  }
  return {
    runInBackground: request.run_in_background ?? options.continuable,
  }
}
