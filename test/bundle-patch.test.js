// dsh-plugin-subagents — cordis.patch.yml bundle patch 测试（T15）。
//
// 覆盖：
//   - patch YAML 可解析为 patch 行数组（yaml 包）。
//   - disable 两行：id 严格等于官方 dsh-base cordis.patch.yml 中被禁用的行 id
//     （tool-subagent / tool-subagent-fork）。读取真实安装文件对照 —— 本地存在
//     该安装时断言两 id 在官方文件中出现；安装不存在（CI 无 harness 安装）则
//     console.warn 跳过对照，测试仍绿。
//   - insert 行：id = 'subagents'、name = 'dsh-plugin-subagents'；且整份 patch
//     无 `!!js` 表达式（纯静态，安全加载，无代码注入面）。
//   - package.json 的 `dsh.bundle.patch` 指向本文件（./cordis.patch.yml）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_PATH = resolve(PKG_DIR, 'cordis.patch.yml')
const PACKAGE_PATH = resolve(PKG_DIR, 'package.json')

// Official dsh-base bundle patch installed by dsh in the live npx cache root.
const OFFICIAL_PATCH_CANDIDATES = [
  resolve(
    process.env.DSH_HARNESS_ROOT || '/Users/yangyitian/.npm/_npx/1e7f6d9597241db0',
    'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
  ),
]

function readPatch(id = 'subagents') {
  const patch = parseYaml(readFileSync(PATCH_PATH, 'utf8'))
  assert.ok(Array.isArray(patch), 'patch must parse to an array of rows')
  const rows = patch.map((row, i) => ({ i, row }))

  // collect disabled rows (they carry `disabled: true` and an `id`)
  const disabled = rows
    .filter(({ row }) => !row.insert && row && row.id && row.disabled === true)
    .map(({ row }) => row.id)

  // collect insert rows (they carry an `insert` array)
  const inserts = rows
    .filter(({ row }) => row && Array.isArray(row.insert))
    .flatMap(({ row }) => row.insert ?? [])

  const insertRow = inserts.find((r) => r && r.id === id)
  return { patch, rows, disabled, inserts, insertRow }
}

function officialPatchText() {
  const path = OFFICIAL_PATCH_CANDIDATES.find((p) => {
    try {
      readFileSync(p, 'utf8')
      return true
    } catch {
      return false
    }
  })
  if (!path) return null
  return { path, text: readFileSync(path, 'utf8') }
}

test('cordis.patch.yml parses into a patch row array', () => {
  const { patch } = readPatch()
  assert.ok(patch.length >= 3, 'expected at least 3 rows (2 disable + 1 insert)')
})

test('disable rows target the official tool-subagent / tool-subagent-fork ids', () => {
  const { disabled } = readPatch()
  assert.deepEqual(
    disabled,
    ['tool-subagent', 'tool-subagent-fork'],
    'the two disabled rows must disable exactly the official delegation tool rows',
  )
})

test('disabled ids appear in the official dsh-base patch (skipped when not installed)', (t) => {
  const official = officialPatchText()
  if (!official) {
    console.warn('[bundle-patch] official dsh-base cordis.patch.yml not found; skipping cross-check')
    t.skip('official dsh-base install absent — cross-check skipped')
    return
  }
  for (const id of ['tool-subagent', 'tool-subagent-fork']) {
    assert.match(
      official.text,
      new RegExp(`-\\s*id:\\s*${id}\\b`),
      `official dsh-base patch must contain the disabled id "${id}"`,
    )
  }
})

test('insert row has the correct id/name and the patch is purely static', () => {
  const { insertRow } = readPatch()
  assert.ok(insertRow, 'must contain an insert row with id "subagents"')
  assert.equal(insertRow.id, 'subagents')
  assert.equal(insertRow.name, 'dsh-plugin-subagents')

  // No `!!js<...>` tag expressions anywhere → purely static / safely loadable.
  const raw = readFileSync(PATCH_PATH, 'utf8')
  assert.doesNotMatch(raw, /!!js/, 'patch must not contain YAML !!js expressions')
})

test('package.json dsh.bundle.patch points at this file', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})
