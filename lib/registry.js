import { homedir } from 'node:os'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
        console.warn(`legacy-bridges-plugin: registry write failed (${error && error.message}); session recovery may degrade after a restart`)
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
