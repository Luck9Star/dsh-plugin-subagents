// dsh-plugin-subagents — tool-output lossless-JSON boundary tests (E3 fix).
//
// The 2026-08-15 real-machine smoke run failed EVERY subagent_progress /
// subagent_wait call with
//   Error: tool "subagent_progress" returned invalid output:
//   value is not lossless JSON
// Root cause (pinned here as a regression): dsh-tools validates each tool's
// returned value with @deepseek-ai/dsh-session's snapshotJsonValue, which
// REJECTS any value with an own enumerable property whose value is
// `undefined` (also non-plain objects, Symbol keys, sparse arrays, non-finite
// numbers, -0, cycles, functions). The observability tools built their return
// objects with unconditional keys like `mode: listStatus ?
// listStatus.mode : undefined` — on the common native path (no listing entry,
// no session fold) that object is GUARANTEED to carry undefined properties,
// so every call died at the tool-output boundary.
//
// Coverage:
//   - reproduction: the exact failing shapes (progress native fallback /
//     unknown, wait unknown, trace events without timestamps, roles with
//     optional fields absent, agents children rows with absent fields) must
//     pass snapshotJsonValue — the SAME gate dsh-tools applies in production;
//   - lib/json-safe.js toLosslessJson unit tests: undefined keys dropped,
//     Date→ISO, Map/Set→arrays, Error→{name,message}, cycles, functions/
//     Symbols dropped, bigint→string, -0→0, non-finite→null, class instances
//     → plain copies, sparse arrays → dense;
//   - structural boundary sweep: every tool exit value round-trips
//     JSON.stringify → JSON.parse deep-equal (the delegation tools build
//     lossless values by construction via conditional spreads — asserted, not
//     assumed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import { registerSubagentProgress } from '../lib/tools/subagent-progress.js'
import { registerSubagentWait } from '../lib/tools/subagent-wait.js'
import { registerSubagentRoles } from '../lib/tools/subagent-roles.js'
import { registerSubagentAgents } from '../lib/tools/subagent-agents.js'
import { registerSubagentTool } from '../lib/tools/subagent.js'
import { registerSubagentFork } from '../lib/tools/subagent-fork.js'
import { registerSubagentSubmit } from '../lib/tools/subagent-submit.js'
import { foldProgress, foldTrace, foldTokenUsage } from '../lib/progress.js'
import { toLosslessJson } from '../lib/json-safe.js'

/** The production gate: dsh-tools snapshots every tool return through this. */
function assertLossless(value, label) {
  const snapshot = snapshotJsonValue(value)
  assert.notEqual(
    snapshot,
    undefined,
    `${label}: value is not lossless JSON (own undefined props / exotic shapes are rejected by dsh-tools)`,
  )
  // structural round trip: stringify→parse must reproduce the structure
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value, `${label}: JSON round trip must be structurally equal`)
  return snapshot
}

// ---- shared fakes (same shapes as test/subagent-observability.test.js) ----

const exec = { agent: { session: { id: 'parent-1', header: { cwd: '/tmp' } } }, signal: undefined }

function observCtx({ children = [], listError, sessions } = {}) {
  const tools = new Map()
  const sessionsSvc = sessions ? { get: (id) => sessions[id] } : undefined
  return {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    get: (name) => (name === 'sessions' ? sessionsSvc : undefined),
    on: () => () => {},
    subagents: {
      listChildren: async () => {
        if (listError) throw listError
        return children
      },
    },
    tool: (name) => tools.get(name),
  }
}

function progressAssembled({ snapshots = {}, bindings = new Map() } = {}) {
  const spawn = {
    id: 'native:spawn',
    kind: 'native',
    async progress(childId) {
      return snapshots[childId] || { childId, status: 'unknown' }
    },
  }
  return {
    native: { spawn, fork: spawn },
    bridges: new Map(),
    availability: {},
    state: { bindings, registry: new Map(), liveChildren: new Set() },
  }
}

