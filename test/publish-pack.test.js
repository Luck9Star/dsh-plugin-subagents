// dsh-plugin-subagents — 发布准备测试（T21）。
//
// 覆盖：
//   - package.json 的 files 白名单包含全部必要路径（lib/ roles/ patches/
//     scripts/ cordis.patch.yml + 各文档）且不含 docs/ 或 test/。
//   - 实际执行 `npm pack --dry-run --json`（子进程），断言产物文件清单里
//     没有 docs/ 或 test/ 前缀的条目 —— npm 不可用（CI 无 npm / 无网络）则
//     console.warn 并 t.skip，测试仍绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_PATH = resolve(PKG_DIR, 'package.json')

const REQUIRED_FILES = [
  'lib/',
  'roles/',
  'patches/',
  'scripts/',
  'cordis.patch.yml',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'SECURITY.md',
  'LICENSE',
]

function readPackageJson() {
  return JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
}

// Run `npm pack --dry-run --json` and resolve to the packed file path list.
// Rejects with a sentinel when npm is not available.
function npmPackFileList() {
  return new Promise((resolveP, reject) => {
    execFile(
      'npm',
      ['pack', '--dry-run', '--json'],
      { cwd: PKG_DIR },
      (err, stdout, stderr) => {
        if (err) {
          // fmt:off
          const noNpm = /not found|ENOENT|spawn/.test(err.message) ||
            /npm is not recognized|command not found/i.test(`${stderr} ${err.message}`)
          // fmt:on
          const sentinel = Object.assign(
            new Error(`npm pack dry-run failed: ${err.message}`),
            { code: noNpm ? 'DSH_NO_NPM' : 'DSH_PACK_FAILED' },
          )
          reject(sentinel)
          return
        }
        try {
          const parsed = JSON.parse(stdout)
          const fileList = Array.isArray(parsed)
            ? parsed.flatMap((entry) => (entry.files ?? []).map((f) => f.path))
            : []
          resolveP({ stdout, fileList })
        } catch (parseErr) {
          reject(Object.assign(parseErr, { code: 'DSH_PACK_PARSE' }))
        }
      },
    )
  })
}

test('package.json files whitelist covers every mandatory path', () => {
  const pkg = readPackageJson()
  assert.ok(Array.isArray(pkg.files), 'package.json must declare a files array')
  for (const path of REQUIRED_FILES) {
    assert.ok(
      pkg.files.includes(path),
      `files must include "${path}"`,
    )
  }
})

test('package.json files whitelist excludes docs/ and test/', () => {
  const pkg = readPackageJson()
  for (const entry of pkg.files) {
    assert.ok(
      entry !== 'docs/' && entry !== 'docs' && entry !== 'test/' && entry !== 'test',
      `files must not include the design/test directory, got "${entry}"`,
    )
  }
  assert.doesNotMatch(
    pkg.files.join(','),
    /(^|,)(docs|test)\/?($|,)/,
    'files must not contain docs/ or test/ entries',
  )
})

test('npm pack --dry-run contains no docs/ or test/ prefixed entries', async (t) => {
  let packed
  try {
    packed = await npmPackFileList()
  } catch (err) {
    if (err.code === 'DSH_NO_NPM') {
      console.warn('[publish-pack] npm not available; skipping pack dry-run check')
      t.skip('npm unavailable — pack dry-run check skipped')
      return
    }
    if (err.code === 'DSH_PACK_PARSE') {
      console.warn('[publish-pack] npm pack --dry-run --json output unparseable; skipping', err.message)
      t.skip('npm pack --dry-run --json parse failure — pack list check skipped')
      return
    }
    throw err
  }

  assert.ok(
    packed.fileList.length > 0,
    'pack dry-run must list at least one file',
  )

  const bad = packed.fileList.filter((p) => p.startsWith('docs/') || p.startsWith('test/'))
  assert.deepEqual(
    bad,
    [],
    `packed file list must not contain docs/ or test/ entries, got: ${bad.join(', ')}`,
  )
})
