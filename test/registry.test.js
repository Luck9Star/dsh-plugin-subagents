import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRegistry, DEFAULT_PATH } from '../lib/registry.js'

test('registry round-trips set/get/remove', () => {
  const path = join(tmpdir(), `reg-test-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    assert.equal(reg.get('child-1'), undefined)
    reg.set('child-1', { backend: 'acp', remoteId: 'ses_123', cwd: '/tmp' })
    const got = reg.get('child-1')
    assert.equal(got.backend, 'acp')
    assert.equal(got.remoteId, 'ses_123')
    assert.equal(typeof got.updatedAt, 'number')
    reg.remove('child-1')
    assert.equal(reg.get('child-1'), undefined)
    assert.ok(existsSync(path), 'registry file persisted')
  } finally {
    rmSync(path, { force: true })
    rmSync(`${path}.tmp`, { force: true })
  }
})

test('registry reloads from disk across instances', () => {
  const path = join(tmpdir(), `reg-test2-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    reg.set('child-9', { backend: 'codex', remoteId: 'thread-1', cwd: '/tmp' })
    const reg2 = createRegistry(path)
    assert.equal(reg2.get('child-9').remoteId, 'thread-1')
    // atomic write means no stray .tmp
    assert.equal(existsSync(`${path}.tmp`), false)
  } finally {
    rmSync(path, { force: true })
    rmSync(`${path}.tmp`, { force: true })
  }
})

test('registry persists and restores the child settings (permission ceiling)', () => {
  const path = join(tmpdir(), `reg-test3-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    reg.set('child-a', { backend: 'claude-code', remoteId: 's1', cwd: '/tmp', settings: { permissionMode: 'readonly', model: 'x' } })
    const got = reg.get('child-a')
    assert.equal(got.settings.permissionMode, 'readonly')
    assert.equal(got.settings.model, 'x')
    // a settings-free entry (pre-upgrade) reads back without the key
    reg.set('child-b', { backend: 'codex', remoteId: 't2', cwd: '/tmp' })
    assert.equal(reg.get('child-b').settings, undefined)
  } finally {
    rmSync(path, { force: true })
  }
})

test('registry prunes to the newest MAX entries', () => {
  const path = join(tmpdir(), `reg-test4-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    for (let i = 0; i < 510; i += 1) {
      reg.set(`child-${String(i).padStart(4, '0')}`, { backend: 'acp', remoteId: `s${i}`, cwd: '/tmp' })
    }
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const keys = Object.keys(raw)
    assert.equal(keys.length, 500, 'pruned to the cap')
    assert.notEqual(raw['child-0509'], undefined, 'newest entries survive')
    assert.notEqual(raw['child-0010'], undefined, 'boundary entry survives')
    assert.equal(raw['child-0009'], undefined, 'oldest entries pruned')
  } finally {
    rmSync(path, { force: true })
  }
})

test('registry ignores prototype-polluting keys', () => {
  const path = join(tmpdir(), `reg-test5-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    reg.set('__proto__', { backend: 'acp', remoteId: 'evil', cwd: '/tmp' })
    reg.set('constructor', { backend: 'acp', remoteId: 'evil', cwd: '/tmp' })
    assert.equal(reg.get('__proto__'), undefined)
    assert.equal(reg.get('constructor'), undefined)
    assert.equal(({}).evil, undefined, 'Object.prototype untouched')
    assert.equal(reg.size, 0)
  } finally {
    rmSync(path, { force: true })
  }
})

test('registry file is written owner-only (0600)', { skip: process.platform === 'win32' }, () => {
  const path = join(tmpdir(), `reg-test6-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    reg.set('child-p', { backend: 'acp', remoteId: 's', cwd: '/tmp' })
    const mode = statSync(path).mode & 0o777
    assert.equal(mode, 0o600)
  } finally {
    rmSync(path, { force: true })
  }
})

test('registry default path is ~/.dsh/subagents-registry.json', () => {
  // the default path constant migrated away from the old product path
  assert.equal(DEFAULT_PATH, join(homedir(), '.dsh', 'subagents-registry.json'))
  assert.ok(!DEFAULT_PATH.includes('product-subagents-registry.json'), 'old product registry path is gone')
})

test('registry persists the backend field on disk', () => {
  const path = join(tmpdir(), `reg-test7-${Date.now()}.json`)
  try {
    const reg = createRegistry(path)
    reg.set('child-d', { backend: 'codex', remoteId: 'thread-9', cwd: '/tmp' })
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(raw['child-d'].backend, 'codex')
  } finally {
    rmSync(path, { force: true })
    rmSync(`${path}.tmp`, { force: true })
  }
})
