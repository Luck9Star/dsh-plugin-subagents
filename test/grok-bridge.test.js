// dsh-plugin-subagents — lib/bridges/grok.js 测试。
//
// 全部 fake：CLI 是「node 脚本 shim」（跨平台，复刻 drivers-assembly.test.js
// 的 shim 模式），按收到的 argv 回放 fixture 输出 —— 无真实 grok、无 API
// key、无网络。fixture 事件流照 task-weaver R2 实测形状（扁平 NDJSON：
// available_commands / thought / text / usage / end{sessionId,stopReason,…}）。
//
// 覆盖：
//   - bridge 契约四方法（create/submit/reconnect/dispose）；
//   - argv 构造：首 turn `-s <uuid>` 预分配 + `--single=<task>` 附值传输
//     （grok 1.0.4 实测：clap 拒绝 `-p -- <task>`，附值形态保住规则 7 的实质
//     —— 任务文本永不成为 flag）；
//   - resume：`end.sessionId` 增量捕获后，后续 turn 用 `--resume <id>`；
//   - 最终文本取最后一个 `text` 事件；`end_turn` → stopReason completed；
//   - flag 注入拒绝（safeFlagValue 白名单）；
//   - 非零退出：exit 2 = clap 参数校验（permanent 提示），无 text 时以
//     stderr/stdout 尾巴报错；
//   - 输出脱敏：默认 redact，redactSecrets:false 透传；
//   - 打断/超时：partial 输出丢弃，AbortError/TimeoutError；
//   - permissionMode 三映射（readonly→plan / full→bypassPermissions /
//     default→dontAsk，未知 fail closed）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { createGrokBridge, safeFlagValue, grokPermissionMode } from '../lib/bridges/grok.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Write a fake `grok` CLI: a node script that echoes its argv to a file and
 * then emits the given stdout/stderr lines with the given exit code.
 * `firstSessionId` substitutes into the `end` event of the fixture (so the
 * incremental-capture path is exercised against a plausible uuid).
 */
function fakeGrok({ dir, argvLog, stdout = [], stderr = [], code = 0 }) {
  const path = join(dir, 'grok-fake.mjs')
  const body = [
    'import { writeFileSync } from "node:fs"',
    `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)))`,
    `process.stdout.write(${JSON.stringify(stdout.join('\n') + (stdout.length ? '\n' : ''))})`,
    `process.stderr.write(${JSON.stringify(stderr.join('\n') + (stderr.length ? '\n' : ''))})`,
    `process.exit(${code})`,
  ].join('\n')
  writeFileSync(path, body)
  return path
}

function fixtureLines(sessionId = SESSION_ID) {
  return [
    JSON.stringify({ type: 'available_commands', toolsCount: 26 }),
    JSON.stringify({ type: 'thought', data: 'The user' }),
    JSON.stringify({ type: 'thought', data: ' says hi.' }),
    JSON.stringify({ type: 'text', data: 'pong' }),
    JSON.stringify({ type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } }),
    JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId, requestId: 'rq-1', usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, num_turns: 1, total_cost_usd: 0.001 }),
  ]
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'grok-bridge-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('grok bridge exposes the contract and preallocates a pending session uuid', async () => {
  const bridge = createGrokBridge()
  for (const method of ['create', 'submit', 'reconnect', 'dispose']) {
    assert.equal(typeof bridge[method], 'function', `${method} on the contract`)
  }
  const remote = await bridge.create('/tmp')
  assert.equal(remote.kind, 'grok')
  assert.match(remote.pendingSessionId, /^[0-9a-f-]{36}$/, 'UUID preallocated for --session-id')
  assert.equal(remote.sessionId, undefined)
})

