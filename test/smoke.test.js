// dsh-plugin-subagents — 最小冒烟测试。
//
// 取代脚手架时代的 `assert.ok(true)` 占位（P3 清理）：真实断言「本包能从
// 入口加载、且四座桥都暴露 bridge 契约」——这是任何部署形态的共同前提，
// 一次 node:test 请求即可发现的回归（模块图断裂、导出面改名）不需要等
// 完整套件。仍零网络、零真实 CLI、零 API key。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('package entry loads and every bridge module exports the factory contract', async () => {
  // the package name/main stay wired for the cordis loader
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'dsh-plugin-subagents')
  assert.equal(manifest.main, 'lib/index.js')

  // lib/index.js parses and exports the cordis plugin entry points
  const entry = await import('../lib/index.js')
  assert.equal(entry.name, 'dsh-plugin-subagents')
  assert.equal(typeof entry.apply, 'function')
  assert.ok(Array.isArray(entry.inject), 'cordis inject list exported')

  // every bridge factory builds the four-method contract
  const bridges = [
    (await import('../lib/bridges/claude.js')).createClaudeBridge,
    (await import('../lib/bridges/codex.js')).createCodexBridge,
    (await import('../lib/bridges/grok.js')).createGrokBridge,
    (await import('../lib/bridges/acp.js')).createAcpBridge,
  ]
  assert.equal(bridges.length, 4)
  for (const factory of bridges) {
    assert.equal(typeof factory, 'function', 'bridge factory exported')
    const bridge = factory()
    for (const method of ['create', 'submit', 'reconnect', 'dispose']) {
      assert.equal(typeof bridge[method], 'function', `${method} on the bridge contract`)
    }
  }
})
