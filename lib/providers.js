import { createClaudeBridge } from './bridges/claude.js'
import { createCodexBridge } from './bridges/codex.js'
import { createAcpBridge } from './bridges/acp.js'
import { createGrokBridge } from './bridges/grok.js'
import { authChecks } from './availability.js'

/**
 * Config-driven provider registry.
 *
 * Built-ins: `claude-code` (type claude), `codex` (type codex), `grok-native`
 * (type grok — the NATIVE streaming-json bridge, one `grok --single=…`
 * process per turn), `acp` (type acp, default command `opencode acp`).
 *
 * NAMING OWNERSHIP (design ruling 2026-08-16): the bare name `grok` belongs
 * to the USER's `config.providers` — existing deployments define it as an
 * ACP transport (e.g. `grok: { type: acp, command: grok, args: [agent,
 * --always-approve, stdio] }`), and durable registry entries with
 * `backend: "grok"` hold ACP-issued remote ids. The native bridge therefore
 * registers under its OWN built-in id `grok-native` and NEVER claims `grok`:
 * the two coexist (`grok` = the user's ACP provider, `grok-native` = the
 * native protocol bridge), and no migration or resume-id heuristics are
 * performed (ACP ids and native session ids cannot be reliably told apart).
 *
 * Custom providers are added (or built-ins overridden) through
 * `config.providers`:
 *
 *   config:
 *     providers:
 *       cursor:    { type: acp, command: agent, args: [acp] }      # Cursor CLI: `agent acp`
 *       codebuddy: { type: acp, command: cbc, args: [--acp] }      # CodeBuddy: `cbc --acp`
 *       gemini:    { type: acp, command: gemini, args: [--acp] }   # Gemini CLI: `gemini --acp`
 *       opencode:  { type: acp, command: opencode, args: [acp] }   # opencode: `opencode acp`
 *       claude-code: { command: claude, env: { ANTHROPIC_API_KEY: '...' } }
 *
 * Invocations verified against each product's own docs (Cursor 2026: the CLI
 * binary is `agent`, so ACP mode is `agent acp` — older references to
 * `cursor-agent acp` are outdated).
 *
 * Any ACP-capable CLI works through the generic acp bridge (persistent
 * process, session/load resume, dead-process reconnect). type may also be
 * `claude` or `codex` to override a built-in's command/env/timeout.
 *
 * NOTE on permissions: ACP has no portable permission flag — a role's
 * permissionMode cannot be enforced on an arbitrary ACP agent by this client.
 * Configure the agent's own flags (e.g. read-only or auto-approve modes)
 * through the provider's `args`; permission requests from the agent are
 * always answered "rejected" so it never silently gains more than its own
 * configuration allows.
 */
const BUILT_INS = {
  'claude-code': { type: 'claude', command: 'claude', checkAuth: authChecks['claude-code'] },
  codex: { type: 'codex', command: 'codex', checkAuth: authChecks.codex },
  'grok-native': { type: 'grok', command: 'grok', checkAuth: authChecks.grok },
  acp: { type: 'acp', command: 'opencode', args: ['acp'], checkAuth: authChecks.acp },
}

export function buildProviders(config = {}) {
  const providers = {}
  const entries = { ...BUILT_INS, ...(config.providers || {}) }
  for (const [name, def] of Object.entries(entries)) {
    const base = BUILT_INS[name] || {}
    const type = def.type || base.type || 'acp'
    const fallbackCommand = type === 'claude' ? 'claude' : type === 'codex' ? 'codex' : type === 'grok' ? 'grok' : 'opencode'
    const command = def.command || base.command || fallbackCommand
    // Built-in `args` / `checkAuth` belong to the built-in COMMAND. When the
    // command is swapped (e.g. overriding the `acp` entry to point at another
    // CLI), inheriting `['acp']` would silently launch the wrong subcommand.
    const sameCommand = def.command === undefined || def.command === base.command
    providers[name] = {
      name,
      type,
      command,
      args: def.args || (sameCommand ? base.args : undefined) || (type === 'acp' ? ['acp'] : []),
      env: def.env || base.env || {},
      timeoutMs: def.timeoutMs !== undefined ? def.timeoutMs : base.timeoutMs,
      checkAuth: def.checkAuth || (sameCommand ? base.checkAuth : undefined) || authChecks.acp,
      // Threading config.redactSecrets (default true) into every def; only an
      // explicit false ever disables (see createBridgeFor / lib/redact.js).
      ...(config.redactSecrets === false ? { redactSecrets: false } : {}),
    }
  }
  return providers
}

/** Create the right bridge for one provider definition. */
export function createBridgeFor(provider) {
  const options = {
    command: provider.command,
    env: provider.env,
    ...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
  }
  // redactSecrets threads config.redactSecrets into every bridge (default
  // true — see lib/redact.js). Built-ins and config.providers entries share
  // the switch; there is deliberately no per-provider override (a partial
  // off-switch would invite accidental secret passthrough).
  if (provider.redactSecrets === false) options.redactSecrets = false
  if (provider.type === 'claude') return createClaudeBridge(options)
  if (provider.type === 'codex') return createCodexBridge(options)
  if (provider.type === 'grok') return createGrokBridge(options)
  return createAcpBridge({ ...options, args: provider.args && provider.args.length ? provider.args : ['acp'] })
}

/**
 * Hardening sentence appended to every relay persona (D2b): the relay model
 * answering identity/runtime questions from its own knowledge was the exact
 * failure — this is the probabilistic layer; the deterministic layer is the
 * turn-closure guard (lib/relay-guard.js, DESIGN §5.4).
 */
const RELAY_HARDENING = ' NEVER answer from your own knowledge, identity, or runtime — you are a relay, not the worker. Any question (including which product/CLI/model you are running as) must go through subagent_submit, and your report must relay the product\'s answer verbatim. A report without a subagent_submit call in the same turn will be rejected.'

/** Relay persona for one provider; custom providers get a generic ACP one. */
export function providerPersona(name, provider) {
  const display = provider && provider.command ? `${name} (${provider.command})` : name
  if (provider && provider.type === 'claude') {
    return `You are a relay bridge to the Claude Code CLI agent. For every user message you receive, call subagent_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — Claude Code owns the full context and file access in this workspace. After subagent_submit returns Claude Code's answer, relay it faithfully to the agent that started you with the report tool.${RELAY_HARDENING}`
  }
  if (provider && provider.type === 'codex') {
    return `You are a relay bridge to the Codex CLI agent. For every user message you receive, call subagent_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — Codex owns the full context and file access in this workspace. After subagent_submit returns Codex's answer, relay it faithfully to the agent that started you with the report tool.${RELAY_HARDENING}`
  }
  if (provider && provider.type === 'grok') {
    return `You are a relay bridge to the Grok CLI agent. For every user message you receive, call subagent_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — Grok owns the full context and file access in this workspace. After subagent_submit returns Grok's answer, relay it faithfully to the agent that started you with the report tool.${RELAY_HARDENING}`
  }
  return `You are a relay bridge to the ACP CLI agent ${display} in this workspace. For every user message you receive, call subagent_submit with the task text verbatim (clarify only if needed). Do not attempt the task yourself with local tools — the ACP agent owns the full context and file access. After subagent_submit returns the ACP agent's answer, relay it faithfully to the agent that started you with the report tool.${RELAY_HARDENING}`
}
