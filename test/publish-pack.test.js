// dsh-plugin-subagents — 发布准备测试（T21）。
//
// 覆盖：
//   - package.json 的 files 白名单包含全部必要路径（lib/ roles/ patches/
//     scripts/ cordis.patch.yml + 各文档）且不含 docs/ 或 test/。
//   - files 白名单显式排除 `patches/.applied`（E-1/C-1 打包侧）——stamp 携带
//     安装机的 liveRoot 与补丁状态，随 tarball 分发等于外发一个可被他人
//     stamp 覆盖的 cwd 门控令牌（驱动侧的 liveRoot 一致性校验是第二道闸）。
//   - 实际执行 `npm pack --dry-run --json`（子进程），断言产物文件清单里
//     没有 docs/ 或 test/ 前缀的条目、也没有 patches/.applied —— npm 不可用
//     （CI 无 npm / 无网络）则 console.warn 并 t.skip，测试仍绿。
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

test('package.json files statically pins the patches/ include and the !patches/.applied negation', () => {
  // CI-safe static pin: the dynamic npm pack check below skips whenever npm is
  // unavailable, so this pure assertion hard-guarantees the tarball always
  // ships the installer (patches/) but never the installer's gitignored stamp
  // (patches/.applied carries the liveRoot + applied states of the machine
  // that ran it — leaking it would hand out a foreign cwd-gate token). Zero
  // external deps, runs on every bare runner.
  const pkg = readPackageJson()
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes('patches/'),
    'files must include the patches/ directory (the installer runs from it)',
  )
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.includes('!patches/.applied'),
    'files must negate patches/.applied (stamp must never ship in the tarball)',
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

test('npm pack --dry-run never ships patches/.applied (E-1/C-1: stamp carries the installer machine state)', async (t) => {
  // A shipped stamp would carry SOMEONE ELSE'S liveRoot and applied states into
  // every npm install; the driver's liveRoot-consistency check (native.js)
  // would then loudly reject it, but the tarball must not carry it in the
  // first place. The `!patches/.applied` negation in files is the gate —
  // verified experimentally: npm's files-negation DOES apply to subpaths.
  let packed
  try {
    packed = await npmPackFileList()
  } catch (err) {
    if (err.code === 'DSH_NO_NPM') {
      console.warn('[publish-pack] npm not available; skipping pack dry-run check')
      t.skip('npm unavailable — .applied pack check skipped')
      return
    }
    if (err.code === 'DSH_PACK_PARSE') {
      console.warn('[publish-pack] npm pack --dry-run --json output unparseable; skipping', err.message)
      t.skip('npm pack --dry-run --json parse failure — .applied pack check skipped')
      return
    }
    throw err
  }

  assert.ok(
    !packed.fileList.includes('patches/.applied'),
    'patches/.applied must never ship in the tarball (files negation "!patches/.applied"); '
    + `got: ${packed.fileList.filter((p) => p.startsWith('patches/')).join(', ')}`,
  )
  // The rest of patches/ must still ship (install.sh etc. run FROM the install).
  for (const needed of ['patches/install.sh', 'patches/verify.sh']) {
    assert.ok(
      packed.fileList.includes(needed),
      `${needed} must still ship (the installer/doctor run from the installed package)`,
    )
  }
})

test('npm-publish.yml guards against the placeholder repository URL before publishing', () => {
  // publish.yml (the release-event workflow) was dropped in favor of the
  // tag-driven npm-publish.yml (see CHANGELOG 0.1.1); this test now pins
  // the surviving workflow's publish gate.
  const workflowPath = resolve(PKG_DIR, '.github', 'workflows', 'npm-publish.yml')
  const workflow = readFileSync(workflowPath, 'utf8')
  // Trusted publishing needs the workflow registered on npmjs.com against
  // user Luck9Star / repo dsh-plugin-subagents — if package.json drifts to
  // the placeholder URL, --provenance breaks. The workflow header documents
  // the binding this test keeps honest.
  assert.match(
    workflow,
    /user Luck9Star, repo dsh-plugin-subagents, filename npm-publish\.yml/,
    'npm-publish.yml must document the trusted-publisher binding (placeholder repository guard)',
  )
  assert.match(
    workflow,
    /npm publish --provenance/,
    'npm-publish.yml must still run npm publish with provenance',
  )
})
