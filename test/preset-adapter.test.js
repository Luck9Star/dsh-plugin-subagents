// T17 — preset adapter tests (L1 delete-rows / L2 enhance-rows, DESIGN §6.3).
//
// The transform is exercised at three levels:
//   1. pure function level: adaptAgentCordisYml / transformRows / updatePresetYml
//      on embedded sample presets (A = standard shape, B = orchestrator shape,
//      C = no official rows);
//   2. pipeline level: adaptPreset over a tmp DSH_HOME (idempotency marker,
//      loud failure paths, source-preset read-only guarantee);
//   3. end-to-end: scripts/install-preset.sh driven through bash with
//      DSH_HOME pointed at a tmp dir (skipped where bash is unavailable).
//
// Real presets under ~/.dsh/.agent-presets are NEVER touched — everything runs
// inside tmp DSH_HOME trees.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isSeq, parseDocument } from 'yaml'
import { validateConfig } from '../lib/config.js'
import {
  MARKER_FILENAME,
  OFFICIAL_ROW_NAME,
  PLUGIN_ROW_NAME,
  adaptAgentCordisYml,
  adaptPreset,
  readMarker,
  updatePresetYml,
} from '../scripts/preset-adapt.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const installSh = join(repoRoot, 'scripts', 'install-preset.sh')

// ── embedded sample presets ─────────────────────────────────────────────────
// Sample A mirrors the shipped `standard` composition: generic delegation rows
// (toolName subagent / subagent_fork) nested inside a cordis:group, a disabled
// product row that must NOT be deleted by L1, `!!js` platform rows, comments.
const SAMPLE_A = `# The \`std-a\` sample preset: standard shape with generic delegation rows.
# ── identity ────────────────────────────────────────────────────────────────
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      Sample persona for std-a.

- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

# ── delegation ──────────────────────────────────────────────────────────────
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable

    # Product providers are host-plane singletons.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        enableRunInBackground: false
        maxDepth: provider-managed

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

# ── remaining model-facing rows ─────────────────────────────────────────────
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
`

const SAMPLE_A_PRESET_YML = `name: 标准模式
description: 功能完整的编码 Agent。
order: 1
`

// Sample B mirrors the user's `orchestrator` preset: role-specialized
// dsh-tool-subagent rows (agentOptions / persona / toolFilter / maxDepth), no
// generic rows at all.
const SAMPLE_B = `# The \`orch-b\` sample preset: orchestrator shape, no generic delegation rows.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      编排主控 persona for orch-b.

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    # 计划/设计 —— 只读角色。
    - id: tool-subagent-plan
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: plan_agent
        backgroundMode: continuable
        agentOptions:
          provider: newapi
          model: glm-5.3
        persona: >-
          你是计划设计子代理。
        toolFilter:
          deny:
            - write
            - edit
        maxDepth: 1

    - id: tool-subagent-scout
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: scout_agent
        backgroundMode: continuable
        agentOptions:
          provider: newapi
          model: deepseek-v4-flash
        persona: >-
          你是侦察子代理。
        maxDepth: 2
`

const SAMPLE_B_PRESET_YML = `name: 编排主控（主代理调度 + 双模型子代理）
description: 主会话只做任务分解、派发调度与结果整合。
order: 2
`

// Sample C: no official dsh-tool-subagent rows at all (L2 must fail loud).
const SAMPLE_C = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      No delegation rows here.
`

// Sample D mirrors the REAL orchestrator zoo — the regression fixture for the
// 2026-08-15 smoke incident: L2 rewrote the fork row (provider fork,
// toolName subagent_fork) into a presetRow, which lib/config.js rejects
// (presetRow registers a SPAWN-semantics delegate; the name collides with the
// global instance's fork tool), so the WHOLE preset failed to mount and the
// session silently fell back to standard.
const SAMPLE_D = `- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    # spawn-semantics role row — a legal L2 rewrite target.
    - id: tool-subagent-plan
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: plan_agent
        backgroundMode: continuable
        agentOptions:
          provider: newapi
          model: glm-5.3
        maxDepth: 1

    # generic delegation row (spawn semantics, official default name).
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    # fork row — fork semantics cannot be hosted by a presetRow instance.
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable
        agentOptions:
          provider: newapi
          model: glm-5.3
        toolFilter:
          deny:
            - write
            - edit
        maxDepth: 1

    # bridge template rows (disabled by default) — bridge delegation cannot be
    # hosted by a presetRow instance either.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        enableRunInBackground: false
        maxDepth: provider-managed

    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: claude-code
        toolName: subagent_claude_code
        enableRunInBackground: false
        maxDepth: provider-managed
