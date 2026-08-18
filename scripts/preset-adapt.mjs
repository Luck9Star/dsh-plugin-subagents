#!/usr/bin/env node
// preset-adapt.mjs — preset adaptation engine for dsh-plugin-subagents (T17).
//
// WHY THIS EXISTS (DESIGN §2.3-B/D + §6.3)
//   In the `web` profile the tool surface of a session is owned by its agent
//   PRESET, not by the host plane: a preset-layer row SHADOWS any host-plane
//   (global-layer) tool registered under the same name. The shipped
//   `standard` preset composes `subagent` / `subagent_fork` rows pointing at
//   the official `@deepseek-ai/dsh-tool-subagent`, which would shadow this
//   plugin's unified tools. Adaptation copies a source preset and rewrites the
//   copy, so the user's original stays untouched:
//
//   L1 (default) — DELETE the generic delegation rows: array items whose
//          `name` is '@deepseek-ai/dsh-tool-subagent' AND whose
//          `config.toolName` is `subagent` / `subagent_fork`. With the
//          shadowing rows gone, the host-plane plugin tools become directly
//          visible. Unlike the earlier cwd plugin’s "rewrite the row" approach
//          this keeps ONE plugin instance — no split state, no duplicate
//          registrations. A preset without generic rows (e.g. `orchestrator`)
//          is a no-op success: there is nothing to un-shadow, and the copy
//          still gets the marker + preset.yml so the flow stays uniform.
//
//   L2 (--enhance-rows) — REWRITE only the rows a presetRow instance can
//          honestly host, and DELETE every other official row:
//            • rewrite → `name: 'dsh-plugin-subagents'` + `presetRow: true`:
//              official rows with `provider: 'spawn'` AND a `toolName` other
//              than subagent/subagent_fork (the per-row (role, model) combos
//              of orchestrator-style presets; every other config key is kept —
//              the official row config is a subset of this plugin's Config,
//              DESIGN red line 9);
//            • delete → generic rows (toolName subagent/subagent_fork — they
//              would collide with the global instance's delegate/fork tools,
//              which register the full-parameter `subagent`/`subagent_fork`),
//              fork rows (`provider: fork` — a presetRow instance registers a
//              SPAWN-semantics delegate via createNativeDriver({kind:'spawn'}),
//              so rewriting a fork row would silently change its semantics;
//              context-inheriting delegation stays on the global
//              `subagent_fork`), and bridge template rows (`provider: codex` /
//              `claude-code` / … — bridge delegation belongs to the global
//              instance's `subagent` with `backend=<name>`; a presetRow row
//              would route the bridge provider name into native spawn
//              semantics and never resolve).
//          The mount-validity invariant (regression gate, test/preset-adapter
//          .test.js): EVERY row the product leaves on
//          `name: dsh-plugin-subagents` must pass lib/config.js validateConfig
//          with `disabled` cleared — an unmountable row takes the WHOLE preset
//          down (the 2026-08-15 smoke incident: a rewritten fork row failed
//          validation, the web app fell back to standard, and the session ran
//          the official 3-param subagent). Zero rewrites still fails loud:
//          --enhance-rows was almost certainly aimed at the wrong preset.
//
//   The YAML transform works on the `yaml` package Document AST, so untouched
//   nodes re-serialize verbatim: comments survive, and cordis custom tags
//   (`disabled: !!js process.platform === 'win32'`) round-trip exactly — they
//   are never resolved to JS values. A plain parse/stringify round trip would
//   silently turn that `!!js` flag into a plain (always-truthy) string and
//   break the bash/pwsh rows.
//
//   scripts/install-preset.sh and scripts/install-preset.ps1 are thin wrappers
//   that resolve DSH_HOME (default ~/.dsh, $DSH_HOME overrides) and forward
//   here. Idempotency marker: <copy>/.dsh-plugin-subagents-adapted.
//
// CLI:  node preset-adapt.mjs [--dsh-home <dir>] [--source <preset-id>] [--enhance-rows]
//       --source defaults to `standard`; --dsh-home defaults to $DSH_HOME, then ~/.dsh.

import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isMap, isSeq, parseDocument, stringify } from 'yaml'

