# dsh-plugin-subagents

**English** | [简体中文](README.zh.md)

The unified subagent plugin for the DeepSeek Harness: one `subagent*` tool
family over two backends — **native in-process subagents** with per-call
overrides (including `cwd`), and **external agent CLIs** (Claude Code, Codex,
Grok, any ACP agent) as durable, continuable bridge subagents. It takes over
the official `subagent` / `subagent_fork` tool names, so model habits carry
over with zero migration, and it **fully replaces** both `legacy-cwd-plugin`
and `legacy-bridges-plugin` (see [Mutual exclusion](#mutual-exclusion-choose-one)).

## Features

- **One tool surface, two backends** — `subagent` delegates to a native
  in-process subagent by default; the `backend` parameter (or a role) switches
  to an external agent CLI. Capability mismatches fail loudly — an unsupported
  parameter is never silently ignored.
- **Native per-call overrides** — `model` (bare id or `provider/model`
  composite), `provider`, `persona` (including `@preset:` references),
  `toolFilter`, and per-call `cwd` (distributed as two minimal patches by this
  repo's installer).
- **CLI bridges** — Claude Code (`--session-id` / `--resume`), Codex (JSONL
  thread capture, `resume`), Grok (native streaming-json bridge under the
  built-in id `grok-native`: one `grok --single=<task>` process per turn,
  session id captured from the terminal `end` event, resumed via
  `--resume <id>`), and a generic ACP bridge (persistent process,
  `session/load` reconnect, vendor-notification absorption). Any ACP CLI
  joins through `config.providers` with zero code. The bare name `grok`
  belongs to your `config.providers` (an ACP transport on existing
  deployments) — `grok-native` and a user-defined `grok` provider coexist.
- **Secret redaction on every bridge output** — common secret shapes
  (`Bearer …`, `sk-…` keys, `gh?_…` PATs, `api_key=…` assignments, JWTs) are
  scrubbed from captured CLI stdout/stderr and from the final text every
  bridge returns to the model, by default (ported from task-weaver's
  redactor). A secret a product CLI prints can never leak into the
  conversation context. Switch: `redactSecrets` (default `true`).
- **Role library with a permission ceiling** — declarative roles pin a
  backend, the remote permission mode, extra instructions, and native
  overrides. `readonly < default < full` can never be raised down the
  delegation tree; unknown stored modes fail closed to `readonly`.
- **Relay turn-closure guard (D2b)** — a bridge relay child that tries to
  `report` an answer before forwarding anything through `subagent_submit` in
  the same turn gets the report call rejected with a corrective error (the
  model can still forward and report afterwards); relay personas carry a
  matching hardening sentence, and `subagent_progress` / `subagent_wait`
  surface zero-submit epochs (`relayEpochSubmits`, `relayGuardFlag`, a
  labeled answer prefix) so a self-answering relay can never masquerade as
  the remote product silently. Switch: `relayReportGuard` (default `true`).
- **Durable recovery** — bridge children survive idle disposal and restarts
  (durable registry: owner-only `0600` atomic writes, 500-entry cap); native
  children persist with the harness session. A predecessor
  `legacy-bridges-plugin` registry migrates once on first load, with
  optional `product_submit` / `product_delegate` aliases for old relay
  children.
- **Install + doctor** — a two-stage installer (mandatory `dsh-tools`
  single-instance link repair + optional cwd patches) and a read-only `verify`
  doctor that catches npx-cache drift loudly instead of letting it fail
  silently.

## Requirements

- DeepSeek Harness `0.1.0-rc.6` (the `peerDependencies` lock the
  `^0.1.0-rc.6` family).
- Node ≥ 18.
- For bridge backends only: at least one CLI on `PATH` and authenticated —
  `claude`, `codex`, `grok`, or any ACP CLI. Native-only deployments need
  none.

## Install

Six steps (DESIGN §6.5). Steps 1–3 and 6 are always required; step 5 is for
web sessions on `standard`-like presets.

```sh
# 1. Install the plugin (auto-appends the bundle layer, which disables the
#    official tool-subagent rows and registers the unified tool surface)
dsh plugin --profile web add dsh-plugin-subagents      # or: add <local path>

# 2. Remove the predecessor (mutual exclusion — see the table below)
#    a. edit ~/.dsh/profiles/web/cordis.patch.yml and delete the
#       `- id: legacy-bridges-plugin` insert row
#    b. cd ~/.dsh/profiles/web && pnpm remove legacy-bridges-plugin

# 3. [MUST RUN] dsh-tools single-instance links + cwd patches (two stages)
./patches/install.sh              # macOS / Linux
patches\install.ps1               # Windows

# 4. (Recommended) read-only doctor
./patches/verify.sh               # Windows: patches\verify.ps1

# 5. Adapt the preset for web sessions (standard-like presets need this)
./scripts/install-preset.sh standard

# 6. Restart dsh and open a NEW session
dsh --profile web
```

Step notes:

- **Step 3 is mandatory even if you never use per-call `cwd`.** Stage A
  repairs the `@deepseek-ai/dsh-tools` references (this repo's `node_modules`
  and every profile tree) so they resolve to the live harness root — a second
  physical copy of `dsh-tools` kills **every** tool call (see
  [Upgrading dsh / npx cache drift](#upgrading-dsh--npx-cache-drift)). Stage A
  runs first and is never blocked by Stage B. Stage B applies the two cwd
  patches (per-patch four-state logic, `.bak_cwd` backup, `node --check`
  verification, loud failure on anchor drift). Exit codes: `0` success;
  `1` live-root resolution or Stage A failure; `3` Stage B drift (Stage A
  results remain in place — the output says so).
  Don't need per-call `cwd`? Run `./patches/install.sh --links-only` — Stage A
  only, no patches evaluated.
- **Step 4** verifies the live root, both cwd patches (two different files at
  two different merge points), both `dsh-tools` links, and the repo's
  `dsh-subagent` copy version (warning only). Any drift → non-zero exit with a
  one-line fix hint. `--probe` re-runs the behavioral cwd probe as an
  independent deep check.
- **Step 5**: in `web` sessions the tool surface is owned by the session's
  **preset** — a preset-layer row shadows any same-name host-plane tool, so
  the shipped `standard` preset would shadow this plugin's `subagent` with the
  official native-only one. The script copies the source preset to
  `<source>-subagents`, deletes the generic delegation rows from the copy
  (the source is never touched), and is idempotent. Then **switch to the
  adapted preset in the UI and open a new session** (`recompose` only works on
  a blank session). `orchestrator`-type presets have no generic subagent rows
  and need no adaptation; they may instead opt into L2:
  `./scripts/install-preset.sh <source> --enhance-rows` rewrites the official
  rows a preset-row instance can host (`provider: spawn` + a `toolName` of
  its own) to this plugin (`presetRow: true`), keeping the per-row role/model
  pattern and gaining all per-call enhancements. The remaining official rows
  are **deleted** from the copy instead of rewritten: generic
  `subagent`/`subagent_fork` rows (they would shadow the global instance's
  full-parameter tools), `provider: fork` rows (a preset-row instance
  registers a spawn-semantics delegate — fork-style context-inheriting
  delegation stays on the global `subagent_fork`), and bridge template rows
  like `provider: codex` / `claude-code` (bridge delegation belongs to the
  global `subagent` tool's `backend` parameter). Rewriting any of those would
  either shadow the global tools or fail the plugin's own config validation
  at mount time — and one bad row takes the whole preset down (the
  2026-08-15 smoke incident; see docs/VERIFY.md).

### Local development install

```sh
git clone <this repository> && cd dsh-plugin-subagents
npm install
npm run setup:peer     # symlink the RUNNING harness's dsh-tools into node_modules/
dsh plugin --profile web add "$(pwd)"
# then steps 2–6 above as usual
```

`@deepseek-ai/dsh-tools` is a peerDependency: dsh-tools registers its
tool-runtime scheduler under a module-level Symbol, so a second physical copy
is a second module instance and every tool call dies with
`Cannot read properties of undefined (reading 'prepare')`. `npm run
setup:peer` (or `HARNESS_DSH_TOOLS=/path/to/dsh-tools npm run setup:peer`)
links the harness's own copy in; re-run it after every `npm install` here and
after a dsh upgrade — `patches/install.sh` Stage A fixes the same link from
the live root.

## Effect matrix

Where each piece takes effect, per deployment shape (DESIGN §4.2):

| Shape | `subagent` / `subagent_fork` | Helper tools (submit / progress / wait / roles / agents) | Bridge delegation | Action needed |
|---|---|---|---|---|
| headless (no preset roster) | this plugin (official rows disabled by the bundle patch) | this plugin | ✅ | install + optional cwd patches |
| web + `standard` (unadapted) | **official version shadows this plugin** (preset layer > global layer) | this plugin (new names are not shadowed) | ❌ (no bridge entry at the root) | run preset adaptation (step 5, L1) |
| web + adapted copy (e.g. `standard-subagents`) | this plugin (the copy's same-name rows are deleted) | this plugin | ✅ | adaptation script + switch preset + new session |
| web + `orchestrator`-like (no generic subagent row) | this plugin (visible directly from the global layer) | this plugin | ✅ | no adaptation; optional L2 (`--enhance-rows`) |

## Mutual exclusion (choose one)

This plugin takes over the official delegation tool names and registers the
bridge provider names, so it is mutually exclusive with the same-family
packages. The failure is loud **by design** — enforced mutual exclusion:

| Cannot coexist with | Why | Failure shape if both are installed |
|---|---|---|
| `legacy-cwd-plugin` | same official-name takeover bundle | both register `subagent` in the global tool layer → duplicate tool registration error, process fails to start |
| `dsh-subagent-tools` | same official-name takeover bundle | duplicate tool registration error (`subagent`), fail loud |
| `legacy-bridges-plugin` (this plugin's predecessor) | duplicate bridge provider names | `registerProvider('codex' / 'claude-code' / 'grok-native' / 'acp')` duplicate error, process fails to start; the old `product_*` tools would also coexist |

Uninstall / disable the other side before installing this plugin (step 2 of
the install flow). Durable relay children from the predecessor are migrated
once and can keep running through the legacy aliases
(`legacyProductAliases`, default `auto`).

## Tools

| Tool | Kind | Purpose |
|---|---|---|
| `subagent` | takes over the official name | unified delegation entry; native by default, `backend` / `role` switch to an external CLI |
| `subagent_fork` | takes over the official name | native fork (the child inherits this conversation's completed turns) with per-call overrides; bridge parameters fail loudly |
| `subagent_submit` | relay pipe | submit one task to the persistent remote product session bound to this child (bridge continuable children only) |
| `subagent_progress` | observability | status + internal trace + token usage of one child — native and bridge alike; bridge children also show the relay epoch's `subagent_submit` count and a `last-epoch-no-forward` guard flag when an epoch closed with zero forwards |
| `subagent_wait` | observability | event-driven wait until a continuable child settles, returning its answer (`timeout_ms` default 300000, capped 600000); a flagged relay answer (zero forwards in its epoch) is prefixed `[relay-guard: …]` |
| `subagent_roles` | observability | the role catalog: id, description, pinned backend, permission mode, may-delegate |
| `subagent_agents` | observability | bridge CLI availability + native providers + live children overview |

The official `send_message` / `list_agents` / `interrupt_agent`
(tool-subagent-control) and `report` (tool-subagent-report) are **not** taken
over — they keep working for both native and relay children.

### `subagent` parameters

| Parameter | Backends | Notes |
|---|---|---|
| `description` | all (required) | 3–5 word display label |
| `prompt` | all (required) | fully self-contained task |
| `backend` | — | `native` (default) or a detected bridge provider (codex / claude-code / grok-native / a user-defined `grok` ACP entry / configured ACP agents) |
| `role` | all | role id (`subagent_roles` lists them); omitted → `general`; must agree with the role's pinned backend |
| `model` | native + bridge | native: bare id (`k3`) or `provider/model` composite; bridge: the product's own model id |
| `persona` | native only | per-call persona text or `@preset:<id>` reference |
| `toolFilter` | native only | `{ allow?: string[], deny?: string[] }` per-call override |
| `cwd` | native only | absolute working directory; requires the cwd patches (step 3) |
| `provider` | native only | per-call subagent provider override (e.g. spawn/fork) |
| `permission_mode` | bridge only | `readonly` / `default` / `full`, capped by the delegation ceiling |
| `reasoning_effort` | bridge only | `low` / `medium` / `high` |
| `run_in_background` | all | default follows `backgroundMode`: `continuable` → true (durable child id), `one-shot` → false (wait, or a job id when true) |

Output is one of `{ kind: continuable, child_id, backend, role?, permission_mode? }`,
`{ kind: background, job_id }`, or `{ kind: foreground, run_id, output[], stop_reason? }`.
`subagent_fork` exposes the native subset (`description`, `prompt`, `model`,
`persona`, `toolFilter`, `cwd`, `provider`, `run_in_background`) — it has no
`backend` / `role` / bridge parameters, and passing any of them fails loudly.

## Configuration

Config lives on the `subagents` insert row this plugin's `cordis.patch.yml`
contributes. Validation is zod-strict: unknown or misspelled keys fail loudly
at apply time.

### Full plugin config

Tool surface:

| Key | Type | Default | Description |
|---|---|---|---|
| `toolNames.delegate` | string | `subagent` | name of the delegation tool |
| `toolNames.fork` | string | `subagent_fork` | name of the fork tool |
| `register.delegate` … `register.agents` | boolean | `true` | per-tool registration switches (delegate / fork / submit / progress / wait / roles / agents) |
| `presetRow` | boolean | `false` | `true` switches to the official preset-row shape (below) |

Native delegation defaults (delegate tool; the fork tool reads the same
fields from the `fork` block):

| Key | Type | Default | Description |
|---|---|---|---|
| `provider` | string | `'spawn'` | subagent provider for the delegate tool |
| `enableRunInBackground` | boolean | `true` | whether `run_in_background` is offered |
| `backgroundMode` | `'one-shot' \| 'continuable'` | delegate `'continuable'` / fork `'one-shot'` | default routing for `run_in_background` (aligns with the official base rows) |
| `agentOptions` | object | — | default child options `{ provider?, model?, maxTokens? }` |
| `persona` | string | — | default persona text or `@preset:<id>` |
| `toolFilter` | object | — | default `{ allow?: string[], deny?: string[] }` |
| `maxDepth` | positive integer \| `'provider-managed'` | `3` (driver-side) | delegation depth cap; when numeric it is forwarded per-request, `'provider-managed'` is not forwarded (provider governs), and when omitted the driver falls back to `3` (aligns with the official `.default(3)`) |
| `presetHints` | string[] | — | preset ids listed in the `persona` parameter description |
| `fork` | object | — | fork-tool overrides: `provider` (default `'fork'`), `backgroundMode`, `enableRunInBackground`, `agentOptions`, `persona`, `toolFilter`, `maxDepth` |

Bridge (inherited from the predecessor in full):

| Key | Type | Default | Description |
|---|---|---|---|
| `providers` | record | — | extra / override providers `{ type?: 'claude' \| 'codex' \| 'grok' \| 'acp', command?, args?, env?, timeoutMs? }`; any ACP CLI joins with zero code. The bare name `grok` is the USER's key (an ACP transport on existing deployments, with durable registry entries under `backend: "grok"`) — a user-defined `grok` entry is entirely unaffected and wins by name; the native protocol bridge registers as the separate built-in `grok-native`, so `grok` and `grok-native` coexist for A/B. No migration, no resume-id heuristics (an ACP remoteId fed to the native `--resume` would be a permanent clap exit-2 error) |
| `registryPath` | string | `~/.dsh/subagents-registry.json` | durable registry location |
| `idleTimeoutMs` | integer ≥ 0 | `600000` | idle window before a settled bridge child's remote session is released (`0` disables) |
| `maxConcurrentChildren` | positive integer | `8` | cap on bridge continuable children with a turn in flight (native background runs go through harness jobs and are not counted) |
| `relayReportGuard` | boolean | `true` | D2b turn-closure guard: reject a bridge relay's `report` call when the current turn has no `subagent_submit` call (the relay model then gets a corrective error and can forward + report). `false` restores the unguarded behavior |
| `redactSecrets` | boolean | `true` | scrub common secret shapes (Bearer tokens, `sk-` keys, GitHub PATs, `api_key=` assignments, JWTs) from captured CLI stdout/stderr and from every bridge's final text. `false` restores byte-exact passthrough for deployments that need it |
| `maxDispatchPermissionMode` | `'readonly' \| 'default' \| 'full'` | `'full'` | deployment cap on the engine-level dispatch seam (`ctx.get('subagentsDispatch')`, see below): a programmatic bridge dispatch requesting a higher permission mode is rejected loudly, never silently downgraded. Default `full` aligns with the tool surface for root callers (the real boundary is the delegation ceiling); set `readonly` to leave the seam read-only dispatches only |
| `rolesDir` | string | the package's `roles/` | role library directory |

Migration:

| Key | Type | Default | Description |
|---|---|---|---|
| `legacyProductAliases` | `'auto' \| boolean` | `'auto'` | register `product_submit` / `product_delegate` alias tools so predecessor relay children recovered from the migrated registry keep working; turn off once the old children are gone |

### Preset-row config (`presetRow: true`)

When a preset row is rewritten to this plugin (L2 `--enhance-rows`), the row's
config validates against the **official tool-row shape**: `provider`
(required), `toolName` (default `subagent`), plus the shared native fields
(`enableRunInBackground`, `backgroundMode`, `agentOptions`, `persona`,
`toolFilter`, `maxDepth`, `presetHints`). Bridge-side keys are rejected — a
preset-row instance is native-only and stateless (providers, registry, and
helper tools belong to the single global instance). The `toolName` must be
distinct from the global instance's delegate/fork names and from other
preset-row rows (e.g. `plan_agent`, `scout_agent`). Accordingly, the L2
adapter only rewrites `provider: spawn` rows with their own `toolName` and
**deletes** the official rows it cannot host honestly (generic
`subagent`/`subagent_fork` rows, `provider: fork` rows, bridge template rows)
— an unrewritable row left behind would shadow the global tools, and a
dishonest rewrite would fail this validation at mount time and take the whole
preset down.

### Roles

Role files live in `rolesDir` as JSON; the role id IS the file basename.
Unknown role ids fail loudly (listing the available roles); only an omitted
role defaults to `general` (synthesized if the library is missing one).

```jsonc
{
  "description": "When to use this role (shown to the delegating model)",
  "backend": "native",          // 'native' | a bridge provider name | '' = caller chooses
  "permissionMode": "full",     // bridge only; readonly < default < full
  "allowDelegation": true,      // may a relay child delegate further
  "instructions": "Extra instructions prefixed onto the task text",
  "overrides": {                // native-only defaults (per-call params still win)
    "agentOptions": { "provider": "newapi", "model": "glm-5.3" },
    "persona": "… (or @preset:xxx)",
    "toolFilter": { "deny": ["write", "edit"] },
    "maxDepth": 1
  }
}
```

Default role set:

| id | backend | permissionMode | allowDelegation | Purpose |
|---|---|---|---|---|
| `general` | `''` (caller chooses) | full | true | default role; the caller picks the backend |
| `explore` | native | — | false | read-only scouting: `deny: [write, edit]`, `maxDepth: 1` |
| `code-review` | native | — | false | reviewer persona + read-only toolFilter |
| `debug` | native | — | true | may delegate one more read-only helper layer |
| `codex-full` | codex | full | true | bridge example: full-permission codex |
| `claude-readonly` | claude-code | readonly | false | bridge example: plan-mode review |
| `grok-native-full` | grok-native | full | true | bridge example: full-permission grok (native streaming-json bridge) |

## Engine-level dispatch seam

Besides the model-facing tools, the global instance provides an
**engine-level programmatic dispatch seam** for plugin code (not model tool
calls) that needs to dispatch a bridge task with a controlled
`permissionMode` — the thing the official `ctx.subagents.start` channel
structurally cannot do (its `SubagentStartRequest` has no settings concept;
`permissionMode` / `reasoningEffort` only flow through this plugin's bridge
settings channel):

```js
const dispatch = ctx.get('subagentsDispatch')
if (dispatch?.available) {
  const outcome = await dispatch.dispatchAgentTask({
    backend: 'codex',                       // required: a bridge provider name
    task: 'Review the diff and report.',    // required: self-contained task text
    parent: exec.agent,                     // required: delegating live Agent
    label: 'review node',                   // optional: display label (echoed)
    role: 'codex-full',                     // optional: role id (no default role)
    settings: {                             // optional: remote settings
      permissionMode: 'readonly',           //   explicit > role.permissionMode > 'default'
      model: 'gpt-5-codex',                 //   passthrough
      reasoningEffort: 'high',              //   passthrough
    },
    cwd: '/abs/worktree',                   // optional: absolute remote cwd (default parentCwd(parent))
    signal: controller.signal,              // optional: cancellation (threads through submit)
  })
  // → { backend, runId, label?, text, stopReason }
}
```

The seam is **bridge-only and one-shot** (`create → submit(settings) →
dispose`, awaited to completion; no registry/binding writes — a disposed
remote has no recovery semantics). `backend: 'native' | 'spawn' | 'fork'` is
rejected loudly with a redirect to the official `ctx.subagents.start`; the
seam never wraps or replaces the official service. `available` reports
whether at least one bridge driver assembled; `backends()` lists their
names. Native-only parameters (`persona` / `toolFilter` / `maxDepth` /
`provider` / `outputSchema` / `maxTokens`) are rejected by name.

Every dispatch passes **two permission gates** (both loud, never a silent
downgrade):

1. **Delegation ceiling** — the `parent` is checked against the live
   bindings ∪ durable registry (same union the `subagent` tool uses): a
   bridge child (e.g. readonly) dispatching through any plugin cannot raise
   its own permission. Unknown stored modes fail closed to `readonly`.
2. **Deployment cap** — `maxDispatchPermissionMode` (default `full`)
   bounds what the seam may request at all.

Dispatches also **consume a concurrency slot** in the same
`maxConcurrentChildren` pool as continuable bridge children (a synthetic
`dispatch:*` key, held for the duration and always released), so in-flight
dispatches count against the same cap. Note they are not harness sessions:
they never appear in `subagent_agents`'s children list (that list comes from
`ctx.subagents.listChildren`) — an in-flight dispatch is observable only
indirectly, through the pool it occupies.

**Orchestrator integration notes**: when combining this seam with an
orchestrator's own concurrency admission (e.g. `maxRunningAgents`), the
effective bridge concurrency is the *minimum* of the two — configure
`maxConcurrentChildren ≥ maxRunningAgents`. The seam has **no built-in
timeout**: cancellation is the caller's `signal` (the bridge settles with
`stopReason: 'aborted'` on abort). Bridge one-shots have no `outputSchema`
concept, so do not declare structured `outputs` on bridge tasks. Only the
global instance provides the seam; a preset-row-only deployment keeps
`ctx.get('subagentsDispatch')` undefined (stateless, red line 10). See
[docs/dispatch-seam.md](docs/dispatch-seam.md) for the full design record.

## Upgrading dsh / npx cache drift

A dsh installed through npx lives in an npx cache root
(`~/.npm/_npx/<hash>/`). When npx re-resolves dependencies or the cache is
cleaned, the live root **silently switches** — the old root (with its cwd
patches) is abandoned with no error, and the `dsh-tools` symlinks go dangling.
Two symptoms (DESIGN §6.4.5):

1. **Per-call `cwd` fails loudly (formerly silent breakage)** — after the old
   root (with its cwd patches) is abandoned, the `liveRoot` recorded in
   `patches/.applied` no longer matches the current root, and the native
   driver's stamp gate throws with both paths and the repair guidance
   (instead of letting an unpatched harness silently drop the `cwd` field,
   run the child in the parent's cwd, and record the task as successful).
2. **Every tool call fails** with
   `Cannot read properties of undefined (reading 'prepare')` — the dangling
   `dsh-tools` links resolve to a second module instance.

**Either symptom → re-run `./patches/install.sh`** (or run
`./patches/verify.sh` first to see the drift). After **upgrading dsh**, replay
the same list:

```sh
./patches/install.sh     # re-applies links + patches against the NEW live root
./patches/verify.sh      # confirm healthy
# restart dsh and open a new session
```

Preset copies under `~/.dsh` are not affected by a root switch. The installer
resolves the live root dynamically (`which dsh` → realpath → walk up to
`node_modules`; `DSH_HARNESS_ROOT` overrides) — it never hardcodes cache paths.

The stamp gate performs the same dynamic check on its own: `patches/.applied`
only proves anything about the one live root it names, so before the native
driver releases `cwd` it compares the stamp's `liveRoot` against the CURRENT
root — resolved JS-side with the same logic as `resolve-root.sh` (walk up
from the realpath of the `@deepseek-ai/dsh-tools` peer this plugin actually
links to, to the enclosing `node_modules` parent). A foreign stamp (formerly
shipped inside the npm tarball — now excluded from the files whitelist), a
pre-drift stamp after an npx cache switch, or a stamp missing its `liveRoot`
record all fail loudly with a pointer to re-run `install.sh`.

## Design notes

Full detail in [docs/DESIGN.md](docs/DESIGN.md); the short version:

- **`SubagentDriver` abstraction.** Both backends implement one driver
  interface; every difference is an explicit capability flag (`cwd`,
  `persona`, `toolFilter`, `llmRoute`, `maxDepth`, `permissionMode`,
  `reasoningEffort`, `continuable`, `backgroundJob`, `durableResume`,
  `promptInjectionGuard`). Native covers the first group; bridges cover
  `permissionMode` / `reasoningEffort` / `continuable` / `durableResume` /
  `promptInjectionGuard`. The tool layer checks parameters against the matrix
  and throws loudly on mismatch — no silent degradation. Lifecycle vocabulary
  reuses the harness seam (`subagent/start|end` events, `stopReason` words,
  `AbortError` / `TimeoutError`).
- **Why the cwd patches exist.** rc.6 has no per-call `cwd` field on
  `SubagentStartRequest` — while per-call `model` / `provider` / `persona` /
  `toolFilter` ARE native request fields and need no patch. Only `cwd` needs
  help: exactly two minimal anchored patches, one per child-creation merge
  point (the one-shot driver package `dsh-subagent-in-process-driver`, and
  the continuable manager inlined in the `dsh-subagent` bundle). The installer
  drives a per-patch four-state machine — applied / idempotent /
  `native-verified` / loud drift — where "dsh now supports it natively" can
  only be recorded after a **hard double gate**: a manually-verified version
  whitelist (initially empty for rc.6) AND a behavioral probe that observes
  the child session's `meta.cwd` through the live subagent path. Both are
  necessary; failure of either is loud (d1 anchor drift → new plugin release;
  d2 unverified-native → `verify --probe`). This is what keeps a silent-cwd
  regression from ever being mistaken for native support.
- **`dsh-subagent` imports are a pure-function whitelist.** Two physical
  copies of `@deepseek-ai/dsh-subagent` exist at runtime (the harness's and
  this repo's peer install). This plugin imports only pure functions
  (`assertSubagentMaxDepth`, `settleRun`) from its copy — no module state, no
  Symbol identity — and takes all service access through `ctx`. That copy is
  deliberately NOT symlinked to the live root: a stale real copy still yields
  correct pure functions, whereas a symlink dangling after an npx hash switch
  would kill the whole plugin load (the most fragile failure mode we know).
  `npm run lint` enforces the whitelist.
- **Secret redaction is default-on at the capture boundary.** The redactor
  (ported from task-weaver's `redact.ts`) scrubs five common secret shapes
  from CLI stdout/stderr the moment they are captured (`lib/run.js`) and from
  the ACP bridge's direct stdio text, plus the final text each bridge returns
  (belt-and-braces; the pass is idempotent). The task text itself is NOT
  redacted on the way in — only outputs coming back. A redacted line that no
  longer parses as JSONL is dropped, never passed through raw (fail closed).
  `redactSecrets: false` restores byte-exact output.
- **The grok bridge keeps flag injection out without a literal `--`.** grok
  1.0.4's clap parser refuses `-p -- <task>`, so the task rides as an
  ATTACHED value, `--single=<task>`: everything after `=` is one literal
  prompt value the parser never re-parses as flags (verified against the
  installed CLI: a task starting with `-` stays task text). This preserves
  the substance of design rule 7 under grok's own parser constraints (the
  one sanctioned exception to rule 7's literal form, annotated in
  AGENTS.md); every actual flag value (model, session id, …) still passes
  the same identifier whitelist as the claude/codex bridges. The bridge
  registers as the built-in **`grok-native`** — the bare `grok` name stays
  owned by the user's `config.providers` (ACP transport on existing
  deployments, whose durable registry sessions keep working unchanged).
- **One global instance holds all shared state.** Bindings, the registry, and
  the concurrency slots live only in the single global `apply()` instance;
  `presetRow` instances are stateless, so preset-row rewrites and the global
  instance coexist safely.

## Development

```bash
npm install
npm run setup:peer     # symlink the running harness's @deepseek-ai/dsh-tools (above)
npm test               # node:test — pure logic + fake bridge/driver/ctx
npm run lint           # node --check every module + the dsh-subagent import whitelist
```

The suite must never require a real CLI, a key, or a network — it runs green
on a bare runner with fakes only. CI runs the suite on
macOS/Ubuntu/Windows × Node 18/20/22 (`npm ci` → `npm run lint` → `npm test`),
with trusted-publishing (`--provenance`) configured for release builds. See
[docs/DESIGN.md](docs/DESIGN.md) for the architecture and
[docs/TASKS.md](docs/TASKS.md) for the task breakdown.

## Security

This is a **configuration-as-trust-boundary** tool: it spawns whatever CLIs
you configure, and `full` passes the products' own "bypass all permission
checks" flags. See [SECURITY.md](SECURITY.md).

## License

MIT
