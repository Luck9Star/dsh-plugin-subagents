import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectAvailability, authChecks } from '../lib/availability.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'avail-test-'))
}

test('detectAvailability: absolute existing command registers; missing does not', async () => {
  const dir = tempDir()
  try {
    const present = join(dir, 'fake-cli')
    const absent = join(dir, 'does-not-exist')
    writeFileSync(present, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    assert.ok(existsSync(present))

    const result = await detectAvailability({
      present: { command: present },
      absent: { command: absent },
    })
    assert.equal(result.present.registered, true)
    assert.equal(result.present.command, true)
    assert.match(result.present.reason, /available/)
    assert.equal(result.absent.registered, false)
    assert.equal(result.absent.command, false)
    assert.match(result.absent.reason, /not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectAvailability: command present but auth broken is reported as not-ready', async () => {
  const dir = tempDir()
  try {
    const present = join(dir, 'fake-cli')
    writeFileSync(present, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const result = await detectAvailability({
      authed: {
        command: present,
        checkAuth: () => ({ ok: false, note: 'creds missing' }),
      },
    })
    assert.equal(result.authed.registered, true)
    assert.ok(result.authed.reason.includes('creds missing'), 'reason surfaces the auth note')
    assert.equal(result.authed.auth.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectAvailability: providers without a command are unregistered', async () => {
  const result = await detectAvailability({ none: { command: undefined } })
  assert.equal(result.none.registered, false)
  assert.match(result.none.reason, /not found/)
})

test('authChecks: acp always ok; others inspect their home-dir login artifacts', () => {
  const acp = authChecks.acp()
  assert.equal(acp.ok, true)
  // claude-code and codex reflect whatever artifacts exist in this home
  const claude = authChecks['claude-code']()
  assert.equal(typeof claude.ok, 'boolean')
  assert.equal(typeof claude.note, 'string')
  const codex = authChecks.codex()
  assert.equal(typeof codex.ok, 'boolean')
  assert.equal(typeof codex.note, 'string')
})
