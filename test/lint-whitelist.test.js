import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WHITELIST, checkWhitelist } from '../scripts/lint.js'

// Red line 12 / DESIGN §6.4.4: imports from `@deepseek-ai/dsh-subagent` are
// forever restricted to the pure-function whitelist. checkWhitelist is the
// exported scanning function from scripts/lint.js; we test it directly against
// in-memory sources (no real whitelist-violating file is ever written to the
// repo), plus one end-to-end run of `node scripts/lint.js` asserting it exits 0
// on the current, compliant tree.

const P = `'@deepseek-ai/dsh-subagent'`

test('whitelist covers the two designated pure functions', () => {
  assert.deepEqual(WHITELIST, ['assertSubagentMaxDepth', 'settleRun'])
})

test('clean: a whitelisted single-line import reports nothing', () => {
  const src = {
    'lib/x.js': `import { settleRun } from ${P}\nimport { assertSubagentMaxDepth } from ${P}\n`,
  }
  assert.deepEqual(checkWhitelist(src), [])
})

test('clean: comma + trailing-comma + multi-line forms are accepted', () => {
  const src = {
    'lib/x.js': `import { assertSubagentMaxDepth, settleRun } from ${P}\n`,
    'lib/y.mjs': `import {\n  assertSubagentMaxDepth,\n  settleRun,\n} from ${P}\n`,
  }
  assert.deepEqual(checkWhitelist(src), [])
})

test('clean: `a as b` aliasing of a whitelisted symbol is accepted', () => {
  const src = { 'lib/x.js': `import { settleRun as settle } from ${P}\n` }
  assert.deepEqual(checkWhitelist(src), [])
})

test('violation: a single non-whitelisted symbol is reported with file/line/symbol', () => {
  const src = { 'lib/x.js': `import { evil } from ${P}\nconst a = 1\n` }
  const r = checkWhitelist(src)
  assert.equal(r.length, 1)
  assert.equal(r[0].file, 'lib/x.js')
  assert.equal(r[0].line, 1)
  assert.equal(r[0].symbol, 'evil')
})

test('violation: multi-line import, one bad member, reported on its import line', () => {
  const src = {
    'test/fake.js': 'import {\n  settleRun,\n  hack,\n} from ' + P + '\n',
  }
  const r = checkWhitelist(src)
  assert.equal(r.length, 1)
  assert.equal(r[0].file, 'test/fake.js')
  assert.equal(r[0].line, 1)
  assert.equal(r[0].symbol, 'hack')
})

test('violation: multiple offending symbols each yield an entry', () => {
  const src = { 'lib/x.js': `import { evil, worse } from ${P}\n` }
  const r = checkWhitelist(src)
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((v) => v.symbol), ['evil', 'worse'])
})

test('clean: imports of other / non-brace (namespace) modules are ignored', () => {
  const src = {
    'lib/x.js':
      "import { anything } from 'yaml'\n" +
      "import * as all from '@deepseek-ai/dsh-subagent'\n" +
      `import { settleRun } from ${P}\n`,
  }
  assert.deepEqual(checkWhitelist(src), [])
})

test('end-to-end: `node scripts/lint.js` exits 0 on the compliant repo', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  execFileSync(process.execPath, ['scripts/lint.js'], {
    cwd: root,
    stdio: 'pipe',
  })
})