export const OFFICIAL_ROW_NAME = '@deepseek-ai/dsh-tool-subagent'
export const PLUGIN_ROW_NAME = 'dsh-plugin-subagents'
export const GENERIC_TOOL_NAMES = ['subagent', 'subagent_fork']
export const MARKER_FILENAME = '.dsh-plugin-subagents-adapted'
export const PRESET_DIR = '.agent-presets'
export const AGENT_YML = 'agent.cordis.yml'
export const PRESET_YML = 'preset.yml'

class UsageError extends Error {}

// ── row predicates (node-level, exported for tests) ─────────────────────────

function scalarString(node) {
  return node && typeof node.value === 'string' ? node.value : undefined
}

/** A row mounting the official subagent tool under ANY toolName. */
export function isOfficialSubagentRow(row) {
  return isMap(row) && scalarString(row.get('name', true)) === OFFICIAL_ROW_NAME
}

/** A generic delegation row: official package + toolName subagent|subagent_fork (L1 target). */
export function isGenericDelegationRow(row) {
  if (!isOfficialSubagentRow(row)) return false
  const config = row.get('config', true)
  if (!isMap(config)) return false
  const toolName = scalarString(config.get('toolName', true)) ?? 'subagent' // official default
  return GENERIC_TOOL_NAMES.includes(toolName)
}

/**
 * A row L2 can honestly rewrite into a plugin presetRow (§6.3-L2): official
 * package + `provider: 'spawn'` + a toolName distinct from the global
 * instance's delegate/fork names (a missing toolName is the official default
 * 'subagent' → generic → not a candidate). Everything else — generic rows,
 * fork rows, bridge template rows, rows without a provider (required by the
 * presetRow schema) — must be DELETED, not rewritten: a presetRow instance
 * registers a spawn-semantics native delegate, and any row that cannot mount
 * through lib/config.js takes the whole preset down with it.
 */
export function isPresetRowCandidate(row) {
  if (!isOfficialSubagentRow(row)) return false
  const config = row.get('config', true)
  if (!isMap(config)) return false
  if (scalarString(config.get('provider', true)) !== 'spawn') return false
  const toolName = scalarString(config.get('toolName', true)) ?? 'subagent' // official default
  return !GENERIC_TOOL_NAMES.includes(toolName)
}

// ── document transforms (exported for tests) ────────────────────────────────

/**
 * Apply L1/L2 to a parsed agent.cordis.yml document, walking the top-level
 * row list and every nested group `config` row list (delegation rows live
 * inside `cordis:group` rows in both known preset shapes).
 * @returns {{ removed: number, enhanced: number }}
 */
export function transformRows(doc, mode) {
  const root = doc.contents
  if (!isSeq(root)) {
    throw new Error(`${AGENT_YML}: expected a top-level list of rows, got ${root ? root.type : 'empty document'}`)
  }
  let removed = 0
  let enhanced = 0

  const dropRows = (seq, shouldDrop) => {
    const kept = seq.items.filter((item) => !shouldDrop(item))
    if (kept.length !== seq.items.length) {
      const dropped = seq.items.length - kept.length
      seq.items = kept
      // The old separator of a deleted leading row otherwise survives as a
      // stray blank line right after `config:`.
      if (seq.items.length > 0 && seq.items[0].spaceBefore) seq.items[0].spaceBefore = false
      removed += dropped
    }
  }

  const walk = (seq) => {
    // Recurse first (over a snapshot): group rows keep nested row lists in `config`.
    for (const item of [...seq.items]) {
      if (!isMap(item)) continue
      const config = item.get('config', true)
      if (isSeq(config)) walk(config)
    }
    if (mode === 'l2') {
      // Rewrite only the spawn-semantics role rows a presetRow can host; drop
      // every other official row (generic / fork / bridge — see the header).
      // An official row left behind would shadow the global instance's tools,
      // and a dishonest rewrite would fail validateConfig at mount time and
      // take the whole preset down (the 2026-08-15 smoke incident).
      for (const item of seq.items) {
        if (!isPresetRowCandidate(item)) continue
        item.set('name', PLUGIN_ROW_NAME) // reuses the row's existing scalar style
        const config = item.get('config', true)
        if (isMap(config)) config.set('presetRow', true)
        else item.set('config', { presetRow: true })
        enhanced += 1
      }
      dropRows(seq, isOfficialSubagentRow)
      return
    }
    // L1: drop the generic delegation rows; keep everything else in order.
    dropRows(seq, isGenericDelegationRow)
  }

  walk(root)
  return { removed, enhanced }
}