`

// ── helpers ─────────────────────────────────────────────────────────────────

// Plain-JS projection of a YAML AST node. `!!js` expressions (cordis custom
// tags) surface as { __jsTag: source } instead of resolving — resolving them
// would throw, and the adapter must round-trip them verbatim.
function toPlain(node) {
  if (!node || typeof node !== 'object') return node
  if (isSeq(node)) return node.items.map(toPlain)
  if (isMap(node)) {
    const out = {}
    for (const pair of node.items) out[toPlain(pair.key)] = toPlain(pair.value)
    return out
  }
  if (node.tag === 'tag:yaml.org,2002:js') return { __jsTag: node.value }
  return node.value
}

// Flat list of every row (top-level + nested inside group `config` lists).
function rowsOf(text) {
  const doc = parseDocument(text)
  assert.equal(doc.errors.length, 0, 'fixture/adapted YAML must parse')
  const rows = []
  const walk = (seq) => {
    for (const item of seq.items) {
      if (!isMap(item)) continue
      rows.push({
        id: item.get('id', true)?.value,
        name: item.get('name', true)?.value,
        disabled: item.has('disabled') ? toPlain(item.get('disabled', true)) : undefined,
        config: item.has('config') ? toPlain(item.get('config', true)) : undefined,
      })
      const nested = item.get('config', true)
      if (isSeq(nested)) walk(nested)
    }
  }
  walk(doc.contents)
  return rows
}

function makeTmpDshHome(presetId, agentYml, presetYml) {
  const home = mkdtempSync(join(tmpdir(), `preset-adapter-${Date.now()}-`))
  const sourceDir = join(home, '.agent-presets', presetId)
  mkdirSync(sourceDir, { recursive: true })
  writeFileSync(join(sourceDir, 'agent.cordis.yml'), agentYml)
  if (presetYml !== undefined) writeFileSync(join(sourceDir, 'preset.yml'), presetYml)
  return { home, sourceDir }
}

const FIXED_NOW = '2025-01-01T00:00:00.000Z'

// ── L1 / L2 pure-transform tests ────────────────────────────────────────────

test('L1 on standard shape removes exactly the two generic delegation rows', () => {
  const adapted = adaptAgentCordisYml(SAMPLE_A, 'l1')
  assert.equal(adapted.removed, 2)
  assert.equal(adapted.enhanced, 0)

  const rows = rowsOf(adapted.text)
  // top-level rows untouched
  assert.deepEqual(
    rows.filter((r) => ['persona', 'tool-bash', 'delegation', 'tool-todo'].includes(r.id)).map((r) => r.id),
    ['persona', 'tool-bash', 'delegation', 'tool-todo']
  )
  const delegationRows = rows.filter((r) => ['tool-subagent-control', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-codex', 'tool-workflow'].includes(r.id))
  assert.deepEqual(
    delegationRows.map((r) => r.id),
    ['tool-subagent-control', 'tool-subagent-codex', 'tool-workflow'],
    'only the generic subagent/subagent_fork rows are deleted'
  )
  // nothing left shadowing the plugin tool names
  for (const row of rows) {
    assert.notEqual(row.config?.toolName, 'subagent')
    assert.notEqual(row.config?.toolName, 'subagent_fork')
  }
  // disabled product row survives with its full config
  const codex = delegationRows.find((r) => r.id === 'tool-subagent-codex')
  assert.equal(codex.name, OFFICIAL_ROW_NAME)
  assert.equal(codex.disabled, true)
  assert.deepEqual(codex.config, {
    provider: 'codex',
    toolName: 'subagent_codex',
    enableRunInBackground: false,
    maxDepth: 'provider-managed',
  })
  // cordis `!!js` tag round-trips verbatim (never resolved to a plain string)
  assert.ok(adapted.text.includes("disabled: !!js process.platform === 'win32'"))
  assert.ok(adapted.text.includes('# Product providers are host-plane singletons.'), 'comments survive')

  // convergent: re-running L1 on the adapted text removes nothing more
  const second = adaptAgentCordisYml(adapted.text, 'l1')
  assert.equal(second.removed, 0)
})

test('L1 on orchestrator shape deletes nothing (no-op adaptation)', () => {
  const before = rowsOf(SAMPLE_B)
  const adapted = adaptAgentCordisYml(SAMPLE_B, 'l1')
  assert.equal(adapted.removed, 0)
  const after = rowsOf(adapted.text)
  assert.equal(after.length, before.length, 'no row is deleted')
  assert.deepEqual(
    after.map((r) => r.id),
    before.map((r) => r.id)
  )
  assert.deepEqual(
    after.map((r) => r.name),
    before.map((r) => r.name),
    'role rows keep pointing at the official package under L1'
  )
})

test('L2 on standard shape fails loud — every official row is generic or a bridge template', () => {
  // The standard shape has NO row a presetRow can host (spawn + distinct
  // toolName): the generic subagent/subagent_fork rows and the disabled
  // bridge template rows are all deletion candidates, so there is nothing to
  // enhance and --enhance-rows fails loud instead of producing a copy whose
  // delegation group would be emptied. Standard-shaped presets are L1 land.
  assert.throws(() => adaptAgentCordisYml(SAMPLE_A, 'l2'), /nothing to enhance/)
})

test('L2 on orchestrator shape enhances role rows preserving agentOptions/persona/toolFilter/maxDepth', () => {
  const before = rowsOf(SAMPLE_B)
  const adapted = adaptAgentCordisYml(SAMPLE_B, 'l2')
  assert.equal(adapted.enhanced, 2)
  assert.equal(adapted.removed, 0)

  const after = rowsOf(adapted.text)
  assert.equal(after.length, before.length)
  const plan = after.find((r) => r.id === 'tool-subagent-plan')
  assert.equal(plan.name, PLUGIN_ROW_NAME)
  assert.deepEqual(plan.config, {
    provider: 'spawn',
    toolName: 'plan_agent',
    backgroundMode: 'continuable',
    agentOptions: { provider: 'newapi', model: 'glm-5.3' },
    persona: '你是计划设计子代理。',
    toolFilter: { deny: ['write', 'edit'] },
    maxDepth: 1,
    presetRow: true,
  })
  const scout = after.find((r) => r.id === 'tool-subagent-scout')
  assert.equal(scout.name, PLUGIN_ROW_NAME)
  assert.deepEqual(scout.config, {
    provider: 'spawn',
    toolName: 'scout_agent',
    backgroundMode: 'continuable',
    agentOptions: { provider: 'newapi', model: 'deepseek-v4-flash' },
    persona: '你是侦察子代理。',
    maxDepth: 2,
    presetRow: true,
  })
})

test('L2 with zero official rows fails loud (anchor mismatch)', () => {
  assert.throws(() => adaptAgentCordisYml(SAMPLE_C, 'l2'), /nothing to enhance/)
})

// ── mount-validity hard gate (2026-08-15 smoke regression) ──────────────────
//
// The incident: L2 rewrote the orchestrator preset's fork row into
// `presetRow: true, provider: fork, toolName: subagent_fork`, which the
// plugin's own validateConfig REJECTS (spawn-semantics row misusing the global
// fork tool's default name) — so the entire preset failed to mount, the web
// app fell back to standard, and the smoke session ran the official 3-param
// subagent instead of the plugin's full-parameter one. This gate must fail on
// any adapter output that could not mount: EVERY row the product leaves on
// `name: dsh-plugin-subagents` has to pass the plugin's own config validation
// (with `disabled` cleared — a template row the user enables must mount too),
// and must not take over the global instance's tool names.
test('L1/L2 products: every dsh-plugin-subagents row passes validateConfig and never takes a global tool name', () => {
  for (const mode of ['l1', 'l2']) {
    const adapted = adaptAgentCordisYml(SAMPLE_D, mode)
    const rows = rowsOf(adapted.text)
    const pluginRows = rows.filter((r) => r.name === PLUGIN_ROW_NAME)
    if (mode === 'l2') {
      assert.ok(pluginRows.length > 0, 'L2 rewrites the spawn role rows')
    } else {
      assert.equal(pluginRows.length, 0, 'L1 never rewrites rows (un-shadow only)')
    }
    for (const row of pluginRows) {
      assert.notEqual(
        row.config?.toolName,
        undefined,
        `${mode}: a rewritten row must keep a toolName`,
      )
      assert.ok(
        !['subagent', 'subagent_fork'].includes(row.config.toolName),
        `${mode}: rewritten row toolName must differ from the global instance's delegate/fork names`,
      )
      // mount-validity: exactly what the cordis loader does when the row is
      // enabled — disabled: true rows are validated here with the flag cleared
      // (a user flipping `disabled` must never produce an unmountable preset).
      assert.doesNotThrow(
        () => validateConfig({ ...row.config, presetRow: true }),
        `${mode}: row "${row.id}" config must pass the plugin's validateConfig`,
      )
    }
    // In an L2 product no official row may survive: it would shadow the
    // global instance's unified tools (the very problem adaptation solves).
    // (L1 keeps official rows by design — it only deletes the generic ones.)
    if (mode === 'l2') {
      assert.equal(
        rows.filter((r) => r.name === OFFICIAL_ROW_NAME).length,
        0,
        'l2: no official dsh-tool-subagent rows may remain (they shadow the global tools)',
      )
    }
  }
})

