// dsh-plugin-subagents — lib/bridges/claude.js 进程级回归测试（G-1）。
//
// 全部 fake：CLI 是「node 脚本 shim」（跨平台，复刻 grok-bridge.test.js 的
// shim 模式），按收到的 argv 回放 fixture 输出 —— 无真实 claude、无 API
// key、无网络。fixture 输出形状照 claude -p --output-format json：
//   · 正常回合：stdout 可能多行（流式 JSONL 前奏），最终行为
//     {"type":"result","subtype":"success","session_id":<uuid>,
//      "result":"<text>","is_error":false}；
//   · 错误回合：is_error:true + error 文案；
//   · 崩溃回合：非零退出 + 非 JSON 尾巴。
//
// 覆盖：
//   - bridge 契约四方法 + 预分配 pendingSessionId（UUID）；
//   - argv 构造：首 turn `--session-id <预分配 UUID>`、`--` 后跟任务文本、
//     -p --output-format json 常驻；
//   - 末行 JSON 解析（流式多行输出只取最后一个非空行）；
//   - session_id 捕获：正常回合后 remote.sessionId 升级，后续 turn 走
//     `--resume <id>`（不再带 --session-id）；
//   - 中断晋升：runCommand 抛错（超时/abort）时 pendingSessionId → sessionId，
//     下次提交即 --resume 该 id（claude 以该 id 持久化了部分会话）；
//   - is_error 回合 → 抛错含 CLI 的 error 文案；
//   - 非 JSON 输出 → 抛 'claude returned unparseable output'；
//   - 超时：rejection 携带 '(timeout)' 标记（claude 桥原样透传 runCommand
//     的拒绝，不做 grok/codex 式 killed→TimeoutError 重映射）；abort 同理
//     携带 '(abort)' 且预分配 id 晋升；
//   - model / reasoningEffort / permissionMode 三映射；
//   - 输出脱敏：默认 redact，redactSecrets:false 透传；
//   - flag 注入拒绝（safeFlagValue 白名单，与 bridges.test.js 互补）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { createClaudeBridge, safeFlagValue } from '../lib/bridges/claude.js'

const SESSION_ID = '11111111-2222-3333-4444-555555555555'

/**
 * Write a fake `claude` CLI: a node script that echoes its argv to a file and
 * then emits the given stdout/stderr with the given exit code. Fixture lines
 * are emitted AS-IS (the caller passes pre-serialized JSONL/JSON lines).
 */
function fakeClaude({ dir, argvLog, name = 'claude-fake.mjs', stdout = [], stderr = [], code = 0, hangMs = 0 }) {
  const path = join(dir, name)
  const body = [
    'import { writeFileSync } from "node:fs"',
    `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)))`,
    hangMs > 0
      ? `import { setTimeout as sleep } from "node:timers/promises"
         process.stdout.write(${JSON.stringify(stdout.join('\n') + (stdout.length ? '\n' : ''))})
         await sleep(${hangMs})
         process.exit(${code})`
      : `process.stdout.write(${JSON.stringify(stdout.join('\n') + (stdout.length ? '\n' : ''))})
         process.stderr.write(${JSON.stringify(stderr.join('\n') + (stderr.length ? '\n' : ''))})
         process.exit(${code})`,
  ].join('\n')
  writeFileSync(path, body)
  return path
}

/** Cross-platform executable wrapper around the fake CLI. */
function wrapCli(dir, cli, wrapperName = 'claude') {
  const wrapper = join(dir, wrapperName)
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  return wrapper
}

/** A successful result line (the LAST stdout line the real CLI prints). */
function resultLine({ text = 'pong', sessionId = SESSION_ID, isError = false, error } = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: isError ? 'error' : 'success',
    session_id: sessionId,
    ...(isError ? { error } : { result: text }),
    is_error: isError,
  })
}

