// dsh-plugin-subagents — lib/bridges/codex.js 进程级回归测试（G-1）。
//
// 全部 fake：CLI 是「node 脚本 shim」（跨平台，复刻 grok-bridge.test.js 的
// shim 模式），按收到的 argv 回放 fixture 输出 —— 无真实 codex、无 API
// key、无网络。fixture 事件流照 codex-cli 0.147.0 `codex exec --json` 的
// 顶层点分事件形状（thread.started / item.completed / turn.completed），
// 并保留旧下划线形状（thread_started / agent_message / run_result）与纯
// 文本输出的回退路径。
//
// 覆盖：
//   - bridge 契约四方法；
//   - argv 构造：exec --json --skip-git-repo-check 常驻、`--` 后跟任务、
//     resume 子命令（0.147 起 resume 是子命令而非 --resume flag）；
//   - thread.started 增量捕获：onStdout 阶段捕获 threadId —— 中断回合
//     （thread.started 已到、item.completed 未完）后 threadId 已在手，
//     下次提交走 `exec resume <thread_id>`；
//   - item.completed 文本拼接（多块 agent_message 顺序拼接）；
//   - error / turn.failed 事件 → 抛 `codex: <message>`（即使 exit 0）；
//   - 半行 JSON 容错：截断的 JSONL 行被丢弃、不透传、不影响其余行；
//   - 非零退出分类：无 text → 抛 `codex exited N`；有 text → stopReason
//     'error' 带 text；
//   - 纯文本回退：无 JSONL 事件时取非 { 开头的行为答案；
//   - 超时（TimeoutError）/ abort（AbortError）：部分输出丢弃；
//   - -c model=… / -c model_reasoning_effort=… / permissionMode 三映射
//     （readonly → -s read-only；full → --dangerously-bypass…）；
//   - flag 注入拒绝（safeConfigValue 白名单）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { createCodexBridge, safeConfigValue } from '../lib/bridges/codex.js'

const THREAD_ID = 'th_0123456789abcdef'

/** Write a fake `codex` CLI: echoes argv to a file, then replays stdout/stderr. */
function fakeCodex({ dir, argvLog, name = 'codex-fake.mjs', stdout = [], stderr = [], code = 0, hangMs = 0, partialLine = false }) {
  const path = join(dir, name)
  const outText = stdout.join('\n') + (stdout.length ? '\n' : '')
  const lines = [
    'import { writeFileSync } from "node:fs"',
    `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)))`,
  ]
  if (hangMs > 0) {
    lines.push(
      'import { setTimeout as sleep } from "node:timers/promises"',
      `process.stdout.write(${JSON.stringify(outText)})`,
      // an optional truncated (no trailing newline) JSON line before hanging —
      // a stream cut mid-line, exactly the half-line-JSON hazard class
      partialLine ? `process.stdout.write(${JSON.stringify('{"type":"item.comp')})` : '',
      `await sleep(${hangMs})`,
      `process.exit(${code})`,
    )
  } else {
    lines.push(
      `process.stdout.write(${JSON.stringify(outText)})`,
      `process.stderr.write(${JSON.stringify(stderr.join('\n') + (stderr.length ? '\n' : ''))})`,
      `process.exit(${code})`,
    )
  }
  writeFileSync(path, lines.filter(Boolean).join('\n'))
  return path
}

function wrapCli(dir, cli, wrapperName = 'codex') {
  const wrapper = join(dir, wrapperName)
  writeFileSync(wrapper, process.platform === 'win32'
    ? `@echo off\r\n"${execPath}" "${cli}" %*\r\n`
    : `#!/bin/sh\nexec "${execPath}" "${cli}" "$@"\n`,
    process.platform === 'win32' ? {} : { mode: 0o755 })
  return wrapper
}

function readArgv(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/** 0.147-shape fixture: thread.started → two agent_message items → turn.completed. */
function fixtureLines(threadId = THREAD_ID) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: threadId }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'pong' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
  ]
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('codex bridge exposes the contract', async () => {
  const bridge = createCodexBridge()
  for (const method of ['create', 'submit', 'reconnect', 'dispose']) {
    assert.equal(typeof bridge[method], 'function', `${method} on the contract`)
  }
  const remote = await bridge.create('/tmp')
  assert.equal(remote.kind, 'codex')
  assert.equal(remote.threadId, undefined)
})

