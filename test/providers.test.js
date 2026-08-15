import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProviders, createBridgeFor, providerPersona } from '../lib/providers.js'

test('built-in providers: claude-code, codex, acp', () => {
  const providers = buildProviders({})
  assert.deepEqual(Object.keys(providers).sort(), ['acp', 'claude-code', 'codex'])
  assert.equal(providers['claude-code'].type, 'claude')
  assert.equal(providers.codex.type, 'codex')
  assert.equal(providers.acp.type, 'acp')
  assert.deepEqual(providers.acp.args, ['acp'])
})

test('custom ACP providers merge in; built-ins overridable', () => {
  const providers = buildProviders({
    providers: {
      cursor: { type: 'acp', command: 'agent', args: ['acp'] },
      codex: { command: 'codex-custom' },
    },
  })
  assert.equal(providers.cursor.command, 'agent')
  assert.deepEqual(providers.cursor.args, ['acp'])
  assert.equal(providers.cursor.type, 'acp')
  // override keeps the built-in type but swaps the command
  assert.equal(providers.codex.type, 'codex')
  assert.equal(providers.codex.command, 'codex-custom')
})

test('custom provider defaults to acp type and opencode command when unset', () => {
  const providers = buildProviders({ providers: { mystery: {} } })
  assert.equal(providers.mystery.type, 'acp')
  assert.equal(providers.mystery.command, 'opencode')
})

test('every built-in bridge implements the bridge contract', () => {
  const providers = buildProviders({})
  for (const def of Object.values(providers)) {
    const bridge = createBridgeFor(def)
    assert.equal(typeof bridge.create, 'function')
    assert.equal(typeof bridge.submit, 'function')
    assert.equal(typeof bridge.reconnect, 'function')
    assert.equal(typeof bridge.dispose, 'function')
  }
})

test('grok-style zero-code ACP registration via config.providers (no CLI needed)', () => {
  const providers = buildProviders({
    providers: {
      grok: { type: 'acp', command: 'grok', args: ['agent', '--stdio'] },
    },
  })
  assert.equal(providers.grok.type, 'acp')
  assert.equal(providers.grok.command, 'grok')
  assert.deepEqual(providers.grok.args, ['agent', '--stdio'])
  // full bridge resolves for the registered ACP provider with no extra code
  const bridge = createBridgeFor(providers.grok)
  assert.equal(typeof bridge.create, 'function')
  assert.equal(typeof bridge.submit, 'function')
  assert.equal(typeof bridge.reconnect, 'function')
  assert.equal(typeof bridge.dispose, 'function')
})

test('providerPersona carries the subagent_submit relay verb and never product_submit', () => {
  const providers = buildProviders({
    providers: {
      grok: { type: 'acp', command: 'grok', args: ['agent', '--stdio'] },
    },
  })
  for (const [name, persona] of [
    ['claude-code', providerPersona('claude-code', providers['claude-code'])],
    ['codex', providerPersona('codex', providers.codex)],
    ['grok', providerPersona('grok', providers.grok)],
  ]) {
    assert.match(persona, /subagent_submit/, `${name} persona names the subagent_submit tool`)
    assert.doesNotMatch(persona, /product_submit/, `${name} persona must not reference product_submit`)
    assert.doesNotMatch(persona, /product_delegate/, `${name} persona must not reference product_delegate`)
  }
  assert.match(providerPersona('claude-code', providers['claude-code']), /Claude Code/)
  assert.match(providerPersona('codex', providers.codex), /Codex/)
  assert.match(providerPersona('grok', providers.grok), /grok \(grok\)/)
})
