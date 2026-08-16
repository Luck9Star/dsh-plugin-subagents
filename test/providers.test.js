import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildProviders, createBridgeFor, providerPersona } from '../lib/providers.js'

test('built-in providers: claude-code, codex, grok-native, acp — bare `grok` is NOT a built-in', () => {
  const providers = buildProviders({})
  assert.deepEqual(Object.keys(providers).sort(), ['acp', 'claude-code', 'codex', 'grok-native'])
  assert.equal(providers['claude-code'].type, 'claude')
  assert.equal(providers.codex.type, 'codex')
  // grok-native is the NATIVE streaming-json bridge (one process per turn).
  assert.equal(providers['grok-native'].type, 'grok')
  assert.equal(providers['grok-native'].command, 'grok')
  assert.equal(providers.acp.type, 'acp')
  assert.deepEqual(providers.acp.args, ['acp'])
})

test('the bare name grok stays OWNED by the user config (design ruling 2026-08-16)', () => {
  // An existing deployment's config.providers defines grok as an ACP
  // transport; the built-in registry never claims that name, so the user
  // entry passes through untouched (type stays acp, args preserved).
  const providers = buildProviders({
    providers: { grok: { type: 'acp', command: 'grok', args: ['agent', '--always-approve', 'stdio'] } },
  })
  assert.equal(providers.grok.type, 'acp')
  assert.deepEqual(providers.grok.args, ['agent', '--always-approve', 'stdio'])
  // and the native bridge is reachable under its own id alongside it
  assert.equal(providers['grok-native'].type, 'grok')
  assert.equal(providers['grok-native'].command, 'grok')
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

test('config.providers wins by NAME over a built-in (merge semantics, guarded via grok-native)', () => {
  // The merge rule `{ ...BUILT_INS, ...(config.providers || {}) }` keys on
  // NAME, not type. Sealing the built-in grok-native to an absolute absent
  // path is the fixture idiom drivers-assembly/index tests already use; here
  // it doubles as the merge-semantics guard — the same-name entry REPLACES
  // the built-in's command while the OTHER built-ins stay intact.
  const providers = buildProviders({
    providers: { 'grok-native': { type: 'acp', command: 'other-grok-cli', args: ['agent'] } },
  })
  assert.equal(providers['grok-native'].type, 'acp')
  assert.equal(providers['grok-native'].command, 'other-grok-cli')
  assert.deepEqual(providers['grok-native'].args, ['agent'])
  // siblings untouched
  assert.equal(providers.codex.type, 'codex')
  assert.equal(providers['claude-code'].type, 'claude')
})

test('redactSecrets:false threads from buildProviders into every provider def', () => {
  const providers = buildProviders({ providers: { cursor: { type: 'acp', command: 'agent' } }, redactSecrets: false })
  for (const def of Object.values(providers)) {
    assert.equal(def.redactSecrets, false)
  }
  // default (absent) → no explicit false anywhere
  const on = buildProviders({})
  for (const def of Object.values(on)) {
    assert.notEqual(def.redactSecrets, false)
  }
})

test('createBridgeFor routes type grok to the native grok bridge (built-in id grok-native)', () => {
  const providers = buildProviders({})
  const bridge = createBridgeFor(providers['grok-native'])
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
    // D2b hardening: never self-answer (identity/runtime questions included);
    // un-forwarded reports will be rejected (the deterministic guard's wording)
    assert.match(persona, /NEVER answer from your own knowledge, identity, or runtime/, `${name} persona forbids self-answering`)
    assert.match(persona, /which product\/CLI\/model you are running as/, `${name} persona names the identity-question trap`)
    assert.match(persona, /A report without a subagent_submit call in the same turn will be rejected/, `${name} persona states the guard`)
  }
  assert.match(providerPersona('claude-code', providers['claude-code']), /Claude Code/)
  assert.match(providerPersona('codex', providers.codex), /Codex/)
  assert.match(providerPersona('grok', providers.grok), /grok \(grok\)/)
})

test('the native grok persona names the Grok CLI (type grok, not the ACP generic text)', () => {
  const providers = buildProviders({})
  const persona = providerPersona('grok-native', providers['grok-native'])
  assert.match(persona, /relay bridge to the Grok CLI agent/)
  assert.match(persona, /subagent_submit/)
  assert.doesNotMatch(persona, /ACP CLI agent/)
})
