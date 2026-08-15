import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRoleLibrary } from '../lib/roles.js'

function makeRolesDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'roles-'))
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

test('loads roles with delegation default ON and explicit false', () => {
  const dir = makeRolesDir({
    'a.json': { description: 'A', permissionMode: 'readonly' },
    'b.json': { description: 'B', allowDelegation: false },
    'c.json': { description: 'C', allowDelegation: true, permissionMode: 'full' },
  })
  try {
    const lib = createRoleLibrary(dir)
    const roles = lib.list()
    // a + b + c + the built-in general fallback (the test dir has no general)
    assert.equal(roles.length, 4)
    const byId = Object.fromEntries(roles.map((r) => [r.id, r]))
    assert.equal(byId.a.allowDelegation, true, 'unspecified delegation defaults to true')
    assert.equal(byId.b.allowDelegation, false, 'explicit false bans delegation')
    assert.equal(byId.c.allowDelegation, true)
    assert.equal(byId.a.permissionMode, 'readonly')
    assert.equal(byId.c.permissionMode, 'full')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid permissionMode falls back to default', () => {
  const dir = makeRolesDir({ 'x.json': { description: 'X', permissionMode: 'banana' } })
  try {
    const lib = createRoleLibrary(dir)
    assert.equal(lib.get('x').permissionMode, 'default')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown role id returns null (no silent full-permission fallback); missing library gets built-in general', () => {
  const dir = makeRolesDir({})
  try {
    const lib = createRoleLibrary(dir)
    assert.equal(lib.get('nope'), null, 'unknown role must fail loudly at the caller')
    assert.equal(lib.get('general').permissionMode, 'full')
    assert.equal(lib.get('general').allowDelegation, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('malformed role files are skipped without breaking the library', () => {
  const dir = makeRolesDir({
    'good.json': { description: 'good' },
    'bad.json': 'not json',
  })
  try {
    const lib = createRoleLibrary(dir)
    assert.equal(lib.get('good').id, 'good')
    assert.ok(!lib.list().some((r) => r.id === 'bad'), 'malformed role is not loaded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- extended: backend / overrides ---

test('backend parses: explicit names are kept, omitted/empty resolve to caller-choose', () => {
  const dir = makeRolesDir({
    'native.json': { description: 'native', backend: 'native' },
    'bridge.json': { description: 'bridge', backend: 'codex' },
    'empty.json': { description: 'empty', backend: '' },
    'omitted.json': { description: 'omitted' },
  })
  try {
    const lib = createRoleLibrary(dir)
    assert.equal(lib.get('native').backend, 'native')
    assert.equal(lib.get('bridge').backend, 'codex', 'non-empty backend passed through without existence check')
    assert.equal(lib.get('empty').backend, '', 'explicit empty string = caller chooses')
    assert.equal(lib.get('omitted').backend, '', 'omitted backend = caller chooses')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('overrides are passed through verbatim and default to empty object when absent', () => {
  const dir = makeRolesDir({
    'over.json': {
      description: 'over',
      overrides: {
        agentOptions: { provider: 'newapi', model: 'glm-5.3' },
        persona: '@preset:codex',
        toolFilter: { deny: ['write', 'edit'] },
        maxDepth: 1,
      },
    },
    'none.json': { description: 'none' },
    'partial.json': { description: 'partial', overrides: { maxDepth: 2 } },
  })
  try {
    const lib = createRoleLibrary(dir)
    const over = lib.get('over')
    assert.deepEqual(over.overrides, {
      agentOptions: { provider: 'newapi', model: 'glm-5.3' },
      persona: '@preset:codex',
      toolFilter: { deny: ['write', 'edit'] },
      maxDepth: 1,
    }, 'overrides passed through verbatim, no deep validation')
    assert.deepEqual(lib.get('none').overrides, {}, 'absent overrides default to empty object')
    assert.deepEqual(lib.get('partial').overrides, { maxDepth: 2 }, 'partial overrides kept as-is')
    assert.equal(lib.get('over').maxDepth, undefined, 'overrides are nested, not flattened onto the role')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('old role files without new fields still load unchanged and the built-in general carries backend/overrides', () => {
  const dir = makeRolesDir({})
  try {
    const lib = createRoleLibrary(dir)
    const general = lib.get('general')
    assert.equal(general.permissionMode, 'full')
    assert.equal(general.allowDelegation, true)
    assert.equal(general.backend, '', 'built-in general backend = caller chooses')
    assert.deepEqual(general.overrides, {}, 'built-in general carries an empty overrides block')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
