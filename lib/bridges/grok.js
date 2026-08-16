import { randomUUID } from 'node:crypto'
import { runCommand } from '../run.js'
import { redactText } from '../redact.js'

/**
 * Grok bridge: one `grok --single=<task> --output-format streaming-json`
 * process per message (grok CLI 1.0.4). Argv/parse/classify logic ported
 * from task-weaver `packages/agent-runtime/src/adapters/grok/{argv,parse,
 * classify}.ts` (pure functions, TS Result types → throw; see the ported
 * helpers below), restructured onto this repo's bridge contract
 * (`create/submit/reconnect/dispose`, one spawn per turn through
 * lib/run.js — never child_process directly).
 *
 * === Deviations from task-weaver's recorded argv (both VERIFIED against the
 * locally installed grok 1.0.4 `--help`, parse-only probes — no model calls;
 * task-weaver pinned an older CLI):
 *
 *  1. Resume is `-r/--resume <id>` ALONE. task-weaver recorded
 *     `-s <uuid> --resume <uuid>`; in 1.0.4 `-s/--session-id` only NAMES a
 *     new conversation ("must be a valid UUID and must not already exist")
 *     and is only legal with `--resume` when combined with `--fork-session`.
 *     So: session identity comes from the streaming `end` event's
 *     `sessionId` (the only CLI-confirmed resume token — task-weaver R2
 *     A-011's conclusion still holds), captured INCREMENTALLY from the
 *     stdout stream; `-s` is used exactly once, pre-allocating the FIRST
 *     conversation's UUID (claude-bridge style) so an interrupted first
 *     turn still knows its id.
 *  2. The task text rides as an ATTACHED flag value: `--single=<task>`.
 *     Design rule 7 ("task text always goes after `--`") cannot be followed
 *     LITERALLY here: clap refuses `grok -p -- <task>` ("a value is required
 *     for '--single' but none was supplied"). The attached-value form
 *     preserves the rule's SUBSTANCE — everything after `=` is one literal
 *     prompt value that clap never re-parses as flags, so a task starting
 *     with "-" (verified: `--single=--dangerous …`) or containing shell/CMD
 *     metacharacters stays task text. run.js still delivers it as ONE argv
 *     element (no shell on POSIX; quoted as a whole on Windows).
 *
 * === Streaming-json event schema (task-weaver R2 fixtures, confirmed shape):
 * flat `{type, …}` NDJSON — `available_commands` (inventory, absorb),
 * `thought` (reasoning deltas), `text` (the turn's full assistant message),
 * `usage` (interim counts), `end` (terminal: stopReason, sessionId,
 * requestId, final usage, total_cost_usd, num_turns). NOT ACP JSON-RPC
 * (that is `grok agent stdio`, a different transport served by the acp
 * bridge via config.providers).
 *
 * === Registration & naming ownership (design ruling 2026-08-16): this
 * bridge is the built-in provider **`grok-native`** (providers.js, type
 * 'grok'). The bare name `grok` belongs to the USER's config.providers —
 * existing deployments define it as an ACP transport and hold durable
 * registry entries with `backend: "grok"` (ACP-issued remote ids). The two
 * coexist; no migration and no resume-id heuristics (ACP ids and native
 * session ids cannot be reliably told apart).
 *
 * === Exit-code classification (task-weaver classify.ts, ported below):
 * exit 2 is clap argument validation (permanent, caller must fix argv);
 * any other non-zero is unknown → fail closed, surfaced as the CLI's own
 * stderr/stdout tail.
 */