test('first turn: task rides --single=<task>; -s preallocates; answer parsed; session captured', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeGrok({ dir, argvLog, stdout: fixtureLines() })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create('/tmp')
  const preallocated = remote.pendingSessionId

  const out = await bridge.submit(remote, 'reply with exactly: pong', undefined, dir)
  assert.equal(out.text, 'pong')
  assert.equal(out.stopReason, 'completed')

  const argv = JSON.parse((await import('node:fs')).readFileSync(argvLog, 'utf8'))
  // streaming-json + a permission mode are always present
  assert.ok(argv.includes('--output-format') && argv.includes('streaming-json'))
  assert.ok(argv.includes('--permission-mode'), 'headless permission mode always emitted')
  // first turn names the conversation with the preallocated uuid
  const sIdx = argv.indexOf('--session-id')
  assert.ok(sIdx >= 0, '--session-id on the first turn')
  assert.equal(argv[sIdx + 1], preallocated)
  // THE injection-safe transport: task text is an ATTACHED --single= value
  const single = argv.find((a) => a.startsWith('--single='))
  assert.ok(single, '--single=<task> attached-value transport')
  assert.equal(single, '--single=reply with exactly: pong')
  // no bare task positional, no `--` (clap refuses it for -p)
  assert.ok(!argv.includes('--'), 'no bare -- (grok clap cannot take -p -- task)')
  // session id captured from the end event
  assert.equal(remote.sessionId, SESSION_ID)
  assert.equal(remote.pendingSessionId, undefined)
})

test('second turn resumes with --resume <id> and no --session-id', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeGrok({ dir, argvLog, stdout: fixtureLines('99999999-8888-7777-6666-555555555555') })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.reconnect(SESSION_ID)
  assert.equal(remote.sessionId, SESSION_ID)

  const out = await bridge.submit(remote, 'what was the word?', undefined, dir)
  assert.equal(out.text, 'pong')
  const argv = JSON.parse((await import('node:fs')).readFileSync(argvLog, 'utf8'))
  const rIdx = argv.indexOf('--resume')
  assert.ok(rIdx >= 0, '--resume carries the CLI-confirmed session id')
  assert.equal(argv[rIdx + 1], SESSION_ID)
  assert.ok(!argv.includes('--session-id'), 'no --session-id once the real id is known')
})

test('NIT-3: a truncated stream (non-zero exit, no `end`) never promotes a resume id — fresh `-s` path survives', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // The CLI reflects a failed turn: text emitted but the stream is cut off
  // BEFORE the terminal `end` event (grok persists a conversation only at
  // `end`). The turn resolves as stopReason error; the incremental capture
  // never saw an `end` line, so it must not leave a doomed resume id.
  const argvLog = join(dir, 'argv.json')
  const stdout = [
    JSON.stringify({ type: 'text', data: 'partial answer before truncation' }),
  ]
  const cli = fakeGrok({ dir, argvLog, stdout, code: 1 })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  const preallocated = remote.pendingSessionId

  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'partial answer before truncation')
  assert.equal(out.stopReason, 'error')

  // No `end` → no resume basis, and the preallocated `-s` id is untouched so
  // the NEXT submission starts a fresh conversation instead of a doomed
  // `--resume` against a session that was never persisted on the CLI.
  assert.equal(remote.sessionId, undefined, 'truncated stream leaves sessionId unset')
  assert.equal(remote.pendingSessionId, preallocated, 'preallocated -s id survives for a fresh retry')
})