test('first turn: exec --json --skip-git-repo-check, task after --, item.completed text, thread captured', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({ dir, argvLog, stdout: fixtureLines() })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()

  const out = await bridge.submit(remote, 'reply with exactly: pong', undefined, dir)
  assert.equal(out.text, 'pong')
  assert.equal(out.stopReason, 'completed')

  const argv = readArgv(argvLog)
  assert.ok(argv.includes('exec') && argv.includes('--json') && argv.includes('--skip-git-repo-check'))
  assert.ok(!argv.includes('resume'), 'fresh thread: no resume subcommand')
  const dd = argv.indexOf('--')
  assert.ok(dd >= 0, 'a literal -- separator is present')
  assert.equal(argv[argv.length - 1], 'reply with exactly: pong')
  assert.equal(argv.lastIndexOf('--'), argv.length - 2, '-- is the second-to-last argv element')
  // thread id captured from thread.started
  assert.equal(remote.threadId, THREAD_ID)
})

test('a leading-dash task stays prompt text after -- (rule 7)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({ dir, argvLog, stdout: fixtureLines() })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await bridge.submit(remote, '--dangerously-bypass-approvals-and-sandbox', undefined, dir)
  const argv = readArgv(argvLog)
  assert.equal(argv[argv.length - 1], '--dangerously-bypass-approvals-and-sandbox')
})

test('second turn resumes via the resume SUBCOMMAND (0.147 argv shape)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: fixtureLines('th_ffffeeeeddddcccc'),
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.reconnect(THREAD_ID)
  assert.equal(remote.threadId, THREAD_ID)
  const out = await bridge.submit(remote, 'what was the word?', undefined, dir)
  assert.equal(out.text, 'pong')
  const argv = readArgv(argvLog)
  // resume <thread_id> rides AFTER exec --json as its own subcommand argv
  const rIdx = argv.indexOf('resume')
  assert.ok(rIdx >= 0, 'resume subcommand on later turns')
  assert.equal(argv[rIdx + 1], THREAD_ID)
})

test('thread.started is captured INCREMENTALLY: an interrupted turn still keeps the thread id', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  // The stream reaches thread.started + one partial agent_message, then the
  // process hangs and is killed by the timeout. The incremental onStdout
  // capture must have committed threadId before the kill.
  const argvLog1 = join(dir, 'argv-1.json')
  const cli1 = fakeCodex({
    dir,
    argvLog: argvLog1,
    name: 'c1.mjs',
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial answer' } }),
    ],
    hangMs: 30000,
    partialLine: true,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli1, 'codex1'), timeoutMs: 2500 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    (error) => {
      assert.equal(error.name, 'TimeoutError')
      return true
    },
  )
  assert.equal(remote.threadId, THREAD_ID, 'threadId committed before the kill')

  // the NEXT submission resumes that thread (a NEW CLI instance sees the argv)
  const argvLog2 = join(dir, 'argv-2.json')
  const cli2 = fakeCodex({ dir, argvLog: argvLog2, name: 'c2.mjs', stdout: fixtureLines() })
  const bridge2 = createCodexBridge({ command: wrapCli(dir, cli2, 'codex2'), timeoutMs: 30000 })
  const out = await bridge2.submit(remote, 'continue', undefined, dir)
  assert.equal(out.text, 'pong')
  const argv = readArgv(argvLog2)
  const rIdx = argv.indexOf('resume')
  assert.ok(rIdx >= 0 && argv[rIdx + 1] === THREAD_ID, 'resumes the incrementally captured thread')
})

test('an error event fails loud even when the process exits 0', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'error', message: 'You exceeded your usage limit' }),
    ],
    code: 0,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    (error) => {
      assert.match(error.message, /codex: You exceeded your usage limit/)
      return true
    },
  )
})

test('a turn.failed event surfaces the nested error message', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'stream disconnected' } }),
    ],
    code: 1,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    /codex: stream disconnected/,
  )
})

test('a truncated (half-line) JSON line is dropped silently — never relayed, never fatal', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  // line 2 is valid JSON without its trailing newline; the parse loop must
  // skip it, not crash, and still assemble the text from the OTHER lines.
  const good = fixtureLines()
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [
      good[0],
      good[1].slice(0, -10) + '"}', // corrupt tail → unparseable but complete-looking line
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ' final' } }),
      good[2],
    ],
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  // only the parseable agent_message line contributes
  assert.equal(out.text, ' final')
  assert.equal(out.stopReason, 'completed')
  assert.equal(remote.threadId, THREAD_ID, 'thread.started still parsed from line 1')
})

test('multiple agent_message items concatenate in stream order', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'part one ' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'part two' } }),
      JSON.stringify({ type: 'turn.completed', usage: {} }),
    ],
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'part one part two')
})

test('non-zero exit with NO text fails loud with the output tail', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })],
    stderr: ['ERROR: codex auth login required'],
    code: 1,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    (error) => {
      assert.match(error.message, /codex exited 1/)
      assert.match(error.message, /codex auth login required/)
      return true
    },
  )
})

