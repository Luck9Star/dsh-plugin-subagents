# dsh-plugin-subagents

**English** | [简体中文](README.zh.md)

> Runs on DeepSeek Harness (dsh) `0.1.0-rc.6` / `0.1.0-rc.7` · Node ≥ 18 · MIT

The subagent upgrade for DeepSeek Harness. The model keeps using the same
`subagent` / `subagent_fork` tools it already knows — but each call can now:

- **Stay native and go fast** — delegate to a dsh in-process subagent, and
  override anything per call: `model`, `provider`, `persona`, tool access
  (`toolFilter`), and the working directory (`cwd`).
- **Borrow other agents** — delegate straight to an external agent CLI:
  **Claude Code**, **Codex**, **Grok**, or **any ACP agent**. A bridge child
  is a long-lived peer you keep talking to, and it reconnects to the same
  external session even after dsh restarts.
- **Pick a role, not a paragraph** — send a task with a named role
  (`code-review`, `explore`, `codex-full`, …) that pins the backend,
  permission mode, and instructions for you.

Everything fails loud: an unsupported parameter is never silently ignored,
and output coming back from external CLIs is scrubbed of secrets before it
enters the conversation.

## When you reach for it

- You want a quick read-only codebase scout or reviewer without write tools
  (`role: "explore"`, `role: "code-review"`).
- You want the heavy editing done by Codex or Claude Code, but orchestrated
  from your dsh session, with results streamed back into the conversation.
- You want several agents working in parallel, each in its own directory
  (`cwd`) — pair it with
  [dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees).
