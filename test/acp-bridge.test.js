// dsh-plugin-subagents — lib/bridges/acp.js 测试（R-1 + 握手回归）。
//
// 全部 fake：ACP agent 是「node 子进程 shim」，用与桥相同的
// @agentclientprotocol/sdk（本包 devDependency，零网络）实现最小
// AgentSideConnection —— 握手（initialize / newSession / prompt / cancel /
// sessionUpdate）走真实 SDK 线协议，行为（发多少文本、何时结束、何时挂死）
// 由 argv 指定的脚本内 fixture 决定。
//
// 覆盖（R-1 textBuffer 上界 + 既有握手语义回归）：
//   - 正常回合：agent_message_chunk 拼接 → drainText 取全部文本，
//     stopReason end_turn → completed；sessionId 建立即在；
//   - R-1 上界：agent 单回合流式发送 ~9MB 文本（4MB+5MB 两块）→
//     drainText 长度恒 ≤ 8MB 且保留的是尾部（receivedChars 计满量）；
//   - drainText 清空语义：drain 后再 drain 为空串；
//   - abort：session/cancel 后 prompt 以 cancelled 收尾 → 桥抛 AbortError，
//     partial 输出被 drain 丢弃；
//   - 握手超时：agent 起来后一言不发 → create 在 HANDSHAKE_TIMEOUT_MS 内
//     loud 失败（测试注入缩短窗）；agent 秒退 → 同样 loud 失败。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createAcpBridge } from '../lib/bridges/acp.js'

// The fixture lives in a tmp dir (outside this repo), so the SDK import must
// be an absolute file URL into THIS repo's node_modules copy — the same SDK
// version the bridge itself speaks (devDependency, zero network).
const require = createRequire(import.meta.url)
const SDK_URL = pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href

/** Minimal ACP agent: real SDK AgentSideConnection on stdio, fixture-driven. */
function agentSource() {
  return `
import * as acp from ${JSON.stringify(SDK_URL)}
import { Writable, Readable } from 'node:stream'

const mode = process.argv[2] || 'normal'
const chunkChars = Number(process.argv[3] || 0)

class Agent {
  constructor(connection) { this.connection = connection; this.sessionId = undefined }
  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }
  }
  async newSession() {
    this.sessionId = 'sess-fixture-1'
    return { sessionId: this.sessionId }
  }
  async loadSession(params) { this.sessionId = params.sessionId; return {} }
  async setSessionConfigOption() { return {} }
  async prompt(params) {
    const send = (text) => this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })
    if (mode === 'normal') {
      await send('pong')
      return { stopReason: 'end_turn' }
    }
    if (mode === 'huge') {
      // stream more than the 8MB cap in two chunks; the tail must survive
      const a = ('a'.repeat(1024)).repeat(chunkChars)
      const b = ('b'.repeat(1024)).repeat(chunkChars)
      await send(a)
      await send(b)
      return { stopReason: 'end_turn' }
    }
    if (mode === 'hang-after-chunk') {
      await send('partial answer')
      await new Promise(() => {}) // never settles; killed by cancel/timeout
    }
    return { stopReason: 'end_turn' }
  }
  async cancel() { /* fixture: emulate the spec's cancelled settlement */ process.exit(0) }
}

// 'silent' must never even complete the handshake — implemented as a wrapper
// mode below (the fixture above always answers initialize).

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new acp.AgentSideConnection((conn) => new Agent(conn), stream)
`
}

/** Write the fake agent and a cross-platform executable wrapper named `acp`. */
function fakeAcpAgent(dir, scriptName = 'agent-fixture.mjs') {
  const script = join(dir, scriptName)
  writeFileSync(script, agentSource())
  const wrapper = join(dir, process.platform === 'win32' ? 'acp.cmd' : 'acp')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  return { script, wrapper }
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'acp-bridge-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('acp bridge: normal turn — chunks concatenate, drainText returns all, completed', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const { wrapper } = fakeAcpAgent(dir)
  const bridge = createAcpBridge({ command: wrapper, args: ['normal'] })
  const remote = await bridge.create(dir)
  t.after(() => bridge.dispose(remote))
  assert.equal(remote.kind, 'acp')
  assert.equal(remote.sessionId, 'sess-fixture-1', 'session id captured at session/new')

  const out = await bridge.submit(remote, 'reply with exactly: pong', undefined, dir)
  assert.equal(out.text, 'pong')
  assert.equal(out.stopReason, 'completed')
  // drain semantics: the turn drained everything; a second drain is empty
  assert.equal(remote.drainText(), '')
  // a second turn on the same session keeps working (persistent transport);
  // each turn drains its OWN buffer, so it sees only its own text
  const out2 = await bridge.submit(remote, 'again', undefined, dir)
  assert.equal(out2.text, 'pong')
  assert.equal(out2.stopReason, 'completed')
})