function readArgv(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-bridge-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('claude bridge exposes the contract and preallocates a pending session uuid', async () => {
  const bridge = createClaudeBridge()
  for (const method of ['create', 'submit', 'reconnect', 'dispose']) {
    assert.equal(typeof bridge[method], 'function', `${method} on the contract`)
  }
  const remote = await bridge.create('/tmp')
  assert.equal(remote.kind, 'claude')
  assert.match(remote.pendingSessionId, /^[0-9a-f-]{36}$/, 'UUID preallocated for --session-id')
  assert.equal(remote.sessionId, undefined)
})

test('first turn: --session-id preallocates, task after --, last-line JSON parsed, session captured', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeClaude({
    dir,
    argvLog,
    // streaming preamble lines then the terminal result JSON — the bridge
    // must parse ONLY the last non-empty line
    stdout: [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking…' }] } }),
      resultLine({ text: 'pong' }),
    ],
  })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create('/tmp')
  const preallocated = remote.pendingSessionId

  const out = await bridge.submit(remote, 'reply with exactly: pong', undefined, dir)
  assert.equal(out.text, 'pong')
  assert.equal(out.stopReason, 'completed')

  const argv = readArgv(argvLog)
  assert.ok(argv.includes('-p') && argv.includes('--output-format') && argv.includes('json'))
  const sIdx = argv.indexOf('--session-id')
  assert.ok(sIdx >= 0, '--session-id on the first turn')
  assert.equal(argv[sIdx + 1], preallocated)
  // rule 7: task text is the positional AFTER `--` — a "-"-leading task stays
  // prompt text
  const dd = argv.indexOf('--')
  assert.ok(dd >= 0, 'a literal -- separator is present')
  assert.equal(argv[argv.length - 1], 'reply with exactly: pong')
  assert.equal(argv.lastIndexOf('--'), argv.length - 2, '-- is the second-to-last argv element')
  // session id promoted from the CLI-confirmed result
  assert.equal(remote.sessionId, SESSION_ID)
  assert.equal(remote.pendingSessionId, undefined)
})

test('a leading-dash task stays prompt text after -- (rule 7)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeClaude({ dir, argvLog, stdout: [resultLine({ text: 'ok' })] })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await bridge.submit(remote, '--dangerously-skip-permissions', undefined, dir)
  const argv = readArgv(argvLog)
  assert.equal(argv[argv.length - 1], '--dangerously-skip-permissions', 'the flag-looking task rides as the final positional')
})

test('second turn resumes with --resume <id> and no --session-id', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeClaude({
    dir,
    argvLog,
    stdout: [resultLine({ text: 'pong', sessionId: '99999999-8888-7777-6666-555555555555' })],
  })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.reconnect(SESSION_ID)
  assert.equal(remote.sessionId, SESSION_ID)
  const out = await bridge.submit(remote, 'what was the word?', undefined, dir)
  assert.equal(out.text, 'pong')
  const argv = readArgv(argvLog)
  const rIdx = argv.indexOf('--resume')
  assert.ok(rIdx >= 0, '--resume carries the CLI-confirmed session id')
  assert.equal(argv[rIdx + 1], SESSION_ID)
  assert.ok(!argv.includes('--session-id'), 'no --session-id once the real id is known')
})

test('an interrupted first turn promotes pendingSessionId so the NEXT turn resumes it', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // turn 1: the CLI hangs mid-stream and gets killed by the timeout — the
  // bridge must still promote the preallocated id (claude persists the
  // session under exactly that id). The claude bridge surfaces runCommand's
  // rejection as-is (no killed→TimeoutError remap like grok/codex): the
  // contract here is the '(timeout)' marker in the message + the promotion.
  const argvLog1 = join(dir, 'argv-1.json')
  const cli1 = fakeClaude({ dir, argvLog: argvLog1, name: 'c1.mjs', stdout: [], code: 0, hangMs: 30000 })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli1, 'claude1'), timeoutMs: 2500 })
  const remote = await bridge.create()
  const preallocated = remote.pendingSessionId
  await assert.rejects(
    () => bridge.submit(remote, 'first attempt', undefined, dir),
    (error) => {
      assert.match(error.message, /\(timeout\)/, 'the timeout marker rides the rejection')
      return true
    },
  )
  assert.equal(remote.sessionId, preallocated, 'interrupted first turn promoted the preallocated id')
  assert.equal(remote.pendingSessionId, undefined)

  // turn 2 (new CLI instance): must resume with --resume <promoted id>
  const argvLog2 = join(dir, 'argv-2.json')
  const cli2 = fakeClaude({ dir, argvLog: argvLog2, name: 'c2.mjs', stdout: [resultLine({ text: 'recovered' })] })
  const bridge2 = createClaudeBridge({ command: wrapCli(dir, cli2, 'claude2'), timeoutMs: 30000 })
  const out = await bridge2.submit(remote, 'continue', undefined, dir)
  assert.equal(out.text, 'recovered')
  const argv = readArgv(argvLog2)
  const rIdx = argv.indexOf('--resume')
  assert.ok(rIdx >= 0, 'the next submission resumes the promoted id')
  assert.equal(argv[rIdx + 1], preallocated)
})

