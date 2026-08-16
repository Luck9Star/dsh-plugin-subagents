import { spawn, spawnSync } from 'node:child_process'
import { redactText } from './redact.js'

/**
 * Cross-platform product CLI launch.
 *
 * On POSIX, the command is spawned directly INTO ITS OWN PROCESS GROUP
 * (`detached: true`) so abort/timeout can kill the whole tree
 * (`kill(-pid)`) — product CLIs spawn shells, git, compilers, …
 *
 * On Windows, npm-installed CLIs (claude, codex, cbc, opencode, agent, …) are
 * `.cmd`/`.bat` shims that plain `spawn` cannot execute (ENOENT), so the
 * whole invocation is run through `cmd.exe` with verbatim arguments.
 *
 * Windows quoting uses the canonical `cmd /d /s /c "…"` pattern: every
 * argument that contains whitespace or a cmd metacharacter is individually
 * double-quoted (embedded `"` doubled to `""`, the cmd/MSVCRT convention),
 * and the ENTIRE command line is then wrapped in one extra pair of outer
 * quotes. With `/s`, cmd strips exactly that outer pair and hands the inner
 * line (`"claude.cmd" -p "task text"`) to the shell with all inner quotes
 * intact. (Without the outer wrap, `/s` would instead strip the first quote
 * of the command and the LAST quote of the final argument, corrupting any
 * invocation whose task contains spaces.)
 *
 * Residual risk, accepted: cmd expands `%VAR%` inside the command line even
 * when quoted, so a task containing `%PATH%` would leak that variable's value
 * into the prompt text. It cannot break out into running another command:
 * every arg with a metacharacter is quoted, so `&`/`|` never reach the shell
 * as operators.
 */
const IS_WIN = process.platform === 'win32'

export function cmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/** Args that must be wrapped in quotes on Windows. */
const WIN_DANGER = /[\s"&|<>^()%!]/

export function winArgs(command, args) {
  const inner = [
    cmdQuote(command),
    ...args.map((a) => (WIN_DANGER.test(a) ? cmdQuote(a) : a)),
  ].join(' ')
  // One outer quote pair around the whole line; `/s` strips exactly this pair.
  return ['/d', '/s', '/c', `"${inner}"`]
}

export function spawnProduct(command, args, options) {
  if (!IS_WIN) {
    // Own process group → the whole tree can be killed together. stdio
    // stays piped, so the child is NOT detached from our control.
    return spawn(command, args, { ...options, detached: true })
  }
  return spawn('cmd.exe', winArgs(command, args), { ...options, windowsVerbatimArguments: true })
}

export function spawnSyncProduct(command, args, options) {
  if (!IS_WIN) return spawnSync(command, args, options)
  return spawnSync('cmd.exe', winArgs(command, args), { ...options, windowsVerbatimArguments: true })
}

/**
 * Kill one launched product and its whole process tree: the POSIX process
 * group via `kill(-pid)`, the Windows tree via `taskkill /T /F` (the spawned
 * object is `cmd.exe`; `child.kill` neither kills the real CLI behind a
 * `.cmd` shim nor its grandchildren).
 */
export function killProcessTree(child, signal = 'SIGTERM') {
  if (!child) return
  const alreadyGone = child.exitCode !== null || child.signalCode !== null
  if (IS_WIN) {
    if (!alreadyGone && child.pid !== undefined) {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      if (!result.error && result.status === 0) return
      // fall through to a plain kill
    }
    try { child.kill(signal) } catch { /* already gone */ }
    return
  }
  if (!alreadyGone && child.pid !== undefined) {
    try { process.kill(-child.pid, signal) } catch { /* group gone — try the leader */ }
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

/** Keep only the tail of an ever-growing capture so huge outputs stay bounded. */
const MAX_CAPTURE_CHARS = 8 * 1024 * 1024

function appendCapped(current, chunk) {
  const next = current + chunk
  return next.length > MAX_CAPTURE_CHARS ? next.slice(next.length - MAX_CAPTURE_CHARS) : next
}

/**
 * Run one product CLI command to completion, returning stdout/stderr plus a
 * `killed` reason ('timeout' | 'abort') when the process tree was killed by
 * the caller's cancellation paths — callers must not mistake that for a
 * normal result. Cancellation (signal) and a hard timeout bound the wait;
 * `onStdout` receives each stdout chunk as it arrives (for live progress).
 * Captures keep only the last 8MB (stdout is parsed from its tail).
 *
 * Secret redaction (ported from task-weaver redact.ts, see lib/redact.js):
 * by default every stdout/stderr chunk is redacted BEFORE it is buffered
 * (task-weaver invariant: "redaction happens before the parser sink") — a
 * product CLI that prints a Bearer token / API key never leaks it into the
 * conversation context, progress previews, or error messages built from the
 * captured output. `redactSecrets: false` restores the raw passthrough for
 * deployments that need byte-exact output (e.g. relaying signed payloads);
 * the default stays ON because a leaked secret is unrecoverable while a
 * false positive costs one redacted token. appendCapped semantics are
 * unchanged (still the last 8MB of the REDACTED stream — redaction runs
 * first so a secret split across the cap boundary is still scrubbed).
 */
export function runCommand(command, args, options = {}) {
  const { env = {}, cwd, signal, timeoutMs = 300000, onStdout, allowNonZero = false, redactSecrets = true } = options
  const scrub = redactSecrets === false ? (text) => text : redactText
  return new Promise((resolve, reject) => {
    const child = spawnProduct(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, ...env },
    })
    let killed
    // Products never read stdin; hand them an immediate EOF (some CLIs, e.g.
    // codex exec, misbehave when the stream is outright ignored). An EPIPE
    // against a CLI that exited early must not become an unhandled error.
    child.stdin.on('error', () => {})
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      // Redact once, then use the SAME scrubbed chunk everywhere (capture,
      // progress callbacks) so no surface ever sees the raw secret.
      const chunk = scrub(String(d))
      stdout = appendCapped(stdout, chunk)
      if (onStdout) { try { onStdout(chunk) } catch { /* progress is best-effort */ } }
    })
    child.stderr.on('data', (d) => { stderr = appendCapped(stderr, scrub(String(d))) })
    const onAbort = () => { killed = 'abort'; killProcessTree(child, 'SIGTERM') }
    if (signal && signal.aborted) onAbort()
    else if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { killed = 'timeout'; killProcessTree(child, 'SIGKILL') }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (error) => {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      if (code === 0 || allowNonZero) resolve({ stdout, stderr, code, killed })
      else reject(new Error(`command "${command} ${args.join(' ')}" exited ${code}${killed ? ` (${killed})` : ''}: ${(stderr || stdout).slice(0, 600)}`))
    })
  })
}

/** cwd of the delegating parent session, with a safe fallback. */
export function parentCwd(parent) {
  try {
    const cwd = parent && parent.session && parent.session.header && parent.session.header.cwd
    return cwd || process.cwd()
  } catch {
    return process.cwd()
  }
}