- You want a multi-task job planned, dispatched, and resumed across
  restarts — pair it with
  [dsh-dag-orchestrator](https://github.com/Luck9Star/dsh-dag-orchestrator).

## Requirements

| Need | Detail |
| --- | --- |
| dsh | `0.1.0-rc.6` or `0.1.0-rc.7` |
| Node | ≥ 18 |
| Bridge backends (optional) | the CLI installed **and logged in**: `claude`, `codex`, `grok`, or any ACP agent (e.g. `opencode acp`). A missing CLI simply means that backend is not offered — native subagents need nothing extra. |

## Install

```sh
# 1. Get the repo and link it to your running dsh's internal packages
git clone https://github.com/Luck9Star/dsh-plugin-subagents
cd dsh-plugin-subagents
npm install
npm run setup:peer        # avoids a second copy of dsh-tools (tool calls crash without this)

# 2. Install into your dsh profile
dsh plugin --profile web add "$(pwd)"

# 3. Apply the harness patches — ALWAYS run this
./patches/install.sh      # Windows: patches\install.ps1
#    stage A (mandatory): repairs the dsh-tools single-instance symlinks
#    stage B (recommended): enables per-call cwd for subagents

# 4. (Recommended) read-only health check
./patches/verify.sh       # Windows: patches\verify.ps1 ; --probe also live-tests cwd

# 5. (Web sessions on standard-like presets) adapt the preset layer
./scripts/install-preset.sh standard

# 6. Restart and open a NEW session
dsh --profile web
```

**Expected result:** a new session exposes the tools `subagent`,
`subagent_fork`, `subagent_submit`, `subagent_progress`, `subagent_wait`,
`subagent_roles`, `subagent_agents`. `subagent_agents` shows which backends
are available and which CLIs were found on your PATH.

> **Upgraded dsh?** Re-run `./patches/install.sh` — a dsh upgrade lands in a
> fresh npx cache directory, so the cwd patch must be re-applied.

## Quick start

Ask your agent to call the tools, or drive them yourself:

```jsonc
// Native subagent in a specific directory, run and wait
subagent({ prompt: "Run pwd and echo the first line only",
           cwd: "/tmp/dsh-smoke", run_in_background: false })

// Native subagent on a different model, just for this call
subagent({ prompt: "…", model: "deepseek-v4-flash" })

// Delegate to Codex in the background, then collect the answer
subagent({ backend: "codex",
           prompt: "Which product/CLI are you running as? Reply with the name only.",
           run_in_background: true })   // → { kind: "background", job_id: "…" }
subagent_wait({ subagent_id: "…", timeout_ms: 60000 })   // → "Codex"

// Ask a role instead of writing the policy yourself
subagent({ role: "code-review", prompt: "Review the staged diff." })
```

A background or bridge call returns a **child id**; watch it with
`subagent_progress` and collect with `subagent_wait`. Bridge children are
continuable — call again and the same external session answers.

## Built-in roles

One JSON file per role in `roles/` — drop in your own and they are picked up
automatically (`rolesDir` config).

| Role | Backend | Permission | What it is for |
| --- | --- | --- | --- |
| `general` | caller's choice | full | Default. Handles anything no other role matches. |
| `explore` | native | read-only toolset | Fast codebase reconnaissance — search and read, never write. |
| `code-review` | native | read-only toolset | Reviews diffs for defects, security, maintainability. |
| `debug` | native | default | Root-causes bugs and failures; may spawn read-only helpers. |
| `codex-full` | codex | full | Workhorse: edits files and runs commands via Codex. |
| `claude-readonly` | claude-code | readonly | Read-and-plan with Claude Code, no file changes. |
| `grok-native-full` | grok-native | full | Workhorse on the Grok CLI. |

## Tools

| Tool | What it does |
| --- | --- |
| `subagent` | Delegate a task. Returns a continuable child, a background job, or (foreground) the final output. |
| `subagent_fork` | Same, forking variant (one-shot by default). |
| `subagent_submit` | Hand work to a running bridge child (the relay pipe). |
| `subagent_progress` | Live progress of a child — including how many times a bridge child actually forwarded work out. |
| `subagent_wait` | Block until a child answers (`timeout_ms` default 300 s, max 600 s). |
| `subagent_roles` | List available roles. |
| `subagent_agents` | Availability overview: which backends exist, which CLIs were found, login hints. |

## Safety, built in

- **Permission ceiling** — a bridge child can never spawn a descendant with
  *more* permission than itself. A read-only Codex child cannot escape by
  delegating to a full-permission Claude child — through any path, including
  plugin-to-plugin dispatch. Unknown modes fail closed to read-only.
- **Secret redaction** — bridge output is scrubbed before entering the
  conversation: Bearer tokens, `sk-…` keys, `ghp_/gho_…` tokens, `api_key=`
  assignments, JWTs. On by default (`redactSecrets`).
- **Relay honesty guard** — a bridge child is a *relay*: its job is to
  forward your task to the external CLI, not to answer itself. If it reports
  back without ever forwarding, the report is rejected with a clear warning,
  so a lazy relay can't quietly pass off its own text as Codex's work.
- **Durable recovery** — each bridge child's session mapping and settings
  live in `~/.dsh/subagents-registry.json` (atomic writes, owner-only
  `0600`, capped at 500 entries). After a restart, children reconnect to the
  same external session with the same permission ceiling — the registry is
  the only recovery source, never the child's own log lines.

## Configuration

Optional — everything below has a working default. Keys live on the plugin's
row in your profile's `cordis.patch.yml`; unknown keys fail loudly at startup.

| Key | Default | Meaning |
| --- | --- | --- |
| `providers` | built-ins | Extra bridge CLIs, e.g. `{ myagent: { type: "acp", command: "opencode", args: ["acp"] } }`. Types: `claude` / `codex` / `grok` / `acp`. |
| `rolesDir` | bundled `roles/` | Where role JSON files are loaded from. |
| `idleTimeoutMs` | `600000` | Idle timeout for bridge children (`0` = never). |
| `maxConcurrentChildren` | `8` | Cap on live bridge children. |
| `redactSecrets` | `true` | Scrub secrets from bridge output. |
| `relayReportGuard` | `true` | Reject relay reports that never forwarded. |
| `maxDispatchPermissionMode` | `full` | Permission ceiling for plugin-to-plugin dispatch calls. |
| `legacyProductAliases` | `auto` | Compatibility aliases for children migrated from an older registry. |
| `provider` | `spawn` | Default native subagent provider. |
| `agentOptions` | — | Default `{ provider, model, maxTokens }` for native children. |
| `persona` / `toolFilter` / `maxDepth` | — | Defaults for native children; per-call values win. |
| `toolNames.delegate` / `toolNames.fork` | `subagent` / `subagent_fork` | Rename the takeover tools if you must. |
| `register.*` | `true` | Per-tool switches (`register.wait`, …). |
| `presetRow` | `false` | Expert: register as official preset rows instead of taking over the global tools. |

Role files accept: `description` (shown to the delegating model), `backend`,
`permissionMode` (`readonly` / `default` / `full`), `allowDelegation`,
`instructions` (prepended to the task), `overrides` (native-only per-role
defaults). Full shapes: [docs/DESIGN.md](docs/DESIGN.md).

## For plugin authors: the dispatch seam

Other plugins can dispatch bridge subagents programmatically — no model tool
call involved — via `ctx.get('subagentsDispatch')`. Two permission gates
apply (the delegation ceiling and `maxDispatchPermissionMode`). Details and
examples: [docs/dispatch-seam.md](docs/dispatch-seam.md).

## Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| Every tool call dies with `Cannot read properties of undefined (reading 'prepare')` | Two physical copies of `dsh-tools`. Re-run `npm run setup:peer` in this repo, then `./patches/install.sh`. |
| `subagent: backend "codex" is not available: command "codex" not found on PATH` | The CLI is not installed. Install and log in (`codex login`), restart dsh. `subagent_agents` shows hints for every backend. |
| `cwd` seems ignored after a dsh upgrade | Re-run `./patches/install.sh` — the cwd patch must be re-applied after every dsh upgrade. |
| `subagent: permission escalation blocked …` | Working as designed: a child tried to spawn a higher-permission descendant. |
| grok-native answers with a single character, or every retry fails with `Session ID ... is already in use` | Fixed: grok CLI 1.0.5 streams `text` events as token slices and refuses a reused `-s` id. Update this plugin — the parser now concatenates slices, the lockup falls back to `--resume`, and the default timeout is 15 minutes. |
| Duplicate-provider registration errors at startup | Another plugin in the same profile registers the same bridge backends or takes over `subagent`. Remove one of them: edit the profile's `cordis.patch.yml`, then `pnpm remove` that package, then reinstall this one. |

## Works well with

- [dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees) — parallel tasks each write into their own git worktree via `cwd`.
- [dsh-dag-orchestrator](https://github.com/Luck9Star/dsh-dag-orchestrator) — plans and resumes multi-task DAGs; its task nodes rely on this plugin's `cwd` support.

## Development

```sh
npm install && npm run setup:peer   # link the running harness's peers
npm test                            # node --test, fakes only — no CLI, key, or network
npm run lint
```

Design record: [docs/DESIGN.md](docs/DESIGN.md) · verification playbook:
[docs/VERIFY.md](docs/VERIFY.md).

## References & credits

- **DeepSeek Harness** native `subagent` tool family — the surface this
  plugin extends.
- **Claude Code** (`.claude/agents` per-file agent definitions) — the shape
  of the role library: one file per role, delegation on by default.
- **Codex CLI**, **Claude Code CLI**, **Grok CLI** — the bridge backends.
- **Agent Client Protocol (ACP)** and its
  [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) —
  any ACP-speaking agent plugs in with zero extra code.
- **task-weaver** — the secret-redaction pass and the Grok bridge
  argv/parsing/classification logic are ported from it.

## Security

See [SECURITY.md](SECURITY.md). Bridge CLIs run with your own credentials —
the plugin never executes a CLI just to probe availability (PATH lookup
only), and secrets it has redacted never reach the conversation.

## License

[MIT](LICENSE)
