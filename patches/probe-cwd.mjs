#!/usr/bin/env node
// probe-cwd.mjs — behavioral probe for NATIVE `request.cwd` forwarding (the
// second hard gate of DESIGN §6.4.2 install state c; red line 12 territory).
//
// Usage:   node probe-cwd.mjs <absolute-live-harness-root>
// Returns: 0 = VERIFIED  — a child session created through the LIVE subagent
//                          start path with `request.cwd` got exactly that cwd
//                          in its creation meta (native forwarding observed);
//          1 = FAILED    — the start path executed and the child creation meta
//                          did NOT carry request.cwd (native forwarding absent);
//          2 = NOT EXECUTABLE — the minimal live environment could not be
//                          assembled (imports failed, provider did not
//                          register, start path threw, timed out). Never counts
//                          as evidence for native support.
//          3 = usage error.
//
// How it probes (behavioral, not text-shaped — grepping a file for
// `request.cwd` is FORBIDDEN as native evidence):
//   1. import the LIVE root's own packages by absolute path — @deepseek-ai/
//      cordis, @deepseek-ai/dsh-subagent, @deepseek-ai/dsh-subagent-spawn-
//      in-process — so every module the probe touches IS the code the harness
//      runs (their bare imports resolve inside the live root);
//   2. boot a minimal cordis Context, instantiate the real SubagentRuntime,
//      and register the REAL spawn in-process provider through its real
//      `apply()` under a probe-only provider name;
//   3. call `runtime.start(provider, request)` — the same public seam the
//      subagent tool uses — with a minimal parent whose `ctx.agents.create`
//      is an observation point. The parent session header carries a DIFFERENT
//      cwd than request.cwd, so plain inheritance can never satisfy the probe;
//   4. assert the creation meta forwarded to `agents.create` (the seed of the
//      child session header) equals request.cwd. The child is driven with a
//      stub handle: no model call is made, no reply is expected ("容忍无模型
//      回复"), and the run is disposed immediately.
// The unexecuted remainder of the full ctx.subagents.start path (cordis
// service container wiring in a booted app) is why failures to assemble the
// environment map to exit 2 rather than 1 — fail closed, never guess native.
//
// The probe is read-only with respect to the live tree: everything it creates
// lives in os.tmpdir() or in memory.

import { isAbsolute } from 'node:path'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const PROBE_TIMEOUT_MS = 20_000
const PROVIDER_NAME = 'cwd-probe-spawn-in-process'

function usageError(reason) {
  process.stderr.write(`probe-cwd: ${reason}\n`)
  process.stderr.write('probe-cwd: usage: node probe-cwd.mjs <absolute-live-harness-root>\n')
  return { code: 3, reason }
}

async function runProbe(liveRoot) {
  const pkgLib = (name) =>
    pathToFileURL(join(liveRoot, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href

  // Gate A — assemble the minimal live environment. Any import failure means
  // the probe is NOT EXECUTABLE (this is the fake-tree / stripped-root case).
  let cordis
  let subagent
  let spawnProvider
  try {
    ;[cordis, subagent, spawnProvider] = await Promise.all([
      import(pkgLib('cordis')),
      import(pkgLib('dsh-subagent')),
      import(pkgLib('dsh-subagent-spawn-in-process')),
    ])
  } catch (error) {
    return { code: 2, reason: `minimal environment not obtainable — live package import failed: ${error?.message ?? error}` }
  }

  // Two distinct cwds: parent header cwd vs the requested per-call cwd. If the
  // live path merely inherits the parent cwd, the mismatch is the verdict.
  const parentCwd = mkdtempSync(join(tmpdir(), 'cwd-probe-parent-'))
  const requestedCwd = mkdtempSync(join(tmpdir(), 'cwd-probe-child-'))

  let captured = null
  const childStub = {
    cancel() {},
    followup() {},
    async whenIdle() {},
    session: { events: [] },
  }
  const publishedHandle = { agent: childStub, async dispose() {} }
  const parent = {
    options: { provider: 'cwd-probe-parent-provider', model: 'cwd-probe-parent-model' },
    session: { header: { id: 'cwd-probe-parent-session', cwd: parentCwd }, events: [] },
    ctx: {
      agents: { create: async (options) => { captured = options; return publishedHandle } },
      get() { return undefined },
    },
  }

  const controller = new AbortController()
  let run = null
  try {
    const ctx = new cordis.Context({})
    const runtime = new subagent.SubagentRuntime(ctx)
    if (typeof spawnProvider.apply !== 'function' || typeof runtime.start !== 'function') {
      return { code: 2, reason: 'live packages do not expose the expected seams (SubagentRuntime.start / provider apply)' }
    }
    spawnProvider.apply(ctx, { providerName: PROVIDER_NAME })
    if (runtime.getProvider(PROVIDER_NAME) === undefined) {
      return { code: 2, reason: `the live spawn provider did not register under "${PROVIDER_NAME}"` }
    }

    const request = {
      label: 'cwd-probe',
      prompt: 'cwd probe — no model reply expected',
      parent,
      cwd: requestedCwd,
      signal: controller.signal,
    }
    const timer = setTimeout(() => controller.abort('probe timeout'), PROBE_TIMEOUT_MS)
    timer.unref?.()
    try {
      run = await runtime.start(PROVIDER_NAME, request)
    } finally {
      clearTimeout(timer)
    }

    if (captured === null) {
      return { code: 2, reason: 'the live start path returned without ever calling agents.create — creation point not observable' }
    }
    const meta = captured.meta
    if (meta !== null && typeof meta === 'object' && meta.cwd === requestedCwd) {
      return {
        code: 0,
        reason: `VERIFIED — child creation meta.cwd === request.cwd (${JSON.stringify(requestedCwd)}); native request.cwd forwarding observed on the live one-shot subagent path`,
      }
    }
    return {
      code: 1,
      reason: `executed, NOT forwarded — child creation meta.cwd is ${JSON.stringify(meta?.cwd)} while request.cwd is ${JSON.stringify(requestedCwd)} (parent header cwd was ${JSON.stringify(parentCwd)})`,
    }
  } catch (error) {
    return { code: 2, reason: `the live subagent start path could not execute: ${error?.stack ?? error}` }
  } finally {
    try { await run?.dispose?.() } catch { /* disposal failures never change the verdict */ }
    controller.abort('probe finished')
    rmSync(parentCwd, { recursive: true, force: true })
    rmSync(requestedCwd, { recursive: true, force: true })
  }
}

const liveRoot = process.argv[2]
let verdict
if (liveRoot === undefined || liveRoot === '') {
  verdict = usageError('no live harness root argument given')
} else if (!isAbsolute(liveRoot)) {
  verdict = usageError(`live harness root must be an absolute path (got ${JSON.stringify(liveRoot)})`)
} else {
  verdict = await runProbe(liveRoot)
}

if (verdict.code === 0) {
  process.stdout.write(`probe-cwd: ${verdict.reason}\n`)
} else {
  process.stderr.write(`probe-cwd: ${['', 'FAILED (forwarding not observed)', 'NOT EXECUTABLE', 'usage error'][verdict.code]} — ${verdict.reason}\n`)
}
process.exit(verdict.code)
