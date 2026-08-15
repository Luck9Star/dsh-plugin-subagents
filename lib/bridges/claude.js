import { randomUUID } from 'node:crypto'
import { runCommand } from '../run.js'

/**
 * Claude Code bridge: one `claude -p --output-format json` invocation per
 * message. The session id is PREALLOCATED as a UUID (`--session-id`) on
 * create(), so it is known BEFORE the first submission: an interrupted first
 * submission still knows its id (the next call resumes it), and the bridge
 * never has to guess "the newest session file for this cwd" (which would race
 * with any other Claude session sharing the workspace). Sessions are
 * resumable by id across restarts. Model and reasoning effort are passed
 * through as `--model` / `--effort`.
 */
export function createClaudeBridge(options = {}) {
  const command = options.command || 'claude'
  const env = options.env || {}
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 300000)

  async function invoke(remote, args, signal, cwd) {
    remote.progress = { ...remote.progress, busySince: Date.now(), stage: 'claude running', receivedChars: 0 }
    let stdout
    try {
      ;({ stdout } = await runCommand(command, args, {
        env,
        signal,
        cwd,
        timeoutMs,
        onStdout: (chunk) => {
          remote.progress = {
            ...remote.progress,
            lastChunkAt: Date.now(),
            receivedChars: (remote.progress.receivedChars || 0) + chunk.length,
          }
        },
      }))
    } catch (error) {
      // The submission was interrupted or failed. Promote the preallocated id:
      // claude persists the session under exactly this id, so the NEXT
      // submission resumes this conversation instead of starting a fresh one.
      if (!remote.sessionId && remote.pendingSessionId) {
        remote.sessionId = remote.pendingSessionId
        remote.pendingSessionId = undefined
      }
      throw error
    }
    remote.progress = { ...remote.progress, busySince: undefined, lastChunkAt: Date.now(), stage: 'answer received' }
    const line = stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop()
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('claude returned unparseable output: ' + stdout.slice(0, 300))
    }
    if (parsed.is_error) throw new Error(String(parsed.error || 'claude returned an error'))
    if (parsed.session_id) {
      remote.sessionId = parsed.session_id
      remote.pendingSessionId = undefined
    }
    const text = String(parsed.result ?? parsed.text ?? '').trim()
    return { text, stopReason: 'completed' }
  }

  function buildArgs(remote, task, settings) {
    const args = ['-p', '--output-format', 'json']
    if (settings.model) args.push('--model', safeFlagValue(settings.model, 'model'))
    if (settings.reasoningEffort) args.push('--effort', safeFlagValue(settings.reasoningEffort, 'reasoningEffort'))
    // Product permission mode (applies to the remote agent, never the relay):
    //   readonly -> plan mode (read-only exploration)
    //   full     -> bypass all permission checks
    //   default  -> the product's own configured defaults
    if (settings.permissionMode === 'readonly') args.push('--permission-mode', 'plan')
    else if (settings.permissionMode === 'full') args.push('--dangerously-skip-permissions')
    if (remote.sessionId) args.push('--resume', remote.sessionId)
    else if (remote.pendingSessionId) args.push('--session-id', remote.pendingSessionId)
    // `--` ends flag parsing: a task that HAPPENS to start with "-" (e.g. a
    // relayed "--dangerously-skip-permissions" after prompt injection in the
    // remote product's output) must stay a positional prompt, never a flag.
    args.push('--', task)
    return args
  }

  return {
    async create(_cwd, _signal) {
      return { kind: 'claude', sessionId: undefined, pendingSessionId: randomUUID(), progress: {} }
    },
    async submit(remote, task, signal, cwd, settings = {}) {
      const out = await invoke(remote, buildArgs(remote, task, settings), signal, cwd)
      return out
    },
    async reconnect(sessionId, _cwd, _signal) {
      return { kind: 'claude', sessionId, pendingSessionId: undefined, progress: {} }
    },
    async dispose() {
      // each submission is a separate process; nothing to tear down
    },
  }
}

/**
 * Values that end up as CLI flag values must be plain identifiers — a value
 * like `x", something_else="y` could inject additional options, and a leading
 * `-` could flip into another flag.
 */
export function safeFlagValue(value, what) {
  const text = String(value)
  // must START safe: a leading "-" could flip into another flag
  if (!/^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/.test(text)) {
    throw new Error(`claude: refusing unsafe ${what} value: ${JSON.stringify(text.slice(0, 40))}`)
  }
  return text
}
