import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import { killProcessTree, spawnProduct } from '../run.js'

/** Grace period after session/cancel before the transport is killed. */
const CANCEL_KILL_GRACE_MS = 5000
/** Grace period after SIGTERM in dispose before the tree is force-killed. */
const DISPOSE_KILL_GRACE_MS = 3000
/** Upper bound for the ACP handshake (initialize / session/new / load). */
const HANDSHAKE_TIMEOUT_MS = 30000

/**
 * ACP bridge: one persistent child process speaking the Agent Client Protocol
 * over stdio (e.g. `opencode acp`, `agent acp` (Cursor), `grok agent … stdio`,
 * `cbc --acp`). A session lives in that process; later prompts on the same
 * session continue the conversation, and `session/load` reconnects a
 * persisted session id.
 *
 * Model selection: ACP has no portable model flag. `settings.model` is
 * attempted through `setSessionConfigOption` when the agent advertises the
 * option (best-effort, silently ignored otherwise); configure the agent's own
 * model via its CLI flags / config (`args` option) instead.
 *
 * Permission mapping: ACP has no portable permission flag either —
 * `permissionMode` cannot be enforced on an arbitrary ACP agent by the
 * client. Configure the agent's own flags (e.g. `--always-approve` /
 * read-only modes) through the provider's `args`. `requestPermission` is
 * always answered "rejected" so an unattended agent never silently gains a
 * permission its own config did not grant.
 *
 * Vendor extensions: agents may send non-standard notifications (grok sends
 * `_x.ai/*`). `extNotification` absorbs them silently instead of letting the
 * SDK log a "Method not found" error per notification.
 */
