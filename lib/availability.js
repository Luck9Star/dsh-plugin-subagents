import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { spawnProduct } from './run.js'

/**
 * Detect whether each product CLI exists and whether its login artifacts are
 * present. Missing command => the provider is NOT registered (and the
 * delegation tool omits it / errors clearly). Login artifacts are reported as
 * a hint; an actually broken credential (e.g. a 401) still surfaces at call
 * time with the product's own error.
 *
 * Detection never RUNS the CLI (some CLIs exit non-zero on `--version`, and
 * running every CLI blocks harness startup): it is a PATH lookup
 * (`which` / Windows `where`), executed for all providers in PARALLEL so
 * startup cost is the slowest lookup, not the sum of all.
 */
export async function detectAvailability(products) {
  const entries = Object.entries(products)
  const results = await Promise.all(entries.map(([, def]) => commandExists(def.command)))
  const result = {}
  entries.forEach(([name, def], i) => {
    const found = results[i]
    let auth = { ok: true, note: 'no auth required' }
    if (def.checkAuth) auth = def.checkAuth()
    result[name] = {
      registered: found,
      command: found,
      reason: found ? (auth.ok ? 'available' : `command present, but ${auth.note}`) : `command "${def.command}" not found on PATH`,
      auth,
    }
  })
  return result
}

/** Whether a command resolves (PATH lookup; an absolute/existing path counts). */
function commandExists(command) {
  if (!command) return Promise.resolve(false)
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    try { return Promise.resolve(existsSync(command)) } catch { return Promise.resolve(false) }
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    const child = spawnProduct(lookup, [command], { stdio: 'ignore' })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(false)
    }, 10000)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

const home = () => homedir()

export const authChecks = {
  'claude-code': () => {
    const candidates = [join(home(), '.claude', '.credentials.json'), join(home(), '.claude.json')]
    const present = candidates.some((p) => existsSync(p))
    return present
      ? { ok: true, note: 'login artifacts present' }
      : { ok: false, note: 'no Claude login artifacts found (~/.claude.json / ~/.claude/.credentials.json)' }
  },
  codex: () => {
    const path = join(home(), '.codex', 'auth.json')
    return existsSync(path)
      ? { ok: true, note: 'auth.json present (validity verified at call time)' }
      : { ok: false, note: '~/.codex/auth.json missing — run "codex login"' }
  },
  acp: () => ({ ok: true, note: 'no auth required' }),
}