test('non-zero exit WITH text resolves as stopReason error (the turn partially succeeded)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }),
    ],
    code: 1,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'partial')
  assert.equal(out.stopReason, 'error')
})

test('plain-text output (no JSONL events) falls back to the non-JSON lines', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: ['plain answer line one', 'plain answer line two', ''],
    code: 0,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  assert.equal(out.text, 'plain answer line one\nplain answer line two')
  assert.equal(out.stopReason, 'completed')
})

test('old underscore event shapes still parse (pre-0.147 fallback)', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const argvLog = join(dir, 'argv.json')
  const cli = fakeCodex({
    dir,
    argvLog,
    stdout: [
      JSON.stringify({ type: 'thread_started', payload: { thread_id: THREAD_ID } }),
      JSON.stringify({ type: 'agent_message', payload: { text: 'legacy answer' } }),
      JSON.stringify({ type: 'run_result', payload: { result: 'final from run_result' } }),
    ],
    code: 0,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const out = await bridge.submit(remote, 'task', undefined, dir)
  // run_result REPLACES the accumulated agent_message text (payload.result wins)
  assert.equal(out.text, 'final from run_result')
  assert.equal(remote.threadId, THREAD_ID)
})

test('abort discards partial output with AbortError', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const cli = fakeCodex({
    dir,
    argvLog: join(dir, 'argv.json'),
    stdout: [JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID })],
    hangMs: 30000,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
  const remote = await bridge.create()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 150)
  await assert.rejects(
    () => bridge.submit(remote, 'task', controller.signal, dir),
    (error) => {
      assert.equal(error.name, 'AbortError')
      assert.match(error.message, /interrupted/)
      return true
    },
  )
})

test('timeout kills the turn with TimeoutError and discards partial output', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const cli = fakeCodex({
    dir,
    argvLog: join(dir, 'argv.json'),
    stdout: [
      JSON.stringify({ type: 'thread.started', thread_id: THREAD_ID }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }),
    ],
    hangMs: 30000,
  })
  const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 500 })
  const remote = await bridge.create()
  await assert.rejects(
    () => bridge.submit(remote, 'task', undefined, dir),
    (error) => {
      assert.equal(error.name, 'TimeoutError')
      assert.match(error.message, /timed out/)
      assert.match(error.message, /partial output discarded/, 'partial text is explicitly discarded')
      return true
    },
  )
})

test('model / reasoning effort ride -c key=value; permissionMode maps to sandbox flags', async (t) => {
  const { dir, done } = tempDir()
  t.after(done)
  const cases = [
    [{ model: 'gpt-5.2-codex', reasoningEffort: 'high' }, (argv) => {
      assert.ok(argv.includes('-c') && argv.includes('model=gpt-5.2-codex'), 'model as -c model=…')
      assert.ok(argv.includes('model_reasoning_effort=high'), 'effort as -c model_reasoning_effort=…')
    }],
    [{ permissionMode: 'readonly' }, (argv) => {
      const s = argv.indexOf('-s')
      assert.ok(s >= 0 && argv[s + 1] === 'read-only', 'readonly → -s read-only')
    }],
    [{ permissionMode: 'full' }, (argv) => {
      assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'), 'full → bypass flags')
    }],
    [{ permissionMode: 'default' }, (argv) => {
      assert.ok(!argv.includes('-s') && !argv.includes('--dangerously-bypass-approvals-and-sandbox'), 'default → own sandbox')
    }],
  ]
  for (const [settings, check] of cases) {
    const argvLog = join(dir, `argv-${Math.random().toString(36).slice(2)}.json`)
    const cli = fakeCodex({ dir, argvLog, name: `c-${Math.random().toString(36).slice(2)}.mjs`, stdout: fixtureLines() })
    const bridge = createCodexBridge({ command: wrapCli(dir, cli), timeoutMs: 30000 })
    const remote = await bridge.create()
    await bridge.submit(remote, 'task', undefined, dir, settings)
    check(readArgv(argvLog))
  }
})

test('config injection is refused by the whitelist (codex safeConfigValue)', () => {
  for (const evil of [
    'x", sandbox_mode="danger-full-access',
    '-something',
    'a b',
    'key=value',
    'x;y',
  ]) {
    assert.throws(() => safeConfigValue(evil, 'model'), /unsafe model/, `codex refuses ${evil}`)
  }
  assert.equal(safeConfigValue('gpt-5.2-codex', 'model'), 'gpt-5.2-codex')
  assert.equal(safeConfigValue('low', 'reasoningEffort'), 'low')
})