export function createGrokBridge(options = {}) {
  const command = options.command || 'grok'
  const env = options.env || {}
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 300000)
  // redactSecrets is threaded from config by providers.js (default true).
  const redactSecrets = options.redactSecrets !== false
  const scrub = redactSecrets ? redactText : (text) => text

  return {
    async create(_cwd, _signal) {
      // pendingSessionId: preallocated UUID for the FIRST conversation
      // (`-s`), promoted on failure like claude's — the next submission
      // creates the conversation under exactly this id. Later turns resume
      // by the CLI-confirmed id learned from the `end` event.
      return { kind: 'grok', sessionId: undefined, pendingSessionId: randomUUID(), progress: {} }
    },

    async submit(remote, task, signal, cwd, settings = {}) {
      const args = ['--output-format', 'streaming-json', '--permission-mode', grokPermissionMode(settings.permissionMode)]
      if (settings.model) args.push('--model', safeFlagValue(settings.model, 'model'))
      if (settings.reasoningEffort) args.push('--reasoning-effort', safeFlagValue(settings.reasoningEffort, 'reasoningEffort'))
      if (remote.sessionId) {
        // grok 1.0.4: `-r/--resume <id>` continues that named session.
        args.push('--resume', safeFlagValue(remote.sessionId, 'sessionId'))
      } else if (remote.pendingSessionId) {
        // First turn: name the NEW conversation with the preallocated UUID.
        args.push('--session-id', safeFlagValue(remote.pendingSessionId, 'sessionId'))
      }
      // ATTACHED value (see module header): clap treats everything after
      // `=` as the literal prompt — a "-"-prefixed or metacharacter-laden
      // task can never flip into another flag (rule 7's substance).
      args.push(`--single=${task}`)

      remote.progress = { ...remote.progress, busySince: Date.now(), stage: 'grok running', receivedChars: 0 }
      // allowNonZero: grok reflects a failed turn in its exit code; the
      // streaming events + stderr are the authoritative diagnosis, parsed
      // below before any exit-code error is thrown.
      let lineBuffer = ''
      const { stdout, stderr, code, killed } = await runCommand(command, args, {
        env,
        signal,
        cwd,
        timeoutMs,
        allowNonZero: true,
        redactSecrets,
        onStdout: (chunk) => {
          remote.progress = {
            ...remote.progress,
            lastChunkAt: Date.now(),
            receivedChars: (remote.progress.receivedChars || 0) + chunk.length,
          }
          // Capture the session id INCREMENTALLY: the `end` event carries
          // it, so even an interrupted submission that got far enough to
          // emit `end` keeps the id and the next submission resumes the
          // same conversation (same discipline as the codex bridge).
          lineBuffer += chunk
          let nl
          while ((nl = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, nl).trim()
            lineBuffer = lineBuffer.slice(nl + 1)
            const session = sessionFromLine(line)
            if (session && !remote.sessionId) remote.sessionId = session
          }
        },
      })
      remote.progress = { ...remote.progress, busySince: undefined, lastChunkAt: Date.now(), stage: 'answer received' }

      // Final pass over the full stream (task-weaver parse.ts mapping): last
      // `text` event wins as the assistant message; `end` supplies the
      // authoritative stopReason; unknown types are ignored (their evidence
      // was already redacted into the capture). The sessionId was already
      // committed INCREMENTALLY by the onStdout closure the instant an `end`
      // line arrived — that is the only path that runs when a submission is
      // later interrupted/errored, so it is where the resume id must stick.
      let text = ''
      let stopReason
      let sawEnd = false
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue
        // `text` = the agent's turn message (grok emits one per turn, full
        // message — task-weaver maps it to message.completed).
        if (event.type === 'text' && typeof event.data === 'string') text = event.data
        if (event.type === 'end') {
          sawEnd = true
          if (typeof event.stopReason === 'string') stopReason = event.stopReason
        }
      }
      // NIT-3: grok persists a conversation only at the stream's terminal
      // `end` event (module header note 1). A stream truncated BEFORE `end`
      // (non-zero exit after partial output) never persisted a session, so
      // promoting an incrementally captured id here would hand the next turn
      // a doomed `--resume`. Gate the promote on `sawEnd` — a truncated turn
      // leaves the preallocated `-s` first-turn path in place (fresh session)
      // instead of guessing at an id that does not exist on the CLI.
      if (sawEnd && remote.sessionId) {
        remote.pendingSessionId = undefined
      }
      // An aborted/signalled/timed-out run resolved with partial output:
      // report the interruption, never the partial text (codex-bridge
      // discipline). `killed` is explicit (Windows taskkill yields a
      // numeric exit code, not a null one).
      if (killed || (signal && signal.aborted) || code === null) {
        const error = new Error(`grok turn ${killed === 'timeout' ? 'timed out' : 'interrupted'}${text ? ' (partial output discarded)' : ''}`)
        error.name = killed === 'timeout' ? 'TimeoutError' : 'AbortError'
        throw error
      }
      if (code !== 0 && !text) {
        // Task-weaver classify.ts: exit 2 = clap argument validation
        // (permanent); anything else is unknown → surface the CLI's own
        // output tail, already redacted by run.js.
        const hint = code === 2 ? ' (argument validation failed — permanent)' : ''
        throw new Error(`grok exited ${code}${hint}: ${(stderr || stdout).slice(0, 400)}`)
      }
      if (code !== 0) return { text, stopReason: 'error' }
      // grok's own terminal stopReason passes through (harness vocabulary:
      // completed/aborted/error/max-tokens/refusal — foreign values are
      // relayed verbatim per DESIGN §3.2).
      const normalized = stopReason === 'end_turn' ? 'completed' : (stopReason || 'completed')
      return { text: scrub(text), stopReason: normalized }
    },

    async reconnect(sessionId, _cwd, _signal) {
      // A persisted grok session is resumed with `--resume <id>` on the next
      // submission; no process survives to reconnect to.
      return { kind: 'grok', sessionId, pendingSessionId: undefined, progress: {} }
    },

    async dispose() {
      // each submission is a separate process; nothing to tear down
    },
  }
}