export function createAcpBridge(options = {}) {
  const command = options.command || 'opencode'
  const args = options.args || ['acp']
  const env = options.env || {}
  // Optional hard cap on one prompt turn (a wedged agent otherwise holds the
  // caller forever). Undefined = no cap beyond the caller's signal.
  const timeoutMs = options.timeoutMs !== undefined ? Math.max(1000, Number(options.timeoutMs) || 0) : undefined

  function makeClient(onText, cwd) {
    return {
      async sessionUpdate(params) {
        const update = params && params.update
        if (update && update.sessionUpdate === 'agent_message_chunk') {
          const content = update.content
          if (content && content.type === 'text' && typeof content.text === 'string') onText(content.text)
        }
        return {}
      },
      async requestPermission() {
        // unattended: every permission request is rejected
        return { outcome: { outcome: 'rejected' } }
      },
      async readTextFile(params) {
        // Read-only, confined to the session's cwd subtree — by REAL paths,
        // so a symlink (or Windows junction) inside cwd cannot escape it.
        const root = realpathSafe(cwd)
        const lexical = isAbsolute(params.path) ? resolvePath(params.path) : resolvePath(root, params.path)
        const target = realpathSafe(lexical)
        if (!root || !target || (target !== root && !target.startsWith(root + sep))) {
          throw new Error(`legacy-bridges-plugin: ACP readTextFile refused a path outside the workspace: ${params.path}`)
        }
        const content = readFileSync(target, 'utf8')
        if (params.limit != null || params.line != null) {
          // the protocol's `line` is 1-based
          const firstLine = Number.isFinite(Number(params.line)) && params.line != null ? Number(params.line) : 1
          const start = Math.max(0, firstLine - 1)
          const lines = content.split('\n')
          const count = params.limit != null ? Math.max(0, Number(params.limit) || 0) : lines.length - start
          return { content: lines.slice(start, start + count).join('\n') }
        }
        return { content }
      },
      async writeTextFile() {
        throw new Error('legacy-bridges-plugin: ACP writeTextFile is not supported')
      },
      async extNotification() {
        // Vendor-extension notifications (e.g. grok's `_x.ai/*`) carry no
        // obligation for us — absorb them instead of erroring.
      },
    }
  }

  function bounded(promise, ms, what) {
    // swallow the losing promise's late rejection (it is abandoned, not awaited)
    promise.catch(() => {})
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`product agent "${command}" ${what} timed out after ${ms}ms`)), ms)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  }

  async function connect(cwd, signal) {
    if (signal && signal.aborted) throw abortError()
    const proc = spawnProduct(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'],
      cwd,
      env: { ...process.env, ...env },
    })
    // If the handshake dies (bad binary, immediate crash, caller abort), fail
    // fast instead of leaving a zombie process behind.
    const exited = new Promise((resolve) => proc.once('exit', () => resolve()))
    const onAbort = () => killProcessTree(proc, 'SIGKILL')
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    try {
      const input = Writable.toWeb(proc.stdin)
      const output = Readable.toWeb(proc.stdout)
      const stream = acp.ndJsonStream(input, output)
      let textBuffer = ''
      const progress = { busySince: undefined, stage: 'idle', lastChunkAt: undefined, receivedChars: 0, partialPreview: '' }
      const client = makeClient((text) => {
        textBuffer += text
        progress.lastChunkAt = Date.now()
        progress.receivedChars += text.length
        progress.partialPreview = textBuffer.slice(-200)
      }, cwd)
      const connection = new acp.ClientSideConnection(() => client, stream)
      await bounded(Promise.race([
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
        }),
        exited.then(() => { throw new Error(`product agent "${command}" exited before the ACP handshake`) }),
      ]), HANDSHAKE_TIMEOUT_MS, 'handshake')
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new Error(`product agent "${command}" exited before the ACP handshake`)
      }
      return {
        proc,
        connection,
        progress,
        drainText() {
          const text = textBuffer
          textBuffer = ''
          return text
        },
      }
    } catch (error) {
      killProcessTree(proc, 'SIGKILL')
      throw signal && signal.aborted ? abortError() : error
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
    }
  }

  /** Whether the ACP server process is gone (exited or killed). */
  function transportDead(remote) {
    if (!remote || !remote.proc) return true
    return remote.proc.exitCode !== null || remote.proc.signalCode !== null
  }

  /** Load a persisted session id on a fresh connection, else start a new one. */
  async function establishSession(handle, sessionId, cwd, signal) {
    if (sessionId !== undefined) {
      try {
        await bounded(handle.connection.loadSession({ sessionId }), HANDSHAKE_TIMEOUT_MS, 'session/load')
        handle.sessionId = sessionId
        return handle
      } catch {
        // agent does not support loadSession — fall through to a new session
      }
    }
    try {
      const session = await bounded(handle.connection.newSession({ cwd, mcpServers: [] }), HANDSHAKE_TIMEOUT_MS, 'session/new')
      handle.sessionId = session.sessionId
    } catch (error) {
      killProcessTree(handle.proc, 'SIGKILL')
      throw error
    }
    return handle
  }

  /**
   * Re-establish the ACP connection after the server process died. Mutates
   * `remote` in place (the old process is already dead — nothing to reap).
   */
  async function reconnectRemote(remote, cwd, signal) {
    const handle = await establishSession(await connect(cwd, signal), remote.sessionId, cwd, signal)
    remote.proc = handle.proc
    remote.connection = handle.connection
    remote.drainText = handle.drainText
    remote.progress = handle.progress
    remote.sessionId = handle.sessionId
  }

  async function runPrompt(remote, task) {
    const response = await remote.connection.prompt({
      sessionId: remote.sessionId,
      prompt: [{ type: 'text', text: task }],
    })
    const rawStop = response && response.stopReason ? String(response.stopReason) : 'end_turn'
    const stopReason = rawStop === 'end_turn' ? 'completed' : rawStop
    return { text: remote.drainText(), stopReason }
  }

  return {
    async create(cwd, signal) {
      const handle = await connect(cwd, signal)
      try {
        return { kind: 'acp', ...await establishSession(handle, undefined, cwd, signal) }
      } catch (error) {
        killProcessTree(handle.proc, 'SIGKILL')
        throw error
      }
    },
    async submit(remote, task, signal, cwd, settings = {}) {
      if (settings.model) {
        try {
          await remote.connection.setSessionConfigOption({ sessionId: remote.sessionId, configId: 'model', value: settings.model })
        } catch {
          // agent does not support the option; its own config decides
        }
      }
      // The persistent server process may have died between turns (crash, OOM,
      // manual kill). The session id itself was captured at session/new, so
      // continuity is preserved wherever the agent allows session/load. If the
      // prompt fails on a dead transport, reconnect once and retry (the prompt
      // cannot have been delivered to a dead process, so a retry is safe).
      remote.progress.busySince = Date.now()
      remote.progress.stage = 'agent running'
      remote.progress.receivedChars = 0
      const settle = () => {
        remote.progress.busySince = undefined
        remote.progress.lastChunkAt = Date.now()
        remote.progress.stage = 'answer received'
      }
      // Cancellation: abort (or a configured hard timeout) asks the agent to
      // stop via session/cancel; the spec says it then answers the prompt with
      // stopReason "cancelled". If it does not settle within the grace period,
      // kill the transport so a wedged agent cannot hold the caller hostage;
      // the next submit reconnects. The abort race wraps the WHOLE attempt —
      // including the dead-transport reconnect retry — so cancellation stays
      // effective even while a retry is in flight.
      let interrupted = false // set for abort OR timeout
      const interrupt = () => {
        if (interrupted) return
        interrupted = true
        try { remote.connection.cancel({ sessionId: remote.sessionId }) } catch { /* transport may be gone */ }
        const killTimer = setTimeout(() => killProcessTree(remote.proc, 'SIGKILL'), CANCEL_KILL_GRACE_MS)
        if (typeof killTimer.unref === 'function') killTimer.unref()
      }
      const attempt = async () => {
        try {
          return await runPrompt(remote, task)
        } catch (error) {
          if (interrupted || !transportDead(remote)) throw error
          await reconnectRemote(remote, cwd, signal)
          return await runPrompt(remote, task)
        }
      }
      let onAbort
      const abortedPromise = signal
        ? new Promise((resolve) => {
            onAbort = () => { interrupt(); resolve() }
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, { once: true })
          })
        : null
      const timeoutTimer = timeoutMs
        ? setTimeout(() => interrupt(), timeoutMs)
        : null
      if (timeoutTimer && typeof timeoutTimer.unref === 'function') timeoutTimer.unref()
      try {
        if (!abortedPromise) {
          const out = await attempt()
          // the agent may answer the cancel gracefully (stopReason cancelled);
          // that is still a timeout, not a result
          if (interrupted) throw timeoutError(timeoutMs)
          return out
        }
        if (signal.aborted) throw abortError()
        let outcome
        try {
          const attemptPromise = attempt()
          // The abort path abandons the attempt; swallow its late rejection.
          attemptPromise.catch(() => {})
          outcome = await Promise.race([attemptPromise, abortedPromise.then(() => ABORTED)])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
        if (outcome === ABORTED) {
          // Discard any partial output of the cancelled turn so the next
          // submission starts from a clean buffer.
          remote.drainText()
          throw abortError()
        }
        if (interrupted) throw timeoutError(timeoutMs)
        return outcome
      } catch (error) {
        if (interrupted) throw signal && signal.aborted ? abortError() : timeoutError(timeoutMs)
        throw error
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        settle()
      }
    },
    async reconnect(sessionId, cwd, signal) {
      const handle = await connect(cwd, signal)
      try {
        return { kind: 'acp', ...await establishSession(handle, sessionId, cwd, signal) }
      } catch (error) {
        killProcessTree(handle.proc, 'SIGKILL')
        throw error
      }
    },
    async dispose(remote) {
      try {
        // bounded: a wedged agent must not stall idle disposal or teardown
        await Promise.race([
          remote.connection.closeSession({ sessionId: remote.sessionId }).catch(() => {}),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, DISPOSE_KILL_GRACE_MS)
            if (typeof timer.unref === 'function') timer.unref()
          }),
        ])
      } catch {
        // already closed or the process is gone
      }
      killProcessTree(remote.proc, 'SIGTERM')
      if (remote.proc.exitCode !== null || remote.proc.signalCode !== null) return
      await new Promise((resolve) => {
        const timer = setTimeout(() => { killProcessTree(remote.proc, 'SIGKILL'); resolve() }, DISPOSE_KILL_GRACE_MS)
        remote.proc.once('exit', () => { clearTimeout(timer); resolve() })
      })
    },
  }
}

const ABORTED = Symbol('aborted')

function abortError() {
  const error = new Error('product_submit aborted before the agent answered')
  error.name = 'AbortError'
  return error
}

function timeoutError(timeoutMs) {
  const error = new Error(`product agent did not answer within ${timeoutMs}ms (prompt cancelled)`)
  error.name = 'TimeoutError'
  return error
}

function realpathSafe(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