test('L2 on the full row zoo drops generic/fork/bridge rows and keeps only spawn-semantics rewrites', () => {
  const adapted = adaptAgentCordisYml(SAMPLE_D, 'l2')
  assert.equal(adapted.enhanced, 1, 'only the spawn plan row is rewritten')
  assert.equal(adapted.removed, 4, 'generic + fork + two bridge rows are dropped')

  const rows = rowsOf(adapted.text)
  const ids = rows.map((r) => r.id)
  assert.deepEqual(
    ids,
    ['delegation', 'tool-subagent-plan'],
    'generic (tool-subagent), fork (tool-subagent-fork), and bridge template rows (codex/claude-code) are all deleted',
  )
  const plan = rows.find((r) => r.id === 'tool-subagent-plan')
  assert.equal(plan.name, PLUGIN_ROW_NAME)
  assert.equal(plan.config.presetRow, true)
  assert.equal(plan.config.toolName, 'plan_agent')
})

// ── preset.yml handling ─────────────────────────────────────────────────────

test('updatePresetYml renames an existing preset.yml and keeps the other fields', () => {
  const out = updatePresetYml(SAMPLE_A_PRESET_YML, 'std-a')
  const parsed = parseDocument(out)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.contents.get('name', true).value, '标准模式+subagents')
  assert.equal(parsed.contents.get('description', true).value, '功能完整的编码 Agent。')
  assert.equal(parsed.contents.get('order', true).value, 1)

  assert.throws(() => updatePresetYml('- a\n- b\n', 'x'), /expected a mapping/)
  assert.throws(() => updatePresetYml('name: [oops\n', 'x'), /invalid YAML/)
})