/**
 * Transform one agent.cordis.yml text. Round-trip safe for comments and
 * `!!js` custom tags (untouched AST nodes re-serialize verbatim).
 * @param {string} text source YAML
 * @param {'l1'|'l2'} mode
 * @returns {{ text: string, removed: number, enhanced: number }}
 */
export function adaptAgentCordisYml(text, mode) {
  if (mode !== 'l1' && mode !== 'l2') throw new Error(`invalid adaptation mode: ${mode}`)
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new Error(`${AGENT_YML}: invalid YAML (${String(doc.errors[0]).split('\n')[0]})`)
  }
  const { removed, enhanced } = transformRows(doc, mode)
  if (mode === 'l2' && enhanced === 0) {
    // Loud anchor mismatch: L2 was explicitly requested, but there is nothing
    // to enhance — wrong preset or dsh layout drift (TASKS T17: 锚失配 loud).
    throw new Error(
      `该 preset 中没有可改写为 presetRow 的官方行（判定：official dsh-tool-subagent 行 + provider: spawn ` +
        `+ toolName 独立于 subagent/subagent_fork）。` +
        `若源 preset 是 standard 类（只有通用/bridge 行），L2 不适用，请用默认 L1；` +
        `若确有角色行，请检查行是否用了官方默认 toolName。` +
        `(${AGENT_YML}: nothing to enhance for mode='l2'; source preset found no presetRow candidate rows)`
    )
  }
  let out = doc.toString({ lineWidth: 0 }) // no 80-col re-wrapping of untouched long lines
  if (!out.endsWith('\n')) out += '\n'
  return { text: out, removed, enhanced }
}

/**
 * Produce the copy's preset.yml text: rename the display name to
 * `<original>+subagents` (or `<source-id>+subagents` when absent/unnamed),
 * keeping every other field (description, order, …) and comment intact.
 * @param {string|null} existingText null when the source preset had no preset.yml
 * @returns {string}
 */
export function updatePresetYml(existingText, sourceId) {
  if (existingText === null || existingText === undefined) {
    const name = `${sourceId}+subagents`
    const description = `Copy of '${sourceId}' adapted by dsh-plugin-subagents`
    const out = stringify({ name, description }, { lineWidth: 0 })
    return out.endsWith('\n') ? out : `${out}\n`
  }
  const doc = parseDocument(existingText)
  if (doc.errors.length > 0) {
    throw new Error(`${PRESET_YML}: invalid YAML (${String(doc.errors[0]).split('\n')[0]})`)
  }
  if (!isMap(doc.contents)) {
    throw new Error(`${PRESET_YML}: expected a mapping at document root, got ${doc.contents.type}`)
  }
  const current = scalarString(doc.contents.get('name', true))
  const next = `${current || sourceId}+subagents`
  doc.contents.set('name', next)
  let out = doc.toString({ lineWidth: 0 }) // keep long descriptions on their original line
  if (!out.endsWith('\n')) out += '\n'
  return out
}

/** Read the plugin adaptation marker; null when absent or unparseable. */
export function readMarker(dir) {
  const markerPath = path.join(dir, MARKER_FILENAME)
  if (!fs.existsSync(markerPath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fall through: corrupt marker reads as absent; the CLI fails loud on it
  }
  return null
}

export function writeMarker(dir, marker) {
  fs.writeFileSync(path.join(dir, MARKER_FILENAME), `${JSON.stringify(marker, null, 2)}\n`)
}

/** Recursive directory copy (fs.cpSync is still experimental on Node 18/20). */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
    else throw new Error(`unsupported directory entry while copying preset: ${from}`)
  }
}

function assertValidPresetId(source) {
  if (!source || source === '.' || source === '..' || source.includes('/') || source.includes('\\') || source.includes(path.sep)) {
    throw new UsageError(`invalid preset id: ${JSON.stringify(source)}`)
  }
  return source
}

