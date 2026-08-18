// T16 — install/verify/uninstall patch scripts + live-root resolution +
// behavioral probe, exercised EXCLUSIVELY on fake directory trees via
// DSH_HARNESS_ROOT / DSH_PLUGIN_ROOT / DSH_HOME overrides. The real live dsh
// install (~/.npm/_npx/<hash>), the real ~/.dsh, and this repo's own
// node_modules are NEVER touched by this suite (real-machine acceptance is
// T19's job, run by the main session).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const PATCHES = join(REPO, 'patches')
const INSTALL = join(PATCHES, 'install.sh')
const VERIFY = join(PATCHES, 'verify.sh')
const UNINSTALL = join(PATCHES, 'uninstall.sh')
const RESOLVE_ROOT = join(PATCHES, 'resolve-root.sh')
const PROBE = join(PATCHES, 'probe-cwd.mjs')

// ------------------------------------------------------------ fixtures ------

function writeIf(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function pkgJson(name, version) {
  // Real @deepseek-ai packages ship `"type": "module"` — without it node < 22
  // parses the fixture ESM libs as CJS (`Unexpected token 'export'`); node 22+
  // only gets away via default module syntax detection.
  return `${JSON.stringify({ name, version, type: 'module' }, null, 2)}\n`
}

// Legal-JS stand-ins for the two patch targets. The anchor/marker lines are
// byte-identical to the real rc.6 hunks (tab counts included) — that is the
// whole point of these fixtures.
const DRIVER_META_ANCHOR = '\t\tmeta: childSessionMeta(parent, childDepth, activationBoundary),'
const DRIVER_PATCHED_LINES = [
  '\t\tmeta: {',
  '\t\t\t...childSessionMeta(parent, childDepth, activationBoundary),',
  '\t\t\t...request.cwd !== void 0 ? { cwd: request.cwd } : {}',
  '\t\t},',
]
const BUNDLE_META_ANCHOR = '\t\t\t\t\t\tmeta: childSessionMeta(parent, childDepth, lineageSeedLength),'
const BUNDLE_PATCHED_LINES = [
  '\t\t\t\t\t\tmeta: {',
  '\t\t\t\t\t\t\t...childSessionMeta(parent, childDepth, lineageSeedLength),',
  '\t\t\t\t\t\t\t...request.cwd !== void 0 ? { cwd: request.cwd } : {}',
  '\t\t\t\t\t\t},',
]

function driverJs(metaLines, extra = '') {
  return [
    '// fixture stand-in for @deepseek-ai/dsh-subagent-in-process-driver (legal JS)',
    'export async function startInProcessRun(request) {',
    '\tconst parent = request.parent;',
    '\tconst childDepth = 1;',
    '\tconst activationBoundary = 0;',
    '\treturn drivePublishedRun(await parent.ctx.agents.create({',
    "\t\tsessionId: 'child',",
    ...metaLines,
    '\t\tagentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),',
    '\t\tsignal: request.signal',
    "\t}), request.signal, request.prompt, 'child', activationBoundary, undefined);",
    '}',
    extra,
    '',
  ].join('\n')
}

function bundleJs(metaLines, extra = '') {
  return [
    '// fixture stand-in for the @deepseek-ai/dsh-subagent BUNDLE (legal JS)',
    'export class SubagentContinuationManager {',
    '\tasync startContinuable(spec) {',
    '\t\tconst messageId = await this.locks.run(spec.childId, async () => {',
    '\t\t\tconst activation = await this.materialize({',
    '\t\t\t\tchildId: spec.childId,',
    '\t\t\t\tparent: spec.parent,',
    '\t\t\t\tcreate: {',
    '\t\t\t\t\tseed: spec.seed,',
    ...metaLines,
    '\t\t\t\t\tdelegatedPolicies: spec.delegatedPolicies',
    '\t\t\t\t},',
    '\t\t\t\tagentOptions: resolveChildAgentOptions(spec.parent, spec.request.agentOptions, 1)',
    '\t\t\t});',
    '\t\t\treturn messageId;',
    '\t\t});',
    '\t\treturn { childId: spec.childId, messageId };',
    '\t}',
    '}',
    extra,
    '',
  ].join('\n')
}

const DRIVER_VARIANTS = {
  stock: () => driverJs([DRIVER_META_ANCHOR]),
  patched: () => driverJs(DRIVER_PATCHED_LINES),
  drift: () => driverJs(['\t\tmeta: childSessionMeta(parent, childDepth, redesignedBoundary),']),
  // Anti-grep regression sample: stock code with NO anchor but an unrelated
  // `request.cwd` reference elsewhere — must never count as native evidence.
  requestcwd: () => driverJs(
    ['\t\tmeta: childSessionMeta(parent, childDepth, redesignedBoundary),'],
    'export function debugRequestCwd(request) {\n\treturn request.cwd;\n}\n',
  ),
}

const BUNDLE_VARIANTS = {
  stock: () => bundleJs([BUNDLE_META_ANCHOR]),
  patched: () => bundleJs(BUNDLE_PATCHED_LINES),
  drift: () => bundleJs(['\t\t\t\t\t\tmeta: childSessionMeta(parent, childDepth, remasteredLineage),']),
  requestcwd: () => bundleJs(
    ['\t\t\t\t\t\tmeta: childSessionMeta(parent, childDepth, remasteredLineage),'],
    'export function debugRequestCwd(request) {\n\treturn request.cwd;\n}\n',
  ),
}

// Minimal, contract-true stand-ins for the runtime packages the behavioral
// probe drives (the probe's real-path fidelity was verified by hand against a
// real rc.6 root; these fixtures give the tests controlled ground truth).
const MINI_CORDIS = 'export class Context {\n\tconstructor(_options) {}\n}\n'

function miniSubagentRuntimeJs() {
  return [
    '// fixture mini-runtime for the behavioral probe (contract of SubagentRuntime)',
    'export class SubagentRuntime {',
    '\tconstructor(ctx) {',
    '\t\tthis.ctx = ctx;',
    '\t\tthis.providers = new Map();',
    '\t\tctx.subagents = this;',
    '\t}',
    '\tregisterProvider(provider) { this.providers.set(provider.name, provider); }',
    '\tgetProvider(name) { return this.providers.get(name); }',
    '\tasync start(name, request) {',
    '\t\tconst provider = this.providers.get(name);',
    "\t\tif (provider === undefined) throw new Error('no subagent provider registered for ' + name);",
    '\t\treturn provider.start(request);',
    '\t}',
    '}',
    '',
  ].join('\n')
}

function miniSpawnProviderJs(mergesCwd) {
  return [
    '// fixture spawn provider: optional native-style request.cwd merge',
    'export function apply(ctx, config) {',
    '\tctx.subagents.registerProvider({',
    '\t\tname: config.providerName,',
    '\t\tasync start(request) {',
    "\t\t\tconst meta = { parentSession: request.parent.session.header.id };",
    mergesCwd ? '\t\t\tif (request.cwd !== undefined) meta.cwd = request.cwd;' : '\t\t\t/* fixture: does NOT forward request.cwd (stock-like) */',
    "\t\t\tconst handle = await request.parent.ctx.agents.create({ sessionId: 'probe-child', meta });",
    "\t\t\treturn { id: 'probe-child', localAgent: handle.agent, result: Promise.resolve({ output: [], stopReason: 'error' }), dispose: async () => {} };",
    '\t\t}',
    '\t});',
    '}',
    '',
  ].join('\n')
}

/**
 * Fake live harness root + fake plugin package + fake DSH_HOME, all under one
 * mkdtemp base. Every path the scripts touch is inside `base`.
 */
function buildFakeWorld(opts = {}) {
  const {
    dshVersion = '0.1.0-rc.6',
    driver = 'stock',
    bundle = 'stock',
    runtime = false,
    runtimeMergesCwd = true,
    withDshTools = true,
    repoSubagentVersion,
    profileTools = 'real',
  } = opts
  const base = mkdtempSync(join(tmpdir(), 't16-'))
  const root = join(base, 'live')
  const pm = join(root, 'node_modules', '@deepseek-ai')

  writeIf(join(pm, 'dsh/package.json'), pkgJson('@deepseek-ai/dsh', dshVersion))
  const binPath = join(pm, 'dsh/lib/bin.js')
  writeIf(binPath, '#!/usr/bin/env node\nprocess.exit(0);\n')
  chmodSync(binPath, 0o755)
  writeIf(join(pm, 'dsh-subagent/package.json'), pkgJson('@deepseek-ai/dsh-subagent', dshVersion))
  writeIf(join(pm, 'dsh-subagent/lib/index.js'), runtime ? miniSubagentRuntimeJs() : BUNDLE_VARIANTS[bundle]())
  writeIf(join(pm, 'dsh-subagent-in-process-driver/package.json'), pkgJson('@deepseek-ai/dsh-subagent-in-process-driver', dshVersion))
  writeIf(join(pm, 'dsh-subagent-in-process-driver/lib/index.js'), DRIVER_VARIANTS[driver]())
  if (withDshTools) writeIf(join(pm, 'dsh-tools/package.json'), pkgJson('@deepseek-ai/dsh-tools', dshVersion))
  if (runtime) {
    writeIf(join(pm, 'cordis/package.json'), pkgJson('@deepseek-ai/cordis', '4.0.1'))
    writeIf(join(pm, 'cordis/lib/index.js'), MINI_CORDIS)
    writeIf(join(pm, 'dsh-subagent-spawn-in-process/package.json'), pkgJson('@deepseek-ai/dsh-subagent-spawn-in-process', dshVersion))
    writeIf(join(pm, 'dsh-subagent-spawn-in-process/lib/index.js'), miniSpawnProviderJs(runtimeMergesCwd))
  }

  // Fake plugin package (stamp + repo-side dsh-tools link + dsh-subagent copy
  // for verify check (d)).
  const pkgRoot = join(base, 'pkg')
  mkdirSync(join(pkgRoot, 'patches'), { recursive: true })
  writeIf(join(pkgRoot, 'node_modules/@deepseek-ai/dsh-tools/package.json'), pkgJson('@deepseek-ai/dsh-tools', dshVersion))
  writeIf(
    join(pkgRoot, 'node_modules/@deepseek-ai/dsh-subagent/package.json'),
    pkgJson('@deepseek-ai/dsh-subagent', repoSubagentVersion ?? dshVersion),
  )

  // Fake DSH_HOME with one profile whose dsh-tools is an entity copy, a
  // wrong-root link, the correct link, or absent.
  const home = join(base, 'home')
  const profileToolsPath = join(home, 'profiles/web/node_modules/@deepseek-ai/dsh-tools')
  if (profileTools === 'real') {
    writeIf(join(profileToolsPath, 'package.json'), pkgJson('@deepseek-ai/dsh-tools', dshVersion))
  } else if (profileTools === 'correct') {
    mkdirSync(dirname(profileToolsPath), { recursive: true })
    symlinkSync(join(root, 'node_modules/@deepseek-ai/dsh-tools'), profileToolsPath)
  } else if (profileTools === 'wrong') {
    const other = join(base, 'other/node_modules/@deepseek-ai/dsh-tools')
    writeIf(join(other, 'package.json'), pkgJson('@deepseek-ai/dsh-tools', dshVersion))
    mkdirSync(dirname(profileToolsPath), { recursive: true })
    symlinkSync(other, profileToolsPath)
  }

  // install.sh links to the CANONICAL live root (realpath); mirror that here
  // (macOS tmpdir lives behind the /var -> /private/var symlink).
  const expectedTools = join(realpathSync(root), 'node_modules/@deepseek-ai/dsh-tools')
  return { base, root, pkgRoot, home, expectedTools }
}

function runScript(script, args, extraEnv = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
}

/** Run a one-liner in bash with the library sourced (`resolve_live_root` etc.). */
function runLib(command, extraEnv = {}) {
  return spawnSync('/bin/bash', ['-c', `source '${RESOLVE_ROOT}' && ${command}`], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
}

function installRun(world, args = [], extraEnv = {}) {
  return runScript(INSTALL, args, {
    DSH_HARNESS_ROOT: world.root,
    DSH_PLUGIN_ROOT: world.pkgRoot,
    DSH_HOME: world.home,
    ...extraEnv,
  })
}

function verifyRun(world, args = [], extraEnv = {}) {
  return runScript(VERIFY, args, {
    DSH_HARNESS_ROOT: world.root,
    DSH_PLUGIN_ROOT: world.pkgRoot,
    DSH_HOME: world.home,
    ...extraEnv,
  })
}

function uninstallRun(world, extraEnv = {}) {
  return runScript(UNINSTALL, [], {
    DSH_HARNESS_ROOT: world.root,
    DSH_PLUGIN_ROOT: world.pkgRoot,
    DSH_HOME: world.home,
    ...extraEnv,
  })
}

function driverTarget(world) {
  return join(world.root, 'node_modules/@deepseek-ai/dsh-subagent-in-process-driver/lib/index.js')
}
function bundleTarget(world) {
  return join(world.root, 'node_modules/@deepseek-ai/dsh-subagent/lib/index.js')
}
function stampPath(world) {
  return join(world.pkgRoot, 'patches/.applied')
}
function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`
}
function cleanup(world) {
  rmSync(world.base, { recursive: true, force: true })
}

// ------------------------------------------------------ resolve_live_root ----

test('resolve_live_root: DSH_HARNESS_ROOT override resolves, canonicalizes, self-verifies', () => {
  const world = buildFakeWorld()
  try {
    const result = runLib('resolve_live_root', {
      DSH_HARNESS_ROOT: world.root,
    })
    assert.equal(result.status, 0, outputOf(result))
    assert.equal(result.stdout.trim(), realpathSync(world.root))
  } finally {
    cleanup(world)
  }
})

test('resolve_live_root: command -v dsh → realpath → upward walk to node_modules parent', () => {
  const world = buildFakeWorld()
  try {
    // <base>/live/node_modules/.bin/dsh -> ../@deepseek-ai/dsh/lib/bin.js (relative),
    // plus an outer <base>/shim/dsh -> the .bin link (two symlink hops).
    const dotBin = join(world.root, 'node_modules/.bin')
    mkdirSync(dotBin, { recursive: true })
    symlinkSync('../@deepseek-ai/dsh/lib/bin.js', join(dotBin, 'dsh'))
    const shimDir = join(world.base, 'shim')
    mkdirSync(shimDir, { recursive: true })
    symlinkSync(join(dotBin, 'dsh'), join(shimDir, 'dsh'))

    const result = runLib('resolve_live_root', {
      PATH: `${shimDir}:${process.env.PATH}`,
      DSH_HARNESS_ROOT: '',
    })
    assert.equal(result.status, 0, outputOf(result))
    assert.equal(result.stdout.trim(), realpathSync(world.root))
  } finally {
    cleanup(world)
  }
})

test('resolve_live_root: loud failure when the self-verification package is missing', () => {
  const world = buildFakeWorld()
  try {
    rmSync(join(world.root, 'node_modules/@deepseek-ai/dsh-subagent'), { recursive: true, force: true })
    const result = runLib('resolve_live_root', {
      DSH_HARNESS_ROOT: world.root,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /self-verification failed/)
    // the loud error names the three supported forms (override included)
    assert.match(result.stderr, /DSH_HARNESS_ROOT/)
    assert.match(result.stderr, /npx cache install/)
    assert.match(result.stderr, /npm install -g|global/)
  } finally {
    cleanup(world)
  }
})

test('resolve_live_root: loud failure when dsh is not on PATH', () => {
  const world = buildFakeWorld()
  try {
    const emptyBin = join(world.base, 'empty-bin')
    mkdirSync(emptyBin, { recursive: true })
    const result = runLib('resolve_live_root', {
      PATH: emptyBin,
      DSH_HARNESS_ROOT: '',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no dsh executable on PATH/)
  } finally {
    cleanup(world)
  }
})

test('resolve_live_root: loud failure when the dsh binary is outside any node_modules tree', () => {
  const world = buildFakeWorld()
  try {
    const looseDir = join(world.base, 'loose')
    writeIf(join(looseDir, 'dsh'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(looseDir, 'dsh'), 0o755)
    const result = runLib('resolve_live_root', {
      PATH: `${looseDir}:${process.env.PATH}`,
      DSH_HARNESS_ROOT: '',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not inside a node_modules tree/)
  } finally {
    cleanup(world)
  }
})

// --------------------------------------------------------- state machine ----

test('install: state a — applies both patches, .bak_cwd backup, node --check clean, stamp written', () => {
  const world = buildFakeWorld()
  try {
    const driverBefore = readFileSync(driverTarget(world), 'utf8')
    const bundleBefore = readFileSync(bundleTarget(world), 'utf8')

    const result = installRun(world)
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /\[patch\] applied:/)

    const driverAfter = readFileSync(driverTarget(world), 'utf8')
    const bundleAfter = readFileSync(bundleTarget(world), 'utf8')
    assert.ok(driverAfter.includes('...request.cwd !== void 0 ? { cwd: request.cwd } : {}'))
    assert.ok(bundleAfter.includes('...request.cwd !== void 0 ? { cwd: request.cwd } : {}'))
    assert.ok(!driverAfter.includes(DRIVER_META_ANCHOR), 'stock anchor must be consumed by the replacement')
    assert.ok(!bundleAfter.includes(BUNDLE_META_ANCHOR), 'stock anchor must be consumed by the replacement')
    assert.equal(readFileSync(`${driverTarget(world)}.bak_cwd`, 'utf8'), driverBefore)
    assert.equal(readFileSync(`${bundleTarget(world)}.bak_cwd`, 'utf8'), bundleBefore)

    // the patched products must still be parseable JS
    for (const target of [driverTarget(world), bundleTarget(world)]) {
      const check = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
      assert.equal(check.status, 0, check.stderr)
    }

    // stamp shape — exactly what lib/drivers/native.js assertsCwdPatchesTrusted reads
    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.dshVersion, '0.1.0-rc.6')
    assert.equal(stamp.liveRoot, realpathSync(world.root))
    assert.equal(typeof stamp.appliedAt, 'string')
    assert.equal(stamp.patches.inProcessDriver, 'applied')
    assert.equal(stamp.patches.subagentBundle, 'applied')
    assert.equal(typeof stamp.mtimes.inProcessDriver, 'string')
    assert.equal(typeof stamp.mtimes.subagentBundle, 'string')
    assert.equal(stamp.links['plugin-repo'], 'fixed')
    assert.equal(stamp.links['profile:web'], 'fixed')
  } finally {
    cleanup(world)
  }
})

test('install: state b — second run is idempotent and leaves content untouched', () => {
  const world = buildFakeWorld()
  try {
    assert.equal(installRun(world).status, 0)
    const afterFirst = readFileSync(driverTarget(world), 'utf8')
    const bakFirst = readFileSync(`${driverTarget(world)}.bak_cwd`, 'utf8')

    const second = installRun(world)
    assert.equal(second.status, 0, outputOf(second))
    assert.match(second.stdout, /already applied \(idempotent\)/)
    assert.equal(readFileSync(driverTarget(world), 'utf8'), afterFirst)
    // the pristine stock backup is never overwritten by a second run
    assert.equal(readFileSync(`${driverTarget(world)}.bak_cwd`, 'utf8'), bakFirst)
  } finally {
    cleanup(world)
  }
})

test('install --links-only: stage A only — links fixed, no stamp, targets untouched', () => {
  const world = buildFakeWorld()
  try {
    const before = readFileSync(driverTarget(world), 'utf8')
    const result = installRun(world, ['--links-only'])
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /stage A complete/)
    assert.doesNotMatch(result.stdout, /\[patch\]/)
    assert.equal(existsSync(stampPath(world)), false, '--links-only must not write a stamp')
    assert.equal(readFileSync(driverTarget(world), 'utf8'), before)
    assert.ok(lstatSync(join(world.pkgRoot, 'node_modules/@deepseek-ai/dsh-tools')).isSymbolicLink())
  } finally {
    cleanup(world)
  }
})

test('install: stage A failure exits non-zero immediately, before any patching', () => {
  const world = buildFakeWorld({ withDshTools: false })
  try {
    const before = readFileSync(driverTarget(world), 'utf8')
    const result = installRun(world)
    assert.equal(result.status, 1, outputOf(result))
    assert.match(result.stderr, /dsh-tools package is missing/)
    assert.equal(readFileSync(driverTarget(world), 'utf8'), before, 'stage B must not run after stage A fails')
    assert.equal(existsSync(stampPath(world)), false)
  } finally {
    cleanup(world)
  }
})

test('install: state d1 — anchor drift with an EMPTY whitelist fails loud, stage A already done', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', dshVersion: '0.1.0-rc.9' })
  try {
    const result = installRun(world)
    assert.equal(result.status, 3, outputOf(result))
    assert.match(outputOf(result), /drift-anchor/)
    assert.match(outputOf(result), /NEWER PLUGIN RELEASE/)
    // the d1 remediation is distinct from d2's
    assert.doesNotMatch(outputOf(result), /unverified-native/)
    // A 段已完成 note
    assert.match(outputOf(result), /Stage A \(dsh-tools links\) already completed/)
    // stage A really did complete: both links point at the fake live root
    assert.equal(readlinkSync(join(world.pkgRoot, 'node_modules/@deepseek-ai/dsh-tools')), world.expectedTools)
    assert.equal(readlinkSync(join(world.home, 'profiles/web/node_modules/@deepseek-ai/dsh-tools')), world.expectedTools)

    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.patches.inProcessDriver, 'drift-anchor')
    assert.equal(stamp.patches.subagentBundle, 'drift-anchor')
    assert.equal(stamp.dshVersion, '0.1.0-rc.9')
  } finally {
    cleanup(world)
  }
})

test('install: anti-grep regression — unrelated stock request.cwd text is NOT native evidence', () => {
  const world = buildFakeWorld({ driver: 'requestcwd', bundle: 'requestcwd', dshVersion: '0.1.0-rc.9' })
  try {
    const result = installRun(world)
    assert.equal(result.status, 3, outputOf(result))
    assert.doesNotMatch(outputOf(result), /\[patch\] native-verified/)
    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.patches.inProcessDriver, 'drift-anchor')
    assert.equal(stamp.patches.subagentBundle, 'drift-anchor')
  } finally {
    cleanup(world)
  }
})

test('install: whitelist hit alone never grants native (probe not executable → d2)', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', dshVersion: '9.9.9-native' })
  try {
    const result = installRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(result.status, 3, outputOf(result))
    assert.match(outputOf(result), /unverified-native/)
    assert.match(outputOf(result), /verify\.sh --probe/)
    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.patches.inProcessDriver, 'unverified-native')
    assert.equal(stamp.patches.subagentBundle, 'unverified-native')
  } finally {
    cleanup(world)
  }
})

test('install: mixed states judge each patch independently (applied + native-verified)', () => {
  const world = buildFakeWorld({
    driver: 'stock',
    bundle: 'drift', // replaced by the mini runtime below
    runtime: true,
    runtimeMergesCwd: true,
    dshVersion: '9.9.9-native',
  })
  try {
    const result = installRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /\[patch\] applied:/)
    assert.match(result.stdout, /native-verified/)
    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.patches.inProcessDriver, 'applied')
    assert.equal(stamp.patches.subagentBundle, 'native-verified')
  } finally {
    cleanup(world)
  }
})

test('install: state c — whitelist + probe PASS → no-op + stamp native-verified, targets untouched', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', runtime: true, runtimeMergesCwd: true, dshVersion: '9.9.9-native' })
  try {
    const driverBefore = readFileSync(driverTarget(world), 'utf8')
    const result = installRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /native-verified/)
    // no-op: no backup, no modification
    assert.equal(readFileSync(driverTarget(world), 'utf8'), driverBefore)
    assert.equal(existsSync(`${driverTarget(world)}.bak_cwd`), false)
    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.patches.inProcessDriver, 'native-verified')
    assert.equal(stamp.patches.subagentBundle, 'native-verified')
  } finally {
    cleanup(world)
  }
})

test('install: state d2 — whitelist hit + probe FAIL (forwarding absent) keeps d1 wording out', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', runtime: true, runtimeMergesCwd: false, dshVersion: '9.9.9-native' })
  try {
    const result = installRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(result.status, 3, outputOf(result))
    assert.match(outputOf(result), /unverified-native/)
    assert.match(outputOf(result), /whitelist mis-entry/)
    // d2's remediation differs from d1's
    assert.doesNotMatch(outputOf(result), /NEWER PLUGIN RELEASE/)
    const stamp = JSON.parse(readFileSync(stampPath(world), 'utf8'))
    assert.equal(stamp.patches.inProcessDriver, 'unverified-native')
    assert.equal(stamp.patches.subagentBundle, 'unverified-native')
  } finally {
    cleanup(world)
  }
})

// ------------------------------------------------------------ probe direct ----

test('probe: PASS — mini runtime forwarding request.cwd exits 0', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', runtime: true, runtimeMergesCwd: true })
  try {
    const result = spawnSync(process.execPath, [PROBE, world.root], { encoding: 'utf8' })
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /VERIFIED/)
  } finally {
    cleanup(world)
  }
})

test('probe: FAIL — mini runtime ignoring request.cwd exits 1 (forwarding not observed)', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', runtime: true, runtimeMergesCwd: false })
  try {
    const result = spawnSync(process.execPath, [PROBE, world.root], { encoding: 'utf8' })
    assert.equal(result.status, 1, outputOf(result))
    assert.match(result.stderr, /NOT forwarded/)
  } finally {
    cleanup(world)
  }
})

test('probe: NOT EXECUTABLE — runtime packages absent exits 2', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift' })
  try {
    const result = spawnSync(process.execPath, [PROBE, world.root], { encoding: 'utf8' })
    assert.equal(result.status, 2, outputOf(result))
    assert.match(result.stderr, /NOT EXECUTABLE/)
  } finally {
    cleanup(world)
  }
})

test('probe: usage error on a non-absolute root exits 3', () => {
  const result = spawnSync(process.execPath, [PROBE, 'relative/path'], { encoding: 'utf8' })
  assert.equal(result.status, 3)
  assert.match(result.stderr, /absolute/)
})

// ---------------------------------------------------------------- links -----

test('links: entity copies and wrong-root links are repaired toward the live root', () => {
  const world = buildFakeWorld({ profileTools: 'wrong' })
  try {
    // plugin repo starts as an entity copy; profile starts pointed at another root
    const result = installRun(world, ['--links-only'])
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /\[link\] fixed: /)
    assert.equal(readlinkSync(join(world.pkgRoot, 'node_modules/@deepseek-ai/dsh-tools')), world.expectedTools)
    assert.equal(readlinkSync(join(world.home, 'profiles/web/node_modules/@deepseek-ai/dsh-tools')), world.expectedTools)

    // already-correct links are skipped idempotently
    const again = installRun(world, ['--links-only'])
    assert.equal(again.status, 0, outputOf(again))
    assert.match(again.stdout, /already correct/)
    assert.doesNotMatch(again.stdout, /\[link\] fixed/)
  } finally {
    cleanup(world)
  }
})

test('links: a profile already carrying the correct link is reported as ok', () => {
  const world = buildFakeWorld({ profileTools: 'correct' })
  try {
    const result = installRun(world, ['--links-only'])
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /profile:web.*already correct|\[link\] ok \(already correct\)/)
  } finally {
    cleanup(world)
  }
})

// ---------------------------------------------------------------- verify ----

test('verify: healthy world after install exits 0 with all four checks', () => {
  const world = buildFakeWorld()
  try {
    assert.equal(installRun(world).status, 0)
    const result = verifyRun(world)
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /\(a\) live root\s+: OK/)
    assert.match(result.stdout, /\(b\) b1 driver\s*: applied/)
    assert.match(result.stdout, /\(b\) b2 bundle\s*: applied/)
    assert.match(result.stdout, /\(c\) link plugin-repo: OK/)
    assert.match(result.stdout, /\(d\) dsh-subagent copy\s+: OK/)
    assert.match(result.stdout, /verify: OK/)
  } finally {
    cleanup(world)
  }
})

test('verify: wrong-root link and dangling link both fail with the install hint', () => {
  const world = buildFakeWorld()
  try {
    assert.equal(installRun(world).status, 0)
    const linkPath = join(world.pkgRoot, 'node_modules/@deepseek-ai/dsh-tools')

    const other = join(world.base, 'other/node_modules/@deepseek-ai/dsh-tools')
    writeIf(join(other, 'package.json'), pkgJson('@deepseek-ai/dsh-tools', '0.1.0-rc.6'))
    rmSync(linkPath)
    symlinkSync(other, linkPath)
    let result = verifyRun(world)
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /wrong-root/)
    assert.match(outputOf(result), /re-run patches\/install\.sh/)

    rmSync(linkPath)
    symlinkSync(join(world.base, 'gone-root/node_modules/@deepseek-ai/dsh-tools'), linkPath)
    result = verifyRun(world)
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /dangling/)
  } finally {
    cleanup(world)
  }
})

test('verify: unpatched targets report missing (→ re-run install) and fail', () => {
  const world = buildFakeWorld()
  try {
    assert.equal(installRun(world, ['--links-only']).status, 0)
    const result = verifyRun(world)
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /\(b\) b1 driver\s*: missing/)
    assert.match(outputOf(result), /\(b\) b2 bundle\s*: missing/)
    assert.match(outputOf(result), /re-run patches\/install\.sh/)
  } finally {
    cleanup(world)
  }
})

test('verify: anchor drift reports drift-anchor (d1 wording), non-zero', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', dshVersion: '0.1.0-rc.9' })
  try {
    const result = verifyRun(world)
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /drift-anchor/)
    assert.match(outputOf(result), /newer plugin release/)
    assert.doesNotMatch(outputOf(result), /unverified-native/)
  } finally {
    cleanup(world)
  }
})

test('verify: whitelisted drift without a verified stamp reports unverified-native', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', dshVersion: '9.9.9-native' })
  try {
    const result = verifyRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(result.status, 1, outputOf(result))
    assert.match(outputOf(result), /unverified-native/)
    assert.match(outputOf(result), /verify\.sh --probe/)
  } finally {
    cleanup(world)
  }
})

test('verify: a recorded native-verified stamp for this root+version passes check (b)', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', dshVersion: '9.9.9-native' })
  try {
    const result = installRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    // no runtime packages in this world → d2; craft the trusted stamp instead
    assert.equal(result.status, 3, outputOf(result))
    writeFileSync(stampPath(world), `${JSON.stringify({
      dshVersion: '9.9.9-native',
      liveRoot: realpathSync(world.root),
      appliedAt: new Date().toISOString(),
      patches: { inProcessDriver: 'native-verified', subagentBundle: 'native-verified' },
      mtimes: { inProcessDriver: null, subagentBundle: null },
    }, null, 2)}\n`)
    const verify = verifyRun(world, [], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(verify.status, 0, outputOf(verify))
    assert.match(outputOf(verify), /native-verified/)
  } finally {
    cleanup(world)
  }
})

test('verify --probe: re-runs the behavioral probe read-only and writes nothing', () => {
  const world = buildFakeWorld({ driver: 'drift', bundle: 'drift', runtime: true, runtimeMergesCwd: true, dshVersion: '9.9.9-native' })
  try {
    const result = verifyRun(world, ['--probe'], { DSH_NATIVE_CWD_VERSIONS: '9.9.9-native' })
    assert.equal(result.status, 1, outputOf(result), 'unverified-native until install records the verdict')
    assert.match(result.stdout, /probe re-run/)
    assert.match(result.stdout, /exit 0/)
    assert.equal(existsSync(stampPath(world)), false, 'verify must stay read-only')
  } finally {
    cleanup(world)
  }
})

test('verify: repo dsh-subagent version mismatch is a warning, not a failure', () => {
  const world = buildFakeWorld({ repoSubagentVersion: '0.1.0-rc.3' })
  try {
    assert.equal(installRun(world).status, 0)
    const result = verifyRun(world)
    assert.equal(result.status, 0, outputOf(result))
    assert.match(outputOf(result), /WARNING — repo copy 0\.1\.0-rc\.3 vs live root 0\.1\.0-rc\.6/)
  } finally {
    cleanup(world)
  }
})

// ------------------------------------------------------------- uninstall ----

test('uninstall → install round trip: restores originals, drops stamp, keeps links', () => {
  const world = buildFakeWorld()
  try {
    const driverBefore = readFileSync(driverTarget(world), 'utf8')
    const bundleBefore = readFileSync(bundleTarget(world), 'utf8')

    assert.equal(installRun(world).status, 0)
    assert.equal(verifyRun(world).status, 0)

    const uninstall = uninstallRun(world)
    assert.equal(uninstall.status, 0, outputOf(uninstall))
    assert.equal(readFileSync(driverTarget(world), 'utf8'), driverBefore, 'driver restored to stock')
    assert.equal(readFileSync(bundleTarget(world), 'utf8'), bundleBefore, 'bundle restored to stock')
    assert.equal(existsSync(`${driverTarget(world)}.bak_cwd`), false)
    assert.equal(existsSync(stampPath(world)), false, 'stale stamp must not re-enable cwd')
    // links are deliberately NOT rolled back (deployment health, §6.4.2)
    assert.equal(readlinkSync(join(world.pkgRoot, 'node_modules/@deepseek-ai/dsh-tools')), world.expectedTools)
    assert.equal(readlinkSync(join(world.home, 'profiles/web/node_modules/@deepseek-ai/dsh-tools')), world.expectedTools)
    assert.match(uninstall.stdout, /LEFT IN PLACE/)

    // reinstall after uninstall is a clean idempotent round trip
    const reinstall = installRun(world)
    assert.equal(reinstall.status, 0, outputOf(reinstall))
    assert.match(reinstall.stdout, /\[patch\] applied:/)
    assert.equal(verifyRun(world).status, 0)
  } finally {
    cleanup(world)
  }
})

test('uninstall: unpatched world is a no-op with exit 0', () => {
  const world = buildFakeWorld()
  try {
    const result = uninstallRun(world)
    assert.equal(result.status, 0, outputOf(result))
    assert.match(result.stdout, /not patched, nothing to restore|nothing to do/)
  } finally {
    cleanup(world)
  }
})

// ---------------------------------------------------------- red line 11 ----

test('red line 11: no hardcoded npx-hash paths, no ls|tail root picking in scripts', () => {
  for (const script of ['install.sh', 'verify.sh', 'uninstall.sh', 'resolve-root.sh']) {
    const content = readFileSync(join(PATCHES, script), 'utf8')
    assert.equal(content.includes('_npx'), false, `${script} must not mention _npx paths at all`)
    assert.doesNotMatch(content, /ls\s+[^\n]*\.npm/, `${script} must not enumerate npm caches`)
    assert.doesNotMatch(content, /tail\s+-1/, `${script} must not pick roots by tail`)
  }
})

test('whitelist constant starts EMPTY in both install.sh and verify.sh', () => {
  for (const script of ['install.sh', 'verify.sh']) {
    const content = readFileSync(join(PATCHES, script), 'utf8')
    const line = content.split('\n').find((l) => l.startsWith('NATIVE_CWD_VERSIONS='))
    assert.ok(line, `${script} defines NATIVE_CWD_VERSIONS`)
    assert.equal(line.trim(), "NATIVE_CWD_VERSIONS=''", `${script} whitelist must start empty`)
  }
})

// --------------------------------------------------------------- windows ----

test('windows: ps1 scripts exist and carry the key functions (static checks)', { skip: false }, () => {
  const install = readFileSync(join(PATCHES, 'install.ps1'), 'utf8')
  const verify = readFileSync(join(PATCHES, 'verify.ps1'), 'utf8')
  const uninstall = readFileSync(join(PATCHES, 'uninstall.ps1'), 'utf8')

  for (const [name, content] of [['install.ps1', install], ['verify.ps1', verify], ['uninstall.ps1', uninstall]]) {
    assert.match(content, /function Resolve-LiveRoot/, `${name} resolves the live root dynamically`)
    assert.doesNotMatch(content, /_npx/, `${name} must not mention _npx paths`)
    assert.match(content, /DSH_HARNESS_ROOT/, `${name} honors the explicit override`)
  }
  assert.match(install, /NATIVE_CWD_VERSIONS = @\(\)/, 'install.ps1 whitelist starts empty')
  assert.match(install, /probe-cwd\.mjs/, 'install.ps1 runs the shared behavioral probe')
  assert.match(install, /SymbolicLink/, 'install.ps1 creates symbolic links')
  assert.match(verify, /unverified-native/, 'verify.ps1 reports the d2 state')
  assert.match(uninstall, /\.bak_cwd/, 'uninstall.ps1 restores the backups')
  assert.match(uninstall, /LEFT IN PLACE/, 'uninstall.ps1 does not roll back stage A links')

  // Runtime syntax self-check when a PowerShell engine exists; otherwise the
  // static checks above stand and the skip is declared here (CI without pwsh).
  const engine = spawnSync('/bin/sh', ['-c', 'command -v pwsh || command -v powershell.exe || true'], { encoding: 'utf8' }).stdout.trim()
  if (engine === '') {
    console.log('[skip] no pwsh / powershell.exe on this machine — ps1 runtime syntax check skipped (static checks only)')
    return
  }
  for (const name of ['install.ps1', 'verify.ps1', 'uninstall.ps1']) {
    const parsed = spawnSync(engine, ['-NoProfile', '-Command', `$null = [scriptblock]::Create((Get-Content -Raw '${join(PATCHES, name)}')); Write-Output ok`], { encoding: 'utf8' })
    assert.equal(parsed.stdout.trim(), 'ok', `${name} must parse: ${parsed.stderr}`)
  }
})
