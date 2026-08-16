import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeBridge, safeFlagValue } from '../lib/bridges/claude.js'
import { createCodexBridge, safeConfigValue } from '../lib/bridges/codex.js'
import { createAcpBridge } from '../lib/bridges/acp.js'
import { createGrokBridge } from '../lib/bridges/grok.js'

/**
 * The bridge contract: every bridge exposes create / submit / reconnect /
 * dispose. A FAKE bridge here verifies the interface shape that product
 * providers and tools rely on, without needing any real CLI or API key.
 */
function fakeBridge() {
  let n = 0
  return {
    async create() { return { kind: 'fake', id: `s${++n}` } },
    async submit(remote, task) { return { text: `echo:${task}`, stopReason: 'completed' } },
    async reconnect(id) { return { kind: 'fake', id } },
    async dispose() {},
  }
}

test('real bridges expose the contract', () => {
  for (const bridge of [createClaudeBridge(), createCodexBridge(), createAcpBridge(), createGrokBridge()]) {
    assert.equal(typeof bridge.create, 'function')
    assert.equal(typeof bridge.submit, 'function')
    assert.equal(typeof bridge.reconnect, 'function')
    assert.equal(typeof bridge.dispose, 'function')
  }
})

test('fake bridge fulfills the same contract (interface-level integration)', async () => {
  const bridge = fakeBridge()
  const remote = await bridge.create('/tmp')
  const out = await bridge.submit(remote, 'task A')
  assert.equal(out.text, 'echo:task A')
  const resumed = await bridge.reconnect(remote.id)
  assert.equal(resumed.id, remote.id)
  await bridge.dispose(remote)
})

test('bridges accept timeoutMs without breaking the default', () => {
  const b = createClaudeBridge({ timeoutMs: 9000 })
  assert.equal(typeof b.submit, 'function')
  const c = createCodexBridge({ timeoutMs: 12000 })
  assert.equal(typeof c.submit, 'function')
})

test('flag/config values that could inject options or flags are refused', () => {
  // TOML injection into `-c model=…` / flag injection into `--model …`
  for (const evil of [
    'x", sandbox_mode="danger-full-access',
    '-something',
    'a b',
    'key=value',
    'x;y',
  ]) {
    assert.throws(() => safeConfigValue(evil, 'model'), /unsafe model/, `codex refuses ${evil}`)
    assert.throws(() => safeFlagValue(evil, 'model'), /unsafe model/, `claude refuses ${evil}`)
  }
  // plain identifiers pass
  assert.equal(safeConfigValue('gpt-5.2-codex', 'model'), 'gpt-5.2-codex')
  assert.equal(safeFlagValue('claude-sonnet-4-5', 'model'), 'claude-sonnet-4-5')
  assert.equal(safeFlagValue('low', 'reasoningEffort'), 'low')
})

test('claude bridge preallocates a pending session id (no disk guessing)', async () => {
  const bridge = createClaudeBridge({ command: 'definitely-not-installed-cli' })
  const remote = await bridge.create()
  assert.match(remote.pendingSessionId, /^[0-9a-f-]{36}$/, 'UUID preallocated for --session-id')
  assert.equal(remote.sessionId, undefined)
})

test('NIT-4: a poisoned sessionId / threadId through reconnect is refused loudly at arg-build', async () => {
  // A session/thread id captured from a hostile stream must be whitelisted
  // before it rides a SEPARATE argv element (`--resume <id>` / `resume
  // <threadId>`) — a flag-shaped id could otherwise flip into another CLI
  // flag. safeFlagValue / safeConfigValue throw BEFORE any process spawns, so
  // a definitely-not-installed `command` keeps this deterministic: a whitelist
  // regression would attempt (and fail loudly on) that spawn, not silently hit
  // a real installed `claude`/`codex` on the CI machine.
  const NOT_INSTALLED = 'definitely-not-installed-cli'
  for (const [bridge, evil, what] of [
    [createClaudeBridge({ command: NOT_INSTALLED }), '--dangerously-skip-permissions', 'sessionId'],
    [createCodexBridge({ command: NOT_INSTALLED }), '--dangerously-bypass-approvals-and-sandbox', 'threadId'],
  ]) {
    const remote = await bridge.reconnect(evil)
    await assert.rejects(
      () => bridge.submit(remote, 'task'),
      (error) => {
        assert.match(error.message, new RegExp(`unsafe ${what}`))
        return true
      },
    )
  }
  // valid UUID-ish ids pass the whitelist and are the ids the bridges emit
  assert.equal(safeFlagValue('22222222-3333-4444-5555-666666666666', 'sessionId'), '22222222-3333-4444-5555-666666666666')
  assert.equal(safeConfigValue('thread-1', 'threadId'), 'thread-1')
})