test('NIT-4: a poisoned stream sessionId is refused loudly at the next --resume (fail closed, never a separate flag)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // Grok 1.0.4 names the conversation with `-s` on the FIRST turn; the
  // CLI-confirmed id only surfaces on later `end` events. Simulate a
  // poisoned stream whose `end.sessionId` is a flag-shaped string — if it
  // ever reached `--resume <id>` unguarded it could flip into another CLI
  // flag. safeFlagValue refuses it loudly at arg-build.
  const poisoned = '--dangerously-bypass-approvals-and-sandbox'
  const argvLog = join(dir, 'argv.json')
  const cli = fakeGrok({
    dir,
    argvLog,
    stdout: [
      JSON.stringify({ type: 'text', data: 'pong' }),
      JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: poisoned }),
    ],
  })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  // First turn runs fine (fresh `-s` path) but captures the poisoned id.
  await bridge.submit(remote, 'reply with exactly: pong', undefined, dir)
  assert.equal(remote.sessionId, poisoned, 'fixture: poisoned id was captured from the stream')

  // The very next submission would resume with `--resume <id>`. The whitelist
  // must refuse the flag-shaped id LOUDLY (fail closed) — a success here would
  // mean the poisoned id silently became a separate argv flag (rule 7 break).
  const argvLog2 = join(dir, 'argv2.json')
  const cli2 = fakeGrok({ dir, argvLog: argvLog2, stdout: fixtureLines() })
  const wrapper2 = join(dir, 'grok2')
  writeFileSync(wrapper2, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli2}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli2}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge2 = createGrokBridge({ command: wrapper2, timeoutMs: 30000 })
  const remote2 = await bridge2.reconnect(poisoned)
  await assert.rejects(
    () => bridge2.submit(remote2, 'next', undefined, dir),
    (error) => {
      assert.match(error.message, /unsafe sessionId/)
      return true
    },
  )
})

test('a leading-dash task stays prompt text (rule 7 substance over the attached transport)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeGrok({ dir, argvLog, stdout: fixtureLines() })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  await bridge.submit(remote, '--dangerously-bypass-approvals-and-sandbox', undefined, dir)
  const argv = JSON.parse((await import('node:fs')).readFileSync(argvLog, 'utf8'))
  // The whole flag-looking task is exactly one attached value — it can never
  // surface as a standalone argv element the CLI would parse as a flag.
  assert.ok(argv.includes('--single=--dangerously-bypass-approvals-and-sandbox'))
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'))
})

test('model / reasoning effort pass through as whitelisted flag values', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeGrok({ dir, argvLog, stdout: fixtureLines() })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  await bridge.submit(remote, 'task', undefined, dir, { model: 'grok-4.5', reasoningEffort: 'high', permissionMode: 'readonly' })
  const argv = JSON.parse((await import('node:fs')).readFileSync(argvLog, 'utf8'))
  assert.ok(argv.includes('grok-4.5') && argv.includes('--model'))
  assert.ok(argv.includes('high') && argv.includes('--reasoning-effort'))
  assert.ok(argv.includes('plan'), 'readonly → plan (grok read-only mode)')
})

test('flag injection is refused by the whitelist (grok safeFlagValue)', () => {
  for (const evil of [
    'x", something_else="y',
    '-something',
    'a b',
    'x;y',
    'grok$(pwn)',
  ]) {
    assert.throws(() => safeFlagValue(evil, 'model'), /unsafe model/, `grok refuses ${evil}`)
  }
  assert.equal(safeFlagValue('grok-4.5', 'model'), 'grok-4.5')
  assert.equal(safeFlagValue('high', 'reasoningEffort'), 'high')
})

test('exit 2 (clap arg validation) with no text fails loudly with the permanent hint', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeGrok({ dir, argvLog, stderr: ['error: invalid value \'bogus\' for \'--output-format\''], code: 2 })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    (error) => {
      assert.match(error.message, /grok exited 2/)
      assert.match(error.message, /argument validation failed — permanent/)
      assert.match(error.message, /invalid value/)
      return true
    },
  )
})

test('non-zero exit WITH text resolves as stopReason error (grok reflects a failed turn)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const stdout = fixtureLines().filter((l) => !l.includes('"end"')).concat([
    JSON.stringify({ type: 'end', stopReason: 'max_turns', sessionId: SESSION_ID }),
  ])
  const cli = fakeGrok({ dir, argvLog, stdout, code: 1 })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'pong')
  assert.equal(out.stopReason, 'error')
})

