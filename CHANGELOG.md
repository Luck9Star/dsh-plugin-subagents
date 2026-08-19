# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-08-19

### Fixed — grok-native bridge vs grok CLI 1.0.5

Field diagnosis: every grok-native relay session locked up permanently
("Session ID ... is already in use" on all retries) after one initial
turn timeout, with degraded sessions answering only the last character
of each reply. Two independent defects, both verified against a live
1.0.5 install:

- **Streaming parser**: grok 1.0.5 emits `text` events as token-slice
  deltas (`"PROBE"`, `"-"`, `"XY"`, ...), where 1.0.4 emitted one full
  message per turn. The bridge's last-event-wins assignment kept only
  the final slice — answers arrived truncated to one character. `text`
  events now concatenate, which also preserves the 1.0.4 single-event
  shape.
- **Session-id lockup recovery**: 1.0.5 persists the conversation
  directory before the terminal `end` event, so a turn killed by the
  timeout leaves the preallocated `-s <uuid>` taken while the bridge
  never learns the id. 1.0.5's `-s` REFUSES an existing id and does NOT
  resume, so every retry re-sent the same `-s` and failed forever. The
  bridge now detects the "already in use" refusal and retries once via
  `--resume <preallocated>` (verified legal and lossless on a live
  locked session).
- **Timeout default**: the grok default `timeoutMs` rises from 5 to 15
  minutes — a trivial 1.0.5 probe already reports ~37k input tokens of
  CLI-injected skills/MCP inventory before the task text, and
  relay-scale task briefs need far more than 5 minutes of wall time.

## [0.1.1] - 2026-08-18

First release through the npm trusted-publishing pipeline (OIDC, tag
`v0.1.1`, no tokens, provenance attached). No code changes — 0.1.0 was
bootstrapped with a manual publish; this version proves the CI path.

## [0.1.0] - 2026-08-18

First release. `dsh-plugin-subagents` unifies two earlier internal
plugins — configurable native subagents (per-call overrides including
`cwd`) and external agent bridges — in one plugin that takes over the
official `subagent` / `subagent_fork` tool names.

### Documentation (2026-08-18) — README rewrite

- Both READMEs (`README.md` / `README.zh.md`) rewritten in plain language,
  still section-for-section aligned. New shape: what the plugin gives you →
  when to reach for it → install with per-step explanations and an expected
  result → quick start with real tool calls → built-in roles / tools tables
  → safety features in user terms → trimmed configuration table →
  troubleshooting table → references & credits. Per maintainer request, the
  READMEs no longer name the predecessor package; provenance is presented
  as a "References & credits" list (Claude Code agent files, Codex /
  Claude Code / Grok CLIs, ACP SDK, task-weaver) instead. The
  mutual-exclusion instructions were generalized to "remove the other
  plugin taking over `subagent` or registering the same bridge backends".