/**
 * Full adaptation pipeline over a DSH_HOME. The source preset directory is
 * only ever READ (the transform runs on the copy — the user's real preset
 * under $DSH_HOME/.agent-presets must stay untouched).
 *
 * @param {{ dshHome: string, source: string, mode?: 'l1'|'l2', now?: () => string }} opts
 * @returns {{ skipped: boolean, targetDir: string, marker: object,
 *             removed?: number, enhanced?: number, presetYmlCreated: boolean, presetName: string }}
 */
export function adaptPreset({ dshHome, source, mode = 'l1', now = () => new Date().toISOString() }) {
  assertValidPresetId(source)
  const presetsRoot = path.join(dshHome, PRESET_DIR)
  const sourceDir = path.join(presetsRoot, source)
  if (!fs.existsSync(sourceDir)) {
    throw new Error(
      `source preset not found: ${sourceDir} — pass an existing preset id under ${presetsRoot}` +
        ' (DSH_HOME defaults to ~/.dsh; override with the DSH_HOME environment variable)'
    )
  }
  const sourceAgentYml = path.join(sourceDir, AGENT_YML)
  if (!fs.existsSync(sourceAgentYml)) {
    throw new Error(`source preset has no ${AGENT_YML}: ${sourceAgentYml}`)
  }

  const targetDir = path.join(presetsRoot, `${source}-subagents`)
  if (fs.existsSync(targetDir)) {
    const markerPath = path.join(targetDir, MARKER_FILENAME)
    if (!fs.existsSync(markerPath)) {
      throw new Error(
        `target preset already exists without a ${MARKER_FILENAME} marker — refusing to overwrite: ${targetDir}. ` +
          'Move it away or delete it first.'
      )
    }
    const marker = readMarker(targetDir)
    if (!marker) {
      throw new Error(`corrupt adaptation marker: ${markerPath} — delete the file (or the whole preset copy) and re-run.`)
    }
    return { skipped: true, targetDir, marker, presetYmlCreated: false, presetName: '' }
  }

  // Do every fallible read/transform BEFORE creating anything on disk, so a
  // loud failure never leaves a half-adapted target directory behind.
  const adapted = adaptAgentCordisYml(fs.readFileSync(sourceAgentYml, 'utf8'), mode)
  const presetYmlPath = path.join(targetDir, PRESET_YML)
  const hadPresetYml = fs.existsSync(path.join(sourceDir, PRESET_YML))
  const presetYmlText = updatePresetYml(
    hadPresetYml ? fs.readFileSync(path.join(sourceDir, PRESET_YML), 'utf8') : null,
    source
  )
  const presetName = (parseDocument(presetYmlText).contents?.get?.('name', true)?.value) || `${source}-subagents`
  const marker = { source, mode, adaptedAt: now() }

  copyTree(sourceDir, targetDir)
  try {
    fs.writeFileSync(path.join(targetDir, AGENT_YML), adapted.text)
    fs.writeFileSync(presetYmlPath, presetYmlText)
    writeMarker(targetDir, marker)
  } catch (err) {
    fs.rmSync(targetDir, { recursive: true, force: true })
    throw err
  }
  return {
    skipped: false,
    targetDir,
    marker,
    removed: adapted.removed,
    enhanced: adapted.enhanced,
    presetYmlCreated: !hadPresetYml,
    presetName,
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: preset-adapt.mjs [--dsh-home <dir>] [--source <preset-id>] [--enhance-rows]

Adapt a DSH agent preset for dsh-plugin-subagents (DESIGN §6.3).
  --dsh-home <dir>   DSH home (default: $DSH_HOME, then ~/.dsh)
  --source <id>      source preset id under <dsh-home>/.agent-presets (default: standard)
  --enhance-rows     L2: rewrite official dsh-tool-subagent rows with provider
                     spawn + a distinct toolName to this plugin (presetRow:
                     true); DELETE the generic subagent/subagent_fork rows,
                     fork rows, and bridge template rows (they shadow or cannot
                     mount as presetRow rows — the global instance's
                     subagent/subagent_fork and subagent backend=<bridge> cover
                     them). Default L1 deletes only the generic rows.

The copy lands in <dsh-home>/.agent-presets/<source>-subagents; the source is
never modified. Idempotent: a copy carrying the plugin marker is skipped.`

function parseArgs(argv) {
  const out = {
    dshHome: process.env.DSH_HOME || path.join(homedir(), '.dsh'),
    source: 'standard',
    mode: 'l1',
    help: false,
  }
  const rest = [...argv]
  while (rest.length > 0) {
    const arg = rest.shift()
    if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--enhance-rows') out.mode = 'l2'
    else if (arg === '--dsh-home' || arg === '--source') {
      if (rest.length === 0) throw new UsageError(`missing value for ${arg}`)
      if (arg === '--dsh-home') out.dshHome = rest.shift()
      else out.source = rest.shift()
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option: ${arg}`)
    } else {
      out.source = arg
    }
  }
  return out
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[error] ${err.message}`)
    process.exit(2)
  }
  if (args.help) {
    console.log(USAGE)
    return
  }
  console.log('[info] DSH_HOME = ' + args.dshHome)
  try {
    const result = adaptPreset({ dshHome: args.dshHome, source: args.source, mode: args.mode })
    if (result.skipped) {
      console.log(
        `[skip] ${result.targetDir} already adapted (source: ${result.marker.source}, mode: ${result.marker.mode}, ` +
          `adaptedAt: ${result.marker.adaptedAt}) — nothing to do.`
      )
      // Idempotent skip: only a HINT when the source preset has changed since
      // the copy was made (mtime of the source agent.cordis.yml is later than
      // the marker's adaptedAt). Never re-adapt automatically — the copy stays
      // untouched until the user asks.
      const markerAdaptedTime = Date.parse(result.marker.adaptedAt)
      const sourceYmlPath = path.join(args.dshHome, PRESET_DIR, args.source, AGENT_YML)
      const sourceYmlMtime = fs.existsSync(sourceYmlPath) ? fs.statSync(sourceYmlPath).mtimeMs : -1
      if (!Number.isNaN(markerAdaptedTime) && sourceYmlMtime > markerAdaptedTime) {
        console.log(
          `[note] the source preset changed since this copy was adapted (${AGENT_YML} mtime ${sourceYmlMtime} ` +
            `> adaptedAt ${markerAdaptedTime}) — if you want the changes re-adapted, ` +
            `delete ${result.targetDir} and re-run.`
        )
      }
      if (result.marker.mode !== args.mode) {
        console.log(
          `[note] existing copy was adapted with mode=${result.marker.mode}, not ${args.mode}. ` +
            `To re-adapt, delete ${result.targetDir} and re-run.`
        )
      }
      return
    }
    if (args.mode === 'l1') {
      const wording = result.removed > 0
        ? `[ok] L1: removed ${result.removed} generic delegation row(s) (name: '${OFFICIAL_ROW_NAME}', toolName: ${GENERIC_TOOL_NAMES.join('|')})`
        : '[note] L1: no generic delegation rows found — nothing to un-shadow; copy created unchanged (no-op adaptation)'
      console.log(wording)
    } else {
      console.log(`[ok] L2: enhanced ${result.enhanced} row(s) -> name: '${PLUGIN_ROW_NAME}' + presetRow: true`)
      if (result.removed > 0) {
        console.log(
          `[ok] L2: removed ${result.removed} row(s) that a presetRow cannot host or that would shadow the global tools`
            + ' (generic subagent/subagent_fork rows, provider-fork rows, bridge template rows —'
            + ' the global instance\'s subagent / subagent_fork / subagent backend=<bridge> cover them)'
        )
      }
    }
    console.log(`[ok] ${PRESET_YML} name -> '${result.presetName}'${result.presetYmlCreated ? ' (created)' : ''}`)
    console.log(`[ok] marker written: ${path.join(result.targetDir, MARKER_FILENAME)}`)
    console.log('')
    console.log('Done. Next steps:')
    console.log(`  1. Switch the preset in the UI: Settings > General > Agent preset -> '${result.presetName}'`)
    console.log('  2. Start a NEW session for the adapted preset to take effect (recompose only applies to empty sessions).')
    console.log(`To undo: switch back in the UI and delete ${result.targetDir}`)
  } catch (err) {
    console.error(`[error] ${err.message}`)
    process.exit(1)
  }
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
if (invokedAsScript) main()