test('secrets in the answer text are redacted by default; redactSecrets:false passes them through', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const stdout = [
    JSON.stringify({ type: 'text', data: 'token: Bearer abc.def+ghi==' }),
    JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: SESSION_ID }),
  ]
  const mk = async (redactSecrets) => {
    const argvLog = join(dir, `argv-${redactSecrets}.json`)
    const cli = fakeGrok({ dir, argvLog, stdout })
    const wrapper = join(dir, `grok-${redactSecrets}`)
    writeFileSync(wrapper, process.platform === 'win32'
      ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
      : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
      process.platform === 'win32' ? {} : { mode: 0o755 })
    const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000, ...(redactSecrets === false ? { redactSecrets } : {}) })
    const remote = await bridge.create()
    return bridge.submit(remote, 'task', undefined, dir)
  }
  const clean = await mk(true)
  assert.ok(!clean.text.includes('abc.def+ghi'), 'secret scrubbed from the final text')
  assert.ok(clean.text.includes('[REDACTED:bearer]'))
  const raw = await mk(false)
  assert.ok(raw.text.includes('Bearer abc.def+ghi=='), 'raw passthrough when explicitly disabled')
})

test('abort discards partial output with AbortError (never half an answer)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // A fake CLI that streams one text event then hangs until killed.
  const cli = join(dir, 'grok-hang.mjs')
  writeFileSync(cli, [
    'import { setTimeout as sleep } from "node:timers/promises"',
    'process.stdout.write(' + JSON.stringify(JSON.stringify({ type: 'text', data: 'partial' }) + '\n') + ')',
    'await sleep(30000)',
    'process.exit(0)',
  ].join('\n'))
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    () => bridge.submit(remote, 'task', controller.signal, dir),
    (error) => {
      assert.equal(error.name, 'AbortError')
      assert.match(error.message, /interrupted/)
      // The partial-discard note is best-effort (whether the text chunk
      // arrived before the kill is a race) — never assert the positive side.
      assert.ok(!error.message.includes('pong'))
      return true
    },
  )
})

test('timeout kills the turn with TimeoutError', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const cli = join(dir, 'grok-hang.mjs')
  writeFileSync(cli, [
    'import { setTimeout as sleep } from "node:timers/promises"',
    'await sleep(30000)',
    'process.exit(0)',
  ].join('\n'))
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 500 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    (error) => {
      assert.equal(error.name, 'TimeoutError')
      return true
    },
  )
})

test('grokPermissionMode maps the three modes and fails closed to plan (rule 3)', () => {
  assert.equal(grokPermissionMode('readonly'), 'plan')
  assert.equal(grokPermissionMode('full'), 'bypassPermissions')
  assert.equal(grokPermissionMode('default'), 'dontAsk')
  assert.equal(grokPermissionMode(undefined), 'dontAsk')
  // unknown → grok's readonly equivalent (plan), never an elevated mode —
  // design rule 3: unknown permission modes fail closed to readonly
  assert.equal(grokPermissionMode('superuser'), 'plan', 'unknown fails closed to plan')
})

test('text events concatenate (grok 1.0.5 token-slice streams; 1.0.4 single events append whole)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  // 1.0.5 verified shape: the same logical turn message arrives as multiple
  // token-slice text events ("PROBE", "-", "XY", …) — the bridge must
  // reassemble, not keep only the last slice.
  const stdout = [
    JSON.stringify({ type: 'thought', data: 'thinking…' }),
    JSON.stringify({ type: 'text', data: 'PROBE' }),
    JSON.stringify({ type: 'text', data: '-' }),
    JSON.stringify({ type: 'text', data: 'XY' }),
    JSON.stringify({ type: 'text', data: '-' }),
    JSON.stringify({ type: 'text', data: '7799' }),
    JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: SESSION_ID }),
  ]
  const cli = fakeGrok({ dir, argvLog, stdout })
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'PROBE-XY-7799')
})