/** Extract a CLI-confirmed session id from one streaming-json line, if any. */
function sessionFromLine(line) {
  if (!line) return undefined
  try {
    const event = JSON.parse(line)
    if (event && typeof event === 'object' && event.type === 'end' && typeof event.sessionId === 'string') {
      return event.sessionId
    }
  } catch {
    /* not JSON — ignore */
  }
  return undefined
}

/**
 * Product permission mode (applies to the remote agent, never the relay):
 *   readonly -> plan            (grok's own read-only exploration mode)
 *   full     -> bypassPermissions (dangerous, role-gated upstream)
 *
 * The two remaining cases are deliberately split — conflating them is what
 * makes this easy to misread:
 *   - `undefined` / `'default'` -> dontAsk (grok's official headless,
 *     non-interactive default — grok's `default` waits on interactive
 *     approval that an unattended turn can never grant; `dontAsk` refuses
 *     tools it cannot auto-approve. task-weaver records the same CI-safe
 *     default.)
 *   - ANY OTHER unknown value -> plan (fail closed to grok's readonly
 *     equivalent — design rule 3: unknown permission modes fail closed to
 *     readonly; never an elevated mode).
 */
export function grokPermissionMode(permissionMode) {
  if (permissionMode === 'full') return 'bypassPermissions'
  if (permissionMode === 'readonly') return 'plan'
  // undefined === 'default' (the plugin's default mode) → grok's headless
  // non-interactive mode
  if (permissionMode === undefined || permissionMode === 'default') return 'dontAsk'
  // unknown → readonly's grok equivalent (plan), fail closed (rule 3)
  return 'plan'
}

/**
 * Values that end up as CLI flag values must be plain identifiers — a value
 * like `x", something_else="y` could inject additional options, and a
 * leading `-` could flip into another flag (same whitelist as the claude
 * bridge's safeFlagValue; task text is exempt — it rides the attached-value
 * transport, not this path).
 */
export function safeFlagValue(value, what) {
  const text = String(value)
  // must START safe: a leading "-" could flip into another flag
  if (!/^[A-Za-z0-9_][A-Za-z0-9._:/-]*$/.test(text)) {
    throw new Error(`grok: refusing unsafe ${what} value: ${JSON.stringify(text.slice(0, 40))}`)
  }
  return text
}
