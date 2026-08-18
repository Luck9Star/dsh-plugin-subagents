import { homedir } from 'node:os'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Durable registry mapping a product child's harness session id to its remote
 * product session id (plus the settings — permissionMode / model /
 * reasoningEffort — the child was created with, so recovery restores the SAME
 * permission ceiling instead of silently escalating to the product default).
 * The remote id is captured the moment it is known and survives binding
 * disposal (idle release) and process restarts, so a cold-resumed child
 * reconnects to the SAME product session instead of resetting the
 * conversation.
 *
 * This file is the ONLY recovery source after a restart: a child's own log
 * markers are display metadata, never authorization (any session that
 * relayed a marker-bearing answer could otherwise claim the remote session).
 *
 * Writes are small, atomic (temp file + rename), owner-only (0600), and the
 * registry is pruned to the newest MAX_ENTRIES children so it cannot grow
 * forever. Stale entries (a deleted child) are harmless: reconnection falls
 * back to a fresh product session.
 */
export const DEFAULT_PATH = join(homedir(), '.dsh', 'subagents-registry.json')
const MAX_ENTRIES = 500

let warnedSaveFailure = false

export function createRegistry(path = DEFAULT_PATH) {
  let cache

  const load = () => {
    if (cache !== undefined) return cache
    try {
      const raw = readFileSync(path, 'utf8')
      // null prototype: a hostile/corrupt key like "__proto__" must not reach
      // Object.prototype
      cache = Object.assign(Object.create(null), JSON.parse(raw))
      // tighten a pre-0600-era file (or one left world-readable by a crash)
      try { chmodSync(path, 0o600) } catch { /* best-effort */ }
    } catch {
      cache = Object.create(null)
    }
    return cache
  }

  const save = () => {
    try {
      prune()
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
      // a leftover tmp from a crash keeps its OLD mode on overwrite — force it
      try { chmodSync(tmp, 0o600) } catch { /* best-effort */ }
      renameSync(tmp, path)
    } catch (error) {
      // best-effort: recovery falls back to a fresh product session, but say
      // so once instead of failing completely silently
      if (!warnedSaveFailure) {
        warnedSaveFailure = true
        console.warn(`subagents: registry write failed (${error && error.message}); session recovery may degrade after a restart`)
      }
    }
  }

  const prune = () => {
    const keys = Object.keys(cache)
    if (keys.length <= MAX_ENTRIES) return
    // Ties on updatedAt (same millisecond) break by insertion order — object
    // key order tracks insertion for these string keys — so the OLDEST
    // entries are pruned deterministically.
    const rank = new Map(keys.map((key, index) => [key, index]))
    const byAge = keys
      .map((key) => ({ key, at: Number(cache[key] && cache[key].updatedAt) || 0, seq: rank.get(key) }))
      .sort((a, b) => (b.at - a.at) || (b.seq - a.seq))
    for (const { key } of byAge.slice(MAX_ENTRIES)) delete cache[key]
  }

  return {
    /** Record or refresh one child's remote session identity and settings. */
    set(childId, entry) {
      if (typeof childId !== 'string' || childId === '__proto__' || childId === 'constructor' || childId === 'prototype') return
      const data = load()
      data[childId] = { ...entry, updatedAt: Date.now() }
      save()
    },
    /** Look up one child's recorded remote session identity. */
    get(childId) {
      const data = load()
      const entry = data[childId]
      return entry === undefined ? undefined : { ...entry }
    },
    /** Drop one child's entry (e.g. when its session is deleted). */
    remove(childId) {
      const data = load()
      if (data[childId] !== undefined) {
        delete data[childId]
        save()
      }
    },
    /** Number of entries (test/diagnostic use). */
    get size() {
      return Object.keys(load()).length
    },
  }
}

/**
 * The legacy bridges plugin's durable registry —
 * the one-time migration source (DESIGN §6.6). The old file is NEVER touched
 * or removed by the migration.
 */