test('updatePresetYml creates a preset.yml when the source preset had none', () => {
  const out = updatePresetYml(null, 'std-a')
  const parsed = parseDocument(out)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.contents.get('name', true).value, 'std-a+subagents')
  assert.ok(parsed.contents.has('description'))
})

// ── pipeline level (adaptPreset over a tmp DSH_HOME) ───────────────────────

test('adaptPreset L1: artifacts written, source preset stays untouched', () => {
  const { home, sourceDir } = makeTmpDshHome('std-a', SAMPLE_A, SAMPLE_A_PRESET_YML)
  try {
    const srcAgent = join(sourceDir, 'agent.cordis.yml')
    const srcPresetYml = join(sourceDir, 'preset.yml')
    const agentBefore = readFileSync(srcAgent, 'utf8')
    const presetBefore = readFileSync(srcPresetYml, 'utf8')
    const mtimeBefore = statSync(srcAgent).mtimeMs

    const result = adaptPreset({ dshHome: home, source: 'std-a', mode: 'l1', now: () => FIXED_NOW })
    assert.equal(result.skipped, false)
    assert.equal(result.removed, 2)
    assert.equal(result.presetYmlCreated, false)

    const targetDir = join(home, '.agent-presets', 'std-a-subagents')
    assert.ok(existsSync(join(targetDir, 'agent.cordis.yml')))
    assert.deepEqual(readMarker(targetDir), { source: 'std-a', mode: 'l1', adaptedAt: FIXED_NOW })

    const targetRows = rowsOf(readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8'))
    assert.ok(!targetRows.some((r) => ['subagent', 'subagent_fork'].includes(r.config?.toolName)))
    const targetPreset = parseDocument(readFileSync(join(targetDir, 'preset.yml'), 'utf8'))
    assert.equal(targetPreset.contents.get('name', true).value, '标准模式+subagents')

    // read-only guarantee: byte-identical content and untouched mtime
    assert.equal(readFileSync(srcAgent, 'utf8'), agentBefore)
    assert.equal(readFileSync(srcPresetYml, 'utf8'), presetBefore)
    assert.equal(statSync(srcAgent).mtimeMs, mtimeBefore)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('adaptPreset is idempotent: a marked copy is skipped, artifacts unchanged', () => {
  const { home } = makeTmpDshHome('std-a', SAMPLE_A, SAMPLE_A_PRESET_YML)
  try {
    adaptPreset({ dshHome: home, source: 'std-a', mode: 'l1', now: () => FIXED_NOW })
    const targetDir = join(home, '.agent-presets', 'std-a-subagents')
    const agentAfterFirst = readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8')
    const markerAfterFirst = readFileSync(join(targetDir, MARKER_FILENAME), 'utf8')

    const second = adaptPreset({ dshHome: home, source: 'std-a', mode: 'l1', now: () => '2099-01-01T00:00:00.000Z' })
    assert.equal(second.skipped, true)
    assert.equal(second.marker.mode, 'l1')
    assert.equal(readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8'), agentAfterFirst)
    assert.equal(readFileSync(join(targetDir, MARKER_FILENAME), 'utf8'), markerAfterFirst, 'marker not rewritten on skip')

    // a corrupt marker is loud, not silently treated as absent
    writeFileSync(join(targetDir, MARKER_FILENAME), 'not-json')
    assert.throws(() => adaptPreset({ dshHome: home, source: 'std-a' }), /corrupt adaptation marker/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('adaptPreset fails loud on bad input and leaves no half-adapted target', () => {
  const { home } = makeTmpDshHome('std-a', SAMPLE_A, SAMPLE_A_PRESET_YML)
  try {
    // missing source preset
    assert.throws(() => adaptPreset({ dshHome: home, source: 'nope' }), /source preset not found/)

    // pre-existing target without the plugin marker must not be overwritten
    const targetDir = join(home, '.agent-presets', 'std-a-subagents')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'user-file.txt'), 'hand-made preset copy')
    assert.throws(() => adaptPreset({ dshHome: home, source: 'std-a' }), /refusing to overwrite/)
    assert.equal(readFileSync(join(targetDir, 'user-file.txt'), 'utf8'), 'hand-made preset copy')
    rmSync(targetDir, { recursive: true, force: true })
    assert.equal(readMarker(targetDir), null, 'readMarker: absent file reads as null')

    // malformed agent.cordis.yml
    const bad = makeTmpDshHome('bad-yml', 'name: [unclosed\n', 'name: x\n')
    try {
      assert.throws(() => adaptPreset({ dshHome: bad.home, source: 'bad-yml' }), /invalid YAML/)
      assert.equal(existsSync(join(bad.home, '.agent-presets', 'bad-yml-subagents')), false, 'no target left behind')
    } finally {
      rmSync(bad.home, { recursive: true, force: true })
    }

    // malformed preset.yml: transform runs before the copy, so nothing lands on disk
    const badPreset = makeTmpDshHome('bad-preset-yml', SAMPLE_C, 'name: [unclosed\n')
    try {
      assert.throws(() => adaptPreset({ dshHome: badPreset.home, source: 'bad-preset-yml' }), /invalid YAML/)
      assert.equal(existsSync(join(badPreset.home, '.agent-presets', 'bad-preset-yml-subagents')), false)
    } finally {
      rmSync(badPreset.home, { recursive: true, force: true })
    }

    // L2 anchor mismatch through the pipeline
    const noRows = makeTmpDshHome('no-rows', SAMPLE_C, 'name: x\n')
    try {
      assert.throws(() => adaptPreset({ dshHome: noRows.home, source: 'no-rows', mode: 'l2' }), /nothing to enhance/)
      assert.equal(existsSync(join(noRows.home, '.agent-presets', 'no-rows-subagents')), false)
    } finally {
      rmSync(noRows.home, { recursive: true, force: true })
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('adaptPreset L2 on orchestrator shape: marker mode l2, then mode-mismatch skip surfaces', () => {
  const { home } = makeTmpDshHome('orch-b', SAMPLE_B, SAMPLE_B_PRESET_YML)
  try {
    const result = adaptPreset({ dshHome: home, source: 'orch-b', mode: 'l2', now: () => FIXED_NOW })
    assert.equal(result.skipped, false)
    assert.equal(result.enhanced, 2)
    assert.deepEqual(readMarker(join(home, '.agent-presets', 'orch-b-subagents')), {
      source: 'orch-b',
      mode: 'l2',
      adaptedAt: FIXED_NOW,
    })
    const rows = rowsOf(readFileSync(join(home, '.agent-presets', 'orch-b-subagents', 'agent.cordis.yml'), 'utf8'))
    assert.equal(rows.filter((r) => r.name === PLUGIN_ROW_NAME).length, 2)
    const preset = parseDocument(readFileSync(join(home, '.agent-presets', 'orch-b-subagents', 'preset.yml'), 'utf8'))
    assert.equal(preset.contents.get('name', true).value, '编排主控（主代理调度 + 双模型子代理）+subagents')

    // a later L1 run skips but surfaces the marker's l2 mode
    const second = adaptPreset({ dshHome: home, source: 'orch-b', mode: 'l1' })
    assert.equal(second.skipped, true)
    assert.equal(second.marker.mode, 'l2')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ── end-to-end through scripts/install-preset.sh ────────────────────────────

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0

test('install-preset.sh end-to-end: L1 adapt, idempotent skip, L2 flag, loud failure', { skip: !bashAvailable && 'bash unavailable' }, () => {
  const { home, sourceDir } = makeTmpDshHome('std-a', SAMPLE_A, SAMPLE_A_PRESET_YML)
  const run = (args) =>
    spawnSync('bash', [installSh, ...args], {
      cwd: tmpdir(), // script dir resolution must not depend on the caller's cwd
      env: { ...process.env, DSH_HOME: home },
      encoding: 'utf8',
    })
  try {
    const agentBefore = readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8')

    // L1 default
    const first = run(['std-a'])
    assert.equal(first.status, 0, `stdout: ${first.stdout}\nstderr: ${first.stderr}`)
    assert.match(first.stdout, /\[ok\] L1: removed 2 generic delegation row\(s\)/)
    const targetDir = join(home, '.agent-presets', 'std-a-subagents')
    const marker = readMarker(targetDir)
    assert.equal(marker.source, 'std-a')
    assert.equal(marker.mode, 'l1')
    assert.match(marker.adaptedAt, /^\d{4}-\d{2}-\d{2}T/, 'adaptedAt is an ISO timestamp')
    const rows = rowsOf(readFileSync(join(targetDir, 'agent.cordis.yml'), 'utf8'))
    assert.ok(!rows.some((r) => ['subagent', 'subagent_fork'].includes(r.config?.toolName)))
    assert.equal(readFileSync(join(sourceDir, 'agent.cordis.yml'), 'utf8'), agentBefore, 'source untouched')

    // idempotent skip
    const second = run(['std-a'])
    assert.equal(second.status, 0)
    assert.match(second.stdout, /\[skip\]/)

    // loud failure on a missing source
    const missing = run(['does-not-exist'])
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /\[error\] source preset not found/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  // L2 through the --enhance-rows flag on the orchestrator shape
  const orch = makeTmpDshHome('orch-b', SAMPLE_B, SAMPLE_B_PRESET_YML)
  try {
    const res = spawnSync('bash', [installSh, 'orch-b', '--enhance-rows'], {
      cwd: tmpdir(),
      env: { ...process.env, DSH_HOME: orch.home },
      encoding: 'utf8',
    })
    assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`)
    assert.match(res.stdout, /\[ok\] L2: enhanced 2 row\(s\)/)
    const marker = readMarker(join(orch.home, '.agent-presets', 'orch-b-subagents'))
    assert.equal(marker.mode, 'l2')
    const rows = rowsOf(readFileSync(join(orch.home, '.agent-presets', 'orch-b-subagents', 'agent.cordis.yml'), 'utf8'))
    assert.equal(rows.filter((r) => r.name === PLUGIN_ROW_NAME).length, 2)
  } finally {
    rmSync(orch.home, { recursive: true, force: true })
  }
})
