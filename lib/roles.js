import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Declarative role library: one JSON file per role (like Claude Code's
 * `.claude/agents/*.md`), loaded from `rolesDir` (default: this plugin's
 * `roles/` directory).
 *
 * Role schema:
 *   id             — the role id IS the file basename; an `id` field inside
 *                    the file is documentation only (it is not used)
 *   description    — when to use this role (shown to the delegating model)
 *   backend        — backend to delegate to: 'native' | a bridge provider
 *                    name | '' (caller chooses; 'native' is the tool default).
 *                    A non-empty value is NOT existence-validated here — the
 *                    tool layer resolves and validates on merge.
 *   permissionMode — "readonly" | "default" | "full" — applies to the REMOTE
 *                    PRODUCT agent, never to the relay model (the relay is
 *                    always a read-only pipe: only subagent_submit and, when
 *                    allowDelegation, subagent).
 *   allowDelegation— whether the subagent may spawn its own subagents
 *   instructions   — extra instructions prepended to the product's task
 *   overrides      — native-only defaults passed through verbatim (no deep
 *                    validation here): { agentOptions?, persona?,
 *                    toolFilter?, maxDepth? }. Per-call parameters still win.
 *
 * Unknown role ids resolve to null — callers fail loudly (an omitted role
 * defaults to `general` at the caller); the loader guarantees a `general`
 * entry always exists.
 */
export function createRoleLibrary(rolesDir) {
  let cache

  const load = () => {
    if (cache !== undefined) return cache
    cache = {}
    try {
      for (const file of readdirSync(rolesDir)) {
        if (!file.endsWith('.json')) continue
        const id = file.slice(0, -'.json'.length)
        try {
          const raw = JSON.parse(readFileSync(join(rolesDir, file), 'utf8'))
          cache[id] = {
            id,
            description: raw.description || '',
            backend: raw.backend || '',
            permissionMode: ['readonly', 'default', 'full'].includes(raw.permissionMode) ? raw.permissionMode : 'default',
            // delegation defaults ON for standard roles (like Claude Code's
            // general-purpose agents); an explicit `false` bans it (e.g. the
            // Explore role, which must never spawn subagents)
            allowDelegation: raw.allowDelegation !== false,
            instructions: raw.instructions || '',
            // native-only defaults, passed through verbatim (no deep
            // validation); an absent overrides block contributes nothing
            overrides: raw.overrides || {},
          }
        } catch {
          // a malformed role file is skipped (never breaks the plugin)
          console.warn(`[roles] skipping malformed role file: ${file}`)
        }
      }
    } catch {
      // roles dir missing → only the built-in fallbacks below
    }
    // built-in fallback so a missing roles dir never breaks delegation
    if (!cache.general) {
      cache.general = {
        id: 'general',
        description: '通用代理:处理其他所有任务,放开产品全部权限。',
        backend: '',
        permissionMode: 'full',
        allowDelegation: true,
        instructions: 'You are the general-purpose agent. Complete the task directly and thoroughly with full permissions.',
        overrides: {},
      }
    }
    return cache
  }

  return {
    list() {
      return Object.values(load())
    },
    /**
     * Resolve a role id EXACTLY; unknown ids return null so the caller fails
     * loudly (a silent fallback to the full-permission "general" role on a
     * typo would be a privilege footgun). Callers default to "general"
     * themselves when the role is omitted; the loader guarantees a "general"
     * entry always exists.
     */
    get(id) {
      const roles = load()
      return roles[id] || null
    },
  }
}

export function defaultRolesDir() {
  // fileURLToPath (not `.pathname`): on Windows, `import.meta.url` pathname
  // starts with `/C:/…`, which join() would corrupt.
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'roles')
}
