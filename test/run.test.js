import { test } from 'node:test'
import assert from 'node:assert/strict'
import { winArgs, cmdQuote, parentCwd } from '../lib/run.js'

test('winArgs wraps the whole line in one outer quote pair after /s /c', () => {
  const args = winArgs('claude.cmd', ['-p', 'Fix the bug'])
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c'])
  const line = args[3]
  assert.ok(line.startsWith('"'), 'outer wrap starts with a quote')
  assert.ok(line.endsWith('"'), 'outer wrap ends with a quote')
  assert.ok(line.includes('"claude.cmd"'), 'command stays quoted inside')
  assert.ok(line.includes('"Fix the bug"'), 'spaced task stays quoted inside')
})

test('stripping the outer pair (what cmd /s does) leaves a balanced command', () => {
  for (const task of ['Fix the bug in file & run the test', 'say "hi" there', '--dangerously-skip-permissions']) {
    const args = winArgs('C:\\Users\\x\\claude.cmd', ['-p', '--output-format', 'json', task])
    const inner = args[3].slice(1, -1)
    // every argument is still present, metacharacter tasks still quoted
    assert.ok(inner.startsWith('"C:\\Users\\x\\claude.cmd"'))
    if (/[\s"&|<>^()%!]/.test(task)) {
      assert.ok(inner.includes(`"${task.replace(/"/g, '""')}"`), `quoted task survives: ${task}`)
    } else {
      assert.ok(inner.endsWith(task), `plain task survives: ${task}`)
    }
  }
})

test('plain flags stay unquoted; dangerous args stay quoted', () => {
  const args = winArgs('claude.cmd', ['-p', '--model', 'claude-sonnet-5', 'a & b'])
  const inner = args[3].slice(1, -1)
  assert.ok(inner.includes(' -p --model claude-sonnet-5 '))
  assert.ok(inner.includes('"a & b"'))
})

test('cmdQuote wraps and escapes (cmd doubling convention)', () => {
  assert.equal(cmdQuote('a b'), '"a b"')
  assert.equal(cmdQuote('a"b'), '"a""b"', 'embedded quotes double, so cmd parsing never breaks out of the quoted region')
})

test('runCommand reports why the tree was killed', async () => {
  const { runCommand } = await import('../lib/run.js')
  // a process that outlives a tiny timeout, killed explicitly
  const out = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    timeoutMs: 100,
    allowNonZero: true,
  })
  assert.equal(out.killed, 'timeout')
  const out2 = await runCommand(process.execPath, ['-e', 'console.log("ok")'], { timeoutMs: 10000 })
  assert.equal(out2.killed, undefined)
  assert.match(out2.stdout, /ok/)
})

test('parentCwd falls back to process.cwd()', () => {
  assert.equal(parentCwd(null), process.cwd())
  assert.equal(parentCwd({}), process.cwd())
  assert.equal(parentCwd({ session: { header: { cwd: '/tmp/x' } } }), '/tmp/x')
})