const T0 = 1700000000000

// ---- reproduction tests (E3): these MUST pass the production gate ---------

test('progress native fallback path returns lossless JSON (was: value is not lossless JSON)', async () => {
  const assembled = progressAssembled({
    snapshots: { 'c-native': { childId: 'c-native', status: 'inactive', label: 'helper' } },
  })
  const ctx = observCtx({ listError: new Error('listing unavailable') })
  registerSubagentProgress(ctx, { assembled, foldProgress, foldTrace, foldTokenUsage })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-native' }, exec)
  assert.equal(out.status, 'inactive')
  assertLossless(out, 'progress native fallback')
})

test('progress unknown-child path returns lossless JSON', async () => {
  const ctx = observCtx({ children: [] })
  registerSubagentProgress(ctx, { assembled: progressAssembled(), foldProgress, foldTrace, foldTokenUsage })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'ghost' }, exec)
  assert.equal(out.status, 'unknown')
  assertLossless(out, 'progress unknown')
})

test('progress bridge path returns lossless JSON even with unset optional fields', async () => {
  const bindings = new Map()
  bindings.set('c-bridge', {
    product: 'codex',
    // no remote id yet, no settings, and an idle progress record whose
    // busySince is explicitly undefined (the ACP/claude bridges write that).
    remote: { threadId: undefined, sessionId: undefined, progress: { busySince: undefined, stage: 'idle' } },
    settings: undefined,
  })
  const assembled = progressAssembled({ bindings })
  const ctx = observCtx({
    children: [{ id: 'c-bridge', activity: 'inactive', mode: undefined, label: undefined, hasChildren: false }],
    sessions: { 'c-bridge': { events: [] } },
  })
  registerSubagentProgress(ctx, { assembled, foldProgress, foldTrace, foldTokenUsage })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-bridge' }, exec)
  assert.equal(out.status, 'inactive')
  assertLossless(out, 'progress bridge idle')
})

test('progress trace entries without timestamps stay lossless (at: undefined was rejected)', async () => {
  const assembled = progressAssembled({
    snapshots: { 'c-native': { childId: 'c-native', status: 'running' } },
  })
  const ctx = observCtx({
    children: [{ id: 'c-native', activity: 'running' }],
    sessions: {
      // compactEvent produces { at: safeIso(undefined) → undefined, ... } for
      // events without a timestamp — an undefined property INSIDE the trace
      // array, which the snapshotter rejects just the same.
      'c-native': { events: [
        { type: 'turn/start', payload: { turn: 1 } },
        { type: 'step/start', timestamp: T0, payload: { turn: 1, step: 1 } },
      ] },
    },
  })
  registerSubagentProgress(ctx, { assembled, foldProgress, foldTrace, foldTokenUsage })
  const out = await ctx.tool('subagent_progress').execute({ subagent_id: 'c-native' }, exec)
  assert.equal(out.trace.length, 2)
  assertLossless(out, 'progress untimed trace')
})

test('wait unknown/timeout paths return lossless JSON', async () => {
  const ctx = observCtx({ children: [] })
  registerSubagentWait(ctx, { foldProgress, foldTrace })
  const unknown = await ctx.tool('subagent_wait').execute({ subagent_id: 'nope', timeout_ms: 1000 }, exec)
  assert.equal(unknown.status, 'unknown')
  assertLossless(unknown, 'wait unknown')

  const live = observCtx({ children: [{ id: 'c1', activity: 'active' }] })
  registerSubagentWait(live, { foldProgress, foldTrace })
  const timedOut = await live.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 1000 }, exec)
  assert.equal(timedOut.status, 'timeout')
  assertLossless(timedOut, 'wait timeout')
})

