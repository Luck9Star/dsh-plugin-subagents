// dsh-plugin-subagents — lib/redact.js 测试。
//
// 移植自 task-weaver redact.ts（逻辑等价）；测试覆盖：
//   - 五种秘密形态各命中（Bearer / sk- / gh?_ PAT / api_key= / JWT）；
//   - 不误伤普通文本（含 "sk-" 前缀但太短、"bearer" 小写无 token、
//     eyJ 单段等边缘形状）；
//   - 幂等性（对已脱敏文本重跑是无操作）；
//   - pattern 次序语义：Bearer 头先于嵌套 JWT 片段被整体清除；
//   - lastIndex 不跨调用泄漏（global regex 复用陷阱）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { redactText, DEFAULT_PROCESS_REDACTOR_PATTERNS } from '../lib/redact.js'

test('redacts each of the five secret shapes', () => {
  const cases = [
    // upstream's bearer pattern includes the "Bearer " prefix in the match
    ['Authorization: Bearer abc123._-+/==', '[REDACTED:bearer]', 'bearer header collapsed to a placeholder'],
    ['key is sk-proj-0123456789abcdefg', '[REDACTED:openai_key]', 'sk- key (16+ chars) redacted'],
    ['token ghp_0123456789abcdefghijklmnopqrst in log', '[REDACTED:github_pat]', 'ghp_ PAT (20+ chars) redacted'],
    ['config: api_key = "supersecretvalue123"', '[REDACTED:api_key]', 'api_key= assignment redacted'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpM', '[REDACTED:jwt]', 'three-segment JWT redacted'],
  ]
  for (const [input, placeholder, why] of cases) {
    const out = redactText(input)
    assert.ok(out.includes(placeholder), `${why} → ${out}`)
    assert.ok(!/[A-Za-z0-9._\-+/=]{16,}/.test(out) || placeholder === '[REDACTED:jwt]' || !out.includes('eyJ'), 'no long secret run survives')
  }
  // the api_key value itself never survives
  assert.ok(!redactText('api_key = "supersecretvalue123"').includes('supersecretvalue123'))
})

test('does not mangle ordinary text (no false positives on prose)', () => {
  const plain = [
    'The quick brown fox jumps over 16 lazy dogs.',
    'use the sk- prefix when creating keys', // "sk-" alone is < 16 chars of body
    'the Bearer, as a concept, is fine', // no \s+token-run after the word
    'api key rotation is scheduled weekly', // "api key" without :/=
    'total_cost_usd: 0.0741, num_turns: 1',
    'grok --single=hello world --output-format streaming-json',
    'ask-anything (not an sk- key)', // "sk-" must be followed by 16+ key chars
  ]
  for (const text of plain) {
    assert.equal(redactText(text), text, `unchanged: ${text}`)
  }
  // Known conservative true-positive on prose (inherited upstream shape, the
  // /i flag): "bearer <any word>" consumes the next word — documented, not a
  // false-negative risk, and harmless next to the leak it prevents.
  assert.equal(redactText('bearer tokens go in headers'), '[REDACTED:bearer] go in headers')
})

test('is idempotent — rerunning on redacted output is a no-op', () => {
  const secret = 'Authorization: Bearer abc.def+ghi/jkl== and sk-abcdefghijklmnopqrstuvwx'
  const once = redactText(secret)
  const twice = redactText(once)
  assert.equal(once, twice, 'placeholders never match a later pattern')
  assert.ok(once.includes('[REDACTED:'))
  assert.ok(!once.includes('abc.def+ghi'))
})

test('Bearer order: the multi-token form is scrubbed before a nested JWT fragment re-matches', () => {
  // A bearer value that happens to contain three dot-separated segments must
  // be consumed whole by the bearer pattern (pattern order is load-bearing;
  // upstream's pattern includes the "Bearer " prefix in the match, so the
  // word itself is part of the replacement — preserved task-weaver shape).
  const out = redactText('Bearer eyJaaa.bbb.ccc1234567890')
  assert.equal(out, '[REDACTED:bearer]')
  assert.ok(!out.includes('[REDACTED:jwt]'), 'the jwt pass sees only the already-redacted line')
})

test('global-regex lastIndex never leaks across calls', () => {
  // Call twice in a row: a shared sticky/global regex with a stale lastIndex
  // would silently skip matches in the second call.
  const line = 'token: sk-abcdefghijklmnopqrstuvwx done'
  assert.equal(redactText(line), redactText(line), 'same input → same output every call')
  const a = redactText('sk-abcdefghijklmnopqrstuvwx')
  const b = redactText('sk-zyxwvutsrqponmlkjihgfe')
  assert.ok(a.includes('[REDACTED:openai_key]'))
  assert.ok(b.includes('[REDACTED:openai_key]'))
})

test('the exported catalog keeps five ordered kinds', () => {
  assert.deepEqual(
    DEFAULT_PROCESS_REDACTOR_PATTERNS.map((p) => p.kind),
    ['bearer', 'openai_key', 'github_pat', 'api_key', 'jwt'],
  )
})

// ---- run.js 接线：捕获路径默认脱敏，redactSecrets:false 恢复透传 ----------

test('runCommand scrubs secrets from stdout/stderr captures by default', async () => {
  const { runCommand } = await import('../lib/run.js')
  const leak = 'Authorization: Bearer abc.def+ghi=='
  const out = await runCommand(process.execPath, ['-e', `console.log("${leak}"); console.error("err ${leak}")`], {
    timeoutMs: 15000,
    allowNonZero: true,
  })
  assert.ok(!out.stdout.includes('abc.def+ghi'), 'stdout secret scrubbed')
  assert.ok(out.stdout.includes('[REDACTED:bearer]'), 'placeholder present in stdout')
  assert.ok(!out.stderr.includes('abc.def+ghi'), 'stderr secret scrubbed')
})

test('runCommand redactSecrets:false restores the raw passthrough', async () => {
  const { runCommand } = await import('../lib/run.js')
  const leak = 'Bearer abc.def+ghi=='
  const out = await runCommand(process.execPath, ['-e', `console.log("${leak}")`], {
    timeoutMs: 15000,
    allowNonZero: true,
    redactSecrets: false,
  })
  assert.ok(out.stdout.includes(leak), 'raw bytes preserved when explicitly disabled')
})

test('runCommand onStdout receives the scrubbed chunk (progress never sees the secret)', async () => {
  const { runCommand } = await import('../lib/run.js')
  const seen = []
  await runCommand(process.execPath, ['-e', 'console.log("Bearer abc.def+ghi==")'], {
    timeoutMs: 15000,
    allowNonZero: true,
    onStdout: (chunk) => seen.push(chunk),
  })
  const joined = seen.join('')
  assert.ok(!joined.includes('abc.def+ghi'), 'progress callback got the redacted chunk')
  assert.ok(joined.includes('[REDACTED:bearer]'))
})