export const LEGACY_PATH = join(homedir(), '.dsh', 'product-subagents-registry.json')

/**
 * Re-entry marker path for the one-time legacy import: the target registry
 * path with `.json` replaced by `.migrated` (`~/.dsh/subagents-registry.json`
 * → `~/.dsh/subagents-registry.migrated`, exactly as DESIGN §6.6 specifies).
 * Deriving it from the target keeps injected test paths hermetic.
 */
function markerPathFor(targetPath) {
  return targetPath.endsWith('.json')
    ? `${targetPath.slice(0, -'.json'.length)}.migrated`
    : `${targetPath}.migrated`
}

/**
 * One-time legacy registry import (DESIGN §6.6, wired from apply()):
 *
 *  - runs only when the NEW registry does not exist yet, the legacy file
 *    exists, and the `.migrated` marker is absent (marker OR an existing
 *    target both guard re-entry);
 *  - translates each legacy entry's `product` field to `backend` (the T03
 *    rename; every other field — remoteId / cwd / settings / updatedAt —
 *    passes through so cold-resumed children reconnect to the SAME remote
 *    session with the SAME permission ceiling);
 *  - writes the new file atomically with the same discipline as save()
 *    (temp + rename, owner-only 0600) and drops hostile keys (__proto__ …);
 *  - leaves the legacy file untouched.
 *
 * A legacy file that exists but cannot be read/parsed is reported (reason
 * carries the detail) WITHOUT performing the import — the caller warns and
 * the plugin continues; new-era functionality never depends on legacy data.
 *
 * @param {Object} [options]
 * @param {string} [options.legacyPath]  source (default LEGACY_PATH; test injection)
 * @param {string} [options.targetPath]  destination (default DEFAULT_PATH)
 * @returns {{ performed: boolean, imported: number, markerExists: boolean, reason?: string }}
 */
export function migrateLegacyRegistry({ legacyPath = LEGACY_PATH, targetPath = DEFAULT_PATH } = {}) {
  const marker = markerPathFor(targetPath)
  if (existsSync(marker)) {
    return { performed: false, imported: 0, markerExists: true, reason: 'marker-exists' }
  }
  if (existsSync(targetPath)) {
    // An existing new-era registry is its own re-entry guard (and must never
    // be clobbered by an import).
    return { performed: false, imported: 0, markerExists: false, reason: 'target-exists' }
  }
  let raw
  try {
    raw = readFileSync(legacyPath, 'utf8')
  } catch {
    return { performed: false, imported: 0, markerExists: false, reason: 'legacy-missing' }
  }
  let doc
  try {
    doc = JSON.parse(raw)
  } catch (error) {
    return { performed: false, imported: 0, markerExists: false, reason: `legacy-unreadable: ${error && error.message}` }
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { performed: false, imported: 0, markerExists: false, reason: 'legacy-invalid-shape' }
  }

  const entries = Object.create(null)
  let imported = 0
  for (const [childId, entry] of Object.entries(doc)) {
    if (childId === '__proto__' || childId === 'constructor' || childId === 'prototype') continue
    if (entry === null || typeof entry !== 'object') continue
    const { product, ...rest } = entry
    entries[childId] = { ...rest, ...(product !== undefined ? { backend: product } : {}) }
    imported += 1
  }

  // Atomic, owner-only write — same discipline as the registry's own save().
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* best-effort */ }
  renameSync(tmp, targetPath)

  // Re-entry marker. If THIS write fails the existing-target check above still
  // guards a second import, so the failure is tolerable.
  try {
    writeFileSync(marker, JSON.stringify({ migratedAt: new Date().toISOString(), legacyPath, imported }, null, 2), { mode: 0o600 })
    try { chmodSync(marker, 0o600) } catch { /* best-effort */ }
  } catch { /* target-exists check guards re-entry */ }

  return { performed: true, imported, markerExists: true, reason: 'imported' }
}
