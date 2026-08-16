# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First release. `dsh-plugin-subagents` unifies and fully replaces
`legacy-cwd-plugin` (configurable native subagents) and
`legacy-bridges-plugin` (external agent bridges) in one plugin that
takes over the official `subagent` / `subagent_fork` tool names.

### Added

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

- Claude Code, Codex, and generic ACP bridges migrated from
  `legacy-bridges-plugin` (bridge contract unchanged:
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
- Enforced mutual exclusion with `legacy-cwd-plugin` / `dsh-subagent-tools`
  (duplicate tool registration) and `legacy-bridges-plugin` (duplicate
  bridge provider registration) — both fail loudly at startup by design.
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
- 316 `node:test` cases — pure logic plus fake bridge / driver / ctx; the
  suite never requires a real CLI, a key, or a network (lint whitelist and
  npm-pack content checks included).
- `npm run lint`: `node --check` every module plus the
  `@deepseek-ai/dsh-subagent` pure-function import whitelist
  (`assertSubagentMaxDepth`, `settleRun`).

### Fixed

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
  matching `legacy-cwd-plugin`, with a strict-ctx regression test that
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