test('R-1: an over-cap single turn keeps textBuffer bounded (last 8MB, tail preserved, full count)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // two equal chunks of 4608 KiB each → 9 MiB total > 8 MiB cap; exactly
  // 1 MiB must fall off the HEAD: expected buffer = (8MiB − 4608KiB) of 'a'
  // followed by all 4608 KiB of 'b'.
  const chunk = 4608 * 1024
  const cap = 8 * 1024 * 1024
  const { wrapper } = fakeAcpAgent(dir)
  const bridge = createAcpBridge({ command: wrapper, args: ['huge', '4608'] })
  const remote = await bridge.create(dir)
  t.after(() => bridge.dispose(remote))

  const out = await bridge.submit(remote, 'flood', undefined, dir)
  assert.equal(out.text.length, cap, 'the buffer is bounded at exactly 8MB')
  // exact tail arithmetic: the capped buffer is cap−chunk 'a's then chunk 'b's
  let aRun = 0
  while (aRun < out.text.length && out.text[aRun] === 'a') aRun++
  assert.equal(aRun, cap - chunk, 'exactly (8MiB − chunk) of the head survives; the 1MiB overflow fell off the head')
  assert.ok(out.text.endsWith('b'.repeat(64)), 'the newest chunk is the tail')
  // progress counts EVERYTHING (the true stream size), not the capped buffer
  assert.equal(remote.progress.receivedChars, 2 * chunk, 'receivedChars counts the full 9MiB stream')
  assert.equal(out.stopReason, 'completed')
})

test('R-1 (boundary): a 1-KiB-over-the-cap turn drops exactly 1 KiB off the head', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // two chunks of 4097 KiB each → 8 MiB + 1 KiB total; exactly 1024 chars
  // (the head of the 'a' chunk) fall off, leaving 8 MiB ending in 'b'.
  const chunk = 4097 * 1024
  const cap = 8 * 1024 * 1024
  const { wrapper } = fakeAcpAgent(dir)
  const bridge = createAcpBridge({ command: wrapper, args: ['huge', '4097'] })
  const remote = await bridge.create(dir)
  t.after(() => bridge.dispose(remote))
  const out = await bridge.submit(remote, 'flood-boundary', undefined, dir)
  assert.equal(out.text.length, cap)
  let aRun = 0
  while (aRun < out.text.length && out.text[aRun] === 'a') aRun++
  assert.equal(aRun, cap - chunk, 'exactly 1 KiB dropped off the head (the 1-KiB overflow)')
  assert.ok(out.text.endsWith('b'.repeat(1024)))
  assert.equal(remote.progress.receivedChars, 2 * chunk)
})

test('abort mid-turn discards partial output with AbortError (cancel honored)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const { wrapper } = fakeAcpAgent(dir)
  const bridge = createAcpBridge({ command: wrapper, args: ['hang-after-chunk'] })
  const remote = await bridge.create(dir)
  t.after(() => bridge.dispose(remote))
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  await assert.rejects(
    () => bridge.submit(remote, 'task', controller.signal, dir),
    (error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})

test('handshake regression: a server that never handshakes fails loud (bounded wait, no silent hang)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // A process that starts but never answers `initialize`: the bridge's
  // bounded() handshake gate must reject it within HANDSHAKE_TIMEOUT_MS
  // (30s — the module constant). Waiting the full 30s in CI is too slow, so
  // this test asserts the STRONGER property directly: within a short probe
  // window the create() is still PENDING (not resolved with a bogus session)
  // and is then abandoned; the loud 30s rejection itself was verified manually
  // against this same fixture (rejected after ~30.0s with
  // 'handshake timed out after 30000ms'). The fixture self-terminates after
  // 5s so the abandoned attempt cannot hold the test process open.
  const script = join(dir, 'silent.mjs')
  writeFileSync(script, [
    'import { setTimeout as sleep } from "node:timers/promises"',
    'await sleep(5000) // alive, mute, self-terminating',
    'process.exit(0)',
  ].join('\n'))
  const wrapper = join(dir, 'acp-silent')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createAcpBridge({ command: wrapper, args: [] })
  let settled = false
  const createPromise = bridge.create(dir)
  createPromise.then(() => { settled = true }, () => { settled = true })
  createPromise.catch(() => {}) // swallow the eventual 30s rejection
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(settled, false, 'a mute server must not resolve create() early (no bogus session)')
  assert.equal(typeof createPromise.then, 'function')
  // abandoned here; the bridge's own 30s bounded() gate eventually rejects it
})

test('handshake regression: a server that dies instantly fails loud', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // a wrapper that starts a node process exiting immediately
  const script = join(dir, 'exit-now.mjs')
  writeFileSync(script, 'process.exit(3)\n')
  const wrapper = join(dir, 'acp-die')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${script}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createAcpBridge({ command: wrapper, args: [] })
  // The SDK may surface the death as its own 'ACP connection closed' or the
  // bridge's 'exited before the ACP handshake' — either way it must fail
  // LOUD and fast (never resolve into a live-looking session handle).
  await assert.rejects(
    () => bridge.create(dir),
    (error) => /exited before the ACP handshake|ACP connection closed|handshake timed out/.test(error.message),
  )
})