test('an is_error result fails loud with the CLI error wording', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeClaude({
    dir,
    argvLog,
    stdout: [resultLine({ isError: true, error: 'Credit balance too low', sessionId: SESSION_ID })],
  })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    /Credit balance too low/,
  )
})

test('non-JSON output fails as unparseable (never empty-string success)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeClaude({ dir, argvLog, stdout: ['Internal Error: Something broke'] })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    /claude returned unparseable output: Internal Error/,
  )
})

test('abort discards partial output (never half an answer)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // The claude bridge surfaces runCommand's rejection as-is: an aborted run
  // dies with the '(abort)' marker (and the promoted pending session id).
  const cli = fakeClaude({ dir, argvLog: join(dir, 'argv.json'), stdout: [], code: 0, hangMs: 30000 })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const preallocated = remote.pendingSessionId
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    () => bridge.submit(remote, 'task', controller.signal, dir),
    (error) => {
      assert.match(error.message, /\(abort\)/, 'the abort marker rides the rejection')
      return true
    },
  )
  assert.equal(remote.sessionId, preallocated, 'the aborted first turn still promoted its id for resume')
})

test('timeout kills the turn with the timeout marker', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const cli = fakeClaude({ dir, argvLog: join(dir, 'argv.json'), stdout: [], code: 0, hangMs: 30000 })
  const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 500 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    /\(timeout\)/,
  )
})

test('model / reasoning effort / permissionMode map onto claude flags', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const cases = [
    [{ model: 'claude-sonnet-4-5', reasoningEffort: 'high' }, (argv) => {
      const m = argv.indexOf('--model')
      assert.ok(m >= 0 && argv[m + 1] === 'claude-sonnet-4-5')
      const e = argv.indexOf('--effort')
      assert.ok(e >= 0 && argv[e + 1] === 'high')
    }],
    [{ permissionMode: 'readonly' }, (argv) => {
      const p = argv.indexOf('--permission-mode')
      assert.ok(p >= 0 && argv[p + 1] === 'plan', 'readonly → plan')
    }],
    [{ permissionMode: 'full' }, (argv) => {
      assert.ok(argv.includes('--dangerously-skip-permissions'), 'full → bypass all checks')
    }],
    [{ permissionMode: 'default' }, (argv) => {
      assert.ok(!argv.includes('--permission-mode') && !argv.includes('--dangerously-skip-permissions'), 'default → the product own defaults')
    }],
  ]
  for (const [settings, check] of cases) {
    const argvLog = join(dir, `argv-${Math.random().toString(36).slice(2)}.json`)
    const cli = fakeClaude({ dir, argvLog, name: `c-${Math.random().toString(36).slice(2)}.mjs`, stdout: [resultLine()] })
    const bridge = createClaudeBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
    const remote = await bridge.create()
    await bridge.submit(remote, 'task', undefined, dir, settings)
    check(readArgv(argvLog))
  }
})

test('secrets in the answer text are redacted by default; redactSecrets:false passes them through', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const mk = async (redactSecrets) => {
    const argvLog = join(dir, `argv-${redactSecrets}.json`)
    const cli = fakeClaude({
      dir,
      argvLog,
      name: `c-${redactSecrets}.mjs`,
      stdout: [resultLine({ text: 'token: Bearer abc.def+ghi==' })],
    })
    const bridge = createClaudeBridge({
      command: wrapCli(dir, cli, `claude-${redactSecrets}`),
      timeoutMs: 30000,
      ...(redactSecrets === false ? { redactSecrets } : {}),
    })
    const remote = await bridge.create()
    return bridge.submit(remote, 'task', undefined, dir)
  }
  const clean = await mk(true)
  assert.ok(!clean.text.includes('abc.def+ghi'), 'secret scrubbed from the final text')
  assert.ok(clean.text.includes('[REDACTED:bearer]'))
  const raw = await mk(false)
  assert.ok(raw.text.includes('Bearer abc.def+ghi=='), 'raw passthrough when explicitly disabled')
})

test('flag injection is refused by the whitelist (claude safeFlagValue)', () => {
  for (const evil of [
    'x", something_else="y',
    '-something',
    'a b',
    'x;y',
    'claude$(pwn)',
  ]) {
    assert.throws(() => safeFlagValue(evil, 'model'), /unsafe model/, `claude refuses ${evil}`)
  }
  assert.equal(safeFlagValue('claude-sonnet-4-5', 'model'), 'claude-sonnet-4-5')
  assert.equal(safeFlagValue('low', 'reasoningEffort'), 'low')
})