test('wait settled child with no answer returns lossless JSON', async () => {
  const ctx = observCtx({ children: [{ id: 'c1', activity: 'inactive' }] })
  registerSubagentWait(ctx, { foldProgress, foldTrace })
  const out = await ctx.tool('subagent_wait').execute({ subagent_id: 'c1', timeout_ms: 1000 }, exec)
  assert.equal(out.status, 'ready')
  assertLossless(out, 'wait ready (no fold, no answer)')
})

test('roles with optional fields absent return lossless JSON', async () => {
  const ctx = observCtx()
  registerSubagentRoles(ctx, {
    roles: {
      list: () => [
        // a minimal role file: permissionMode/allowDelegation omitted → the
        // tool must not emit undefined-valued keys for them
        { id: 'bare', description: 'Minimal role', backend: '' },
      ],
    },
  })
  const out = await ctx.tool('subagent_roles').execute({}, exec)
  assert.equal(out.roles[0].id, 'bare')
  assertLossless(out, 'roles minimal')
})

test('agents children rows with absent mode/label stay lossless', async () => {
  const assembled = {
    native: {
      spawn: { id: 'native:spawn', kind: 'native', available: () => ({ registered: true, reason: 'spawn registered' }) },
      fork: { id: 'native:fork', kind: 'native', available: () => ({ registered: true, reason: 'fork registered' }) },
    },
    bridges: new Map(),
    availability: { codex: { registered: false, command: false, reason: 'not on PATH', auth: { ok: false, note: 'none' } } },
    state: { bindings: new Map(), registry: new Map(), liveChildren: new Set() },
  }
  const ctx = observCtx({ children: [{ id: 'c1', activity: 'running' /* no mode, no label */ }] })
  registerSubagentAgents(ctx, { assembled })
  const out = await ctx.tool('subagent_agents').execute({}, exec)
  assert.equal(out.children[0].id, 'c1')
  assertLossless(out, 'agents sparse child row')
})

// ---- toLosslessJson unit tests ---------------------------------------------

test('toLosslessJson drops undefined-valued keys and undefined array items become null', () => {
  const out = toLosslessJson({ a: 1, b: undefined, keep: { nested: undefined, x: 'y' }, arr: [1, undefined, 2] })
  assert.deepEqual(out, { a: 1, keep: { x: 'y' }, arr: [1, null, 2] })
  assertLossless(out, 'undefined dropping')
})

test('toLosslessJson converts Date to ISO, Map/Set to arrays, Error to {name,message}', () => {
  const date = new Date(T0)
  const out = toLosslessJson({
    at: date,
    map: new Map([['k', 1], ['m', { deep: true }]]),
    set: new Set([1, 2]),
    err: Object.assign(new Error('boom'), { stack: 'STACK' }),
  })
  assert.equal(out.at, new Date(T0).toISOString())
  assert.deepEqual(out.map, [['k', 1], ['m', { deep: true }]])
  assert.deepEqual(out.set, [1, 2])
  assert.deepEqual(out.err, { name: 'Error', message: 'boom' })
  assertLossless(out, 'Date/Map/Set/Error conversion')
})

test('toLosslessJson is cycle-safe (repeated + circular references)', () => {
  const shared = { id: 'shared' }
  const root = { a: shared, b: shared }
  root.self = root
  const out = toLosslessJson(root)
  assert.equal(out.a.id, 'shared')
  assert.equal(out.self, '[Circular]')
  assertLossless(out, 'cyclic structure')
})

test('toLosslessJson drops functions/Symbols, stringifies bigint, normalizes numbers', () => {
  const sym = Symbol('s')
  const out = toLosslessJson({
    fn: () => 1,
    [sym]: 'symbol-keyed',
    keep: 'v',
    big: 10n,
    negZero: -0,
    nan: NaN,
    inf: Infinity,
  })
  assert.deepEqual(out, { keep: 'v', big: '10', negZero: 0, nan: null, inf: null })
  assert.ok(Object.is(out.negZero, 0))
  assertLossless(out, 'function/symbol/bigint/number normalization')
})