test('1.0.5 lockup recovery: "Session ID already in use" on the preallocated -s demotes it to --resume (one retry)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // Reproduces the field lockup verbatim: the first-turn `-s <uuid>` process
  // died (timeout) AFTER grok 1.0.5 persisted the conversation directory, so
  // the CLI now refuses the same `-s` on every retry ("already in use", no
  // resume semantics). The bridge must detect the refusal and re-submit via
  // --resume <preallocated> exactly once.
  const argvLogs = [join(dir, 'argv-1.json'), join(dir, 'argv-2.json')]
  let call = 0
  // A fake CLI whose behavior depends on the call index: first call exits 1
  // with the lockup message; second call answers normally.
  const cli = join(dir, 'grok-lock.mjs')
  writeFileSync(cli, [
    'import { writeFileSync, readFileSync, existsSync } from "node:fs"',
    `const call = existsSync(${JSON.stringify(join(dir, 'call-count'))})`,
    `  ? Number(readFileSync(${JSON.stringify(join(dir, 'call-count'))}, "utf8")) + 1`,
    '  : 1',
    `writeFileSync(${JSON.stringify(join(dir, 'call-count'))}, String(call))`,
    `if (call === 1) {`,
    `  writeFileSync(${JSON.stringify(argvLogs[0])}, JSON.stringify(process.argv.slice(2)))`,
    '  process.stderr.write(' + JSON.stringify('Error: Session ID 11111111-2222-3333-4444-555555555555 is already in use.\n') + ')',
    '  process.exit(1)',
    '}',
    // Real-CLI semantics: --resume <id> makes the terminal end event report
    // THAT SAME id — echo the id received on argv into the fixture.
    'const argv = process.argv.slice(2)',
    'const resumed = argv[argv.indexOf("--resume") + 1]',
    'const lines = [' + JSON.stringify(JSON.stringify({ type: 'text', data: 'pong' })) + ',',
    '  JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: resumed, requestId: "rq-2", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, num_turns: 1, total_cost_usd: 0.001 })]',
    `writeFileSync(${JSON.stringify(argvLogs[1])}, JSON.stringify(argv))`,
    'process.stdout.write(lines.join("\\n") + "\\n")',
    'process.exit(0)',
  ].join('\n'))
  const wrapper = join(dir, 'grok')
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  const bridge = createGrokBridge({ command: wrapper, timeoutMs: 30000 })
  const remote = await bridge.create()
  const preallocated = remote.pendingSessionId

  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'pong', 'the resume retry answered')

  const argv1 = JSON.parse((await import('node:fs')).readFileSync(argvLogs[0], 'utf8'))
  const argv2 = JSON.parse((await import('node:fs')).readFileSync(argvLogs[1], 'utf8'))
  const sIdx = argv1.indexOf('--session-id')
  assert.ok(sIdx >= 0 && argv1[sIdx + 1] === preallocated, 'first attempt used the preallocated -s')
  const rIdx = argv2.indexOf('--resume')
  assert.ok(rIdx >= 0 && argv2[rIdx + 1] === preallocated, 'recovery retried with --resume <preallocated>')
  assert.ok(!argv2.includes('--session-id'), 'recovery never re-sends the colliding -s')
  assert.equal(remote.sessionId, preallocated, 'the resumed turn end-event id equals the recovered id')
})

test('grok default timeout is 15 minutes (1.0.5 headless input preprocessing is heavy)', async (t) => {
  // A hanging CLI killed at 900s proves the default only via configuration
  // inspection — asserting the constant indirectly keeps the test fast:
  // a 500ms explicit override still times out (proving the override path),
  // and the default is asserted by reading the source constant.
  const { dir, done } = tempDir()
  t.after(done)
  const source = (await import('node:fs')).readFileSync(new URL('../lib/bridges/grok.js', import.meta.url), 'utf8')
  assert.match(source, /Number\(options\.timeoutMs\) \|\| 900000/, 'grok default timeoutMs raised to 15 min')
  done()
})