- Earlier-plugin references scrubbed repo-wide: CHANGELOG historical
  entries, AGENTS.md, cordis.patch.yml comments, docs/ and code comments
  now use generic wording ("an earlier internal bridges plugin" / "an
  earlier internal cwd plugin"); runtime log and error prefixes from the earlier plugin renamed to
  `subagents:`. Only functional references remain —
  the one-time migration source path `~/.dsh/product-subagents-registry.json`
  and its tests. Git history was rewritten to remove the earlier package
  names from all past commits and commit messages (pre-rewrite mirror
  backup kept locally).

### CI (2026-08-18)

- CI green again on node 18/20: the patch-script fixtures' package.json now
  declare `"type": "module"` exactly like the real `@deepseek-ai` packages
  (without it, node < 22 parses the fixture ESM libs as CJS —
  `Unexpected token 'export'` — and every install/verify/probe test fails;
  node 22+ only passed via default module syntax detection), and
  test/inject-contract.test.js walks `lib/` with a recursive readdir
  instead of the node-22-only `fs.globSync`. Full suite: 480/480 on node
  18 and node 24 locally.
- windows-latest leg DEFERRED: every Windows job hung indefinitely (no
  logs flushed; only the 6h job limit killed it). Removed from the matrix
  until the hang is reproduced and fixed; `timeout-minutes: 15` added as a
  runaway guard. `install.ps1` / `verify.ps1` still ship — Windows
  validation is manual until the leg returns.
- Added gitleaks secret scanning: `.github/workflows/gitleaks.yml` (full
  history scan on every push/PR) and `.pre-commit-config.yaml` for local
  commits; matches the gateway-provider repo's setup.
### Documentation (2026-08-18)

- Both READMEs (`README.md` / `README.zh.md`) updated in lockstep, kept
  section-for-section aligned:
  - **rc.7 compatibility declared.** Requirements and the header now state
    compatibility with DSH `0.1.0-rc.7` (npm latest) alongside `rc.6`, that
    `peerDependencies: ^0.1.0-rc.6` satisfies `rc.7` under semver's
    same-tuple prerelease rule (and stops matching at `0.1.1-rc.x`), and
    that the two cwd patch anchors exist verbatim and uniquely in rc.7
    exactly as in rc.6. Removed the rc.6-only phrasing in the design notes
    ("rc.6 has no per-call cwd field" → "neither rc.6 nor rc.7 has").
    Compatibility verified before writing: the full suite passes 480/480
    with the rc.7 live root on this machine.
  - **New "Same-path npx refresh" subsection** (Upgrading dsh / npx cache
    drift, both languages): documents the one silent failure mode the stamp
    gate cannot catch — npx refreshing the cache in place (same
    `~/.npm/_npx/<hash>/` path, stamp `liveRoot` still matches, gate
    passes, but the replaced files carry no patches → `cwd` silently
    dropped). Covers the symptom (per-call `cwd` stops having any effect
    after a dsh upgrade/refresh), recovery (re-run `patches/install.sh` —
    idempotent, `.bak_cwd` backup, `node --check` verification),
    verification (`verify.sh` / `--probe`), and the known limitation made
    explicit as standing discipline: the stamp gate validates patch states
    + `liveRoot` but not `dshVersion`/mtimes, so re-run `install.sh` after
    **every** dsh upgrade/refresh.
  - **Companion repos linked.** The dispatch-seam section now links
    [dsh-dag-orchestrator](https://github.com/Luck9Star/dsh-dag-orchestrator)
    (its worktree tasks rely on this plugin forwarding `request.cwd`) and
    [dsh-worktrees](https://github.com/Luck9Star/dsh-worktrees) (its
    composition examples use this plugin's per-call `cwd`), as absolute
    GitHub URLs — the sibling repos each live in their own repository. The
    local-development clone command now uses the GitHub URL.
  - **Roles vs. agent presets clarified.** The Roles section now states
    explicitly that `roles/` and the harness's official `dsh-agent-presets`
    (an rc.7 capability) are orthogonal: a role shapes how this plugin
    delegates, a preset is a persona bundle the child's `persona` may
    reference via `@preset:<id>` (resolved by this plugin's persona seam);
    they compose freely with no migration either way.

### Fixed (2026-08-18 audit round)

- **E-1/C-1 (P1): the cwd gate could be satisfied by a foreign `.applied`
  stamp.** Two stacked defects: (a) `patches/.applied` — the install-time
  record naming THIS machine's live harness root and patch states — shipped
  inside the npm tarball (`files` included `patches/` wholesale), so every
  `npm install` carried someone else's `liveRoot` + `applied` marker; (b)
  `lib/drivers/native.js`'s `assertCwdPatchesTrusted` verified only the two
  patch states, never that the stamp's `liveRoot` equals the CURRENT harness
  root — an npm user who skipped `install.sh` got cwd silently unlocked
  against an unpatched harness (which then drops the `cwd` field with no
  error: children run in the parent's cwd, the task "succeeds"). Fixes:
  the `files` whitelist now negates `!patches/.applied` (verified:
  npm's files-negation applies to subpaths; `npm pack --dry-run` no longer
  lists the stamp, and `test/publish-pack.test.js` pins it), and the stamp
  gate additionally requires `stamp.liveRoot === <current root>`, where the
  current root is resolved JS-side by walking up from the realpath of the
  plugin's `@deepseek-ai/dsh-tools` peer (the mirror of
  `patches/resolve-root.sh`'s logic — the peer symlink repaired by Stage A /
  `setup:peer` makes the shared package the strongest existing evidence of
  "same root as the harness"). Mismatch, a missing `liveRoot` record, or an
  unresolvable root all fail LOUD with both paths in the message and the
  `install.sh` repair guidance; the stamp is still re-read on every cwd call
  (running install still needs no restart). Tests: a foreign-root stamp and
  an npx-drift stamp throw loudly; the production path passes end-to-end on
  this machine against the real installed stamp.
- **R-1 (P2): the ACP bridge's `textBuffer` grew without bound.** The ACP
  transport speaks stdio directly (`spawnProduct`, not `runCommand`), so
  `lib/run.js`'s 8MB tail cap never applied; a runaway agent could exhaust
  memory in one turn. The buffer now uses the same `appendCapped` semantics
  (last 8MB kept, head dropped), `drainText()` unchanged; the progress
  `receivedChars` still counts the true stream size. Regression: a
  real-SDK fake agent streams a 9MiB turn — the drained text is exactly
  8MiB, exactly 1MiB falls off the head, and the boundary case
  (1KiB over cap) drops exactly 1KiB.
- **G-1 (P2): the claude and codex bridges had no process-level regression
  tests** (only the grok bridge did). Both now have full fake-CLI suites in
  the grok paradigm — node-script shims that record argv to a file and
  replay fixture output, with argv asserted element-for-element, zero
  network / zero real CLI:
  `test/claude-bridge.test.js` (12 cases: last-line JSON parsing over
  streaming multi-line output, `--session-id` preallocation, `--resume`
  promotion after an interrupted first turn, `is_error`, unparseable
  output, abort/timeout markers, permission-mode mapping, redaction,
  flag-injection whitelist) and `test/codex-bridge.test.js` (17 cases:
  `thread.started` incremental capture surviving an interrupted turn, the
  `resume <thread_id>` subcommand shape, `item.completed` text
  concatenation, `error`/`turn.failed` surfacing at exit 0, half-line JSON
  tolerance (truncated lines dropped, never relayed), non-zero-exit
  classification with and without text, plain-text fallback, pre-0.147
  underscore event shapes, abort/timeout, `-c key=value` and sandbox flag
  mapping, config-injection whitelist). The ACP bridge additionally gained
  a real-SDK agent-process test file (`test/acp-bridge.test.js`, 6 cases:
  normal turn, both textBuffer cap boundaries, abort, mute-server and
  instant-death handshake regressions).
- **CI-safe tests + memo fix + static pins (cross-review round).** (a) The
  production-path end-to-end test in `test/native-driver.test.js` depended on
  the machine-local gitignored `patches/.applied` stamp and the live
  dsh-tools peer symlink — a clean checkout / bare CI hard-red. It now probes
  both up front and `t.skip`s ("local-machine production-path probe…") when
  either is absent, while still running for real on this machine. (b)
  `lib/drivers/native.js`'s `resolveLiveHarnessRoot` failure result was
  memoized per driver instance, so a resolution that failed BEFORE
  `install.sh` stayed failed after it until restart — contradicting the
  README's "no restart needed after running install.sh"; only a successful
  resolution is now memoized, failures retry on the next cwd call (loud
  failure behavior unchanged). (c) `test/publish-pack.test.js` gains a
  pure-static, zero-dependency assertion that `files` pins both `patches/`
  and the `!patches/.applied` negation — the dynamic `npm pack` check is
  skipped when npm is unavailable, so this hard-guards the tarball gate on
  every bare runner.
- **P3 cleanups:** `test/smoke.test.js`'s scaffold placeholder
  (`assert.ok(true)`) replaced with a real minimal smoke (package manifest
  wiring + `lib/index.js` entry exports + all four bridge factories
  building the contract); the stale "316 node:test cases" count in this
  CHANGELOG corrected to the current number (480).

### Added

**Engine-level dispatch seam (bridge programmatic dispatch)**

- New `lib/dispatch.js` + `ctx.provide('subagentsDispatch', { dispatchAgentTask,
  available, backends })`: plugin code (not model tool calls) can now
  dispatch a **bridge** task one-shot with a controlled `permissionMode` —
  the capability the official `ctx.subagents.start` channel structurally
  lacks (no settings concept in `SubagentStartRequest`). Design record:
  [docs/dispatch-seam.md](docs/dispatch-seam.md) (T22).
- `dispatchAgentTask({ backend, task, parent, label?, role?, settings?, cwd?,
  signal? })` runs the full driver sync route (create → submit(settings) →
  dispose), flattens the outcome to `{ backend, runId, label?, text,
  stopReason }`, and writes **nothing** to the registry/bindings (a disposed
  one-shot remote has no recovery semantics). Native-only parameters
  (`persona` / `toolFilter` / `maxDepth` / `provider` / `outputSchema` /
  `maxTokens`) and unknown keys are rejected loudly by name — including all
  three `Object.keys` bypass faces (review F-8; red line 8): symbol-keyed
  properties (via a `getOwnPropertySymbols` check), custom-prototype
  requests whose INHERITED keys would slip past the whitelist enumeration
  and then be actually consumed by prototype-chain destructuring (a plain
  object is required; `Object.create(null)` passes — it has no inherited
  keys), and a polluted `Object.prototype` (assignment-style pollution from
  a buggy merge/deepClone yields enumerable keys; every dispatch fails
  closed while the pollution persists); illegal
  `permissionMode` / `reasoningEffort` enums fail closed (no schema surface
  to lean on).
- Two permission gates on every dispatch, both loud, never a silent
  downgrade: the delegation ceiling over `parent` (live bindings ∪ durable
  registry — a readonly bridge child cannot raise its own permission through
  any plugin) and the new deployment cap `maxDispatchPermissionMode`
  (default `full`, full schema branch only).
- Dispatches consume a concurrency slot in the shared
  `maxConcurrentChildren` pool (synthetic `dispatch:*` key, always released)
  — unlike the tool layer's sync route, code callers have no bounded turn,
  so the pool is the governance. The synthetic key is not a harness session:
  it never shows up in `subagent_agents`'s children list (that list comes
  from `ctx.subagents.listChildren`); an in-flight dispatch is observable
  only indirectly, through the pool it occupies.
- The seam's optional `cwd` is its one deliberate extension over the tool
  surface (absolute path, `assertCwd`-validated; default `parentCwd(parent)`):
  orchestration parents drift across sessions while a task's workspace is
  per-task. Plumbs through `DelegateRequest.cwd` on the bridge driver's sync
  route (the tool layer never sets it — capability matrix bridge cwd ❌ is
  unchanged).
- Shared helpers (`resolveBridgePermissionMode` / `buildBridgeSettings` /
  `assertCallerWithinCeiling`) extracted from the `subagent` tool into
  `lib/dispatch.js` and re-imported: tool behavior, validation order, and
  error wording are byte-for-byte unchanged (the existing tool tests pass
  untouched).
- Only the global instance provides the seam; preset-row deployments keep
  `ctx.get('subagentsDispatch')` undefined (stateless, red line 10).
  `backend: 'native' | 'spawn' | 'fork'` is rejected with a redirect to the
  official channel — the seam is bridge-only by design.
- Security hardening found in review (back-ported into the shared ceiling):
  `lib/ceiling.js`'s `PERM_RANK[mode] ?? fallback` lookups were fail-open on
  prototype keys — a stored `permissionMode` of `'toString'` /
  `'constructor'` resolved to an inherited *function*, so the `??` never
  fired and the numeric comparison became NaN (always false), silently
  lifting the ceiling. Both lookups now guard with an own-key
  (`hasOwnProperty`) check: legal values and unknown strings behave exactly
  as before (caller side still fails closed to rank 0, requested side keeps
  unknown-as-default rank 1); inherited keys are closed. The dispatch seam's
  `maxDispatchPermissionMode` cap check uses the closed `PERMISSION_MODES`
  array for the same reason.

**Output redaction (task-weaver port)**

- New `lib/redact.js`: five common secret shapes (Bearer headers, `sk-…`
  keys, `gh?_…` PATs, `api_key=`/`access_token=`/`secret_key=` assignments,
  JWTs) scrubbed to `[REDACTED:<kind>]` placeholders. Logic-equivalent port
  of task-weaver `agent-runtime/src/redact.ts` (zero dependencies, pure
  string ops; fresh RegExp per pass so `lastIndex` never leaks).
- Applied at `lib/run.js`'s stdout/stderr capture boundary (task-weaver's
  "redaction happens before the parser sink" invariant; `appendCapped`
  8MB-tail semantics unchanged), at the ACP bridge's direct-stdio text
  buffering (its capture bypasses run.js), and idempotently on every
  bridge's final text (claude / codex / grok / acp).
- New config key `redactSecrets` (boolean, **default `true`**, full schema
  branch only — the presetRow branch rejects it per red line 9). `false`
  restores byte-exact passthrough.
- Known inherited trade-off (documented in lib/redact.js): a JSONL line whose
  own fields look secret-shaped can be structurally corrupted by the
  replacement and then fail to parse — dropped, never passed through raw
  (fail closed). Prose false-positives of the shape `bearer <word>` are also
  consumed (the upstream `/i` pattern includes the `Bearer ` prefix).

**Grok native bridge**

- New `lib/bridges/grok.js`: one `grok --single=<task> --output-format
  streaming-json --permission-mode <mode>` process per turn through
  `lib/run.js` (never child_process directly; Windows `.cmd` shims safe).
  Flat-NDJSON event mapping ported from task-weaver
  `adapters/grok/{argv,parse,classify}.ts` (TS Result → throw; exit 2 = clap
  argument validation surfaced as a permanent-hint error; unknown non-zero
  fails closed with the CLI's own output tail).
- Session continuity: `-s <uuid>` preallocates the FIRST conversation
  (claude-style, so an interrupted first turn still knows its id); the
  terminal `end` event's `sessionId` is captured incrementally and later
  turns resume via `-r/--resume <id>`.
- Flag-injection guard (design rule 7's substance under grok 1.0.4's clap
  constraints): the task rides as an ATTACHED value `--single=<task>` —
  verified against the installed CLI that a `-`-prefixed task stays task
  text and can never surface as a flag; model / session-id / effort values
  pass the same identifier whitelist as the claude/codex bridges
  (`safeFlagValue`).
- Defense-in-depth: the resume/session/thread ids handed to separate flag or
  sub-command values are whitelisted the same way across all bridges —
  grok's `--resume` / `-s` (a stream-poisoned sessionId refuses loudly at
  the next submission rather than riding in as a foreign flag), claude's
  `--resume` / `--session-id`, and codex's `resume <thread_id>`. A stream
  truncated before grok's terminal `end` event never promotes a resume id
  (the fresh `-s` path survives instead of issuing a doomed `--resume`).
- Verified deviations from task-weaver's recorded argv (grok CLI moved):
  resume is `--resume <id>` alone (task-weaver recorded `-s <id> --resume
  <id>`; in 1.0.4 `-s` only names a NEW session and needs `--fork-session`
  to combine with `--resume`), and `grok -p -- <task>` is rejected by clap
  ("a value is required for '--single'"), hence the attached-value transport.
- Provider registration & naming ownership (design ruling 2026-08-16): the
  native bridge is the built-in provider **`grok-native`** (`type: grok`,
  PATH detection, `~/.grok/auth.json` file-artifact auth hint — the CLI is
  never executed during detection; the auth probe covers the grok CLI
  itself, shared by both transports). The bare name `grok` belongs to the
  USER's `config.providers` (existing deployments define it as an ACP
  transport, and durable registry entries under `backend: "grok"` hold
  ACP-issued remote ids) — so a user-defined `grok` key is entirely
  unaffected and wins by name, and `grok` / `grok-native` coexist for A/B.
  No migration code and no resume-id heuristics (ACP ids and native session
  ids cannot be reliably told apart — feeding an ACP remoteId to the native
  bridge's `--resume` would be a permanent clap exit-2 error).
- `permissionMode` mapping: `readonly → plan`, `full → bypassPermissions`,
  `default → dontAsk` (grok's non-interactive headless mode; `default` would
  wait on an approval no unattended turn can grant). UNKNOWN modes fail
  closed to `plan` — grok's readonly equivalent (design rule 3).
- New default role `grok-native-full` (backend grok-native, full, may
  delegate), mirroring `codex-full`.
- Bridge output passes through the redactor (`redactSecrets` switch shared
  with the other bridges).

**Unified tool surface**

- `subagent` — single delegation entry taking over the official tool name:
  native backend by default, `backend` / `role` switch to an external agent
  CLI. Validation order: role resolution → backend merge →
  parameter-capability matrix → bridge availability + permission ceiling →
  native per-call resolution → routing.
- `subagent_fork` — native fork variant taking over the official tool name
  (child inherits the parent's completed turns) with per-call overrides;
  bridge parameters fail loudly.
- `subagent_submit` / `subagent_wait` / `subagent_roles` / `subagent_agents`
  — the `subagent_*` helper family (renamed from the predecessor's
  `product_submit` / `product_wait` / `product_roles` / `product_agents`).
- `subagent_progress` — now covers native children too (session-log folding
  plus a minimal driver snapshot), alongside bridge children.
- The official `send_message` / `list_agents` / `interrupt_agent` / `report`
  tools are intentionally untouched and serve both kinds of children.

**Native backend**

- Per-call `model` (bare id or `provider/model` composite), `provider`,
  `persona` (including `@preset:<id | display name>` references), and
  `toolFilter` overrides — all through native rc.6 request fields, no
  patches required.
- Per-call `cwd` via two minimal anchored patches (one-shot driver package +
  the continuable manager in the `dsh-subagent` bundle), distributed and
  verified by the installer/doctor below.
- Three delegation routes: foreground sync, one-shot background job (harness
  jobs integration), and continuable child (`startContinuable`).

**Bridge backends**

- Claude Code, Codex, and generic ACP bridges carried over from an
  earlier internal bridges plugin (bridge contract unchanged:
  `create` / `submit` / `reconnect` / `dispose`).
- Any ACP CLI joins through `config.providers` with zero code (e.g. grok).
- Providers register only when their CLI is detected on `PATH` (parallel
  detection; CLIs are never executed during detection).
- Delegation permission ceiling: `readonly < default < full` cannot be raised
  down the delegation tree; unknown stored modes fail closed to `readonly`;
  recovery restores the recorded settings.
- Bridge lifecycle governance: concurrency slots, idle disposal,
  pending-start guard, teardown — migrated unchanged.

**Durability & migration**

- Durable registry at `~/.dsh/subagents-registry.json`: owner-only `0600`
  atomic writes, 500-entry pruning, hostile-key (`__proto__` …) protection.
- One-time migration from the predecessor's
  `~/.dsh/product-subagents-registry.json` (`.migrated` marker, legacy file
  left in place), with optional `product_submit` / `product_delegate` alias
  tools (`legacyProductAliases`, default `auto`) so recovered legacy relay
  children keep working.

**Roles**

- Declarative role library (`roles/*.json`) with the new `backend` field
  (`'native'` | a bridge provider name | `''` = caller chooses) and
  native-only `overrides` (`agentOptions` / `persona` / `toolFilter` /
  `maxDepth`).
- Six default roles: `general`, `explore`, `code-review`, `debug`,
  `codex-full`, `claude-readonly`. Unknown role ids fail loudly; only an
  omitted role defaults to `general`.

**Installation & compatibility**

- Bundle-type plugin (`dsh.bundle.patch`): disables the official
  `tool-subagent` / `tool-subagent-fork` rows (required in headless, idempotent
  in web) and registers one global instance holding all shared state;
  `presetRow` instances are stateless and coexist safely.
- Two-stage installer `patches/install.sh | .ps1`: Stage A (mandatory, first,
  never blocked) repairs both `dsh-tools` references (plugin repo + every
  profile) to the live harness root; Stage B applies the cwd patches through a
  per-patch four-state machine with `.bak_cwd` backups, `node --check`
  verification, and loud drift failures. `--links-only` runs Stage A only.
- "dsh supports per-call cwd natively" can only be recorded after a hard
  double gate — a manually verified version whitelist (initially empty) AND a
  behavioral probe observing the child session's `meta.cwd` through the live
  subagent path; whole-file grepping is forbidden as evidence.
- Read-only doctor `patches/verify.sh | .ps1`: live root, both patches (two
  files, two merge points, checked separately), both `dsh-tools` links,
  repo-copy version drift (warning only); any drift exits non-zero with a
  one-line fix hint; `--probe` re-runs the behavioral probe.
- `patches/uninstall.sh | .ps1` restores patch backups and removes the stamp;
  deliberately does not roll back the Stage A links (deployment health, not
  plugin state).
- Live-root resolution is always dynamic (`which dsh` → realpath → walk up to
  `node_modules`; `DSH_HARNESS_ROOT` override) — no hardcoded paths, no
  `ls | tail -1` heuristics; survives npx cache switches.
- Preset adaptation `scripts/install-preset.sh | .ps1`: L1 (default) copies
  the source preset and deletes the generic delegation rows so the plugin's
  tools show through; L2 (`--enhance-rows`) rewrites official subagent rows to
  this plugin with `presetRow: true`. Idempotent; the source preset is never
  modified; POSIX sh + PowerShell.
- Enforced mutual exclusion with same-surface plugins such as
  `dsh-subagent-tools` (duplicate tool registration) and the earlier
  internal bridges plugin (duplicate bridge provider registration) —
  both fail loudly at startup by design.
- Strict zod config with two branches: the full plugin schema and the
  official preset-row shape; unknown keys fail loudly at apply time.
- dsh-tools double-instance self-check at apply time: detects the second
  module instance (scheduler Symbol missing) and fails with the dedupe fix
  guidance instead of letting every tool call die later.

**Build & CI**

- GitHub Actions CI matrix (`.github/workflows/ci.yml`): macOS / Ubuntu /
  Windows × Node 18 / 20 / 22 running `npm ci` → `npm run lint` →
  `npm test`; the suite and lint need no real CLI, key, or network, so the
  bare runners stay green. The Windows leg exercises the `.cmd`-shim
  launching paths.
- Trusted-publishing npm release workflow (`.github/workflows/publish.yml`):
  OIDC `id-token: write` + `--provenance --access public`, no static
  `NODE_AUTH_TOKEN`.
- `npm run lint` now also enforces the `@deepseek-ai/dsh-subagent`
  pure-function import whitelist (red line 12, `{ assertSubagentMaxDepth,
  settleRun }`) across `lib/`, `test/`, `scripts/`; a violation is reported
  as `file:line: illegal import …`. The whitelist captures named, namespace,
  dynamic-import and require forms.
- Publish metadata in `package.json`: a `files` whitelist (`lib/`, `roles/`,
  `patches/`, `scripts/`, `cordis.patch.yml`, `README*`, `CHANGELOG`,
  `LICENSE`, …), `repository` / `bugs` / `homepage` (placeholder URLs — must
  be replaced with the real repo before publishing) and `keywords`.
- Placeholder-repo caveat: `npm publish` must be gated on a real OIDC-trusted
  publisher owner and updated `repository`/`homepage`/`bugs` URLs (see
  `publish.yml` and `docs/VERIFY.md`).

**Docs & tests**

- Bilingual README (effect matrix, mutual-exclusion table, six-step install,
  npx-cache drift playbook), CHANGELOG, AGENTS.md (design red lines),
  SECURITY.md, and an acceptance record in `docs/VERIFY.md`.
- 479 `node:test` cases — pure logic plus fake bridge / driver / ctx; the
  suite never requires a real CLI, a key, or a network (lint whitelist and
  npm-pack content checks included). The claude/codex/grok bridges carry
  process-level fake-CLI regressions (node-script shims record argv and
  replay fixtures — argv asserted byte-for-byte), and the ACP bridge runs a
  real-SDK `AgentSideConnection` child process (devDependency, no network).
- `npm run lint`: `node --check` every module plus the
  `@deepseek-ai/dsh-subagent` pure-function import whitelist
  (`assertSubagentMaxDepth`, `settleRun`).

### Fixed

- Fixed the `subagent` tool's `backend` parameter description contradicting
  its own enum on bridge-less rows (P3). The single fallback wording —
  "a bridge name (none detected on this deployment)" — also fired for
  `presetRow` rows, lying about the deployment (bridges ARE detected; the
  row is simply native-only by design). The description is now three-state:
  detected bridges are listed; a bridge-less presetRow row says the tool is
  native-only and points at the global `subagent` tool's `backend`
  parameter; a bridge-less global instance honestly says no external agent
  CLI is currently detected (pointing at `subagent_agents`). A consistency
  invariant is pinned by tests: with bridges present every enum bridge name
  appears in the description, and the misleading "(none detected…)" wording
  never appears.
- Fixed `subagent_progress` traces printing `"turn undefined start"` /
  `"step undefined.undefined"` when a session event payload carries no
  turn/step numbers (P3) — the brief now degrades to `turn start` / `turn
  end` / `step start`; fully numbered payloads keep the historical
  `turn N start` / `step N.M` wording (regression-pinned).
- Fixed bridge relay children silently self-answering instead of forwarding
  (2026-08-15 smoke D2b). A continuable relay asked a self-referential
  question ("which product/CLI are you running as?") answered from its own
  system prompt and closed the turn with only a `report` call — never calling
  `subagent_submit` — so the parent received the relay model's own answer
  attributed to the remote product, with no error anywhere (registry
  `remoteId: —`, no remote session artifacts). The fix makes "did the relay
  actually forward?" a deterministic check (DESIGN §5.4.1), in three layers:
  a turn-closure guard (new `lib/relay-guard.js`, attached via the host's
  `ctx.subagents.registerContinuableSetup` + `childCtx.tools.guard` seam —
  the same channel the official in-process driver uses) that rejects a
  relay's `report` call with a corrective `Error: …` result while the turn
  continues, so the model can forward and report afterwards; a hardening
  sentence appended to every relay persona (`NEVER answer from your own
  knowledge, identity, or runtime …`); and observability markers
  (`subagent_progress` gains `relayEpochSubmits` / `relayGuardFlag`,
  `subagent_wait` prefixes a flagged answer, the `subagent/end` hook warns on
  zero-submit epochs) because the harness settlement notice itself is not
  interceptable by a plugin. Counting happens at the `subagent_submit`
  execute entrance (a failed forward still counts — reporting the error is a
  legal closure), the legacy `product_submit` alias shares the same execute,
  and cold-resumed registry-only children are recognized via the binding ∪
  registry union. New config key `relayReportGuard` (default `true`,
  full-branch only — presetRow rows are stateless and never guarded).
- Fixed preset adaptation L2 producing an unmountable preset (2026-08-15
  smoke incident). `--enhance-rows` rewrote EVERY official
  `dsh-tool-subagent` row to `presetRow: true`, including the fork row
  (`provider: fork`, `toolName: subagent_fork`) that the plugin's own config
  validation rejects (a presetRow registers a spawn-semantics delegate and
  must not take the global fork tool's default name) — one invalid row took
  the WHOLE preset down at mount time, the web app silently fell back to the
  `standard` preset, and the session ran the official 3-parameter `subagent`
  instead of the plugin's full-parameter tool. L2 now rewrites only the rows
  a presetRow can honestly host (`provider: spawn` + a `toolName` distinct
  from `subagent`/`subagent_fork`) and deletes the rest: generic rows (they
  would shadow the global instance's delegate/fork tools), fork rows
  (spawn-only semantics in a presetRow; context-inheriting delegation stays
  on the global `subagent_fork`), and bridge template rows (bridge delegation
  belongs to the global `subagent` with `backend=<name>`). A regression hard
  gate asserts every `dsh-plugin-subagents` row in an L1/L2 product passes
  `validateConfig` with `disabled` cleared. Zero rewritable rows still fails
  loud (standard-shaped presets are L1 land).
- Fixed preset adaptation L1 leaving an official `dsh-tool-subagent` row that
  omits `toolName` untouched. `isGenericDelegationRow` did not apply the
  official default (`subagent`) when judging deletion targets, so such a row
  survived L1 adaptation and shadowed the plugin's global full-parameter
  `subagent` at the preset layer (the same failure class as the L2 mount
  incident, one layer down). Both L1/L2 judgments now share one default-value
  rule. Regression case included (a missing-`toolName` official row is
  deleted; role rows with distinct toolNames are untouched).
- Fixed `subagent_progress` / `subagent_wait` failing every call with
  `returned invalid output: value is not lossless JSON` (2026-08-15 smoke
  E3). dsh-tools snapshots every tool return through dsh-session's
  `snapshotJsonValue`, which rejects any value carrying an own property whose
  value is `undefined` (plus Dates, Maps/Sets, class instances, cycles, …);
  the observability tools built returns with unconditional keys like
  `mode: listStatus ? listStatus.mode : undefined`, guaranteed to trip the
  gate on common paths. New `lib/json-safe.js` (`toLosslessJson`) deep
  sanitizes tool outputs — undefined-valued keys dropped, `Date` → ISO,
  `Map`/`Set` → arrays, `Error` → `{name, message}`, bigint → string,
  non-finite numbers/`-0` normalized, cycles and throwing getters safe — and
  is applied at the `subagent_progress` / `subagent_wait` / `subagent_roles` /
  `subagent_agents` return boundaries. The delegation tools build lossless
  values by construction (conditional spreads) and are pinned by tests
  running the exact production snapshot gate.
- Fixed boot failure — `inject` now declares `systemPrompt`
  (Cordis service-access contract). The plugin directly accesses
  `ctx.tools` / `ctx.subagents` / `ctx.systemPrompt` but `inject` was
  `['subagents','tools','sessions']` (sessions is only reached through the
  lazy `ctx.get('sessions')` accessor and `systemPrompt` was missing), which
  made Cordis throw `cannot get property "systemPrompt" without inject` at
  startup. `inject` is now `['subagents','tools','systemPrompt']`,
  matching the earlier cwd plugin, with a strict-ctx regression test that
  emulates the Cordis inject mechanism across every `apply()` branch.
- Fixed boot failure — `apply()` now resolves to `undefined`. The Cordis
  loader treats the plugin callback's return value as a disposable
  (`TypeError: Invalid effect` otherwise), but the T14 introspection build
  returned the assembly object `{ assembled, migration, presetRow }`,
  breaking real starts with `failed to apply loader entry subagents
  (dsh-plugin-subagents): Invalid effect`. Internal introspection now goes
  through the exported `assembleDrivers` / `migrateLegacyRegistry` seams and
  the fake-ctx registration records; both `apply()` branches are covered by a
  strict-ctx regression test asserting an `undefined` resolution.