test('toLosslessJson plain-copies class instances and densifies sparse arrays', () => {
  class Thing {
    constructor() { this.name = 'thing'; this.map = new Map([['a', 1]]) }
    method() {} // prototype method: must not leak (functions are dropped)
  }
  const sparse = [1, , 3] // hole at index 1
  sparse.extra = 'own-prop-on-array'
  const out = toLosslessJson({ thing: new Thing(), sparse })
  assert.deepEqual(out.thing, { name: 'thing', map: [['a', 1]] })
  assert.deepEqual(out.sparse, [1, null, 3])
  assertLossless(out, 'class instance + sparse array')
})

test('toLosslessJson keeps already-lossless values structurally identical', () => {
  const value = { childId: 'c1', status: 'running', trace: [{ at: 'iso', event: 'e', brief: 'b' }], n: 0, b: false, nul: null }
  assert.deepEqual(toLosslessJson(value), value)
  assertLossless(toLosslessJson(value), 'identity on clean values')
})

test('toLosslessJson survives a throwing getter', () => {
  const hostile = {}
  Object.defineProperty(hostile, 'boom', {
    enumerable: true,
    get() { throw new Error('getter threw') },
  })
  hostile.safe = 1
  const out = toLosslessJson(hostile)
  assert.equal(out.safe, 1)
  assert.equal('boom' in out, false)
  assertLossless(out, 'throwing getter')
})

// ---- delegation tool boundary (lossless by construction — asserted) --------

function delegationCtx() {
  const tools = new Map()
  return {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      get: (name) => tools.get(name),
    },
    tool: (name) => tools.get(name),
  }
}

function delegationAssembled(outcome) {
  const driver = {
    id: 'native:spawn',
    kind: 'native',
    capabilities: { perCallProvider: true, perCallModel: true, perCallPersona: true, perCallToolFilter: true, perCallCwd: true, background: true },
    available: () => ({ registered: true, reason: 'registered' }),
    async start() { return outcome },
  }
  return {
    native: { spawn: driver, fork: driver },
    bridges: new Map(),
    availability: {},
    state: {
      bindings: new Map(),
      registry: new Map(),
      liveChildren: new Set(),
      persistRemote: () => {},
      cancelDispose: () => {},
    },
    providerBridges: {},
  }
}

const ALL_ROLES = {
  list: () => [{ id: 'general', description: 'general', backend: '', permissionMode: 'full', allowDelegation: true }],
  get: (id) => (id === 'general' ? { id: 'general', description: 'general', backend: '', permissionMode: 'full', allowDelegation: true } : null),
}

test('subagent / subagent_fork returns are lossless on all three outcome kinds', async () => {
  const outcomes = [
    { kind: 'foreground', runId: 'r1', output: [{ type: 'text', text: 'done' }], stopReason: 'completed' },
    { kind: 'foreground', runId: 'r2', output: [{ type: 'text', text: 'no stop reason' }] },
    { kind: 'continuable', childId: 'child-1', backend: 'native:spawn' },
  ]
  for (const outcome of outcomes) {
    const ctx = delegationCtx()
    registerSubagentTool(ctx, { assembled: delegationAssembled(outcome), roles: ALL_ROLES, config: { backgroundMode: 'one-shot' } })
    const out = await ctx.tool('subagent').execute({ description: 'd', prompt: 'p', run_in_background: false }, exec)
    assertLossless(out, `subagent outcome ${outcome.kind}`)
  }
  const ctx = delegationCtx()
  registerSubagentFork(ctx, { assembled: delegationAssembled({ kind: 'foreground', runId: 'r', output: [{ type: 'text', text: 'forked' }] }), roles: ALL_ROLES, config: { backgroundMode: 'one-shot' } })
  const forkOut = await ctx.tool('subagent_fork').execute({ description: 'd', prompt: 'p', run_in_background: false }, exec)
  assertLossless(forkOut, 'subagent_fork foreground')
})
