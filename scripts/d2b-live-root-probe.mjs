// D2b live-root re-verification probe v2 (repo edition, one-shot).
//
// 用途：D2b 修复（relay 回合闭环：MAJOR-1 冷恢复两 epoch 归零、BLOCKER-1
//   installer disposer 的 contribution 移除路径）的 live-root 复证 probe。
//   兼作 dsh 升级漂移告警——锚点（`SubagentActivationSetupRegistry` class
//   起止、`function isRemoved`)在升级后的 live bundle 中缺失即 loud fail。
// 运行方式：
//   node scripts/d2b-live-root-probe.mjs
//   期望结果：22 PASS / 0 FAIL（进程以非零退出码反映 FAIL）。
//   运行依赖动态解析 live harness root（DSH_HARNESS_ROOT 或 `which dsh` 的
//   realpath 就近 `node_modules` ascend）与本仓真实模块，二者皆应可用。
// 输出：一次性 stdout。持久证据以仓库测试套件与本文件的可重复执行性为准；
//   如需留存输出可 `node scripts/d2b-live-root-probe.mjs | tee /tmp/…`。
//
// Re-verifies the review's two findings AFTER the fixes, using:
//   - the REAL SubagentActivationSetupRegistry implementation, extracted
//     VERBATIM from the live root's dsh-subagent bundle (the class is not
//     exported, so we slice it out of lib/index.js by exact anchors and
//     run it in a vm — any live-root drift fails loudly);
//   - the plugin repo's REAL createRegistry / createBridgeState /
//     attachBridgeLifecycle / attachRelayGuard / RELAY_GUARD_REASON.
//
// Scenario A (MAJOR-1, reviewer's exact sequence):
//   epoch1 forwards once → binding dropped, registry entry kept (cold
//   resume) → new subagent/start → epoch2 counter is ZERO → zero-submit
//   report DENIED (RELAY_GUARD_REASON text) → subagent/end FIRES THE WARN →
//   a late submit then lets the report pass.
//
// Scenario B (BLOCKER-1, reviewer's exact sequence):
//   real SetupRegistry registers attachRelayGuard's contribution → the
//   installer returns a FUNCTION (disposer) → CALLING the disposer
//   invalidates the guard → the child-scope release path (contribution
//   removal → releaseAll → installation.dispose()) does NOT throw
//   "installation.dispose is not a function".
//   Plus a sensitivity negative control: an installer returning undefined
//   DOES throw on that same path (the original BLOCKER-1 failure mode).
import { readFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// ── dynamic live-root resolution (red line 11; same algorithm as
//    patches/resolve-root.sh resolve_live_root) ───────────────────────────────
// (1) DSH_HARNESS_ROOT explicit override (self-verified below);
// (2) `which dsh` (win32 `where dsh`) → realpath → ascend to the first
//     `node_modules` NAMED directory; that node_modules' parent is the root.
// Self-verification: <root>/node_modules/@deepseek-ai/dsh-subagent must exist.
function liveRootResolve() {
  const anchor = 'node_modules/@deepseek-ai/dsh-subagent'
  if (process.env.DSH_HARNESS_ROOT) return process.env.DSH_HARNESS_ROOT
  let bin = null
  try {
    bin = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
      .split(/\r?\n/)[0].trim()
  } catch { bin = null }
  if (!bin) throw new Error(
    `d2b probe: \`${process.platform === 'win32' ? 'where' : 'which'} dsh\` found no dsh on PATH. ` +
    'Resolve the live root one of two ways then rerun: ' +
    '(1) export DSH_HARNESS_ROOT=<root> where <root>/node_modules/@deepseek-ai/dsh-subagent exists; ' +
    'or (2) have `dsh` on PATH inside its npx/global install and rerun.')
  let real
  try { real = realpathSync(bin) } catch (e) {
    throw new Error(`d2b probe: cannot canonicalize the dsh binary at '${bin}': ${e.message}`)
  }
  let dir = dirname(real)
  let root = null
  while (dir && dir !== '/' && !/^[A-Za-z]:[\\/]?$/.test(dir)) {
    if (dir === 'node_modules' || dir.endsWith('/node_modules') || dir.endsWith('\\node_modules')) {
      root = dirname(dir); break
    }
    dir = dirname(dir)
  }
  if (!root) throw new Error(
    `d2b probe: the running dsh binary '${real}' is not inside a node_modules tree (unexpected install layout)`)
  if (!existsSync(join(root, anchor))) throw new Error(
    `d2b probe: self-verification failed — '${join(root, anchor)}' does not exist; ` +
    'this is not a live dsh harness root. Resolve differently (DSH_HARNESS_ROOT override or a real dsh install on PATH).')
  return root
}
const LIVE_ROOT = liveRootResolve()

// ── repo root from import.meta.url (this file sits in <repo>/scripts/) ───────
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const out = []
const log = (line) => { out.push(line); console.log(line) }
let failures = 0
const check = (label, ok) => { if (!ok) failures += 1; log(`${ok ? 'PASS' : 'FAIL'}  ${label}`) }
console.log(`[probe] resolved LIVE_ROOT dynamically: ${LIVE_ROOT}`)
console.log(`[probe] repo root from import.meta.url: ${REPO}`)

// ── extract the REAL SubagentActivationSetupRegistry from the live root ─────
const bundleSrc = readFileSync(join(LIVE_ROOT, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js'), 'utf8')
const START = 'var SubagentActivationSetupRegistry = class {'
const startIdx = bundleSrc.indexOf(START)
if (startIdx < 0) throw new Error('live-root drift: class start anchor not found')
const endIdx = bundleSrc.indexOf('\n};', startIdx)
if (endIdx < 0) throw new Error('live-root drift: class end anchor not found')
const classSrc = bundleSrc.slice(startIdx, endIdx + 3)
const isRemovedIdx = bundleSrc.indexOf('function isRemoved(registration) {')
if (isRemovedIdx < 0) throw new Error('live-root drift: isRemoved anchor not found')
const isRemovedEnd = bundleSrc.indexOf('\n}', isRemovedIdx)
const isRemovedSrc = bundleSrc.slice(isRemovedIdx, isRemovedEnd + 2)
// the class also references SubagentError + errorChain — faithful stand-ins;
// their only use is error MESSAGE formatting on dispose-failure paths, which
// this probe asserts never run (except the deliberate negative control).
const sandbox = {
  SubagentError: class SubagentError extends Error {},
  errorChain: (e) => String(e && e.message),
}
vm.createContext(sandbox)
vm.runInContext(`${isRemovedSrc}\n${classSrc}\nthis.Ctor = SubagentActivationSetupRegistry;`, sandbox)
const SetupRegistry = sandbox.Ctor
log(`[probe] extracted SubagentActivationSetupRegistry (${classSrc.length} chars) + isRemoved (${isRemovedSrc.length} chars) from the live root (anchors verified)`)

// ── real plugin pieces ───────────────────────────────────────────────────────
const { createRegistry } = await import(join(REPO, 'lib/registry.js'))
const { createBridgeState, attachBridgeLifecycle } = await import(join(REPO, 'lib/drivers/bridge.js'))
const { attachRelayGuard, RELAY_GUARD_REASON } = await import(join(REPO, 'lib/relay-guard.js'))

const regPath = join(tmpdir(), `d2b-probe-${Date.now()}.json`)
const registry = createRegistry(regPath)
const state = createBridgeState({ registry, idleTimeoutMs: 0, pendingStartGuardMs: 60000 })

const bridge = {
  async create() { return { sessionId: 's-probe' } },
  async submit(remote, task) { return { text: `echo:${task}`, stopReason: 'completed' } },
  async reconnect(id) { return { sessionId: id } },
  async dispose() {},
}
state.bindings.set('c-probe', { product: 'fake', bridge, remote: { sessionId: 's-probe' }, settings: undefined })
state.persistRemote('c-probe', { product: 'fake', remote: { sessionId: 's-probe' } }, '/tmp')
const reportExec = { name: 'report', agent: { session: { id: 'c-probe' } } }

// ══ Scenario A (MAJOR-1): two epochs + cold resume, real-registry guard ══════
log('\n── Scenario A (MAJOR-1): epoch1 forwards → cold resume → epoch2 zero-submit report denied → end warn → late submit passes ──')
const warns = []
const listeners = new Map()
const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn) }
const dispatch = (name, info) => { for (const fn of listeners.get(name) || []) fn(info) }
attachBridgeLifecycle({ on, effect: () => {}, logger: { warn: (m) => warns.push(m) } }, state)

// attach the plugin guard through the REAL SetupRegistry, as the host would
const host = new SetupRegistry()
const registerContinuableSetup = (contribution) => host.register(contribution)
check('attachRelayGuard attached on a real-registry host',
  attachRelayGuard({ logger: { warn: () => {} }, subagents: { registerContinuableSetup } }, { state }) === true)

// materialize a child scope: host.apply(childCtx) installs every live
// contribution; commit() publishes. A host child scope carries effect().
const installedFns = new Set()
const installerReturns = []
const childCtx = {
  tools: { guard: (fn) => { installedFns.add(fn); const d = () => { installedFns.delete(fn) }; installerReturns.push(d); return d } },
  effect: () => () => {},
}
host.apply(childCtx).commit()
check('exactly one guard fn installed into the child scope', installedFns.size === 1)
const installedGuard = [...installedFns][0]

// epoch 1: start → one submit → report passes → end (no warn)
dispatch('subagent/start', { id: 'c-probe' })
check('epoch1 counter reset to 0 on start', state.relayEpochs.get('c-probe').submits === 0)
state.noteRelaySubmit('c-probe')
check('epoch1 report PASSES after a submit', installedGuard(reportExec) === undefined)
dispatch('subagent/end', { id: 'c-probe' })
check('epoch1 end: no zero-submit warning', warns.length === 0)

// cold resume: binding dropped (idle disposal), registry entry KEPT
state.bindings.delete('c-probe')
check('registry entry survives the binding loss (registry is the recovery source)', registry.get('c-probe') !== undefined)

// epoch 2 (send_message cold resume): the union reset must bring it to 0 …
dispatch('subagent/start', { id: 'c-probe' })
check('epoch2 counter reset to 0 (binding ∪ registry union — MAJOR-1 fix)', state.relayEpochs.get('c-probe').submits === 0)

// … zero-submit report DENIED, reason text verbatim …
const denial = installedGuard(reportExec)
check('epoch2 zero-submit report DENIED by the real-installed guard', denial === RELAY_GUARD_REASON)
log(`       RELAY_GUARD_REASON (first 110 chars): ${JSON.stringify(RELAY_GUARD_REASON.slice(0, 110))}…`)

// … the end event FIRES THE WARN for the zero-submit epoch …
dispatch('subagent/end', { id: 'c-probe' })
check('epoch2 end WARNED (zero subagent_submit)', warns.length === 1 && warns[0].includes('zero subagent_submit'))
check('noForward flag recorded for observability', state.lastRelayEpochNoForward('c-probe') === true)

// … a late submit then lets the report pass (lazy {submits:1})
state.noteRelaySubmit('c-probe')
check('report PASSES after a late submit', installedGuard(reportExec) === undefined)

// ══ Scenario B (BLOCKER-1): disposer contract on the real registry ══════════
log('\n── Scenario B (BLOCKER-1): installer returns a disposer → calling it invalidates the guard → release path does not throw ──')

// B1 — the reviewer's exact sequence on a fresh real registry + child scope
const host2 = new SetupRegistry()
const undo2Ref = { undo: null }
const register2 = (contribution) => { undo2Ref.undo = host2.register(contribution); return undo2Ref.undo }
check('attachRelayGuard attached on host2',
  attachRelayGuard({ logger: { warn: () => {} }, subagents: { registerContinuableSetup: register2 } }, { state }) === true)
const fns2 = new Set()
let installerReturn2 = null
const childCtx2 = {
  tools: { guard: (fn) => { fns2.add(fn); const d = () => { fns2.delete(fn) }; installerReturn2 = d; return d } },
  effect: () => () => {},
}
host2.apply(childCtx2).commit()
check('host2: guard installed into the child scope', fns2.size === 1)
check('host2: the contribution/installer returned a FUNCTION (disposer)', typeof installerReturn2 === 'function')
state.noteRelayEpochStart('c-probe') // zero the counter so the guard must intercept
check('host2: guard INTERCEPTS before disposal (RELAY_GUARD_REASON)', [...fns2][0](reportExec) === RELAY_GUARD_REASON)
installerReturn2()
check('host2: CALLING the installer-returned disposer invalidates the guard (unregistered)', fns2.size === 0)

// B2 — the child-scope release path (contribution removal → releaseAll →
// installation.dispose()) on a fresh installation, un-confounded by B1
const host4 = new SetupRegistry()
let undo4 = null
const register4 = (contribution) => { undo4 = host4.register(contribution); return undo4 }
check('attachRelayGuard attached on host4',
  attachRelayGuard({ logger: { warn: () => {} }, subagents: { registerContinuableSetup: register4 } }, { state }) === true)
const fns4 = new Set()
let installerReturn4 = null
const childCtx4 = {
  tools: { guard: (fn) => { fns4.add(fn); const d = () => { fns4.delete(fn) }; installerReturn4 = d; return d } },
  effect: () => () => {},
}
host4.apply(childCtx4).commit()
check('host4: guard installed', fns4.size === 1)
check('host4: installer returned a FUNCTION (disposer)', typeof installerReturn4 === 'function')
let releaseThrew = null
try {
  undo4() // contribution removal → releaseAll → installation.dispose()
} catch (e) {
  releaseThrew = e
}
check('host4: release path does NOT throw (no "installation.dispose is not a function")', releaseThrew === null)
check('host4: guard unregistered after the release', fns4.size === 0)
if (releaseThrew) log(`       release error was: ${releaseThrew.message}`)

// B3 — sensitivity negative control: an installer returning undefined DOES
// throw on the very same path (the original BLOCKER-1 failure mode — proves
// this probe can see it, so the PASS above is meaningful)
const host3 = new SetupRegistry()
const undo3 = host3.register(() => undefined)
const ctx3 = { tools: {}, effect: () => () => {} }
host3.apply(ctx3).commit()
let undefinedInstallerThrew = false
try { undo3() } catch { undefinedInstallerThrew = true }
check('negative control: an undefined-returning installer DOES throw on removal (probe sensitivity)', undefinedInstallerThrew)

const passCount = out.filter((l) => l.startsWith('PASS')).length
log(`\n[probe] ${passCount} PASS / ${failures} FAIL`)
rmSync(regPath, { force: true })
rmSync(`${regPath}.tmp`, { force: true })
process.exit(failures ? 1 : 0)
